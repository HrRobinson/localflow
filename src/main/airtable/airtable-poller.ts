import type {
  AirtableTriggerId,
  AirtableChangePayload,
  AirtableChangeType
} from '../../shared/airtable'
import type { SeedEvent } from '../flow/trigger-subscriber'
import type { AirtableApi } from './airtable-api'
import type { AirtableCursorStore } from './airtable-cursor-store'
import { normalizePayloadBatch, type AirtableChangeSeed } from './airtable-normalize'

/**
 * The POLL / reconcile trigger backbone (spec §4) — the KEY design point. An
 * Airtable webhook notification is a bare PING with no change payload, so the
 * poll of `/payloads` with a persisted integer cursor is the PRIMARY (and
 * MVP-only) trigger ingress, modeled directly on `posthog-poller.ts` and the
 * email reconcile (`email/provider.ts reconcile(cursor)`).
 *
 * Per active subscription: a cadence keyed off the INJECTED CLOCK (`deps.now`,
 * the `flow-engine.now()` seam) so tests advance time deterministically with NO
 * real waiting (spec §10) — no wall-clock `setInterval` in the tested core. The
 * cursor is the WEBHOOK's monotonic integer, stored per webhook in
 * `airtable-cursor-store.ts`; a webhook can watch multiple tables, so the poller
 * FANS a fetched payload batch out to every subscription whose `(tableId,
 * changeType)` filter matches — two flows watching the same base share one
 * webhook + one cursor + one `/payloads` call.
 *
 * Disciplines carried verbatim from the PostHog poller:
 *  - **Baseline-without-firing** on first observation: the first poll advances the
 *    cursor past the existing backlog WITHOUT firing, so an existing pile of
 *    changes doesn't flood a run on startup (spec §4.2).
 *  - **Advance-after-handoff** (at-least-once): the cursor is written ONLY AFTER
 *    the changed records are handed to the subscription handlers, so a crash
 *    mid-poll re-fetches rather than drops (spec §4.2).
 *  - **Seen-set dedup**: a bounded per-subscription set of eventIds makes a
 *    re-emit after a persist-failure a no-op → honest at-least-once, effective
 *    exactly-once across a persist retry (spec §4.2).
 *  - **Loud degradation, never a silent dead poll**: a failed tick logs loudly and
 *    does NOT advance the cursor; the next tick retries from the same cursor, so a
 *    signal is worked late, never lost (spec §4.2, §9).
 */

export interface AirtablePollerDeps {
  api: AirtableApi
  cursors: AirtableCursorStore
  /** The injected clock (ms). The same seam `flow-engine.now()` uses (spec §4.2). */
  now: () => number
  /** Poll cadence in seconds; default 60 (spec §4.2). */
  pollSeconds?: number
  /** Degradation logger. NEVER receives a secret or a record payload. */
  log?: (message: string) => void
}

type TriggerHandler = (event: SeedEvent) => void

interface Subscription {
  key: string
  triggerId: AirtableTriggerId
  baseId: string
  tableId: string
  webhookId: string
  handler: TriggerHandler
  nextDueAt: number
  /** Bounded set of eventIds handed off since the last durable cursor commit —
   *  suppresses a re-emit when a cursor persist failed AFTER an emit (spec §4.2). */
  seen: Set<string>
}

/** Bound on a subscription's pending-dedup set — cleared on every successful
 *  commit, so it only ever holds one webhook batch's worth of ids normally. */
const SEEN_MAX = 1000

