import { describe, it, expect } from 'vitest'
import {
  eventToPayload,
  normalizeComment,
  normalizeTicket,
  normalizeUser,
  triggersForType
} from '../../src/main/zendesk/zendesk-normalize'
import type { RawComment, RawTicket, RawUser } from '../../src/main/zendesk/zendesk-api'
import type {
  ZendeskCommentEventPayload,
  ZendeskTicketEventPayload
} from '../../src/shared/zendesk'

describe('normalizeTicket (§6.3 — the correctness boundary)', () => {
  it('lowercases status/priority to exact enums, coerces ids to strings, tags to an array', () => {
    const raw: RawTicket = {
      id: 35436,
      subject: 'Where is my refund?',
      status: 'OPEN',
      priority: 'High',
      requester_email: 'buyer@x.com',
      requester_id: 771,
      assignee_id: 42,
      group_id: 9,
      tags: ['refund', 'vip'],
      satisfaction_rating: { score: 'good' },
      created_at: '2026-07-20T10:00:00Z',
      updated_at: '2026-07-20T11:00:00Z'
    }
    expect(normalizeTicket(raw).ticket).toEqual({
      id: '35436',
      subject: 'Where is my refund?',
      status: 'open',
      priority: 'high',
      requesterEmail: 'buyer@x.com',
      requesterId: '771',
      assigneeId: '42',
      groupId: '9',
      tags: ['refund', 'vip'],
      satisfactionScore: 'good',
      createdAt: '2026-07-20T10:00:00Z',
      updatedAt: '2026-07-20T11:00:00Z'
    })
  })

  it('never throws on a sparse payload — absent priority/assignee/group become "" (safe defaults)', () => {
    const t = normalizeTicket({ id: 1, status: 'new' }).ticket
    expect(t).toMatchObject({
      id: '1',
      status: 'new',
      priority: '',
      requesterEmail: '',
      assigneeId: '',
      groupId: '',
      tags: [],
      satisfactionScore: 'unoffered'
    })
  })

  it('the requesterEmail is a plain string — the cross-connector JOIN key (§7.3)', () => {
    // Same casing/shape as Shopify order.email / Stripe charge.email so `eq` joins.
    expect(normalizeTicket({ id: 1, requester_email: 'buyer@x.com' }).ticket.requesterEmail).toBe(
      'buyer@x.com'
    )
  })
})

describe('normalizeComment', () => {
  it('preserves the public boolean, prefers plain_body, maps the author role', () => {
    const raw: RawComment = {
      id: 5,
      body: '<b>rich</b>',
      plain_body: 'plain text',
      public: true,
      author_id: 771,
      author_role: 'end-user',
      created_at: '2026-07-20T10:05:00Z'
    }
    expect(normalizeComment(raw).comment).toEqual({
      id: '5',
      body: 'plain text',
      public: true,
      authorId: '771',
      authorRole: 'end-user',
      createdAt: '2026-07-20T10:05:00Z'
    })
  })

  it('a private note normalizes public:false, unknown role → agent', () => {
    const c = normalizeComment({ id: 6, body: 'note', public: false }).comment
    expect(c).toMatchObject({ public: false, authorRole: 'agent' })
  })
})

describe('normalizeUser', () => {
  it('maps role, coerces ids, defaults role to end-user', () => {
    const raw: RawUser = {
      id: 771,
      email: 'buyer@x.com',
      name: 'Bee',
      role: 'end-user',
      organization_id: 88,
      created_at: '2026-01-01T00:00:00Z'
    }
    expect(normalizeUser(raw).user).toEqual({
      id: '771',
      email: 'buyer@x.com',
      name: 'Bee',
      role: 'end-user',
      organizationId: '88',
      createdAt: '2026-01-01T00:00:00Z'
    })
    expect(normalizeUser({ id: 1 }).user.role).toBe('end-user')
  })
})

describe('triggersForType + eventToPayload (§7.2)', () => {
  it('maps each supported event type to its trigger id, and nothing for the rest', () => {
    expect(triggersForType('ticket.commentAdded')).toEqual(['ticket.commentAdded'])
    expect(triggersForType('ticket.created')).toEqual(['ticket.created'])
    expect(triggersForType('ticket.updated')).toEqual(['ticket.updated'])
    expect(triggersForType('ticket.escalated')).toEqual(['ticket.escalated'])
    expect(triggersForType('ticket.deleted')).toEqual([])
  })

  it('normalizes a ticket.commentAdded delivery to the comment payload (public + requesterEmail)', () => {
    const payload = eventToPayload(
      'ticket.commentAdded',
      {
        ticket: { id: 35436, requester_email: 'buyer@x.com' },
        comment: { id: 5, plain_body: 'still broken', public: true, author_role: 'end-user' }
      },
      'evt_1'
    ) as ZendeskCommentEventPayload
    expect(payload).toEqual({
      ticketId: '35436',
      commentId: '5',
      body: 'still broken',
      public: true,
      authorRole: 'end-user',
      requesterEmail: 'buyer@x.com',
      eventId: 'evt_1',
      type: 'ticket.commentAdded'
    })
  })

  it('normalizes a ticket.created delivery to the ticket payload (status/tags as strings)', () => {
    const payload = eventToPayload(
      'ticket.created',
      {
        ticket: {
          id: 1,
          subject: 'hi',
          status: 'open',
          priority: 'normal',
          requester_email: 'a@b.com',
          tags: ['x']
        }
      },
      'evt_2'
    ) as ZendeskTicketEventPayload
    expect(payload).toMatchObject({
      ticketId: '1',
      subject: 'hi',
      status: 'open',
      requesterEmail: 'a@b.com',
      tags: ['x'],
      type: 'ticket.created'
    })
  })

  it('returns null for an unsupported type or a shape with no ticket id (no run seeded)', () => {
    expect(eventToPayload('ticket.deleted', { ticket: { id: 1 } }, 'e')).toBeNull()
    expect(eventToPayload('ticket.created', { ticket: {} }, 'e')).toBeNull()
    expect(eventToPayload('ticket.created', 'garbage', 'e')).toBeNull()
  })
})
