import { describe, it, expect } from 'vitest'
import {
  HubSpotApiClient,
  RateLimiter,
  type HubSpotRequest,
  type HubSpotResponse,
  type HubSpotTransport
} from '../../src/main/hubspot/hubspot-api'

const TOKEN = 'pat-na1-secret-token-do-not-leak'

/** Records every request and replies with a queue of canned responses (or a
 *  repeated last response). */
class MockTransport implements HubSpotTransport {
  readonly requests: HubSpotRequest[] = []
  private readonly queue: HubSpotResponse[]
  constructor(responses: HubSpotResponse[]) {
    this.queue = responses
  }
  send(req: HubSpotRequest): Promise<HubSpotResponse> {
    this.requests.push(req)
    const res = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]
    return Promise.resolve(res)
  }
}

const ok = (body: unknown): HubSpotResponse => ({ status: 200, body: JSON.stringify(body) })

function client(
  transport: MockTransport,
  extra: Partial<{ now: () => number }> = {}
): HubSpotApiClient {
  return new HubSpotApiClient({
    transport,
    reveal: () => TOKEN,
    sleep: () => Promise.resolve(),
    now: extra.now
  })
}

describe('HubSpotApiClient — reads', () => {
  it('getContact → GET /crm/v3/objects/contacts/<id> with a properties selector + Bearer auth', async () => {
    const t = new MockTransport([ok({ id: '501', properties: { email: 'a@b.com' } })])
    const raw = await client(t).getContact('501')
    const req = t.requests[0]
    expect(req.method).toBe('GET')
    expect(req.url).toContain('https://api.hubapi.com/crm/v3/objects/contacts/501')
    expect(req.url).toContain('properties=')
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(raw).toMatchObject({ id: '501' })
  })

  it('getDeal / getCompany hit their v3 object paths', async () => {
    const t = new MockTransport([ok({ id: '1', properties: {} })])
    await client(t).getDeal('77')
    await client(t).getCompany('900')
    expect(t.requests[0].url).toContain('/crm/v3/objects/deals/77')
    expect(t.requests[1].url).toContain('/crm/v3/objects/companies/900')
  })

  it('searchContacts → POST /crm/v3/objects/contacts/search with an email filter group', async () => {
    const t = new MockTransport([ok({ results: [{ id: '1', properties: {} }], total: 1 })])
    const out = await client(t).searchContacts({ email: 'a@b.com' })
    const req = t.requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/search')
    const body = JSON.parse(req.body ?? '{}')
    expect(body.filterGroups[0].filters[0]).toMatchObject({
      propertyName: 'email',
      operator: 'EQ',
      value: 'a@b.com'
    })
    expect(out).toEqual({ results: [{ id: '1', properties: {} }], total: 1 })
  })
})

describe('HubSpotApiClient — writes map to HubSpot property names + associations', () => {
  it('createContact → POST contacts with mapped property names', async () => {
    const t = new MockTransport([ok({ id: 'new', properties: {} })])
    await client(t).createContact({ email: 'a@b.com', firstName: 'Ada', jobTitle: 'Eng' })
    const body = JSON.parse(t.requests[0].body ?? '{}')
    expect(body.properties).toMatchObject({ email: 'a@b.com', firstname: 'Ada', jobtitle: 'Eng' })
  })

  it('updateDeal → PATCH deals/<id> with dealstage + stringified amount', async () => {
    const t = new MockTransport([ok({ id: '77', properties: {} })])
    await client(t).updateDeal('77', { stage: 'closedwon', amount: 4200 })
    const req = t.requests[0]
    expect(req.method).toBe('PATCH')
    expect(req.url).toContain('/crm/v3/objects/deals/77')
    expect(JSON.parse(req.body ?? '{}').properties).toMatchObject({
      dealstage: 'closedwon',
      amount: '4200'
    })
  })

  it('createNote → POST notes with hs_note_body + a HUBSPOT_DEFINED contact association', async () => {
    const t = new MockTransport([ok({ id: 'n1', properties: {} })])
    await client(t).createNote({ note: 'Qualified by localflow', contactId: '501' })
    const body = JSON.parse(t.requests[0].body ?? '{}')
    expect(t.requests[0].url).toContain('/crm/v3/objects/notes')
    expect(body.properties.hs_note_body).toBe('Qualified by localflow')
    expect(body.associations[0]).toMatchObject({
      to: { id: '501' },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
    })
  })

  it('createTask → POST tasks with hs_task_subject + deal association', async () => {
    const t = new MockTransport([ok({ id: 't1', properties: {} })])
    await client(t).createTask({ subject: 'Follow up', dealId: '77' })
    const body = JSON.parse(t.requests[0].body ?? '{}')
    expect(t.requests[0].url).toContain('/crm/v3/objects/tasks')
    expect(body.properties.hs_task_subject).toBe('Follow up')
    expect(body.associations[0]).toMatchObject({
      to: { id: '77' },
      types: [{ associationTypeId: 216 }]
    })
  })
})