/** Which CDC change kind a trigger id consumes (spec §3.1). */
const CHANGE_TYPE_FOR: Record<AirtableTriggerId, AirtableChangeType> = {
  'record.created': 'created',
  'record.updated': 'updated'
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

export class AirtablePoller {
  private readonly api: AirtableApi
  private readonly cursors: AirtableCursorStore
  private readonly now: () => number
  private readonly pollMs: number
  private readonly log: (message: string) => void
  private readonly subs = new Map<string, Subscription>()

  constructor(deps: AirtablePollerDeps) {
    this.api = deps.api
    this.cursors = deps.cursors
    this.now = deps.now
    this.pollMs = (deps.pollSeconds ?? 60) * 1000
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /**
   * Register a poll subscription (spec §4.2). The trigger node's `config` carries
   * `baseId`, `tableId`, and `webhookId` (the `/payloads` cursor stream). Returns
   * an unsubscribe that removes the subscription (the cursor is retained for a
   * restart-resume). A newly registered subscription is due IMMEDIATELY.
   */
  subscribe(
    triggerId: AirtableTriggerId,
    config: Record<string, unknown>,
    handler: TriggerHandler
  ): () => void {
    const baseId = str(config.baseId)
    const tableId = str(config.tableId)
    const webhookId = str(config.webhookId)
    const key = subscriptionKey(triggerId, baseId, tableId, str(config.viewId))
    const sub: Subscription = {
      key,
      triggerId,
      baseId,
      tableId,
      webhookId,
      handler,
      nextDueAt: this.now(),
      seen: new Set<string>()
    }
    this.subs.set(key, sub)
    return () => {
      this.subs.delete(key)
    }
  }

  /** Tear down every subscription (disconnect / secret cleared, spec §5). */
  stopAll(): void {
    this.subs.clear()
  }

  /**
   * Poll every webhook with a DUE subscription once. Production wires a real
   * interval to call this; tests advance the injected clock and call it directly.
   * Subscriptions are grouped by webhook so one `/payloads` fetch serves them all;
   * each webhook group's poll is independent — one failing does not stop the
   * others, and a failure does not advance that webhook's cursor (spec §4.2, §9).
   */
  async tick(): Promise<void> {
    const now = this.now()
    // Group ALL subscriptions by webhook; a group is polled if ANY of its subs is
    // due (they share the cursor, so they poll together).
    const groups = new Map<string, Subscription[]>()
    for (const sub of this.subs.values()) {
      const gk = sub.webhookId.length > 0 ? sub.webhookId : `no-webhook:${sub.key}`
      const list = groups.get(gk) ?? []
      list.push(sub)
      groups.set(gk, list)
    }
    for (const [, group] of groups) {
      if (!group.some((s) => now >= s.nextDueAt)) continue
      await this.pollWebhook(group)
      // Reschedule the whole group regardless of success — a failed poll retries
      // next cadence.
      const due = this.now() + this.pollMs
      for (const s of group) s.nextDueAt = due
    }
  }

  private async pollWebhook(group: Subscription[]): Promise<void> {
    const webhookId = group[0].webhookId
    try {
      if (webhookId.length === 0) {
        throw new Error(
          `Airtable trigger '${group[0].triggerId}' needs a 'webhookId' in its node config ` +
            `(the /payloads cursor stream) — none was supplied.`
        )
      }
      const cursorKey = webhookId
      const stored = this.cursors.get(cursorKey)
      const firstObservation = stored === undefined

      // Page through the stream, collecting every payload up to the latest cursor.
      const payloads = []
      let next: number | undefined = stored?.cursor
      let mightHaveMore = true
      let latestCursor = next ?? 1
      while (mightHaveMore) {
        const page = await this.api.listWebhookPayloads(webhookId, next)
        payloads.push(...page.payloads)
        latestCursor = page.cursor
        next = page.cursor
        mightHaveMore = page.mightHaveMore === true
      }

      if (firstObservation) {
        // Baseline WITHOUT firing: jump the cursor past the existing backlog so
        // startup doesn't flood a run (spec §4.2).
        this.commitCursor(cursorKey, webhookId, latestCursor, group)
        return
      }

      // Fan the batch out: each seed goes to every subscription whose table +
      // change type match.
      const seeds = normalizePayloadBatch(payloads)
      for (const seed of seeds) {
        for (const sub of group) {
          if (!matches(sub, seed)) continue
          this.emit(sub, seed)
        }
      }
      // Advance AFTER the handoffs (spec §4.2 dedup rule).
      this.commitCursor(cursorKey, webhookId, latestCursor, group)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // LOUD degradation; cursor NOT advanced — the next tick retries from the
      // same cursor so the signal is worked late, never lost (spec §9).
      this.log(
        `airtable poller: trigger '${group[0].triggerId}' poll failed — ${reason}. ` +
          `Cursor not advanced; retrying next tick.`
      )
    }
  }

  /** Hand a SeedEvent to the subscription's handler, catching+logging a handler
   *  throw so one bad handler never stops the poll or blocks a cursor advance.
   *  Idempotent per eventId: an id already handed off since the last durable
   *  commit is NOT re-seeded (guards the persist-failure re-fetch, spec §4.2). */
  private emit(sub: Subscription, seed: AirtableChangeSeed): void {
    if (sub.seen.has(seed.eventId)) return
    sub.seen.add(seed.eventId)
    if (sub.seen.size > SEEN_MAX) {
      const oldest = sub.seen.values().next().value
      if (oldest !== undefined) sub.seen.delete(oldest)
    }
    const payload: AirtableChangePayload = {
      record: seed.record,
      changeType: seed.changeType,
      baseId: sub.baseId,
      tableId: seed.tableId,
      ...(seed.changedFieldNames ? { changedFieldNames: seed.changedFieldNames } : {})
    }
    try {
      sub.handler({ eventId: seed.eventId, payload: payload as unknown as Record<string, unknown> })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.log(`airtable poller: handler for '${sub.triggerId}' failed — ${reason}`)
    }
  }

  /** Persist the advanced cursor, then clear each group subscription's pending-
   *  dedup set: once the cursor is durable, everything emitted up to it is
   *  committed and a genuine later change must be free to fire. A throw here
   *  (sidecar write failure) leaves `seen` intact so the next tick's re-fetch does
   *  NOT re-seed — the throw propagates to `pollWebhook`'s LOUD log (spec §4.2). */
  private commitCursor(
    key: string,
    webhookId: string,
    cursor: number,
    group: Subscription[]
  ): void {
    this.cursors.set(key, { kind: 'payloads', webhookId, cursor })
    for (const sub of group) sub.seen.clear()
  }
}

/** Whether a seed belongs to a subscription — same table, matching change kind. */
function matches(sub: Subscription, seed: AirtableChangeSeed): boolean {
  return seed.tableId === sub.tableId && seed.changeType === CHANGE_TYPE_FOR[sub.triggerId]
}

/** A stable subscription key so two flows watching the same base/table/view/
 *  trigger share one subscription, and two watching different ones don't. */
function subscriptionKey(
  triggerId: AirtableTriggerId,
  baseId: string,
  tableId: string,
  viewId: string
): string {
  return `${triggerId}:${baseId}:${tableId}:${viewId}`
}
