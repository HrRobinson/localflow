import { describe, it, expect } from 'vitest'
import { HubspotConnector } from '../../src/main/hubspot/hubspot-connector'
import {
  MockHubSpotApi,
  HubSpotApiClient,
  type HubSpotObject,
  type HubSpotRequest,
  type HubSpotResponse,
  type HubSpotTransport
} from '../../src/main/hubspot/hubspot-api'
import type { HubSpotWebhookEvent } from '../../src/main/hubspot/hubspot-normalize'

const contactObj: HubSpotObject = {
  id: '501',
  createdAt: '2026-07-01T00:00:00Z',
  properties: { email: 'ada@example.com', firstname: 'Ada', lastname: 'Lovelace' }
}

const dealObj: HubSpotObject = {
  id: '77',
  properties: { dealname: 'Big', dealstage: 'closedwon', amount: '4200' }
}

const contactEvent = (): HubSpotWebhookEvent => ({
  eventId: 'ev-1',
  triggerId: 'contact.created',
  payload: { objectId: '501', contactId: '501', subscriptionType: 'contact.creation' }
})

describe('HubspotConnector — read dispatch', () => {
  it('getContact → normalized HubSpotContactContext', async () => {
    const api = new MockHubSpotApi({ contacts: { '501': contactObj } })
    const out = await new HubspotConnector({ api }).invokeAction('getContact', { id: '501' })
    expect(api.calls.getContact).toEqual(['501'])
    expect(out).toMatchObject({ contact: { id: '501', name: 'Ada Lovelace' } })
  })

  it('getDeal → normalized HubSpotDealContext with numeric amount', async () => {
    const api = new MockHubSpotApi({ deals: { '77': dealObj } })
    const out = await new HubspotConnector({ api }).invokeAction('getDeal', { id: '77' })
    expect(out).toMatchObject({ deal: { id: '77', stage: 'closedwon', amount: 4200 } })
  })

  it('searchContacts → { contacts, total } normalized, needing an email or query', async () => {
    const api = new MockHubSpotApi({ searchResults: [contactObj], searchTotal: 1 })
    const out = await new HubspotConnector({ api }).invokeAction('searchContacts', {
      email: 'ada@example.com'
    })
    expect(out).toMatchObject({ total: 1, contacts: [{ contact: { id: '501' } }] })
    await expect(new HubspotConnector({ api }).invokeAction('searchContacts', {})).rejects.toThrow(
      /needs an 'email' or a 'query'/
    )
  })

  it('rejects a read with a missing id, legibly, before any api call', async () => {
    const api = new MockHubSpotApi({ contacts: { '501': contactObj } })
    await expect(new HubspotConnector({ api }).invokeAction('getContact', {})).rejects.toThrow(
      /id/i
    )
    expect(api.calls.getContact).toHaveLength(0)
  })
})

describe('HubspotConnector — gated write dispatch', () => {
  it('createTask → api.createTask, resolves { taskId }', async () => {
    const api = new MockHubSpotApi()
    const out = await new HubspotConnector({ api }).invokeAction('createTask', {
      subject: 'Follow up with Ada',
      contactId: '501'
    })
    expect(api.calls.createTask[0]).toMatchObject({
      subject: 'Follow up with Ada',
      contactId: '501'
    })
    expect(out).toEqual({ taskId: 'new-task' })
  })

  it('updateDeal → api.updateDeal, resolves normalized deal', async () => {
    const api = new MockHubSpotApi()
    await new HubspotConnector({ api }).invokeAction('updateDeal', { id: '77', stage: 'closedwon' })
    expect(api.calls.updateDeal[0]).toMatchObject({ id: '77', fields: { stage: 'closedwon' } })
  })

  it('logActivity → api.createNote, resolves { noteId }', async () => {
    const api = new MockHubSpotApi()
    const out = await new HubspotConnector({ api }).invokeAction('logActivity', {
      note: 'Qualified',
      dealId: '77'
    })
    expect(api.calls.createNote[0]).toMatchObject({ note: 'Qualified', dealId: '77' })
    expect(out).toEqual({ noteId: 'new-note' })
  })

  it('a write that HubSpot rejects REJECTS with the verbatim cause (pinned convention)', async () => {
    const api = new MockHubSpotApi({
      createContactError: 'Contact already exists. Existing ID: 42'
    })
    await expect(
      new HubspotConnector({ api }).invokeAction('createContact', { email: 'a@b.com' })
    ).rejects.toThrow(/Contact already exists. Existing ID: 42/)
  })

  it('rejects an unknown action id legibly', async () => {
    const api = new MockHubSpotApi()
    await expect(
      new HubspotConnector({ api }).invokeAction('deleteEverything', {})
    ).rejects.toThrow(/HubSpot has no action 'deleteEverything'/)
  })
})

