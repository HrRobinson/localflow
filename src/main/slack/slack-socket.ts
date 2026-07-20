/**
 * The **Socket Mode** client (spec §2.1, §4.4) — the zero-ingress default. A
 * persistent OUTBOUND WebSocket (opened with the app token via
 * `apps.connections.open`) carries events, slash commands, AND interaction
 * (button) payloads with NO public URL, no tunnel, no relay, and NO signature
 * verification (the socket is authenticated at open). This is the property no
 * other connector has.
 *
 * Each envelope is `ack`ed on the wire immediately; the run/resolution happens
 * after. A `disconnect` (refresh) frame triggers a transparent reconnect — the
 * pending approval map (owned by `slack-approval-port.ts`) is independent of the
 * socket, so no gate is lost across a reconnect (spec §11). The live WebSocket
 * transport is behind a `SocketTransport` interface so a `MockSocketTransport`
 * drives inbound traffic with zero network in CI (spec §12).
 */

/** The normalized inbound category the connector routes on (transport-agnostic). */
export interface SlackInbound {
  type: 'events_api' | 'slash_commands' | 'interactive'
  /** The raw Slack payload for this category — parsed in `slack-blocks.ts`. */
  payload: unknown
}

/** A raw Socket Mode envelope (before ack + normalization). */
export interface SlackSocketEnvelope {
  /** The id to `ack` (absent on `hello`/`disconnect` control frames). */
  envelopeId?: string
  type: 'events_api' | 'slash_commands' | 'interactive' | 'hello' | 'disconnect'
  payload?: unknown
  /** On a `disconnect` frame — why Slack is closing the socket. */
  reason?: string
}

/** The live WS seam — the real impl opens the socket; tests inject a mock. */
export interface SocketTransport {
  /** Open (or re-open) the outbound WS. */
  connect(): Promise<void>
  /** Register the single envelope sink. */
  onEnvelope(handler: (env: SlackSocketEnvelope) => void): void
  /** Ack an envelope on the wire. */
  ack(envelopeId: string): void
  /** Close the socket. */
  close(): void
}

export interface SlackSocketDeps {
  transport: SocketTransport
  /** Normalized, acked inbound → the connector's router. */
  onInbound: (inbound: SlackInbound) => void
  /** Route + reason logger. NEVER receives a token. */
  log?: (message: string) => void
}

export class SlackSocket {
  private readonly transport: SocketTransport
  private readonly onInbound: (inbound: SlackInbound) => void
  private readonly log: (message: string) => void
  private closed = false

  constructor(deps: SlackSocketDeps) {
    this.transport = deps.transport
    this.onInbound = deps.onInbound
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /** Wire the envelope sink and open the socket. */
  async start(): Promise<void> {
    this.transport.onEnvelope((env) => this.onEnvelope(env))
    await this.transport.connect()
  }

  close(): void {
    this.closed = true
    this.transport.close()
  }

  private onEnvelope(env: SlackSocketEnvelope): void {
    if (env.type === 'hello') return // handshake — nothing to do.
    if (env.type === 'disconnect') {
      // Slack refreshes the socket periodically; reconnect transparently. The
      // pending approval map is independent of the socket, so no gate is lost.
      if (this.closed) return
      this.log(`slack socket: reconnecting (${env.reason ?? 'refresh'})`)
      this.transport.connect().catch((err: unknown) => {
        // A HARD, repeated failure is loud (approvals won't arrive) — never a
        // silent dead socket (spec §11).
        this.log(
          `slack socket: can't stay connected (${err instanceof Error ? err.message : String(err)}) — approvals won't arrive until it recovers.`
        )
      })
      return
    }
    // events_api / slash_commands / interactive: ack FIRST, then deliver.
    if (env.envelopeId) this.transport.ack(env.envelopeId)
    this.onInbound({ type: env.type, payload: env.payload })
  }
}

// ── Test double (spec §12) ───────────────────────────────────────────────────

/** In-memory `SocketTransport` — emits scripted envelopes, records acks/connects. */
export class MockSocketTransport implements SocketTransport {
  readonly acks: string[] = []
  connects = 0
  closed = false
  private handler: ((env: SlackSocketEnvelope) => void) | null = null

  connect(): Promise<void> {
    this.connects += 1
    return Promise.resolve()
  }

  onEnvelope(handler: (env: SlackSocketEnvelope) => void): void {
    this.handler = handler
  }

  ack(envelopeId: string): void {
    this.acks.push(envelopeId)
  }

  close(): void {
    this.closed = true
  }

  /** Drive an inbound envelope through the wired socket. */
  emit(env: SlackSocketEnvelope): void {
    this.handler?.(env)
  }
}
