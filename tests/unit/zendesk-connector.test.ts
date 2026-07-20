import { describe, it, expect } from 'vitest'
import { ZendeskConnector } from '../../src/main/zendesk/zendesk-connector'
import { MockZendeskApi, type RawTicket } from '../../src/main/zendesk/zendesk-api'
import type {
  ZendeskWebhookDelivery,
  ZendeskWebhookServer
} from '../../src/main/zendesk/zendesk-webhook-server'

const ticket: RawTicket = {
  id: 35436,
  subject: 'Where is my refund?',
  status: 'open',
  priority: 'high',
  requester_email: 'buyer@x.com',
  requester_id: 771,
  tags: ['refund']
}

/** A fake webhook server whose onEvent sink we can drive directly. */
function fakeWebhook(): {
  server: ZendeskWebhookServer
  deliver: (d: ZendeskWebhookDelivery) => void
} {
  let sink: ((d: ZendeskWebhookDelivery) => void) | null = null
  return {
    server: {
      port: 0,
      onEvent: (h) => {
        sink = h
      },
      close: () => {}
    },
    deliver: (d) => sink?.(d)
  }
}

describe('ZendeskConnector — read dispatch', () => {
  it('getTicket resolves the normalized ticket context', async () => {
    const c = new ZendeskConnector({ api: new MockZendeskApi({ tickets: { '35436': ticket } }) })
    const out = (await c.invokeAction('getTicket', { id: '35436' })) as {
      ticket: { status: string; requesterEmail: string }
    }
    expect(out.ticket).toMatchObject({ id: '35436', status: 'open', requesterEmail: 'buyer@x.com' })
  })

  it('getComments resolves { comments, count }', async () => {
    const c = new ZendeskConnector({
      api: new MockZendeskApi({
        comments: {
          '35436': [
            { id: 1, body: 'hi', public: true },
            { id: 2, body: 'note', public: false }
          ]
        }
      })
    })
    const out = (await c.invokeAction('getComments', { id: '35436' })) as {
      comments: { comment: { public: boolean } }[]
      count: number
    }
    expect(out.count).toBe(2)
    expect(out.comments[0].comment.public).toBe(true)
    expect(out.comments[1].comment.public).toBe(false)
  })

  it('searchTickets resolves { tickets, count } and getUser resolves the user context', async () => {
    const c = new ZendeskConnector({
      api: new MockZendeskApi({
        searchResults: [ticket],
        users: { '771': { id: 771, email: 'buyer@x.com', role: 'end-user' } }
      })
    })
    const search = (await c.invokeAction('searchTickets', { query: 'requester:buyer@x.com' })) as {
      count: number
    }
    expect(search.count).toBe(1)
    const user = (await c.invokeAction('getUser', { id: '771' })) as { user: { email: string } }
    expect(user.user.email).toBe('buyer@x.com')
  })

  it('rejects a missing id, a missing query, and an unknown action legibly', async () => {
    const c = new ZendeskConnector({ api: new MockZendeskApi({}) })
    await expect(c.invokeAction('getTicket', {})).rejects.toThrow(/needs a ticket id/)
    await expect(c.invokeAction('searchTickets', {})).rejects.toThrow(/needs a search 'query'/)
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })
})

