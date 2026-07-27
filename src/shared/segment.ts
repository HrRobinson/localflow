/**
 * Shared Segment connector types — the PINNED vocabulary (spec §6.3–§6.5) the
 * flow-templates + canvas tracks consume verbatim: the one trigger id, the two
 * write-action ids, the per-node hard-filter `config` (the RAM-ceiling control,
 * §7), and the normalized `SegmentEventContext` a verified event writes to run
 * context. Imported by main (the connector/normalizer) and any renderer palette
 * surface. Mirrors `src/shared/stripe.ts`.
 *
 * NO raw Segment request/response shape lives here — those are isolated in
 * `src/main/segment/segment-client.ts` (the API blast radius). This file holds
 * ONLY saiife-facing, already-normalized vocabulary: the exact field types
 * the (sibling-owned) edge-condition operators of §10 expect (strings coerced so
 * `exists`/`eq` are stable; `properties`/`traits` preserved as objects).
 */

// ── Pinned Segment vocabulary ids (§6 — the templates track consumes these) ───

/** The ONE webhook-backed trigger id (§6.1). Covers `track` AND `identify`; the
 *  node's `config.type` distinguishes them. One id = the source multiplier. */
export const SEGMENT_TRIGGER_IDS = ['event.tracked'] as const
export type SegmentTriggerId = (typeof SEGMENT_TRIGGER_IDS)[number]

/** Gated write-action ids (§6.2) — the author places a gate before these; a
 *  write into Segment fans out to every downstream destination (§9). */
export const SEGMENT_ACTION_IDS = ['track', 'identify'] as const
export type SegmentActionId = (typeof SEGMENT_ACTION_IDS)[number]

/** The Segment event types the trigger recognizes (§6.3). */
export type SegmentEventType = 'track' | 'identify' | 'page' | 'screen' | 'group'

// ── The per-node hard-filter config (the RAM-ceiling control, §7) ─────────────

/**
 * A `segment` `event.tracked` trigger node's config (§6.4). Carried on the
 * trigger `FlowNode.config`, forwarded to `subscribe` (already pinned, §4.3),
 * applied BEFORE a run is seeded so an unmatched firehose event starts nothing.
 */
export interface SegmentTriggerConfig {
  /** Which Segment event type to accept. Default 'track'. */
  type?: SegmentEventType
  /** REQUIRED for 'track': the exact event name, e.g. "Subscription Downgraded".
   *  A track subscription with no `event` is refused at subscribe (§7.3) — an
   *  un-named track filter IS the firehose, and the whole point is to not have it. */
  event?: string
  /** Optional exact-match narrowing on properties (track) or traits (identify),
   *  e.g. { plan: 'pro' }. All entries must match (deterministic value compare). */
  match?: Record<string, string | number | boolean>
}

// ── Context-field shape (§6.5 — PINNED; guarded by the normalize tests) ───────

/**
 * The verified, filtered event normalized into a stable object written to the
 * trigger node's context slot. Downstream conditions read it by dotted path
 * (`t.event.properties.mrr`, `t.event.traits.plan`). userId/anonymousId coerced
 * to strings (never undefined) so `exists`/`eq` are stable; properties/traits
 * preserved as objects so numeric/string compares work (§10).
 */
export interface SegmentEventContext {
  event: {
    /** 'track' | 'identify' | … */
    type: SegmentEventType
    /** the `event` name for track; '' for identify. */
    name: string
    /** '' when only anonymousId is present. */
    userId: string
    /** '' when only userId is present. */
    anonymousId: string
    /** Segment's dedup id (also the SeedEvent eventId). */
    messageId: string
    /** ISO 8601. */
    timestamp: string
    /** track: the event's `properties`; identify: {}. */
    properties: Record<string, unknown>
    /** identify: the user's `traits`; track: {} unless present. */
    traits: Record<string, unknown>
  }
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ───────────

/** `track` action params (§6.2). Names an `event`; userId or anonymousId. */
export interface SegmentTrackParams {
  event: string
  userId?: string
  anonymousId?: string
  properties?: Record<string, unknown>
}

/** `identify` action params (§6.2). userId or anonymousId + traits. */
export interface SegmentIdentifyParams {
  userId?: string
  anonymousId?: string
  traits?: Record<string, unknown>
}

/** The context output a gated write writes back (§6.2). */
export interface SegmentWriteContext {
  segment: {
    messageId: string
    type: 'track' | 'identify'
  }
}
