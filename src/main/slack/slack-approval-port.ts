import type { ApprovalPort, ApprovalRequest } from '../flow/types'
import type { SlackApprovalDecision } from '../../shared/slack'
import type { SlackApi, SlackMessageRef } from './slack-client'
import {
  buildApprovalMessage,
  buildResolvedMessage,
  buildExpiredMessage,
  correlationKey,
  parseInteraction
} from './slack-blocks'

/**
 * THE HEADLINE (spec §3, §7): localflow's FIRST real `ApprovalPort`, replacing
 * the always-`false` stub in `index.ts`. It is CONNECTOR-AGNOSTIC — it knows only
 * `ApprovalRequest`, never which connector's action sits past the gate — so
 * wiring it once makes EVERY gate in EVERY flow (an email send, a `cloud apply`,
 * a Shopify `refundOrder`) approvable from a phone.
 *
 * `requestApproval(req)` posts a Block Kit Approve/Deny message (button value
 * `"{runId}:{nodeId}"`), parks a resolver in a `Map` keyed by that same string,
 * and returns the promise. An inbound `block_actions` interaction — routed here
 * from the active transport (Socket Mode or the Events path) — resolves it
 * `true`/`false`, `chat.update`s the message to a button-less card, and emits the
 * `approval.responded` decision. A liveness timeout resolves `false` (a clean
 * "no", never a failure, §7.3). Idempotent: resolution deletes the pending entry
 * BEFORE any await, so a double-tap / redelivery is a no-op (§7.2).
 */

interface Pending {
  req: ApprovalRequest
  resolve: (approved: boolean) => void
  ref: SlackMessageRef
  cancelTimer: () => void
}

/** A timer that returns a cancel function — injectable for deterministic tests. */
export type ApprovalTimer = (cb: () => void, ms: number) => () => void

const defaultTimer: ApprovalTimer = (cb, ms) => {
  const h = setTimeout(cb, ms)
  return () => clearTimeout(h)
}

/** Default liveness window — 1 hour (§7.3). An unanswered gate never hangs. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 3_600_000

export interface SlackApprovalPortDeps {
  api: SlackApi
  /** The channel approvals post to (`defaultChannel`). */
  channel: string
  /** Liveness timeout; on expiry the gate resolves `false` (§7.3). */
  timeoutMs?: number
  /** Emitted on a button tap so a flow can log/notify (`approval.responded`, §6.1). */
  onDecision?: (decision: SlackApprovalDecision) => void
  /** Injectable timer (returns a cancel fn) — deterministic in tests. */
  timer?: ApprovalTimer
  /** Route + reason logger. NEVER receives a token or the peek content. */
  log?: (message: string) => void
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Best-effort channel+ts from a raw `block_actions` payload (for a stale-tap
 *  update, where we have no parked ref). Null when the shape lacks them. */
function messageRefFromInteraction(raw: unknown): SlackMessageRef | null {
  if (!isObject(raw)) return null
  const channel = isObject(raw.channel) && typeof raw.channel.id === 'string' ? raw.channel.id : undefined
  const ts =
    (isObject(raw.message) && typeof raw.message.ts === 'string' && raw.message.ts) ||
    (isObject(raw.container) && typeof raw.container.message_ts === 'string' && raw.container.message_ts) ||
    undefined
  if (!channel || !ts) return null
  return { channel, ts }
}

export class SlackApprovalPort implements ApprovalPort {
  private readonly api: SlackApi
  private readonly channel: string
  private readonly timeoutMs: number
  private readonly onDecision?: (decision: SlackApprovalDecision) => void
  private readonly timer: ApprovalTimer
  private readonly log: (message: string) => void
  private readonly pending = new Map<string, Pending>()
  /** Keys resolved recently — distinguishes a double-tap (no-op) from a truly
   *  unknown/stale gate ("no longer active"). */
  private readonly settled = new Set<string>()

  constructor(deps: SlackApprovalPortDeps) {
    this.api = deps.api
    this.channel = deps.channel
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.onDecision = deps.onDecision
    this.timer = deps.timer ?? defaultTimer
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /** The `ApprovalPort` seam: post the question, park a resolver, await a tap. */
  async requestApproval(req: ApprovalRequest): Promise<boolean> {
    const key = correlationKey(req.runId, req.nodeId)
    const { text, blocks } = buildApprovalMessage(req)
    // A failed POST is a REAL failure (bad channel / revoked token) — let it
    // reject with the client's legible cause; the gate-runner surfaces it. It is
    // NOT a human "no" (that is only a tap/timeout resolving `false`).
    const ref = await this.api.postMessage({ channel: this.channel, text, blocks })
    return new Promise<boolean>((resolve) => {
      const cancelTimer = this.timer(() => this.expire(key), this.timeoutMs)
      this.pending.set(key, { req, resolve, ref, cancelTimer })
    })
  }

  /**
   * Route an inbound interaction (from Socket Mode or the interactivity URL).
   * A tap for a parked gate resolves it and finalizes the message; a double-tap
   * is a silent no-op; a tap for an unknown/stale gate gets a legible card.
   */
  handleInteraction(raw: unknown): void {
    const decision = parseInteraction(raw)
    if (!decision) return // not one of our approval buttons — ignore.
    const key = correlationKey(decision.runId, decision.nodeId)
    const entry = this.pending.get(key)
    if (!entry) {
      if (this.settled.has(key)) return // double-tap / redelivery → no-op (§7.2).
      // Unknown/stale: run already ended, or localflow restarted losing the map.
      const ref = messageRefFromInteraction(raw)
      if (ref) {
        this.api
          .updateMessage({
            channel: ref.channel,
            ts: ref.ts,
            text: 'This approval is no longer active (the run has ended or localflow restarted).',
            blocks: []
          })
          .catch((err: unknown) => this.log(`slack approval: stale-tap update failed — ${reason(err)}`))
      }
      this.log(`slack approval: interaction for unknown gate '${key}' — dropped`)
      return
    }
    // Idempotency: delete + cancel the timer BEFORE any await (§7.2).
    this.pending.delete(key)
    this.settled.add(key)
    entry.cancelTimer()
    entry.resolve(decision.approved)
    this.emitDecision(decision)
    this.finalize(entry, decision.decidedBy, decision.approved)
  }

  /** Timeout: resolve `false` (clean stop) + stamp the message "Expired" (§7.3). */
  private expire(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    this.settled.add(key)
    entry.resolve(false)
    this.api
      .updateMessage({
        channel: entry.ref.channel,
        ts: entry.ref.ts,
        text: buildExpiredMessage(entry.req).text,
        blocks: buildExpiredMessage(entry.req).blocks
      })
      .catch((err: unknown) => this.log(`slack approval: expiry update failed — ${reason(err)}`))
  }

  /** `chat.update` the message to a resolved, button-less card (§7.2). */
  private finalize(entry: Pending, decidedBy: string, approved: boolean): void {
    const { text, blocks } = buildResolvedMessage(entry.req, decidedBy, approved)
    this.api
      .updateMessage({ channel: entry.ref.channel, ts: entry.ref.ts, text, blocks })
      .catch((err: unknown) => this.log(`slack approval: finalize update failed — ${reason(err)}`))
  }

  private emitDecision(decision: SlackApprovalDecision): void {
    if (!this.onDecision) return
    try {
      this.onDecision(decision)
    } catch (err) {
      this.log(`slack approval: approval.responded handler failed — ${reason(err)}`)
    }
  }

  /** In-flight gates (test/inspection aid). */
  pendingCount(): number {
    return this.pending.size
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
