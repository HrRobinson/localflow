import { describe, it, expect } from 'vitest'
import {
  htmlToPlaintext,
  normalizeContact,
  normalizeConversation,
  notificationToPayload,
  triggersForTopic
} from '../../src/main/intercom/intercom-normalize'
import type { RawContact, RawConversation } from '../../src/main/intercom/intercom-api'

const fullConversation: RawConversation = {
  id: '1001',
  state: 'open',
  read: false,
  priority: 'priority',
  title: 'Where is my order?',
  contacts: { contacts: [{ type: 'contact', id: 'c_9', email: 'Buyer@Example.com' }] },
  conversation_parts: {
    conversation_parts: [
      { body: '<p>First</p>', author: { type: 'user' } },
      { body: '<p>Still waiting &amp; worried</p>', author: { type: 'user' } }
    ]
  },
  tags: { tags: [{ name: 'VIP' }, { name: 'Refund' }] },
  created_at: 1_700_000_000,
  updated_at: 1_700_000_500
}

describe('normalizeConversation — the correctness boundary (§6.3)', () => {
  it('lowercases the join-key email, lowercases enums + tags, strips HTML, ISO-dates', () => {
    const ctx = normalizeConversation(fullConversation)
    expect(ctx.conversation).toEqual({
      id: '1001',
      state: 'open',
      read: false,
      priority: 'priority',
      title: 'Where is my order?',
      contactId: 'c_9',
      contactEmail: 'buyer@example.com', // LOWERCASED join key
      lastMessageBody: 'Still waiting & worried', // latest part, HTML stripped + entity decoded
      lastMessageAuthorType: 'user',
      tags: ['vip', 'refund'], // lowercase tag names
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:21:40.000Z'
    })
  })

  it('derives lastMessageAuthorType (admin/bot stay; lead/contact collapse to user)', () => {
    const admin = normalizeConversation({
      ...fullConversation,
      conversation_parts: { conversation_parts: [{ body: 'hi', author: { type: 'admin' } }] }
    })
    expect(admin.conversation.lastMessageAuthorType).toBe('admin')
    const lead = normalizeConversation({
      ...fullConversation,
      conversation_parts: { conversation_parts: [{ body: 'hi', author: { type: 'lead' } }] }
    })
    expect(lead.conversation.lastMessageAuthorType).toBe('user')
  })

  it('falls back to the source message when there are no parts, and to the source author for the contact', () => {
    const ctx = normalizeConversation({
      id: '1002',
      source: { body: '<div>opened</div>', author: { type: 'user', id: 'c_1', email: 'A@B.io' } }
    })
    expect(ctx.conversation.lastMessageBody).toBe('opened')
    expect(ctx.conversation.contactId).toBe('c_1')
    expect(ctx.conversation.contactEmail).toBe('a@b.io')
  })

  it('never throws on a sparse/garbage object — safe defaults', () => {
    const ctx = normalizeConversation({})
    expect(ctx.conversation).toMatchObject({
      id: '',
      state: 'open',
      priority: 'not_priority',
      contactId: '',
      contactEmail: '',
      lastMessageBody: '',
      lastMessageAuthorType: 'user',
      tags: [],
      createdAt: ''
    })
  })
})

describe('normalizeContact', () => {
  it('lowercases the email and enforces the role enum', () => {
    const raw: RawContact = {
      id: 'c_9',
      email: 'Person@Example.com',
      name: 'Ada',
      role: 'lead',
      created_at: 1_700_000_000,
      last_seen_at: 1_700_000_500
    }
    expect(normalizeContact(raw).contact).toEqual({
      id: 'c_9',
      email: 'person@example.com',
      name: 'Ada',
      role: 'lead',
      createdAt: '2023-11-14T22:13:20.000Z',
      lastSeenAt: '2023-11-14T22:21:40.000Z'
    })
  })

  it('defaults role to user and empties an absent last_seen_at', () => {
    const ctx = normalizeContact({ id: 'c_1', email: 'x@y.io' })
    expect(ctx.contact.role).toBe('user')
    expect(ctx.contact.lastSeenAt).toBe('')
  })
})

describe('htmlToPlaintext', () => {
  it('strips tags, decodes entities, and collapses block breaks', () => {
    expect(htmlToPlaintext('<p>hello</p><p>world</p>')).toBe('hello\nworld')
    expect(htmlToPlaintext('a&nbsp;&amp;&nbsp;b')).toBe('a & b')
    expect(htmlToPlaintext(null)).toBe('')
  })
})

describe('notificationToPayload + triggersForTopic (§6.1)', () => {
  it('maps a conversation.user.replied notification to its seed payload', () => {
    const payload = notificationToPayload('conversation.user.replied', fullConversation, 'notif_1')
    expect(payload).toEqual({
      conversationId: '1001',
      contactId: 'c_9',
      contactEmail: 'buyer@example.com',
      lastMessageBody: 'Still waiting & worried',
      notificationId: 'notif_1',
      topic: 'conversation.user.replied'
    })
    expect(triggersForTopic('conversation.user.replied')).toEqual(['conversation.replied'])
    expect(triggersForTopic('conversation.user.created')).toEqual(['conversation.created'])
  })

  it('returns null for an unsupported topic or an unusable item (no run seeds)', () => {
    expect(notificationToPayload('conversation.admin.replied', fullConversation, 'n')).toBeNull()
    expect(notificationToPayload('conversation.user.replied', { state: 'open' }, 'n')).toBeNull()
    expect(notificationToPayload('conversation.user.replied', 'nope', 'n')).toBeNull()
    expect(triggersForTopic('ping')).toEqual([])
  })
})
