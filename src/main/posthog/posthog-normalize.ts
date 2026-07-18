import type {
  PostHogCohortContext,
  PostHogEventContext,
  PostHogFeatureFlagContext,
  PostHogInsightContext
} from '../../shared/posthog'
import type { SeedEvent } from '../flow/trigger-subscriber'

/**
 * PURE map from raw PostHog JSON to the pinned `event.*` / `insight.*` /
 * `cohort.*` / `flag.*` context fields (spec §6.3) and from a polled signal to a
 * `SeedEvent`. Side-effect-free and defensive — it never trusts PostHog's shape
 * by type, mirroring `wc-normalize.ts`'s purity so every mapping is exhaustively
 * unit-testable with no live project (spec §12).
 *
 * This is the CORRECTNESS BOUNDARY the conditions track depends on: a value must
 * land as a NUMBER (an insight `value` / cohort `count` / flag rollout), a flag
 * `active` as a BOOLEAN, and a timestamp as an ISO STRING — so a downstream
 * `insight.value gt 5` / `flag.active is truthy` compare works (spec §6.3).
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** Coerce a value to a finite number; garbage/absent → 0. */
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** Normalize a raw PostHog event (`{ uuid, event, distinct_id, timestamp,
 *  properties }`) into the pinned `event.*` context payload. */
export function normalizeEvent(raw: unknown): PostHogEventContext {
  const e = isObject(raw) ? raw : {}
  return {
    event: {
      id: str(e.uuid ?? e.id),
      name: str(e.event ?? e.name),
      distinctId: str(e.distinct_id ?? e.distinctId),
      timestamp: str(e.timestamp),
      properties: isObject(e.properties) ? e.properties : {}
    }
  }
}

/**
 * Pull the computed aggregate out of a raw insight. PostHog reports it in a few
 * shapes depending on the insight kind; check the common ones in order
 * (`result[0].aggregated_value`, `result[0].count`, a top-level `value`), so the
 * normalizer — not every caller — owns the shape knowledge.
 */
function insightValue(raw: Record<string, unknown>): number {
  const result = raw.result
  if (Array.isArray(result) && result.length > 0 && isObject(result[0])) {
    const first = result[0]
    if (first.aggregated_value !== undefined) return num(first.aggregated_value)
    if (first.count !== undefined) return num(first.count)
  }
  if (raw.value !== undefined) return num(raw.value)
  if (raw.aggregated_value !== undefined) return num(raw.aggregated_value)
  return 0
}

/** Normalize a raw insight into the pinned `insight.*` context (spec §6.3). */
export function normalizeInsight(raw: unknown): PostHogInsightContext {
  const i = isObject(raw) ? raw : {}
  const insight: PostHogInsightContext['insight'] = {
    id: str(i.id ?? i.short_id),
    name: str(i.name ?? i.derived_name),
    value: insightValue(i),
    computedAt: str(i.last_refresh ?? i.computedAt ?? i.updated_at)
  }
  const unit = i.unit
  if (typeof unit === 'string' && unit.length > 0) insight.unit = unit
  return { insight }
}

/** The distinct-id member set of a raw cohort, for the `cohort.entered` poll
 *  set-diff (spec §7.2b). Reads a `members`/`persons` list of ids/objects. */
export function cohortMembers(raw: unknown): string[] {
  const c = isObject(raw) ? raw : {}
  const list = c.members ?? c.persons ?? c.results
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const m of list) {
    if (typeof m === 'string' && m.length > 0) out.push(m)
    else if (isObject(m)) {
      const id = str(m.distinct_id ?? m.distinctId ?? m.id)
      if (id.length > 0) out.push(id)
    }
  }
  return out
}

/** Normalize a raw cohort into the pinned `cohort.*` context (spec §6.3). When
 *  the poll knows the entering person, pass `enteredDistinctId`. */
export function normalizeCohort(raw: unknown, enteredDistinctId?: string): PostHogCohortContext {
  const c = isObject(raw) ? raw : {}
  const count = c.count !== undefined ? num(c.count) : cohortMembers(c).length
  const cohort: PostHogCohortContext['cohort'] = {
    id: str(c.id),
    name: str(c.name),
    count
  }
  if (enteredDistinctId !== undefined && enteredDistinctId.length > 0) {
    cohort.enteredDistinctId = enteredDistinctId
  }
  return { cohort }
}

/** Pull a simple top-level rollout % out of a raw flag, or null when the flag
 *  uses filter groups with no single top-level number. PostHog nests it under
 *  `filters.groups[0].rollout_percentage`; a top-level `rollout_percentage` is
 *  the legacy shape. */
function flagRollout(raw: Record<string, unknown>): number | null {
  if (typeof raw.rollout_percentage === 'number') return raw.rollout_percentage
  const filters = raw.filters
  if (isObject(filters) && Array.isArray(filters.groups)) {
    const groups = filters.groups
    if (groups.length === 1 && isObject(groups[0])) {
      const rp = groups[0].rollout_percentage
      if (typeof rp === 'number') return rp
    }
  }
  return null
}

/** Normalize a raw feature flag into the pinned `flag.*` context (spec §6.3). */
export function normalizeFeatureFlag(raw: unknown): PostHogFeatureFlagContext {
  const f = isObject(raw) ? raw : {}
  return {
    flag: {
      id: str(f.id),
      key: str(f.key),
      active: f.active === true,
      rolloutPercentage: flagRollout(f)
    }
  }
}

/** Build the `{ eventId, payload }` SeedEvent for a polled signal (spec §7.2).
 *  `eventId` is the idempotency key `trigger-subscriber.coerceEvent` dedups on. */
export function toSeedEvent(eventId: string, payload: Record<string, unknown>): SeedEvent {
  return { eventId, payload }
}
