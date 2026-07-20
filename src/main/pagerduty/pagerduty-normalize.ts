import type { RawPagerDutyIncident, RawPagerDutyService } from './pagerduty-api'
import type {
  PagerDutyIncidentContext,
  PagerDutyIncidentStatus,
  PagerDutyServiceContext,
  PagerDutyServiceStatus,
  PagerDutyTriggerId,
  PagerDutyTriggerPayload,
  PagerDutyUrgency
} from '../../shared/pagerduty'
import { PAGERDUTY_TRIGGER_IDS } from '../../shared/pagerduty'

/**
 * PURE normalization (spec §6.3) — the correctness boundary the conditions track
 * AND the sibling Sentry/GitHub compose depend on. This is where PagerDuty's raw
 * incident/service/webhook shapes become the PINNED context shape ONCE: string
 * ids, a numeric `incident.number`, lowercase `status`/`urgency` enums, and
 * `assignees` as a flat `string[]` — so `incident.urgency eq 'high'`,
 * `incident.assignees contains 'oncall@acme.com'` all work. Never throws — a
 * sparse/garbage node normalizes to safe defaults so a malformed read never
 * crashes a run (mirrors `sentry-normalize.ts` purity).
 */

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const INCIDENT_STATUSES: readonly string[] = ['triggered', 'acknowledged', 'resolved']
function incidentStatus(v: unknown): PagerDutyIncidentStatus {
  const s = str(v).toLowerCase()
  return (INCIDENT_STATUSES.includes(s) ? s : 'triggered') as PagerDutyIncidentStatus
}

function urgency(v: unknown): PagerDutyUrgency {
  return str(v).toLowerCase() === 'low' ? 'low' : 'high'
}

const SERVICE_STATUSES: readonly string[] = [
  'active',
  'warning',
  'critical',
  'maintenance',
  'disabled'
]
function serviceStatus(v: unknown): PagerDutyServiceStatus {
  const s = str(v).toLowerCase()
  return (SERVICE_STATUSES.includes(s) ? s : 'active') as PagerDutyServiceStatus
}

/** A ref's display id — PagerDuty summaries carry the human-readable name. */
function refSummary(ref: unknown): string {
  return isObj(ref) ? str(ref.summary) : ''
}
function refId(ref: unknown): string {
  return isObj(ref) ? str(ref.id) : ''
}

/** Best-effort: a linked Sentry issue id hiding in the incident body `details`
 *  (§7). Matches a Sentry issues URL or a bare numeric group id token. Returns
 *  undefined when nothing recognizable is present. */
function sentryIssueIdFrom(body: unknown): string | undefined {
  if (!isObj(body)) return undefined
  const details = str(body.details)
  if (details.length === 0) return undefined
  const url = /sentry\.io\/[^\s]*issues\/(\d+)/i.exec(details)
  if (url) return url[1]
  const tagged = /sentry[- _]?issue[:\s#]+([\w-]+)/i.exec(details)
  if (tagged) return tagged[1]
  return undefined
}

// ── Incident ──────────────────────────────────────────────────────────────────

/** A raw incident node (REST `GET /incidents/{id}` or webhook `event.data`) → the
 *  pinned incident context. */
export function normalizeIncident(node: RawPagerDutyIncident): PagerDutyIncidentContext {
  const assignments = Array.isArray(node.assignments) ? node.assignments : []
  const assignees = assignments.map((a) => refSummary(a?.assignee)).filter((s) => s.length > 0)

  const priority = refSummary(node.priority)
  const serviceUrl = isObj(node.service) ? str(node.service.html_url) : ''

  const incident: PagerDutyIncidentContext['incident'] = {
    id: str(node.id),
    number: num(node.incident_number),
    title: str(node.title),
    status: incidentStatus(node.status),
    urgency: urgency(node.urgency),
    priority: priority.length > 0 ? priority : undefined,
    serviceId: refId(node.service),
    serviceName: refSummary(node.service),
    escalationPolicyId: refId(node.escalation_policy),
    assignees,
    htmlUrl: str(node.html_url),
    createdAt: str(node.created_at),
    sentryIssueId: sentryIssueIdFrom(node.body),
    serviceUrl: serviceUrl.length > 0 ? serviceUrl : undefined
  }
  return { incident }
}

// ── Service ─────────────────────────────────────────────────────────────────

/** A raw service node (REST `GET /services/{id}`) → the pinned service context. */
export function normalizeService(node: RawPagerDutyService): PagerDutyServiceContext {
  return {
    service: {
      id: str(node.id),
      name: str(node.name),
      status: serviceStatus(node.status),
      escalationPolicyId: refId(node.escalation_policy),
      htmlUrl: str(node.html_url)
    }
  }
}

// ── Webhook envelope → trigger payload (§6.1) ────────────────────────────────

export function isSupportedTrigger(eventType: string): eventType is PagerDutyTriggerId {
  return (PAGERDUTY_TRIGGER_IDS as readonly string[]).includes(eventType)
}

/**
 * Normalize a verified v3 webhook envelope (`eventType` + raw `event.data`
 * incident node) into a `PagerDutyTriggerPayload`, or `null` when the event type
 * is unsupported or the data carries no usable incident id (so no run is ever
 * seeded on garbage — §4.4). All four triggers are a CLEAN 1:1 map to native v3
 * event types; there is no derived filter.
 */
export function webhookToPayload(eventType: string, data: unknown): PagerDutyTriggerPayload | null {
  if (!isSupportedTrigger(eventType)) return null
  if (!isObj(data)) return null
  const { incident } = normalizeIncident(data as RawPagerDutyIncident)
  if (incident.id.length === 0) return null
  return { eventType, incident }
}

/** Which pinned trigger id(s) a verified v3 event type fires — a 1:1 map. */
export function triggersFor(eventType: string): PagerDutyTriggerId[] {
  return isSupportedTrigger(eventType) ? [eventType] : []
}
