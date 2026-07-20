/**
 * Shared PagerDuty connector types — the NORMALIZED, stable context shapes an
 * action/trigger writes to run context (spec §6.3) and the action-param shapes
 * the engine templates. Imported by main (the connector/normalizer/webhook
 * server) and any renderer palette surface. Mirrors `src/shared/sentry.ts`.
 *
 * NO raw PagerDuty REST/webhook shape lives here — those are isolated in
 * `src/main/pagerduty/pagerduty-api.ts` (the API blast radius, §4.1). This file
 * holds ONLY localflow-facing, already-normalized vocabulary: the incident /
 * service fields conditions route on, and the pinned id tuples the templates
 * track reads.
 */

// ── Pinned on-call vocabulary ids (§6 — templates + compose tracks read) ──────

/** Webhook-backed trigger ids (§6.1). All four are CLEAN 1:1 maps to native v3
 *  event types — no derived filter (unlike Sentry's `issue.regressed`). */
export const PAGERDUTY_TRIGGER_IDS = [
  'incident.triggered',
  'incident.acknowledged',
  'incident.escalated',
  'incident.resolved'
] as const
export type PagerDutyTriggerId = (typeof PAGERDUTY_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (§6.2). */
export const PAGERDUTY_READ_ACTION_IDS = ['getIncident', 'getService'] as const

/** Gated-mutation action ids — the author places a gate before EACH of these,
 *  including `acknowledgeIncident` (§6.2, §9). Every one sends the `From:`
 *  acting-user header. */
export const PAGERDUTY_MUTATION_ACTION_IDS = [
  'acknowledgeIncident',
  'resolveIncident',
  'escalateIncident',
  'addNote'
] as const

export type PagerDutyActionId =
  (typeof PAGERDUTY_READ_ACTION_IDS)[number] | (typeof PAGERDUTY_MUTATION_ACTION_IDS)[number]

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ──────

export type PagerDutyIncidentStatus = 'triggered' | 'acknowledged' | 'resolved'
export type PagerDutyUrgency = 'high' | 'low'
export type PagerDutyServiceStatus = 'active' | 'warning' | 'critical' | 'maintenance' | 'disabled'

export interface PagerDutyIncidentContext {
  incident: {
    /** "PXXXXXX" — the API id used by every write. */
    id: string
    /** Human incident #. */
    number: number
    title: string
    status: PagerDutyIncidentStatus
    urgency: PagerDutyUrgency
    /** e.g. "P1"; undefined when unset. */
    priority: string | undefined
    serviceId: string
    serviceName: string
    escalationPolicyId: string
    /** User summaries/emails currently assigned. */
    assignees: string[]
    /** The incident's PagerDuty URL. */
    htmlUrl: string
    /** ISO 8601. */
    createdAt: string
    // Cross-tool compose hooks (§7): links PagerDuty to the source error.
    // Best-effort — from the incident body / first trigger, may be absent.
    sentryIssueId: string | undefined
    /** The service's linked repo/dashboard, if any. */
    serviceUrl: string | undefined
  }
}

export interface PagerDutyServiceContext {
  service: {
    id: string
    name: string
    status: PagerDutyServiceStatus
    escalationPolicyId: string
    htmlUrl: string
  }
}

/** What a verified webhook seeds a run with (§6.1) — the normalized incident plus
 *  the underlying v3 event type. */
export interface PagerDutyTriggerPayload extends PagerDutyIncidentContext {
  eventType: PagerDutyTriggerId
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ───────────

export interface GetIncidentParams {
  id: string
}

export interface GetServiceParams {
  id: string
}

export interface AcknowledgeIncidentParams {
  id: string
}

export interface ResolveIncidentParams {
  id: string
}

export interface EscalateIncidentParams {
  id: string
  /** Bump to a specific escalation level; omitted → the next level up. */
  escalationLevel?: number
}

export interface AddNoteParams {
  id: string
  note: string
}
