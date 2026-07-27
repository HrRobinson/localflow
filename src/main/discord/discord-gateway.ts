/**
 * The **Gateway** client (spec §2.1, §4.4) — the zero-ingress default and the
 * Socket-Mode analog. A persistent OUTBOUND WebSocket (opened after
 * `GET /gateway/bot`, authenticated by an `IDENTIFY` op carrying the bot token +
 * intents) that carries `MESSAGE_CREATE` events AND `INTERACTION_CREATE` (button
 * + slash) dispatches with NO public URL, no tunnel, no relay, and NO signature
 * verification (authenticated at IDENTIFY). This is the property no vertical
 * connector has. The PEER of `slack-socket.ts`.
 *
 * Lifecycle (spec §2.3.4): on `HELLO` the client heartbeats on the given
 * interval (op 1) and IDENTIFYs (op 2); after a drop it `RESUME`s (op 6, session
 * id + last sequence), or re-IDENTIFYs on an `INVALID_SESSION`. The pending
 * approval map (owned by `discord-approval-port.ts`) is independent of the
 * socket, so no gate is lost across a reconnect (spec §11). The live WebSocket is
 * behind a `GatewayTransport` interface so a `MockGatewayTransport` drives
 * inbound traffic with zero network in CI (spec §12).
 */

// ── Gateway opcodes (Discord) ────────────────────────────────────────────────

export const OP_DISPATCH = 0
export const OP_HEARTBEAT = 1
export const OP_IDENTIFY = 2
export const OP_RESUME = 6
export const OP_RECONNECT = 7
export const OP_INVALID_SESSION = 9
export const OP_HELLO = 10
export const OP_HEARTBEAT_ACK = 11

/** Default gateway intents — GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT. The
 *  Message Content bit only yields non-empty text once the privileged intent is
 *  toggled in the Developer Portal (§2.3, §13.3). */
export const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)

/** The normalized inbound category the connector routes on (transport-agnostic). */
export interface DiscordInbound {
  type: 'message' | 'interaction'
  /** The raw Discord payload for this category — parsed in `discord-components.ts`. */
  payload: unknown
}

/** A raw Gateway frame (before dispatch + normalization). */
export interface GatewayFrame {
  op: number
  /** dispatch event name (present on op 0). */
  t?: string | null
  /** sequence number (present on op 0). */
  s?: number | null
  /** the op payload. */
  d?: unknown
}

/** The live WS seam — the real impl opens the socket; tests inject a mock. */
export interface GatewayTransport {
  /** Open (or re-open) the outbound WS. */
  connect(): Promise<void>
  /** Register the single frame sink. */
  onFrame(handler: (frame: GatewayFrame) => void): void
  /** Send a frame on the wire (IDENTIFY / HEARTBEAT / RESUME). */
  send(frame: unknown): void
  /** Close the socket. */
  close(): void
}

/** A heartbeat scheduler that returns a cancel fn — injectable for tests. */
export type HeartbeatTimer = (cb: () => void, ms: number) => () => void

const defaultTimer: HeartbeatTimer = (cb, ms) => {
  const h = setInterval(cb, ms)
  return () => clearInterval(h)
}

