import { describe, it, expect } from 'vitest'
import { IntercomConnector } from '../../src/main/intercom/intercom-connector'
import { MockIntercomApi, type RawConversation } from '../../src/main/intercom/intercom-api'
import type {
  IntercomWebhookDelivery,
  IntercomWebhookServer
} from '../../src/main/intercom/intercom-webhook-server'

const conversation: RawConversation = {
  id: '1001',
  state: 'open',
  read: false,
  priority: 'not_priority',
  contacts: { contacts: [{ type: 'contact', id: 'c_9', email: 'Buyer@X.com' }] },
  conversation_parts: {
    conversation_parts: [{ body: '<p>where is my order</p>', author: { type: 'user' } }]
  }
}

/** A fake webhook server whose onEvent sink we can drive directly. */
function fakeWebhook(): {
  server: IntercomWebhookServer
  deliver: (d: IntercomWebhookDelivery) => void
} {
  let sink: ((d: IntercomWebhookDelivery) => void) | null = null
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

describe('IntercomConnector — read dispatch', () => {
  it('getConversation resolves the normalized conversation context', async () => {
    const c = new IntercomConnector({
      api: new MockIntercomApi({ conversations: { '1001': conversation } })
    })
    const out = (await c.invokeAction('getConversation', { id: '1001' })) as {
      conversation: { contactEmail: string; lastMessageBody: string }
    }
    expect(out.conversation).toMatchObject({
      id: '1001',
      contactId: 'c_9',
      contactEmail: 'buyer@x.com',
      lastMessageBody: 'where is my order'
    })
  })

  it('getContact resolves the normalized contact context', async () => {
    const c = new IntercomConnector({
      api: new MockIntercomApi({ contacts: { c_9: { id: 'c_9', email: 'A@B.io', role: 'user' } } })
    })
    const out = (await c.invokeAction('getContact', { id: 'c_9' })) as {
      contact: { email: string }
    }
    expect(out.contact.email).toBe('a@b.io')
  })

  it('rejects a missing id and an unknown action legibly', async () => {
    const c = new IntercomConnector({ api: new MockIntercomApi({}) })
    await expect(c.invokeAction('getConversation', {})).rejects.toThrow(/needs an id/)
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })
})

describe('IntercomConnector — gated writes', () => {
  it('replyToConversation forwards the approved body and resolves { conversationId, partId }', async () => {
    const api = new MockIntercomApi({})
    const c = new IntercomConnector({ api })
    const out = await c.invokeAction('replyToConversation', {
      id: '1001',
      body: 'Your order ships today.',
      adminId: 'admin_1'
    })
    expect(out).toEqual({ conversationId: '1001', partId: 'part_1' })
    expect(api.calls.reply).toEqual([
      { conversationId: '1001', body: 'Your order ships today.', adminId: 'admin_1' }
    ])
  })

  it('rejects a reply with NO body — a customer reply never sends blank', async () => {
    const api = new MockIntercomApi({})
    const c = new IntercomConnector({ api })
    await expect(c.invokeAction('replyToConversation', { id: '1001' })).rejects.toThrow(
      /needs a 'body'.*never sends without one/s
    )
    expect(api.calls.reply).toHaveLength(0) // never reached the client
  })

  it('rejects a reply business failure verbatim (the pinned convention)', async () => {
    const api = new MockIntercomApi({ replyError: 'the conversation is closed' })
    const c = new IntercomConnector({ api })
    await expect(c.invokeAction('replyToConversation', { id: '1001', body: 'hi' })).rejects.toThrow(
      /the conversation is closed/
    )
  })

  it('closeConversation and tagConversation forward their inputs; tag needs a tagId', async () => {
    const api = new MockIntercomApi({})
    const c = new IntercomConnector({ api })
    await c.invokeAction('closeConversation', { id: '1001', adminId: 'admin_1' })
    await c.invokeAction('tagConversation', { id: '1001', tagId: 'tag_7', adminId: 'admin_1' })
    expect(api.calls.close[0]).toMatchObject({ conversationId: '1001', adminId: 'admin_1' })
    expect(api.calls.tag[0]).toMatchObject({ conversationId: '1001', tagId: 'tag_7' })
    await expect(c.invokeAction('tagConversation', { id: '1001' })).rejects.toThrow(
      /needs a 'tagId'/
    )
  })
})

describe('IntercomConnector — a delivered trigger NEVER auto-sends a reply (§9)', () => {
  it('delivering a conversation.user.replied notification makes ZERO Intercom writes', () => {
    const { server, deliver } = fakeWebhook()
    const api = new MockIntercomApi({})
    const c = new IntercomConnector({ api, webhook: server })
    const seeds: unknown[] = []
    c.subscribe('conversation.replied', (e) => seeds.push(e))
    deliver({
      notificationId: 'notif_1',
      topic: 'conversation.user.replied',
      item: { id: '1001', contacts: { contacts: [{ id: 'c_9', email: 'b@x.com' }] } }
    })
    // A run was seeded — but NO reply/close/tag write was fired.
    expect(seeds).toHaveLength(1)
    expect(api.calls.reply).toHaveLength(0)
    expect(api.calls.close).toHaveLength(0)
    expect(api.calls.tag).toHaveLength(0)
  })

  it('delivers a verified notification as a SeedEvent and dedups a replayed notification id', () => {
    const { server, deliver } = fakeWebhook()
    const c = new IntercomConnector({ api: new MockIntercomApi({}), webhook: server })
    const seeds: unknown[] = []
    const off = c.subscribe('conversation.replied', (e) => seeds.push(e))
    const delivery: IntercomWebhookDelivery = {
      notificationId: 'notif_9',
      topic: 'conversation.user.replied',
      item: {
        id: '1001',
        contacts: { contacts: [{ id: 'c_9', email: 'b@x.com' }] },
        conversation_parts: {
          conversation_parts: [{ body: '<p>hi</p>', author: { type: 'user' } }]
        }
      }
    }
    deliver(delivery)
    deliver(delivery) // replay — same notification id, must be dropped
    expect(seeds).toEqual([
      {
        eventId: 'notif_9',
        payload: {
          conversationId: '1001',
          contactId: 'c_9',
          contactEmail: 'b@x.com',
          lastMessageBody: 'hi',
          notificationId: 'notif_9',
          topic: 'conversation.user.replied'
        }
      }
    ])
    off()
    deliver({ ...delivery, notificationId: 'notif_10' })
    expect(seeds).toHaveLength(1) // unsubscribed
  })

  it('ignores an unknown trigger id and an unsupported topic', () => {
    const { server, deliver } = fakeWebhook()
    const c = new IntercomConnector({
      api: new MockIntercomApi({}),
      webhook: server,
      log: () => {}
    })
    const seeds: unknown[] = []
    c.subscribe('conversation.replied', (e) => seeds.push(e))
    expect(typeof c.subscribe('bogus.trigger', () => {})).toBe('function')
    deliver({
      notificationId: 'notif_x',
      topic: 'conversation.admin.replied',
      item: { id: '1001' }
    })
    expect(seeds).toHaveLength(0)
  })
})