describe('HubspotConnector — subscribe fan-out + authority', () => {
  it('a webhook batch fans out to the matching trigger handler as a SeedEvent', () => {
    const connector = new HubspotConnector({ api: new MockHubSpotApi() })
    const seen: unknown[] = []
    connector.subscribe('contact.created', (e) => seen.push(e))
    connector.deliver([contactEvent()])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ eventId: 'ev-1', payload: { contactId: '501' } })
  })

  it('does not deliver to a handler subscribed to a different trigger', () => {
    const connector = new HubspotConnector({ api: new MockHubSpotApi() })
    const seen: unknown[] = []
    connector.subscribe('deal.stageChanged', (e) => seen.push(e))
    connector.deliver([contactEvent()])
    expect(seen).toHaveLength(0)
  })

  it('unsubscribe stops further delivery; an unknown trigger id is ignored', () => {
    const connector = new HubspotConnector({ api: new MockHubSpotApi() })
    const seen: unknown[] = []
    const off = connector.subscribe('contact.created', (e) => seen.push(e))
    off()
    connector.deliver([contactEvent()])
    expect(seen).toHaveLength(0)
    expect(connector.subscribe('bogus.trigger', () => {})()).toBeUndefined()
  })

  it('★ AUTHORITY: a delivered trigger NEVER fires an api write on its own', () => {
    const api = new MockHubSpotApi()
    const connector = new HubspotConnector({ api })
    connector.subscribe('contact.created', () => {})
    connector.deliver([contactEvent()])
    expect(api.calls.createTask).toHaveLength(0)
    expect(api.calls.createNote).toHaveLength(0)
    expect(api.calls.updateDeal).toHaveLength(0)
    expect(api.calls.createContact).toHaveLength(0)
  })
})

/** ★ The load-bearing secret invariant (§4, §10): the private-app token never
 *  appears in a returned value, a log line, or an error surfaced onward. */
describe('HubspotConnector — no secret leak', () => {
  it('never surfaces the Bearer token through outputs, logs, or errors', async () => {
    const TOKEN = 'pat-na1-super-secret-do-not-leak'
    const logs: string[] = []

    // A transport carrying the real token in its header (as production would),
    // then a failure path — proves the token flows in but never surfaces out.
    class TokenTransport implements HubSpotTransport {
      constructor(private readonly res: HubSpotResponse) {}
      send(req: HubSpotRequest): Promise<HubSpotResponse> {
        expect(req.headers.Authorization).toContain(TOKEN)
        return Promise.resolve(this.res)
      }
    }

    const okApi = new HubSpotApiClient({
      transport: new TokenTransport({
        status: 200,
        body: JSON.stringify(contactObj)
      }),
      reveal: () => TOKEN,
      sleep: () => Promise.resolve()
    })
    const connector = new HubspotConnector({ api: okApi, log: (m) => logs.push(m) })

    const read = await connector.invokeAction('getContact', { id: '501' })
    connector.subscribe('contact.created', () => {
      throw new Error('handler boom') // force a route+reason log
    })
    connector.deliver([contactEvent()])

    let errMsg = ''
    const badApi = new HubSpotApiClient({
      transport: new TokenTransport({ status: 401, body: '{}' }),
      reveal: () => TOKEN,
      sleep: () => Promise.resolve()
    })
    try {
      await new HubspotConnector({ api: badApi }).invokeAction('getContact', { id: '1' })
    } catch (e) {
      errMsg = (e as Error).message
    }

    const surfaced = [JSON.stringify(read), logs.join('\n'), errMsg].join('\n')
    expect(surfaced).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toMatch(/Authorization|Bearer /)
  })
})
