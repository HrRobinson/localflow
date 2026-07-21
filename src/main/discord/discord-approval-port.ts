import type { ApprovalPort, ApprovalRequest } from '../flow/types'
import type { DiscordApprovalDecision } from '../../shared/discord'
import type { DiscordApi, DiscordMessageRef } from './discord-client'
import { CALLBACK_UPDATE_MESSAGE } from './discord-client'
import {
  buildApprovalMessage,
  buildResolvedMessage,
  buildExpiredMessage,
  buildStaleMessage,
  correlationKey,
  interactionRef,
  parseInteraction
} from './discord-components'

/**
 * THE HEADLINE (spec §3, §7): saiife's SECOND real `ApprovalPort` — a
 * near-line-for-line peer of `SlackApprovalPort`, against the SAME
 * `flow/types.ts` seam, with NO engine change. It is CONNECTOR-AGNOSTIC — it
 * knows only `ApprovalRequest`, never which connector's action sits past the
 * gate — so wiring it once makes EVERY gate in EVERY flow (an email send, a
 * `cloud apply`, a Shopify `refundOrder`) approvable from Discord on a phone.
 *
 * `requestApproval(req)` posts an Approve/Deny message (button custom_id
 * `lf:approve|deny:{runId}:{nodeId}`), parks a resolver in a `Map` keyed by
 * `"{runId}:{nodeId}"`, and returns the promise. An inbound component
 * INTERACTION_CREATE — routed here from the active transport (Gateway or the
 * HTTP Interactions path) — resolves it `true`/`false` and FINALIZES + ACKS in
 * ONE call: an `UPDATE_MESSAGE` (type 7) interaction-callback that both satisfies
 * Discord's ≤3s ack AND strips the buttons. The one place Discord diverges from
 * Slack: the TIMEOUT path has no interaction token in hand, so it edits the
 * message via REST `PATCH` (`editMessage`) instead. A liveness timeout resolves
 * `false` (a clean "no", never a failure, §7.3). Idempotent: resolution deletes
 * the pending entry BEFORE any await, so a double-tap / redelivery is a no-op
 * (§7.2).
 */

interface Pending {
  req: ApprovalRequest
  resolve: (approved: boolean) => void
  ref: DiscordMessageRef
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

/**
 * Cap on the `settled` double-tap tombstone set. It only needs to outlive the
 * window between a gate resolving and Discord's last redelivery of that same
 * tap; a long-running saiife would otherwise accumulate one entry per gate
 * forever (an unbounded leak). Oldest entries are evicted FIFO past this cap — a
 * redelivery older than the last `SETTLED_CAP` resolutions simply degrades to
 * the legible "no longer active" card instead of a silent no-op, which is
 * harmless. Peer of `SlackApprovalPort.SETTLED_CAP`.
 */
export const SETTLED_CAP = 1000

export interface DiscordApprovalPortDeps {
  api: DiscordApi
  /** The channel approvals post to (`defaultChannel`, a channel snowflake). */
  channel: string
  /** Liveness timeout; on expiry the gate resolves `false` (§7.3). */
  timeoutMs?: number
  /** Emitted on a button tap so a flow can log/notify (`approval.responded`, §6.1). */
  onDecision?: (decision: DiscordApprovalDecision) => void
  /** Injectable timer (returns a cancel fn) — deterministic in tests. */
  timer?: ApprovalTimer
  /** Route + reason logger. NEVER receives a token or the peek content. */
  log?: (message: string) => void
}

export class DiscordApprovalPort implements ApprovalPort {
  private readonly api: DiscordApi
  private readonly channel: string
  private readonly timeoutMs: number
  private readonly onDecision?: (decision: DiscordApprovalDecision) => void
  private readonly timer: ApprovalTimer
  private readonly log: (message: string) => void
  private readonly pending = new Map<string, Pending>()
  /** Keys resolved recently — distinguishes a double-tap (no-op) from a truly
   *  unknown/stale gate ("no longer active"). */
  private readonly settled = new Set<string>()

  constructor(deps: DiscordApprovalPortDeps) {
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
    // A pending entry for this exact (runId, nodeId) already exists — overwriting
    // it in the Map would ORPHAN the prior resolver (its promise would hang until
    // GC, a leaked gate). This is a caller bug (a gate is requested once per run),
    // so reject LOUDLY before posting a duplicate Discord message rather than
    // silently clobbering the first gate.
    if (this.pending.has(key)) {
      throw new Error(
        `An approval for gate '${key}' is already pending — refusing to open a second one ` +
          '(the first would be silently orphaned).'
      )
    }
    const body = buildApprovalMessage(req)
    // A failed POST is a REAL failure (bad channel / revoked token) — let it
    // reject with the client's legible cause; the gate-runner surfaces it. It is
    // NOT a human "no" (that is only a tap/timeout resolving `false`).
    const ref = await this.api.postMessage({ channelId: this.channel, body })
    return new Promise<boolean>((resolve, reject) => {
      // Re-check atomically with the map: a concurrent same-key request could have
      // raced past the pre-post check during the await above. Never overwrite a
      // live resolver (the executor body runs with no await, so this is atomic).
      if (this.pending.has(key)) {
        reject(
          new Error(`An approval for gate '${key}' is already pending — refusing to orphan it.`)
        )
        return
      }
      const cancelTimer = this.timer(() => this.expire(key), this.timeoutMs)
      this.pending.set(key, { req, resolve, ref, cancelTimer })
    })
  }

