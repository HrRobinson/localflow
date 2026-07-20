import { describe, it, expect } from 'vitest'
import {
  normalizeIncident,
  normalizeService,
  webhookToPayload,
  triggersFor,
  isSupportedTrigger
} from '../../src/main/pagerduty/pagerduty-normalize'
import type {
  RawPagerDutyIncident,
  RawPagerDutyService
} from '../../src/main/pagerduty/pagerduty-api'

const rawIncident: RawPagerDutyIncident = {
  id: 'PABC123',
  incident_number: 42,
  title: 'API 500s spiking',
  status: 'TRIGGERED',
  urgency: 'High',
  priority: { summary: 'P1' },
  service: {
    id: 'PSVC01',
    summary: 'Checkout API',
    html_url: 'https://acme.pagerduty.com/services/PSVC01'
  },
  escalation_policy: { id: 'PEP01', summary: 'Payments EP' },
  assignments: [
    { assignee: { id: 'PU1', summary: 'oncall@acme.com' } },
    { assignee: { id: 'PU2', summary: 'backup@acme.com' } }
  ],
  html_url: 'https://acme.pagerduty.com/incidents/PABC123',
  created_at: '2026-07-20T09:00:00Z',
  body: { details: 'See https://acme.sentry.io/org/proj/issues/4509876/ for the stack trace' }
}

describe('normalizeIncident (§6.3)', () => {
  it('produces the pinned shape: string id, numeric number, lowercase enums, assignees[]', () => {
    const { incident } = normalizeIncident(rawIncident)
    expect(incident).toEqual({
      id: 'PABC123',
      number: 42,
      title: 'API 500s spiking',
      status: 'triggered',
      urgency: 'high',
      priority: 'P1',
      serviceId: 'PSVC01',
      serviceName: 'Checkout API',
      escalationPolicyId: 'PEP01',
      assignees: ['oncall@acme.com', 'backup@acme.com'],
      htmlUrl: 'https://acme.pagerduty.com/incidents/PABC123',
      createdAt: '2026-07-20T09:00:00Z',
      sentryIssueId: '4509876',
      serviceUrl: 'https://acme.pagerduty.com/services/PSVC01'
    })
  })

  it('leaves priority + sentryIssueId undefined when absent, and never throws on a sparse node', () => {
    const { incident } = normalizeIncident({ id: 'PX', status: 'weird', urgency: 'nonsense' })
    expect(incident.priority).toBeUndefined()
    expect(incident.sentryIssueId).toBeUndefined()
    expect(incident.assignees).toEqual([])
    // Unknown status/urgency fall back to safe defaults (deterministic conditions).
    expect(incident.status).toBe('triggered')
    expect(incident.urgency).toBe('high')
    expect(() => normalizeIncident({})).not.toThrow()
  })

  it('extracts a bare tagged sentry issue id from the body details', () => {
    const { incident } = normalizeIncident({
      id: 'PX',
      body: { details: 'root cause: sentry-issue: FRONTEND-42' }
    })
    expect(incident.sentryIssueId).toBe('FRONTEND-42')
  })
})

describe('normalizeService (§6.3)', () => {
  it('produces the pinned service shape with a lowercase status enum', () => {
    const raw: RawPagerDutyService = {
      id: 'PSVC01',
      name: 'Checkout API',
      status: 'CRITICAL',
      escalation_policy: { id: 'PEP01', summary: 'Payments EP' },
      html_url: 'https://acme.pagerduty.com/services/PSVC01'
    }
    expect(normalizeService(raw).service).toEqual({
      id: 'PSVC01',
      name: 'Checkout API',
      status: 'critical',
      escalationPolicyId: 'PEP01',
      htmlUrl: 'https://acme.pagerduty.com/services/PSVC01'
    })
  })

  it('defaults an unknown service status to active', () => {
    expect(normalizeService({ id: 'P', status: 'bogus' }).service.status).toBe('active')
  })
})

describe('webhookToPayload + triggersFor (§6.1 — clean 1:1)', () => {
  it('normalizes a supported event to a trigger payload carrying the eventType', () => {
    const payload = webhookToPayload('incident.triggered', rawIncident)
    expect(payload).not.toBeNull()
    expect(payload!.eventType).toBe('incident.triggered')
    expect(payload!.incident.id).toBe('PABC123')
    expect(payload!.incident.urgency).toBe('high')
  })

  it('returns null for an unsupported event type or an id-less data node (no run on garbage)', () => {
    expect(webhookToPayload('incident.annotated', rawIncident)).toBeNull()
    expect(webhookToPayload('incident.triggered', { title: 'no id' })).toBeNull()
    expect(webhookToPayload('incident.triggered', 'not an object')).toBeNull()
  })

  it('triggersFor maps each supported event 1:1 and drops the rest', () => {
    expect(triggersFor('incident.triggered')).toEqual(['incident.triggered'])
    expect(triggersFor('incident.resolved')).toEqual(['incident.resolved'])
    expect(triggersFor('incident.reassigned')).toEqual([])
    expect(isSupportedTrigger('incident.acknowledged')).toBe(true)
    expect(isSupportedTrigger('bogus')).toBe(false)
  })
})
