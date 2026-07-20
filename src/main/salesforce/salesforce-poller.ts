import type { SalesforceTriggerId } from '../../shared/salesforce'
import type { SeedEvent } from '../flow/trigger-subscriber'
import type { SalesforceApi, SalesforceReconcileParams } from './salesforce-api'
import type { SalesforceCursor, SalesforceCursorStore } from './salesforce-cursor-store'
import { normalizeRecord } from './salesforce-normalize'

/**
 * The POLL / SOQL-reconcile trigger backbone (spec §7) — the KEY design point.
 * Salesforce has no simple signed-HTTP webhook a desktop app can host (spec
 * §2.3), so the poll is the PRIMARY (and MVP-only) trigger ingress, modeled
 * directly on `posthog-poller.ts`'s event poll and the email connector's
 * reconcile.
 *
 * Per active subscription: a cadence keyed off the INJECTED CLOCK (`deps.now`,
 * the `flow-engine.now()` seam) so tests advance time deterministically with NO
 * real waiting (spec §7.1, §12) — no wall-clock `setInterval` in the tested core.
 * Both triggers share this ONE backbone, differing only in the timestamp field
 * they cursor on:
 *  - `record.created`  →  `(CreatedDate, Id)` cursor
 *  - `record.updated`  →  `(LastModifiedDate, Id)` cursor  (the reconcile, §7.2)
 *
 * The SOQL is `WHERE <ts> >= :cursor [AND <where>] ORDER BY <ts>, Id` (inclusive),
 * with `(ts, Id)` tuple dedup: any row `<= (cursor.ts, cursor.id)` is dropped (the
 * inclusive query re-returns the boundary row, which must not re-fire), and the
 * cursor advances to the newest handed-off tuple AFTER the handoff — so a crash
 * mid-poll re-processes rather than drops (at-least-once). The first tick of a
 * fresh subscription BASELINES the newest tuple WITHOUT firing (an already-
 * populated org must not flood a run per pre-existing record, §7.3). A bounded
 * per-subscription `seen` set makes a persist-that-throws-after-emit effectively
 * exactly-once (§7.2). A failed tick ANNOUNCES DEGRADATION LOUDLY and does NOT
 * advance the cursor — the one forbidden outcome is a silent dead poll (§7.4).
 *
 * `subscribe(...,config)` carries WHAT to poll — the sObject (`object`), an
 * optional SOQL `where`, and optional extra `fields` — forwarded by the registry
 * from the flow trigger node's config (spec §4.3). Without it the poll can't run.
 */

export interface SalesforcePollerDeps {
  api: SalesforceApi
  cursors: SalesforceCursorStore
  /** The injected clock (ms). The same seam `flow-engine.now()` uses (spec §7.1). */
  now: () => number
  /** Poll cadence in seconds; default 120 (conservative, spec §2.2). */
  pollSeconds?: number
  /** The org instance URL, for the normalized record's Lightning deep-link. */
  instanceUrl?: string
  /** Degradation logger. NEVER receives a secret or a record payload. */
  log?: (message: string) => void
}

type TriggerHandler = (event: SeedEvent) => void

interface Subscription {
  key: string
  triggerId: SalesforceTriggerId
  config: Record<string, unknown>
  handler: TriggerHandler
  nextDueAt: number
  /** The bounded set of record ids handed off since the LAST durable cursor
   *  commit — makes a persist-failure re-query a no-op (spec §7.2). */
  seen: Set<string>
}

const SEEN_MAX = 1000

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

/** The timestamp field a trigger cursors on (spec §6.1). */
function timestampField(triggerId: SalesforceTriggerId): 'CreatedDate' | 'LastModifiedDate' {
  return triggerId === 'record.created' ? 'CreatedDate' : 'LastModifiedDate'
}

export class SalesforcePoller {
  private readonly api: SalesforceApi
  private readonly cursors: SalesforceCursorStore
  private readonly now: () => number
  private readonly pollMs: number
  private readonly instanceUrl?: string
  private readonly log: (message: string) => void
  private readonly subs = new Map<string, Subscription>()

