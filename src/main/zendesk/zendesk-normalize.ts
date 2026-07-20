import type { RawComment, RawTicket, RawUser } from './zendesk-api'
import type {
  ZendeskCommentContext,
  ZendeskCommentRole,
  ZendeskSatisfaction,
  ZendeskTicketContext,
  ZendeskTicketPriority,
  ZendeskTicketStatus,
  ZendeskTriggerId,
  ZendeskTriggerPayload,
  ZendeskUserContext,
  ZendeskUserRole
} from '../../shared/zendesk'

/**
 * PURE normalization (spec §6.3, §10) — the correctness boundary the conditions
 * track depends on. A raw Zendesk object (or a raw webhook payload) becomes the
 * PINNED context/trigger shape. Statuses/priorities are lowercased to the exact
 * enums (so `eq`/`ne` are exact), tags become a string array (so `contains`
 * works), `public` stays a boolean (so `truthy` works), and `requesterEmail` is a
 * plain lowercase-preserving string so it composes with Shopify's `order.email`
 * and Stripe's `charge.email` (§7.3 — the cross-connector join). Ids are bare
 * numbers-as-strings; timestamps are passed through as ISO 8601. Never throws — a
 * sparse/garbage object normalizes to safe defaults (mirrors `stripe-normalize.ts`).
 */

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

const TICKET_STATUS: Record<string, ZendeskTicketStatus> = {
  new: 'new',
  open: 'open',
  pending: 'pending',
  hold: 'hold',
  solved: 'solved',
  closed: 'closed'
}

const TICKET_PRIORITY: Record<string, ZendeskTicketPriority> = {
  low: 'low',
  normal: 'normal',
  high: 'high',
  urgent: 'urgent'
}

const SATISFACTION: Record<string, ZendeskSatisfaction> = {
  offered: 'offered',
  good: 'good',
  bad: 'bad',
  unoffered: 'unoffered'
}

const COMMENT_ROLE: Record<string, ZendeskCommentRole> = {
  'end-user': 'end-user',
  agent: 'agent',
  system: 'system'
}

const USER_ROLE: Record<string, ZendeskUserRole> = {
  'end-user': 'end-user',
  agent: 'agent',
  admin: 'admin'
}

/** lowercased-then-mapped enum lookup, with a safe default. */
function enumOf<T>(map: Record<string, T>, v: unknown, fallback: T): T {
  return map[str(v).toLowerCase()] ?? fallback
}

export function normalizeTicket(raw: RawTicket): ZendeskTicketContext {
  return {
    ticket: {
      id: str(raw.id),
      subject: str(raw.subject),
      status: enumOf(TICKET_STATUS, raw.status, 'new'),
      priority: enumOf<ZendeskTicketPriority>(TICKET_PRIORITY, raw.priority, ''),
      requesterEmail: str(raw.requester_email),
      requesterId: str(raw.requester_id),
      assigneeId: str(raw.assignee_id),
      groupId: str(raw.group_id),
      tags: strArray(raw.tags),
      satisfactionScore: enumOf(SATISFACTION, raw.satisfaction_rating?.score, 'unoffered'),
      createdAt: str(raw.created_at),
      updatedAt: str(raw.updated_at)
    }
  }
}

export function normalizeComment(raw: RawComment): ZendeskCommentContext {
  return {
    comment: {
      id: str(raw.id),
      // Prefer the plain-text body; fall back to the rich body (§6.3).
      body: str(raw.plain_body) || str(raw.body),
      public: raw.public === true,
      authorId: str(raw.author_id),
      authorRole: enumOf(COMMENT_ROLE, raw.author_role, 'agent'),
      createdAt: str(raw.created_at)
    }
  }
}

export function normalizeUser(raw: RawUser): ZendeskUserContext {
  return {
    user: {
      id: str(raw.id),
      email: str(raw.email),
      name: str(raw.name),
      role: enumOf(USER_ROLE, raw.role, 'end-user'),
      organizationId: str(raw.organization_id),
      createdAt: str(raw.created_at)
    }
  }
}

// ── Webhook event → trigger payload (§7.2) ───────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Which pinned trigger id(s) a verified Zendesk event `type` fires. An unsupported
 * type fires nothing (§6.1, §7.2).
 */
export function triggersForType(type: string): ZendeskTriggerId[] {
  switch (type) {
    case 'ticket.commentAdded':
      return ['ticket.commentAdded']
    case 'ticket.created':
      return ['ticket.created']
    case 'ticket.updated':
      return ['ticket.updated']
    case 'ticket.escalated':
      return ['ticket.escalated']
    default:
      return []
  }
}

/**
 * Normalize a verified delivery's `type` + body into a `ZendeskTriggerPayload`, or
 * `null` when the type is unsupported or the shape is unusable (so no run is ever
 * seeded on an unexpected shape — §7.2). The Admin-Center webhook is templated to
 * POST `{ type, id, ticket:{…}, comment?:{…} }`; statuses/tags stay as strings so
 * a downstream `{{t.requesterEmail}}` composes with Shopify/Stripe (§7.3).
 */
export function eventToPayload(
  type: string,
  data: unknown,
  eventId: string
): ZendeskTriggerPayload | null {
  if (!isObj(data)) return null
  const ticket = isObj(data.ticket) ? data.ticket : undefined
  if (!ticket) return null
  const ticketId = str(ticket.id)
  if (ticketId.length === 0) return null

  if (type === 'ticket.commentAdded') {
    const comment = isObj(data.comment) ? data.comment : {}
    return {
      ticketId,
      commentId: str(comment.id),
      body: str(comment.plain_body) || str(comment.body),
      public: comment.public === true,
      authorRole: str(comment.author_role),
      requesterEmail: str(ticket.requester_email),
      eventId,
      type
    }
  }

  if (type === 'ticket.created' || type === 'ticket.updated' || type === 'ticket.escalated') {
    return {
      ticketId,
      subject: str(ticket.subject),
      status: str(ticket.status),
      priority: str(ticket.priority),
      requesterEmail: str(ticket.requester_email),
      tags: strArray(ticket.tags),
      eventId,
      type
    }
  }

  return null
}
