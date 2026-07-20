import { describe, it, expect } from 'vitest'
import {
  PagerDutyHttpApi,
  type PagerDutyRequest,
  type PagerDutyResponse,
  type PagerDutyTransport
} from '../../src/main/pagerduty/pagerduty-api'

/** A recording transport that returns a canned response per call. */
function recorder(responder: (req: PagerDutyRequest) => PagerDutyResponse): {
  transport: PagerDutyTransport
  calls: PagerDutyRequest[]
} {
  const calls: PagerDutyRequest[] = []
  return {
    calls,
    transport: {
      send: (req) => {
        calls.push(req)
        return Promise.resolve(responder(req))
      }
    }
  }
}

const ok = (body: unknown): PagerDutyResponse => ({ status: 200, body: JSON.stringify(body) })

function api(deps: {
  responder: (req: PagerDutyRequest) => PagerDutyResponse
  region?: 'us' | 'eu'
}): { api: PagerDutyHttpApi; calls: PagerDutyRequest[] } {
  const { transport, calls } = recorder(deps.responder)
  return {
    calls,
    api: new PagerDutyHttpApi({
      transport,
      region: deps.region,
      reveal: () => 'pd_api_key',
      fromEmail: 'bot@acme.com',
      sleep: () => Promise.resolve()
    })
  }
}

describe('PagerDutyHttpApi — endpoint + region base URL (§4.5)', () => {
  it('getIncident hits the us incidents endpoint and unwraps { incident }', async () => {
    const { api: a, calls } = api({ responder: () => ok({ incident: { id: 'PABC' } }) })
    const inc = await a.getIncident('PABC')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://api.pagerduty.com/incidents/PABC')
    expect(calls[0].headers.Authorization).toBe('Token token=pd_api_key')
    expect(inc.id).toBe('PABC')
  })

  it('uses the eu base URL when region is eu', async () => {
    const { api: a, calls } = api({
      responder: () => ok({ service: { id: 'PSVC' } }),
      region: 'eu'
    })
    await a.getService('PSVC')
    expect(calls[0].url).toBe('https://api.eu.pagerduty.com/services/PSVC')
  })

  it('reads never send a From header; writes ALWAYS send From + Content-Type (§8)', async () => {
    const { api: a, calls } = api({ responder: () => ok({}) })
    await a.getIncident('PABC')
    expect(calls[0].headers.From).toBeUndefined()

    await a.acknowledgeIncident({ id: 'PABC' })
    await a.resolveIncident({ id: 'PABC' })
    await a.escalateIncident({ id: 'PABC' })
    await a.addNote({ id: 'PABC', note: 'diagnosis' })
    // every write carries the acting-user header
    for (const c of calls.slice(1)) {
      expect(c.headers.From).toBe('bot@acme.com')
      expect(c.headers['Content-Type']).toBe('application/json')
    }
  })

  it('acknowledge / resolve PUT the incident_reference status', async () => {
    const { api: a, calls } = api({ responder: () => ok({}) })
    await a.acknowledgeIncident({ id: 'PABC' })
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe('https://api.pagerduty.com/incidents/PABC')
    expect(JSON.parse(calls[0].body!)).toEqual({
      incident: { type: 'incident_reference', status: 'acknowledged' }
    })
    await a.resolveIncident({ id: 'PABC' })
    expect(JSON.parse(calls[1].body!)).toEqual({
      incident: { type: 'incident_reference', status: 'resolved' }
    })
  })

  it('escalate sends escalation_level only when provided; addNote posts { note: { content } }', async () => {
    const { api: a, calls } = api({ responder: () => ok({}) })
    await a.escalateIncident({ id: 'PABC', escalationLevel: 2 })
    expect(JSON.parse(calls[0].body!)).toEqual({
      incident: { type: 'incident_reference', escalation_level: 2 }
    })
    await a.escalateIncident({ id: 'PABC' })
    expect(JSON.parse(calls[1].body!)).toEqual({ incident: { type: 'incident_reference' } })

    await a.addNote({ id: 'PABC', note: 'fix PR opened' })
    expect(calls[2].method).toBe('POST')
    expect(calls[2].url).toBe('https://api.pagerduty.com/incidents/PABC/notes')
    expect(JSON.parse(calls[2].body!)).toEqual({ note: { content: 'fix PR opened' } })
  })
})

describe('PagerDutyHttpApi — error mapping (§11)', () => {
  it('maps 401 / 403 / 404 to actionable messages, never leaking the key', async () => {
    const a401 = api({ responder: () => ({ status: 401, body: '' }) }).api
    await expect(a401.getIncident('PABC')).rejects.toThrow(/rejected the API key \(401\)/)

    const a403 = api({
      responder: () => ({ status: 403, body: JSON.stringify({ error: { message: 'no ability' } }) })
    }).api
    await expect(a403.resolveIncident({ id: 'PABC' })).rejects.toThrow(/lacks the ability/)

    const a404 = api({ responder: () => ({ status: 404, body: '' }) }).api
    await expect(a404.getIncident('nope')).rejects.toThrow(/no such resource \(404/)
  })

  it('forwards a 400 escalate-at-top-level detail verbatim (no silent no-op)', async () => {
    const a = api({
      responder: () => ({
        status: 400,
        body: JSON.stringify({ error: { message: 'Incident is at the maximum escalation level' } })
      })
    }).api
    await expect(a.escalateIncident({ id: 'PABC' })).rejects.toThrow(/maximum escalation level/)
  })

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    let n = 0
    const { api: a, calls } = api({
      responder: () =>
        n++ === 0 ? { status: 429, body: '', retryAfterSec: 0 } : ok({ incident: {} })
    })
    await a.getIncident('PABC')
    expect(calls).toHaveLength(2)
  })

  it('never renders the api key in any error', async () => {
    const a = api({ responder: () => ({ status: 500, body: 'pd_api_key leaked?' }) }).api
    await expect(a.getIncident('PABC')).rejects.toThrow(/rejected the request \(500\)/)
    // the reveal value must never surface in a thrown message
    await a.getIncident('PABC').catch((e: Error) => {
      expect(e.message).not.toContain('pd_api_key')
    })
  })
})