  constructor(deps: SalesforcePollerDeps) {
    this.api = deps.api
    this.cursors = deps.cursors
    this.now = deps.now
    this.pollMs = (deps.pollSeconds ?? 120) * 1000
    this.instanceUrl = deps.instanceUrl
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /**
   * Register a poll subscription (spec §7.1). Returns an unsubscribe that stops
   * the subscription (removes it; the cursor is retained for a restart-resume). A
   * newly registered subscription is due IMMEDIATELY (nextDueAt = now).
   */
  subscribe(
    triggerId: SalesforceTriggerId,
    config: Record<string, unknown>,
    handler: TriggerHandler
  ): () => void {
    const key = subscriptionKey(triggerId, config)
    this.subs.set(key, {
      key,
      triggerId,
      config,
      handler,
      nextDueAt: this.now(),
      seen: new Set<string>()
    })
    return () => {
      this.subs.delete(key)
    }
  }

  /** Tear down every subscription (disconnect / key cleared, spec §8). */
  stopAll(): void {
    this.subs.clear()
  }

  /**
   * Poll every DUE subscription once (due when `now() >= nextDueAt`). Production
   * wires a real interval to call this; tests advance the injected clock and call
   * it directly. Each subscription's poll is independent — one failing does not
   * stop the others, and a failure does not advance that cursor (spec §11).
   */
  async tick(): Promise<void> {
    const now = this.now()
    const due = [...this.subs.values()].filter((s) => now >= s.nextDueAt)
    for (const sub of due) {
      await this.pollOne(sub)
      sub.nextDueAt = this.now() + this.pollMs
    }
  }

  private async pollOne(sub: Subscription): Promise<void> {
    try {
      await this.pollRecords(sub)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // LOUD degradation; cursor NOT advanced — the next tick retries from the
      // same boundary so the signal is worked late, never lost (spec §7.4, §11).
      this.log(
        `salesforce poller: trigger '${sub.triggerId}' poll failed — ${reason}. ` +
          `Cursor not advanced; retrying next tick.`
      )
    }
  }

  private async pollRecords(sub: Subscription): Promise<void> {
    const object = requireConfig(sub.config, 'object', sub.triggerId)
    const field = timestampField(sub.triggerId)
    const prev = this.cursors.get(sub.key)

    const params: SalesforceReconcileParams = {
      object,
      timestampField: field,
      fields: optionalFields(sub.config.fields),
      where: str(sub.config.where) || undefined,
      afterTs: prev?.ts
    }
    const result = await this.api.queryReconcile(params)

    // Normalize + sort oldest-first by (ts, Id) so the cursor advances
    // monotonically even if the transport returns out of order (spec §7.2).
    const records = result.records
      .map((r) => normalizeRecord(r, { type: object, instanceUrl: this.instanceUrl }).record)
      .filter((r) => r.id.length > 0)
      .map((r) => ({ record: r, ts: field === 'CreatedDate' ? r.createdDate : r.lastModifiedDate }))
      .filter((r) => r.ts.length > 0)
      .sort((a, b) => cmp(a.ts, a.record.id, b.ts, b.record.id))

    // First observation (cursor undefined): BASELINE the newest (ts, Id) WITHOUT
    // firing — an already-populated org must not wake a run per pre-existing
    // record (spec §7.3). Only records after this baseline fire on later ticks.
    if (!prev) {
      const newest = records[records.length - 1]
      this.cursors.set(
        sub.key,
        newest ? { ts: newest.ts, id: newest.record.id } : { ts: '', id: '' }
      )
      return
    }

    let advanced: SalesforceCursor | undefined
    for (const { record, ts } of records) {
      // Boundary dedup (spec §7.2): drop anything at/under the cursor tuple — the
      // query is inclusive at `ts`, so the boundary row reappears and must not
      // re-fire.
      if (cmp(ts, record.id, prev.ts, prev.id) <= 0) continue
      this.emit(sub, record.id, { record })
      advanced = { ts, id: record.id }
    }
    if (advanced) this.commitCursor(sub, advanced)
  }

  /** Hand a SeedEvent to the handler, catching+logging a handler throw so one bad
   *  handler never stops the poll. Idempotent per record id: an id already handed
   *  off since the last durable commit is NOT re-seeded (spec §7.2). */
  private emit(sub: Subscription, recordId: string, payload: Record<string, unknown>): void {
    if (sub.seen.has(recordId)) return
    sub.seen.add(recordId)
    if (sub.seen.size > SEEN_MAX) {
      const oldest = sub.seen.values().next().value
      if (oldest !== undefined) sub.seen.delete(oldest)
    }
    try {
      sub.handler({ eventId: recordId, payload })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.log(`salesforce poller: handler for '${sub.triggerId}' failed — ${reason}`)
    }
  }

  /** Persist the advanced cursor, then clear the pending-dedup set: once durable,
   *  everything emitted up to it is committed and a GENUINE later re-modification
   *  of the same record must be free to fire again. A throw here leaves `seen`
   *  intact so the next tick's re-query does NOT re-seed — it propagates to
   *  `pollOne`'s LOUD log (spec §7.2, §7.4). */
  private commitCursor(sub: Subscription, cursor: SalesforceCursor): void {
    this.cursors.set(sub.key, cursor)
    sub.seen.clear()
  }
}

/** Compare two `(timestamp, Id)` tuples lexically — ISO 8601 sorts correctly. */
function cmp(tsA: string, idA: string, tsB: string, idB: string): number {
  if (tsA < tsB) return -1
  if (tsA > tsB) return 1
  if (idA < idB) return -1
  if (idA > idB) return 1
  return 0
}

/** A stable subscription key from the trigger + object + where, so two flows
 *  watching the same object+filter share one cursor, and different ones don't. */
function subscriptionKey(triggerId: SalesforceTriggerId, config: Record<string, unknown>): string {
  return `${triggerId}:${str(config.object, '*')}:${str(config.where)}`
}

function optionalFields(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.filter((f): f is string => typeof f === 'string' && f.length > 0)
    return out.length > 0 ? out : undefined
  }
  if (typeof v === 'string' && v.length > 0) {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return undefined
}

function requireConfig(config: Record<string, unknown>, key: string, trigger: string): string {
  const v = config[key]
  if (typeof v === 'string' && v.length > 0) return v
  throw new Error(
    `Salesforce '${trigger}' trigger needs an '${key}' (the sObject, e.g. "Lead") in its node config — none was supplied.`
  )
}