describe('HubSpotApiClient — errors carry the real HubSpot cause', () => {
  it('maps 401 to a legible re-enter-token message', async () => {
    const t = new MockTransport([{ status: 401, body: JSON.stringify({ message: 'expired' }) }])
    await expect(client(t).getContact('1')).rejects.toThrow(
      /rejected the private-app token \(401\)/
    )
  })

  it('surfaces a 409 conflict verbatim (duplicate contact)', async () => {
    const t = new MockTransport([
      { status: 409, body: JSON.stringify({ message: 'Contact already exists. Existing ID: 42' }) }
    ])
    await expect(client(t).createContact({ email: 'a@b.com' })).rejects.toThrow(
      /Contact already exists. Existing ID: 42/
    )
  })

  it('retries a 429 then succeeds (rate-limit backoff)', async () => {
    const t = new MockTransport([
      { status: 429, body: '', headers: { 'retry-after': '1' } },
      ok({ results: [], total: 0 })
    ])
    const out = await client(t).searchContacts({ email: 'a@b.com' })
    expect(out.total).toBe(0)
    expect(t.requests.length).toBe(2)
  })

  it('never leaks the Bearer token into an error message', async () => {
    const t = new MockTransport([
      { status: 403, body: JSON.stringify({ message: 'missing scope crm.objects.contacts.read' }) }
    ])
    const err = await client(t)
      .getContact('1')
      .catch((e: Error) => e.message)
    expect(err).not.toContain(TOKEN)
  })
})

describe('RateLimiter — the 4/sec Search token bucket (§6)', () => {
  it('lets a burst of 4 through instantly, then spaces the 5th by ~250ms', async () => {
    let clock = 0
    const now = (): number => clock
    const sleep = (ms: number): Promise<void> => {
      clock += ms
      return Promise.resolve()
    }
    const bucket = new RateLimiter({ perSec: 4, now, sleep })
    for (let i = 0; i < 4; i++) await bucket.acquire()
    expect(clock).toBe(0) // the burst cost no wait
    await bucket.acquire() // the 5th must wait for a token to refill
    expect(clock).toBeCloseTo(250, 0)
  })

  it('the client gates searchContacts through the bucket (a 5th rapid search is delayed, not 429ed)', async () => {
    let clock = 0
    const now = (): number => clock
    const t = new MockTransport([ok({ results: [], total: 0 })])
    const api = new HubSpotApiClient({
      transport: t,
      reveal: () => TOKEN,
      now,
      sleep: (ms) => {
        clock += ms
        return Promise.resolve()
      }
    })
    for (let i = 0; i < 5; i++) await api.searchContacts({ email: `x${i}@b.com` })
    expect(t.requests.length).toBe(5) // all 5 delivered (none dropped/429ed)
    expect(clock).toBeGreaterThan(0) // the 5th was throttled by the bucket
  })
})
