/**
 * Shared Zendesk connector types — the NORMALIZED, stable shapes an action (or a
 * verified webhook) writes to run context (spec §6.3) and the action-param shapes
 * the engine templates. Imported by main (the connector/normalizer) and any
 * renderer palette surface. Mirrors `src/shared/stripe.ts`.
 *
 * NO raw Zendesk request/response shape lives here — those are isolated in
 * `src/main/zendesk/zendesk-api.ts` (the API blast radius, §4.1). This file holds
 * ONLY localflow-facing, already-normalized vocabulary: lowercase status/priority
 * enums (so `eq`/`ne` are exact, §10), `tags` as a string array (so `contains`
 * works), `public` as a boolean (so `truthy` works), and — critically —
 * `requesterEmail` as a plain string so the CROSS-CONNECTOR join to Shopify's
 * `order.email` and Stripe's `charge.email` compares equal (§6.3, §7.3).
 */

// ── Pinned Zendesk vocabulary ids (§6 — the templates track consumes these) ──

/** Webhook-backed trigger ids (§6.1), delivered via the shared receiver (§7). */
export const ZENDESK_TRIGGER_IDS = [
  'ticket.commentAdded',
  'ticket.created',
  'ticket.updated',
  'ticket.escalated'
] as const
export type ZendeskTriggerId = (typeof ZENDESK_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (§6.2). */
export const ZENDESK_READ_ACTION_IDS = [
  'getTicket',
  'getComments',
  'searchTickets',
  'getUser'
] as const

/**
 * Gated-mutation action ids — the author places a gate before these (§6.2, §9).
 * `replyToTicket` is the ONLY id that emits `comment.public: true` (customer-facing
 * outbound) and is therefore the ONLY id that rides the never-auto-send gate (§9).
 * A flow-validate rule makes `replyToTicket` unauthorable without a preceding gate.
 */
export const ZENDESK_MUTATION_ACTION_IDS = [
  'replyToTicket',
  'addInternalNote',
  'setStatus',
  'assignTicket',
  'tagTicket'
] as const

export type ZendeskActionId =
  (typeof ZENDESK_READ_ACTION_IDS)[number] | (typeof ZENDESK_MUTATION_ACTION_IDS)[number]

/** The one action id whose reply is customer-facing (`comment.public: true`) and
 *  must be gated (never-auto-send, §9). Consumed by flow-validate. */
export const ZENDESK_PUBLIC_REPLY_ACTION_ID = 'replyToTicket'

/** The set-status transitions this connector accepts (§6.2). */
export const ZENDESK_TICKET_STATUSES = ['open', 'pending', 'solved', 'closed'] as const
export type ZendeskSettableStatus = (typeof ZENDESK_TICKET_STATUSES)[number]

// ── Normalized enums (lowercase — exact `eq`/`ne` compares, §10) ─────────────

export type ZendeskTicketStatus = 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed'

/** Priority; `''` when unset (§6.3). */
export type ZendeskTicketPriority = 'low' | 'normal' | 'high' | 'urgent' | ''

export type ZendeskSatisfaction = 'offered' | 'good' | 'bad' | 'unoffered'

export type ZendeskCommentRole = 'end-user' | 'agent' | 'system'

export type ZendeskUserRole = 'end-user' | 'agent' | 'admin'

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ─────

export interface ZendeskTicketContext {
  ticket: {
    /** numeric ticket id, e.g. "35436". */
    id: string
    subject: string
    status: ZendeskTicketStatus
    priority: ZendeskTicketPriority
    /** the customer's email — the JOIN key to Shopify/Stripe (§7.3). */
    requesterEmail: string
    requesterId: string
    /** '' when unassigned. */
    assigneeId: string
    /** '' when ungrouped. */
    groupId: string
    tags: string[]
    satisfactionScore: ZendeskSatisfaction
    /** ISO 8601. */
    createdAt: string
    /** ISO 8601. */
    updatedAt: string
  }
}

export interface ZendeskCommentContext {
  comment: {
    id: string
    /** plain-text body. */
    body: string
    /** true = customer-facing, false = internal note. */
    public: boolean
    authorId: string
    authorRole: ZendeskCommentRole
    /** ISO 8601. */
    createdAt: string
  }
}

export interface ZendeskUserContext {
  user: {
    id: string
    email: string
    name: string
    role: ZendeskUserRole
    /** '' when none. */
    organizationId: string
    /** ISO 8601. */
    createdAt: string
  }
}

/** `getComments` writes the thread + a count. */
export interface ZendeskCommentsContext {
  comments: ZendeskCommentContext[]
  count: number
}

/** `searchTickets` writes the matches + a count. */
export interface ZendeskTicketsContext {
  tickets: ZendeskTicketContext[]
  count: number
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ──────────

export interface GetTicketParams {
  id: string
}
export interface GetCommentsParams {
  id: string
}
export interface SearchTicketsParams {
  /** A Zendesk search query, e.g. "requester:buyer@x.com status:open". */
  query: string
}
export interface GetUserParams {
  id: string
}

/** Public reply — customer-facing; the connector HARD-SETS `public: true` (§9). */
export interface ReplyToTicketParams {
  id: string
  body: string
}
/** Internal note — the connector HARD-SETS `public: false` (§6.2). */
export interface AddInternalNoteParams {
  id: string
  body: string
}
export interface SetStatusParams {
  id: string
  status: ZendeskSettableStatus
}
export interface AssignTicketParams {
  id: string
  /** the agent to assign to (may be paired with, or replaced by, groupId). */
  assigneeId?: string
  groupId?: string
}
export interface TagTicketParams {
  id: string
  tags: string[]
}

// ── Trigger payload shapes (what a verified webhook seeds a run with, §7.2) ──

/** `ticket.created` / `.updated` / `.escalated`. */
export interface ZendeskTicketEventPayload {
  ticketId: string
  subject: string
  status: string
  priority: string
  requesterEmail: string
  tags: string[]
  eventId: string
  type: string
}

/** `ticket.commentAdded` — the flagship trigger (§7.3). */
export interface ZendeskCommentEventPayload {
  ticketId: string
  commentId: string
  body: string
  public: boolean
  authorRole: string
  requesterEmail: string
  eventId: string
  type: string
}

export type ZendeskTriggerPayload = ZendeskTicketEventPayload | ZendeskCommentEventPayload
