import type {
  SegmentEventContext,
  SegmentEventType,
  SegmentTriggerConfig
} from '../../shared/segment'

/**
 * PURE normalization + the pre-seed filter (spec §6.5, §7.2, §10) — the
 * correctness boundary the conditions track depends on and the RAM-ceiling floor
 * the connector runs before seeding any run. A raw (untrusted) Segment event
 * body becomes the PINNED `SegmentEventContext`; `eventMatches` decides whether a
 * verified delivery becomes a `SeedEvent` at all. Never throws — a sparse/garbage
 * body normalizes to safe defaults and simply FAILS the filter rather than
 * crashing a run (mirrors `stripe-normalize.ts` purity).
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function obj(v: unknown): Record<string, unknown> {
  return isObj(v) ? v : {}
}

const EVENT_TYPES: readonly SegmentEventType[] = ['track', 'identify', 'page', 'screen', 'group']

/** Coerce an unknown `type` to a known `SegmentEventType`, defaulting to 'track'
 *  (the highest-volume type, and the one the firehose guard §7.3 protects). */
function coerceType(v: unknown): SegmentEventType {
  return (EVENT_TYPES as readonly string[]).includes(str(v)) ? (v as SegmentEventType) : 'track'
}

/**
 * A raw Segment event body → the pinned `SegmentEventContext` (§6.5). ids are
 * coerced to strings (never undefined) so `exists`/`eq` are stable; `properties`
 * (track) and `traits` (identify) are preserved as objects for numeric/string
 * compares. Unknown/garbage normalizes to safe defaults.
 */
export function normalizeSegmentEvent(body: unknown): SegmentEventContext {
  const b = obj(body)
  const type = coerceType(b.type)
  return {
    event: {
      type,
      // Only a track carries a meaningful `event` name; identify/others → ''.
      name: type === 'track' ? str(b.event) : '',
      userId: str(b.userId),
      anonymousId: str(b.anonymousId),
      messageId: str(b.messageId),
      timestamp: str(b.timestamp),
      properties: type === 'track' ? obj(b.properties) : {},
      traits: type === 'identify' ? obj(b.traits) : {}
    }
  }
}

/**
 * The pre-seed hard filter (§7.2) — the deterministic floor under the RAM ceiling.
 * Returns true ONLY when the verified event matches the node's config on EVERY
 * axis; a false drops the delivery before any run/session is allocated:
 *  - `type` equals `config.type` (default 'track'), else drop.
 *  - for a track, `name` equals `config.event`, else drop.
 *  - every `config.match` entry equals the corresponding property/trait, else drop.
 * No model in the loop — a deterministic value compare (the saiifeguard posture).
 */
export function eventMatches(config: SegmentTriggerConfig, ctx: SegmentEventContext): boolean {
  const wantType: SegmentEventType = config.type ?? 'track'
  if (ctx.event.type !== wantType) return false
  if (wantType === 'track' && ctx.event.name !== config.event) return false
  if (config.match) {
    const bag = wantType === 'identify' ? ctx.event.traits : ctx.event.properties
    for (const [key, value] of Object.entries(config.match)) {
      if (bag[key] !== value) return false
    }
  }
  return true
}

/**
 * The ONE hard rule (§7.3): a `track` subscription MUST name its event. An
 * un-named track filter IS the whole firehose, which would overwhelm the 8 GB
 * machine — so the connector refuses it structurally at subscribe time. `identify`
 * (and other lower-volume types) may omit `event`.
 */
export function assertNamedTrack(config: SegmentTriggerConfig): void {
  const type: SegmentEventType = config.type ?? 'track'
  if (type === 'track' && (config.event === undefined || config.event.length === 0)) {
    throw new Error(
      "A Segment track trigger must name an event (e.g. 'Subscription Downgraded') — " +
        'an un-named track filter is the whole firehose, which will overwhelm this machine.'
    )
  }
}

/**
 * Coerce the raw trigger node `config` (an untrusted `Record`) into a typed
 * `SegmentTriggerConfig`: a known `type`, a string `event`, and a `match` map
 * restricted to primitive values (the only things a deterministic compare can
 * use). Unknown/garbage fields are dropped rather than trusted.
 */
export function parseTriggerConfig(config: Record<string, unknown> = {}): SegmentTriggerConfig {
  const out: SegmentTriggerConfig = {}
  if ((EVENT_TYPES as readonly string[]).includes(str(config.type))) {
    out.type = config.type as SegmentEventType
  }
  if (typeof config.event === 'string' && config.event.length > 0) out.event = config.event
  if (isObj(config.match)) {
    const match: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(config.match)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') match[k] = v
    }
    if (Object.keys(match).length > 0) out.match = match
  }
  return out
}
