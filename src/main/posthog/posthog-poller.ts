import type { PostHogTriggerId } from '../../shared/posthog'
import type { SeedEvent } from '../flow/trigger-subscriber'
import type { PostHogApi } from './posthog-api'
import type { PostHogCursor, PostHogCursorStore } from './posthog-cursor-store'
import {
  cohortMembers,
  normalizeCohort,
  normalizeEvent,
  normalizeInsight
} from './posthog-normalize'

/**
 * The POLL / reconcile trigger backbone (spec §7) — the KEY design point.
 * PostHog has no reliable "new event" webhook a desktop app can host, so the
 * poll is the PRIMARY (and MVP-only) trigger ingress, modeled directly on the
 * email connector's reconcile poll (`email/provider.ts reconcile(cursor)` + a
 * persisted cursor + a periodic defense-in-depth poll).
 *
 * Per active subscription: a cadence keyed off the INJECTED CLOCK (`deps.now`,
 * the `flow-engine.now()` seam) so tests advance time deterministically with NO
 * real waiting (spec §12) — no wall-clock `setInterval` in the tested core. Each
 * trigger id has its own cursor shape + dedup:
 *  - `event.matched`     — timestamp+uuid cursor; first tick BASELINES the backlog
 *                          without firing, then boundary tick fires once (§7.2a)
 *  - `cohort.entered`    — membership set-diff; once per newly-present person (§7.2b)
 *  - `insight.threshold` — EDGE-CROSS; fires on the crossing, not every tick (§7.2c)
 *
 * The cursor is advanced ONLY AFTER the handler is handed the SeedEvent, so a
 * crash mid-poll re-processes rather than drops (at-least-once, deduped
 * downstream by `eventId`). A failed tick ANNOUNCES DEGRADATION LOUDLY and does
 * NOT advance the cursor — the one thing forbidden is a silent dead poll
 * (spec §11 "Poll failed").
 */

export interface PostHogPollerDeps {
  api: PostHogApi
  cursors: PostHogCursorStore
  /** The injected clock (ms). The same seam `flow-engine.now()` uses (spec §7.1). */
  now: () => number
  /** Poll cadence in seconds; default 60 (spec §7.3). */
  pollSeconds?: number
  /** Degradation logger. NEVER receives a secret or an analytics payload. */
  log?: (message: string) => void
}

type TriggerHandler = (event: SeedEvent) => void

interface Subscription {
  key: string
  triggerId: PostHogTriggerId
  config: Record<string, unknown>
  handler: TriggerHandler
  nextDueAt: number
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

export class PostHogPoller {
  private readonly api: PostHogApi
  private readonly cursors: PostHogCursorStore
  private readonly now: () => number
  private readonly pollMs: number
  private readonly log: (message: string) => void
  private readonly subs = new Map<string, Subscription>()

