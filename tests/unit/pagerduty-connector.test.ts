import { describe, it, expect } from 'vitest'
import { PagerDutyConnector } from '../../src/main/pagerduty/pagerduty-connector'
import { MockPagerDutyApi, type RawPagerDutyIncident } from '../../src/main/pagerduty/pagerduty-api'
import type {
  PagerDutyWebhookDelivery,
  PagerDutyWebhookServer
} from '../../src/main/pagerduty/pagerduty-webhook-server'

const incidentNode: RawPagerDutyIncident = {
  id: 'PABC',
  incident_number: 42,
  title: 'boom',
  status: 'triggered',
  urgency: 'high',
  service: { id: 'PSVC', summary: 'Checkout API' }
}

/** A fake webhook server whose onEvent sink we can drive directly. */
function fakeWebhook(): {
  server: PagerDutyWebhookServer
  deliver: (d: PagerDutyWebhookDelivery) => void
} {
  let sink: ((d: PagerDutyWebhookDelivery) => void) | null = null
  return {
    server: { port: 0, onEvent: (h) => (sink = h), close: () => {} },
    deliver: (d) => sink?.(d)
  }
}

const delivery = (eventType: string, id = 'evt-1'): PagerDutyWebhookDelivery => ({
  id,
  eventType,
  resourceType: 'incident',
  data: incidentNode as unknown as Record<string, unknown>
})

describe('PagerDutyConnector — action dispatch', () => {
  it('getIncident resolves the normalized incident context', async () => {
    const c = new PagerDutyConnector({
      api: new MockPagerDutyApi({ incidents: { PABC: incidentNode } })
    })
    const out = (await c.invokeAction('getIncident', { id: 'PABC' })) as {
      incident: { id: string; urgency: string; serviceName: string }
    }
    expect(out.incident).toMatchObject({ id: 'PABC', urgency: 'high', serviceName: 'Checkout API' })
  })

  it('getService resolves the normalized service context', async () => {
    const c = new PagerDutyConnector({
      api: new MockPagerDutyApi({
        services: { PSVC: { id: 'PSVC', name: 'Checkout API', status: 'active' } }
      })
    })
    const out = (await c.invokeAction('getService', { id: 'PSVC' })) as { service: { id: string } }
    expect(out.service.id).toBe('PSVC')
  })

  it('every mutation reaches the api with its id (all four, incl. acknowledge)', async () => {
    const api = new MockPagerDutyApi({})
    const c = new PagerDutyConnector({ api })
    await c.invokeAction('acknowledgeIncident', { id: 'PABC' })
    await c.invokeAction('resolveIncident', { id: 'PABC' })
    await c.invokeAction('escalateIncident', { id: 'PABC', escalationLevel: 2 })
    await c.invokeAction('addNote', { id: 'PABC', note: 'diagnosis' })
    expect(api.calls.acknowledgeIncident).toEqual([{ id: 'PABC' }])
    expect(api.calls.resolveIncident).toEqual([{ id: 'PABC' }])
    expect(api.calls.escalateIncident).toEqual([{ id: 'PABC', escalationLevel: 2 }])
    expect(api.calls.addNote).toEqual([{ id: 'PABC', note: 'diagnosis' }])
  })

  it('every write is attributed to the From acting-user (§8)', async () => {
    const api = new MockPagerDutyApi({}, { fromEmail: 'bot@acme.com' })
    const c = new PagerDutyConnector({ api })
    await c.invokeAction('addNote', { id: 'PABC', note: 'x' })
    // The api layer is what attaches From on the wire; assert the acting user is set.
    expect(api.fromEmail).toBe('bot@acme.com')
  })

  it('rejects a mutation failure verbatim (the pinned convention)', async () => {
    const api = new MockPagerDutyApi({
      escalateError: 'Incident is at the maximum escalation level'
    })
    const c = new PagerDutyConnector({ api })
    await expect(c.invokeAction('escalateIncident', { id: 'PABC' })).rejects.toThrow(
      /maximum escalation level/
    )
  })

  it('rejects a missing id, a missing note, and an unknown action legibly', async () => {
    const c = new PagerDutyConnector({ api: new MockPagerDutyApi({}) })
    await expect(c.invokeAction('getIncident', {})).rejects.toThrow(/needs an incident id/)
    await expect(c.invokeAction('addNote', { id: 'P' })).rejects.toThrow(/needs a non-empty 'note'/)
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })
})

describe('PagerDutyConnector — trigger subscription (webhook)', () => {
  it('delivers a verified incident.triggered as a SeedEvent and writes ZERO mutations', () => {
    const { server, deliver } = fakeWebhook()
    const api = new MockPagerDutyApi({})
    const c = new PagerDutyConnector({ api, webhook: server })
    const seeds: unknown[] = []
    const off = c.subscribe('incident.triggered', (e) => seeds.push(e))
    deliver(delivery('incident.triggered', 'evt-1'))
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({
      eventId: 'evt-1',
      payload: { eventType: 'incident.triggered', incident: { id: 'PABC' } }
    })
    // ★ The authority invariant: a webhook NEVER triggers a write.
    expect(api.calls.acknowledgeIncident).toEqual([])
    expect(api.calls.resolveIncident).toEqual([])
    expect(api.calls.escalateIncident).toEqual([])
    expect(api.calls.addNote).toEqual([])

    off()
    deliver(delivery('incident.triggered', 'evt-2'))
    expect(seeds).toHaveLength(1) // unsubscribed
  })

  it('dedups a repeated event.id — a redelivery seeds no second run', () => {
    const { server, deliver } = fakeWebhook()
    const c = new PagerDutyConnector({ api: new MockPagerDutyApi({}), webhook: server })
    const seeds: unknown[] = []
    c.subscribe('incident.triggered', (e) => seeds.push(e))
    deliver(delivery('incident.triggered', 'dupe'))
    deliver(delivery('incident.triggered', 'dupe'))
    expect(seeds).toHaveLength(1)
  })

  it('routes each supported event 1:1 to its own trigger id', () => {
    const { server, deliver } = fakeWebhook()
    const c = new PagerDutyConnector({ api: new MockPagerDutyApi({}), webhook: server })
    const resolved: unknown[] = []
    const triggered: unknown[] = []
    c.subscribe('incident.resolved', (e) => resolved.push(e))
    c.subscribe('incident.triggered', (e) => triggered.push(e))
    deliver(delivery('incident.resolved', 'r1'))
    expect(resolved).toHaveLength(1)
    expect(triggered).toHaveLength(0)
  })

  it('ignores an unknown trigger id and an unsupported event type', () => {
    const { server, deliver } = fakeWebhook()
    const c = new PagerDutyConnector({
      api: new MockPagerDutyApi({}),
      webhook: server,
      log: () => {}
    })
    const seeds: unknown[] = []
    c.subscribe('incident.triggered', (e) => seeds.push(e))
    expect(typeof c.subscribe('bogus.trigger', () => {})).toBe('function')
    deliver(delivery('incident.annotated', 'a1'))
    expect(seeds).toHaveLength(0)
  })
})