describe('ZendeskConnector — the reply/note split is structural (§6.2, §9)', () => {
  it('replyToTicket posts comment.public: TRUE (customer-facing, never-auto-send)', async () => {
    const api = new MockZendeskApi({})
    const c = new ZendeskConnector({ api })
    await c.invokeAction('replyToTicket', { id: '35436', body: 'On its way!' })
    expect(api.calls.updateTicket).toHaveLength(1)
    expect(api.calls.updateTicket[0]).toEqual({
      ticketId: '35436',
      comment: { body: 'On its way!', public: true }
    })
  })

  it('addInternalNote posts comment.public: FALSE (internal only)', async () => {
    const api = new MockZendeskApi({})
    const c = new ZendeskConnector({ api })
    await c.invokeAction('addInternalNote', { id: '35436', body: 'FYI checked the order' })
    expect(api.calls.updateTicket[0]).toEqual({
      ticketId: '35436',
      comment: { body: 'FYI checked the order', public: false }
    })
  })

  it('setStatus and assignTicket carry NO comment — a status/assign can never smuggle a public reply', async () => {
    const api = new MockZendeskApi({})
    const c = new ZendeskConnector({ api })
    await c.invokeAction('setStatus', { id: '35436', status: 'solved' })
    await c.invokeAction('assignTicket', { id: '35436', assigneeId: '42' })
    expect(api.calls.updateTicket[0]).toEqual({ ticketId: '35436', status: 'solved' })
    expect(api.calls.updateTicket[0].comment).toBeUndefined()
    expect(api.calls.updateTicket[1]).toEqual({
      ticketId: '35436',
      assigneeId: '42',
      groupId: undefined
    })
    expect(api.calls.updateTicket[1].comment).toBeUndefined()
  })

  it('setStatus rejects an invalid status; assignTicket needs an assignee or group', async () => {
    const c = new ZendeskConnector({ api: new MockZendeskApi({}) })
    await expect(c.invokeAction('setStatus', { id: '1', status: 'archived' })).rejects.toThrow(
      /needs a status of open \| pending \| solved \| closed/
    )
    await expect(c.invokeAction('assignTicket', { id: '1' })).rejects.toThrow(
      /needs an 'assigneeId' or a 'groupId'/
    )
  })

  it('tagTicket routes to setTags; needs a non-empty tags array', async () => {
    const api = new MockZendeskApi({})
    const c = new ZendeskConnector({ api })
    await c.invokeAction('tagTicket', { id: '35436', tags: ['vip', 'refund'] })
    expect(api.calls.setTags[0]).toEqual({ ticketId: '35436', tags: ['vip', 'refund'] })
    await expect(c.invokeAction('tagTicket', { id: '1', tags: [] })).rejects.toThrow(
      /needs a non-empty 'tags'/
    )
  })

  it('rejects an update business failure verbatim (the pinned convention, §11)', async () => {
    const api = new MockZendeskApi({
      updateError: 'cannot reply to a closed ticket (`details: status`)'
    })
    const c = new ZendeskConnector({ api })
    await expect(c.invokeAction('replyToTicket', { id: '1', body: 'hi' })).rejects.toThrow(
      /cannot reply to a closed ticket/
    )
  })
})

describe('ZendeskConnector — a delivered trigger NEVER auto-writes (§9)', () => {
  it('delivering a ticket.commentAdded event fires ZERO ticket writes', () => {
    const { server, deliver } = fakeWebhook()
    const api = new MockZendeskApi({})
    const c = new ZendeskConnector({ api, webhook: server })
    const seeds: unknown[] = []
    c.subscribe('ticket.commentAdded', (e) => seeds.push(e))
    deliver({
      eventId: 'evt_1',
      type: 'ticket.commentAdded',
      data: {
        ticket: { id: 35436, requester_email: 'buyer@x.com' },
        comment: { id: 5, plain_body: 'still broken', public: true, author_role: 'end-user' }
      }
    })
    // A run was seeded — but NO reply/note/status/assign/tag write was fired.
    expect(seeds).toHaveLength(1)
    expect(api.calls.updateTicket).toHaveLength(0)
    expect(api.calls.setTags).toHaveLength(0)
  })

  it('delivers a verified event as a SeedEvent and dedups a redelivered id', () => {
    const { server, deliver } = fakeWebhook()
    const c = new ZendeskConnector({ api: new MockZendeskApi({}), webhook: server })
    const seeds: unknown[] = []
    const off = c.subscribe('ticket.created', (e) => seeds.push(e))
    const delivery: ZendeskWebhookDelivery = {
      eventId: 'evt_9',
      type: 'ticket.created',
      data: { ticket: { id: 1, subject: 'hi', status: 'new', requester_email: 'a@b.com' } }
    }
    deliver(delivery)
    deliver(delivery) // redelivery — same id, must be dropped
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({
      eventId: 'evt_9',
      payload: { ticketId: '1', type: 'ticket.created' }
    })
    off()
    deliver({ ...delivery, eventId: 'evt_10' })
    expect(seeds).toHaveLength(1) // unsubscribed
  })

  it('ignores an unknown trigger id and an unsupported event type', () => {
    const { server, deliver } = fakeWebhook()
    const c = new ZendeskConnector({ api: new MockZendeskApi({}), webhook: server, log: () => {} })
    const seeds: unknown[] = []
    c.subscribe('ticket.created', (e) => seeds.push(e))
    expect(typeof c.subscribe('bogus.trigger', () => {})).toBe('function')
    deliver({ eventId: 'evt_x', type: 'ticket.deleted', data: { ticket: { id: 1 } } })
    expect(seeds).toHaveLength(0)
  })
})