export interface DiscordGatewayDeps {
  transport: GatewayTransport
  /** Reveal the bot token at IDENTIFY time (main-process-only; never stored). */
  token: () => string
  /** Gateway intents bitfield. */
  intents?: number
  /** Normalized inbound (MESSAGE_CREATE / INTERACTION_CREATE) → the connector. */
  onInbound: (inbound: DiscordInbound) => void
  /** Injectable heartbeat scheduler — deterministic in tests. */
  heartbeatTimer?: HeartbeatTimer
  /** Route + reason logger. NEVER receives a token. */
  log?: (message: string) => void
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export class DiscordGateway {
  private readonly transport: GatewayTransport
  private readonly token: () => string
  private readonly intents: number
  private readonly onInbound: (inbound: DiscordInbound) => void
  private readonly heartbeatTimer: HeartbeatTimer
  private readonly log: (message: string) => void

  private closed = false
  private lastSeq: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  /** True after a drop where a RESUME (not a fresh IDENTIFY) should follow. */
  private resuming = false
  private cancelHeartbeat: (() => void) | null = null

  constructor(deps: DiscordGatewayDeps) {
    this.transport = deps.transport
    this.token = deps.token
    this.intents = deps.intents ?? DEFAULT_INTENTS
    this.onInbound = deps.onInbound
    this.heartbeatTimer = deps.heartbeatTimer ?? defaultTimer
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /** Wire the frame sink and open the socket. */
  async start(): Promise<void> {
    this.transport.onFrame((frame) => this.onFrame(frame))
    await this.transport.connect()
  }

  close(): void {
    this.closed = true
    this.stopHeartbeat()
    this.transport.close()
  }

  private onFrame(frame: GatewayFrame): void {
    switch (frame.op) {
      case OP_HELLO:
        this.onHello(frame.d)
        return
      case OP_DISPATCH:
        this.onDispatch(frame)
        return
      case OP_HEARTBEAT_ACK:
        return // liveness ack — nothing to do.
      case OP_RECONNECT:
        // Discord asks us to reconnect; the session is resumable.
        this.reconnect(true, 'reconnect requested')
        return
      case OP_INVALID_SESSION:
        // The session can't be resumed; drop it and re-IDENTIFY fresh.
        this.sessionId = null
        this.reconnect(false, 'invalid session')
        return
      default:
        return
    }
  }

  private onHello(d: unknown): void {
    const interval =
      isObject(d) && typeof d.heartbeat_interval === 'number' ? d.heartbeat_interval : 45_000
    this.startHeartbeat(interval)
    if (this.resuming && this.sessionId) {
      this.transport.send({
        op: OP_RESUME,
        d: { token: this.token(), session_id: this.sessionId, seq: this.lastSeq }
      })
      this.resuming = false
      return
    }
    this.transport.send({
      op: OP_IDENTIFY,
      d: { token: this.token(), intents: this.intents, properties: { os: 'saiife' } }
    })
  }

  private onDispatch(frame: GatewayFrame): void {
    if (typeof frame.s === 'number') this.lastSeq = frame.s
    if (frame.t === 'READY' && isObject(frame.d)) {
      const sid = frame.d.session_id
      if (typeof sid === 'string') this.sessionId = sid
      const ru = frame.d.resume_gateway_url
      if (typeof ru === 'string') this.resumeUrl = ru
      return
    }
    if (frame.t === 'MESSAGE_CREATE') {
      this.onInbound({ type: 'message', payload: frame.d })
      return
    }
    if (frame.t === 'INTERACTION_CREATE') {
      this.onInbound({ type: 'interaction', payload: frame.d })
      return
    }
  }

  private reconnect(resumable: boolean, why: string): void {
    if (this.closed) return
    this.resuming = resumable
    this.stopHeartbeat()
    this.log(`discord gateway: reconnecting (${why})`)
    this.transport.connect().catch((err: unknown) => {
      // A HARD, repeated failure is loud (approvals won't arrive) — never a
      // silent dead socket (spec §11).
      this.log(
        `discord gateway: can't stay connected (${reason(err)}) — approvals won't arrive until it recovers.`
      )
    })
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.cancelHeartbeat = this.heartbeatTimer(() => {
      this.transport.send({ op: OP_HEARTBEAT, d: this.lastSeq })
    }, intervalMs)
  }

  private stopHeartbeat(): void {
    this.cancelHeartbeat?.()
    this.cancelHeartbeat = null
  }

  /** The resume gateway url captured from READY (test/inspection aid). */
  currentResumeUrl(): string | null {
    return this.resumeUrl
  }

  /** The last sequence seen (test/inspection aid). */
  lastSequence(): number | null {
    return this.lastSeq
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Test double (spec §12) ───────────────────────────────────────────────────

/** In-memory `GatewayTransport` — emits scripted frames, records sends/connects. */
export class MockGatewayTransport implements GatewayTransport {
  readonly sent: unknown[] = []
  connects = 0
  closed = false
  private handler: ((frame: GatewayFrame) => void) | null = null

  connect(): Promise<void> {
    this.connects += 1
    return Promise.resolve()
  }

  onFrame(handler: (frame: GatewayFrame) => void): void {
    this.handler = handler
  }

  send(frame: unknown): void {
    this.sent.push(frame)
  }

  close(): void {
    this.closed = true
  }

  /** Drive an inbound frame through the wired gateway. */
  emit(frame: GatewayFrame): void {
    this.handler?.(frame)
  }

  /** Every send whose op matches (e.g. IDENTIFY / RESUME / HEARTBEAT). */
  sendsOfOp(op: number): Record<string, unknown>[] {
    return this.sent.filter((f): f is Record<string, unknown> => isObject(f) && f.op === op)
  }
}