  /**
   * Route an inbound component interaction (from the Gateway or the HTTP
   * Interactions path). A tap for a parked gate resolves it and finalizes+acks
   * the message in ONE `UPDATE_MESSAGE` callback; a double-tap is a silent
   * no-op; a tap for an unknown/stale gate gets a legible card.
   */
  handleInteraction(raw: unknown): void {
    const decision = parseInteraction(raw)
    if (!decision) return // not one of our approval buttons — ignore.
    const ref = interactionRef(raw)
    const key = correlationKey(decision.runId, decision.nodeId)
    const entry = this.pending.get(key)
    if (!entry) {
      if (this.settled.has(key)) return // double-tap / redelivery → no-op (§7.2).
      // Unknown/stale: run already ended, or saiife restarted losing the map.
      if (ref) {
        this.api
          .respondToInteraction({
            interactionId: ref.interactionId,
            token: ref.token,
            type: CALLBACK_UPDATE_MESSAGE,
            body: buildStaleMessage()
          })
          .catch((err: unknown) =>
            this.log(`discord approval: stale-tap update failed — ${reason(err)}`)
          )
      }
      this.log(`discord approval: interaction for unknown gate '${key}' — dropped`)
      return
    }
    // Idempotency: delete + cancel the timer BEFORE any await (§7.2).
    this.pending.delete(key)
    this.rememberSettled(key)
    entry.cancelTimer()
    entry.resolve(decision.approved)
    this.emitDecision(decision)
    this.finalize(entry, ref, decision.decidedBy, decision.approved)
  }

  /** Timeout: resolve `false` (clean stop) + stamp the message "Expired" via REST
   *  `PATCH` — there is NO interaction token in hand on the timeout path (§7.3). */
  private expire(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    this.rememberSettled(key)
    entry.resolve(false)
    this.api
      .editMessage({
        channelId: entry.ref.channelId,
        messageId: entry.ref.messageId,
        body: buildExpiredMessage(entry.req)
      })
      .catch((err: unknown) => this.log(`discord approval: expiry update failed — ${reason(err)}`))
  }

  /**
   * Finalize the message to a resolved, button-less card. On a live tap this is
   * the `UPDATE_MESSAGE` interaction-callback (which ALSO acks within Discord's
   * 3s window — one call). If the interaction ref is somehow absent, fall back to
   * a REST `PATCH` so the surface is never left tappable.
   */
  private finalize(
    entry: Pending,
    ref: { interactionId: string; token: string } | null,
    decidedBy: string,
    approved: boolean
  ): void {
    const body = buildResolvedMessage(entry.req, decidedBy, approved)
    if (ref) {
      this.api
        .respondToInteraction({
          interactionId: ref.interactionId,
          token: ref.token,
          type: CALLBACK_UPDATE_MESSAGE,
          body
        })
        .catch((err: unknown) =>
          this.log(`discord approval: finalize callback failed — ${reason(err)}`)
        )
      return
    }
    this.api
      .editMessage({ channelId: entry.ref.channelId, messageId: entry.ref.messageId, body })
      .catch((err: unknown) => this.log(`discord approval: finalize edit failed — ${reason(err)}`))
  }

  private emitDecision(decision: DiscordApprovalDecision): void {
    if (!this.onDecision) return
    try {
      this.onDecision(decision)
    } catch (err) {
      this.log(`discord approval: approval.responded handler failed — ${reason(err)}`)
    }
  }

  /** Record a resolved key as a double-tap tombstone, bounding the set FIFO so it
   *  can't grow without limit over a long-lived process (§7.2). `Set` preserves
   *  insertion order, so the first key is the oldest. */
  private rememberSettled(key: string): void {
    this.settled.add(key)
    while (this.settled.size > SETTLED_CAP) {
      const oldest = this.settled.values().next().value
      if (oldest === undefined) break
      this.settled.delete(oldest)
    }
  }

  /** In-flight gates (test/inspection aid). */
  pendingCount(): number {
    return this.pending.size
  }

  /** Resolved-tombstone count (test/inspection aid). */
  settledCount(): number {
    return this.settled.size
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