  constructor(deps: PostHogPollerDeps) {
    this.api = deps.api
    this.cursors = deps.cursors
    this.now = deps.now
    this.pollMs = (deps.pollSeconds ?? 60) * 1000
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  /**
   * Register a poll subscription (spec §7.1). Returns an unsubscribe that stops
   * the subscription (removes it; the cursor is retained for a restart-resume).
   * A newly registered subscription is due IMMEDIATELY (nextDueAt = now).
   */
  subscribe(
    triggerId: PostHogTriggerId,
    config: Record<string, unknown>,
    handler: TriggerHandler
  ): () => void {
    const key = subscriptionKey(triggerId, config)
    const sub: Subscription = { key, triggerId, config, handler, nextDueAt: this.now() }
    this.subs.set(key, sub)
    return () => {
      this.subs.delete(key)
    }
  }

  /** Tear down every subscription (disconnect / key cleared, spec §8). */
  stopAll(): void {
    this.subs.clear()
  }

  /**
   * Poll every DUE subscription once (a subscription is due when `now() >=
   * nextDueAt`). Production wires a real interval to call this; tests advance the
   * injected clock and call it directly. Each subscription's poll is independent
   * — one failing does not stop the others, and a failure does not advance that
   * subscription's cursor (spec §11).
   */
  async tick(): Promise<void> {
    const now = this.now()
    const due = [...this.subs.values()].filter((s) => now >= s.nextDueAt)
    for (const sub of due) {
      await this.pollOne(sub)
      // Reschedule regardless of success — a failed poll retries next cadence.
      sub.nextDueAt = this.now() + this.pollMs
    }
  }

  private async pollOne(sub: Subscription): Promise<void> {
    try {
      switch (sub.triggerId) {
        case 'insight.threshold':
          await this.pollInsight(sub)
          break
        case 'cohort.entered':
          await this.pollCohort(sub)
          break
        case 'event.matched':
          await this.pollEvents(sub)
          break
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // LOUD degradation; cursor NOT advanced — the next tick retries from the
      // same cursor so the signal is worked late, never lost (spec §11).
      this.log(
        `posthog poller: trigger '${sub.triggerId}' poll failed — ${reason}. ` +
          `Cursor not advanced; retrying next tick.`
      )
    }
  }

  // ── §7.2c insight.threshold — edge-cross ────────────────────────────────────

  private async pollInsight(sub: Subscription): Promise<void> {
    const insightId = requireConfig(sub.config, 'insightId', 'insight.threshold')
    const threshold = requireNumber(sub.config, 'threshold', 'insight.threshold')
    const direction = sub.config.direction === 'below' ? 'below' : 'above'

    const { insight } = normalizeInsight(await this.api.getInsight(insightId))
    const value = insight.value

    const prev = this.cursors.get(sub.key)
    const lastValue = prev && prev.kind === 'insight' ? prev.lastValue : undefined

    // First observation: baseline WITHOUT firing (no prior value ⇒ no crossing
    // observed — an already-elevated value must not wake a run on startup).
    if (lastValue !== undefined && crossed(lastValue, value, threshold, direction)) {
      this.emit(sub, `${insightId}:${value}`, {
        insightId,
        value,
        threshold,
        direction,
        insight
      })
    }
    // Advance AFTER the handoff (spec §7.2 dedup rule).
    this.cursors.set(sub.key, { kind: 'insight', lastValue: value })
  }

  // ── §7.2b cohort.entered — membership set-diff ──────────────────────────────

  private async pollCohort(sub: Subscription): Promise<void> {
    const cohortId = requireConfig(sub.config, 'cohortId', 'cohort.entered')
    const raw = await this.api.getCohort(cohortId)
    const current = cohortMembers(raw)

    const prev = this.cursors.get(sub.key)
    const lastSeen = prev && prev.kind === 'cohort' ? new Set(prev.members) : undefined

    // First observation: baseline the snapshot WITHOUT firing (can't know who is
    // "newly" present on first sight).
    if (lastSeen !== undefined) {
      for (const distinctId of current) {
        if (!lastSeen.has(distinctId)) {
          const { cohort } = normalizeCohort(raw, distinctId)
          this.emit(sub, `${cohortId}:${distinctId}`, {
            cohortId,
            enteredDistinctId: distinctId,
            cohort
          })
        }
      }
    }
    this.cursors.set(sub.key, { kind: 'cohort', members: current })
  }

  // ── §7.2a event.matched — timestamp+uuid cursor ─────────────────────────────

  private async pollEvents(sub: Subscription): Promise<void> {
    const prev = this.cursors.get(sub.key)
    const cursor = prev && prev.kind === 'event' ? prev : undefined

    const rows = await this.api.queryEvents({
      event: optionalStr(sub.config.event),
      after: cursor?.ts,
      properties: isObject(sub.config.properties) ? sub.config.properties : undefined
    })

    // Normalize + sort oldest-first by (timestamp, uuid) so the cursor advances
    // monotonically even if the transport returns out of order.
    const events = rows
      .map((r) => normalizeEvent(r).event)
      .filter((e) => e.id.length > 0 && e.timestamp.length > 0)
      .sort((a, b) => cmp(a.timestamp, a.id, b.timestamp, b.id))

    // First observation (cursor undefined — first subscribe / reset): BASELINE
    // the newest (ts, uuid) WITHOUT firing, exactly like pollInsight/pollCohort.
    // Firing every pre-existing matching event here would flood a run with up to
    // 100 historical signals on startup (spec §7.2a). Only genuinely-new events
    // (arriving after this baseline) fire on later ticks.
    if (!cursor) {
      const newest = events[events.length - 1]
      this.cursors.set(
        sub.key,
        newest
          ? { kind: 'event', ts: newest.timestamp, lastUuid: newest.id }
          : { kind: 'event', ts: '', lastUuid: '' }
      )
      return
    }

    let advanced: PostHogCursor | undefined
    for (const e of events) {
      // Boundary dedup (spec §7.2a): drop anything at/under the cursor's
      // (ts, uuid) — the query is inclusive at `ts`, so already-seen boundary
      // events reappear and must not re-fire.
      if (cmp(e.timestamp, e.id, cursor.ts, cursor.lastUuid) <= 0) continue
      this.emit(sub, e.id, { event: e })
      advanced = { kind: 'event', ts: e.timestamp, lastUuid: e.id }
    }
    // Advance to the newest handed-off (ts, uuid), AFTER the handoffs.
    if (advanced) this.cursors.set(sub.key, advanced)
  }

  /** Hand a SeedEvent to the subscription's handler, catching+logging a handler
   *  throw so one bad handler never stops the poll or blocks a cursor advance. */
  private emit(sub: Subscription, eventId: string, payload: Record<string, unknown>): void {
    try {
      sub.handler({ eventId, payload })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.log(`posthog poller: handler for '${sub.triggerId}' failed — ${reason}`)
    }
  }
}

/** Whether `value` crossed `threshold` from `lastValue` in the given direction. */
function crossed(
  lastValue: number,
  value: number,
  threshold: number,
  direction: 'above' | 'below'
): boolean {
  if (direction === 'above') return lastValue < threshold && value >= threshold
  return lastValue > threshold && value <= threshold
}

/** Compare two (timestamp, uuid) tuples lexically — ISO 8601 sorts correctly. */
function cmp(tsA: string, idA: string, tsB: string, idB: string): number {
  if (tsA < tsB) return -1
  if (tsA > tsB) return 1
  if (idA < idB) return -1
  if (idA > idB) return 1
  return 0
}

/** A stable, collision-resistant subscription key from the trigger + its config
 *  so two flows watching the same insight+threshold share one cursor, and two
 *  watching different ones don't. */
function subscriptionKey(triggerId: PostHogTriggerId, config: Record<string, unknown>): string {
  switch (triggerId) {
    case 'insight.threshold':
      return `insight.threshold:${str(config.insightId)}:${str(String(config.threshold))}:${config.direction === 'below' ? 'below' : 'above'}`
    case 'cohort.entered':
      return `cohort.entered:${str(config.cohortId)}`
    case 'event.matched':
      return `event.matched:${str(config.event, '*')}:${stableProps(config.properties)}`
  }
}

function stableProps(v: unknown): string {
  if (!isObject(v)) return ''
  return Object.keys(v)
    .sort()
    .map((k) => `${k}=${String((v as Record<string, unknown>)[k])}`)
    .join(',')
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function requireConfig(config: Record<string, unknown>, key: string, trigger: string): string {
  const v = config[key]
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  throw new Error(
    `PostHog '${trigger}' trigger needs a '${key}' in its node config — none was supplied.`
  )
}

function requireNumber(config: Record<string, unknown>, key: string, trigger: string): number {
  const v = config[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  throw new Error(
    `PostHog '${trigger}' trigger needs a numeric '${key}' in its node config — none was supplied.`
  )
}
