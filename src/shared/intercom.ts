/**
 * Shared Intercom connector vocabulary + types — the NORMALIZED, stable shapes an
 * action (or a verified webhook) writes to run context (spec §6.3) and the
 * action-param shapes the engine templates. Imported by main (the connector /
 * normalizer / descriptor) and any renderer palette surface. Mirrors
 * `src/shared/stripe.ts`.
 *
 * NO raw Intercom request/response shape lives here — those are isolated in
 * `src/main/intercom/intercom-api.ts` (the API-version blast radius, §4.1). This
 * file holds ONLY localflow-facing, already-normalized vocabulary: ids as bare
 * strings, statuses as LOWERCASE enums (so §10's `eq`/`ne` compare exactly),
 * `contactEmail` as a lowercase string (the cross-connector JOIN KEY into Shopify /
 * Stripe), and `tags` as a lowercase string array — the exact types the
 * (sibling-owned) edge-condition operators of §10 expect.
 */

// ── Pinned Intercom vocabulary ids (§6 — the templates track consumes these) ──

/** Webhook-backed trigger ids (§6.1). Both native 1:1 Intercom topics. */
export const INTERCOM_TRIGGER_IDS = ['conversation.replied', 'conversation.created'] as const
export type IntercomTriggerId = (typeof INTERCOM_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (§6.2). */
export const INTERCOM_READ_ACTION_IDS = ['getConversation', 'getContact'] as const

/**
 * Gated-write action ids — the author places a gate before these (§6.2, §9).
 * `replyToConversation` is CUSTOMER-FACING (never-auto-send, §9); the other two
 * change INTERNAL state and are gated like any Shopify/Stripe mutation.
 */
export const INTERCOM_WRITE_ACTION_IDS = [
  'replyToConversation',
  'closeConversation',
  'tagConversation'
] as const

/**
 * The customer-facing subset (§6.2). §9's flow-validate guard and the templates
 * track BOTH key off this array: a `replyToConversation` node with no upstream gate
 * is unauthorable (a real message to a real customer must never auto-send).
 */
export const INTERCOM_CUSTOMER_FACING_ACTION_IDS = ['replyToConversation'] as const

export type IntercomActionId =
  (typeof INTERCOM_READ_ACTION_IDS)[number] | (typeof INTERCOM_WRITE_ACTION_IDS)[number]

/** True when `ref` is a customer-facing action id (used by the flow-validate guard). */
export function isCustomerFacingIntercomAction(ref: string | undefined): boolean {
  return (
    ref !== undefined && (INTERCOM_CUSTOMER_FACING_ACTION_IDS as readonly string[]).includes(ref)
  )
}

// ── Region (non-secret; selects the API base URL, §8) ────────────────────────

export type IntercomRegion = 'us' | 'eu' | 'au'
export const INTERCOM_REGIONS: readonly IntercomRegion[] = ['us', 'eu', 'au']

// ── Normalized status enums (LOWERCASE — exact `eq`/`ne` compares, §10) ──────

export type IntercomConversationState = 'open' | 'closed' | 'snoozed'
export type IntercomPriority = 'priority' | 'not_priority'
export type IntercomAuthorType = 'user' | 'admin' | 'bot'
export type IntercomContactRole = 'user' | 'lead'

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ─────

export interface IntercomConversationContext {
  conversation: {
    /** Bare Intercom conversation id. */
    id: string
    state: IntercomConversationState
    read: boolean
    priority: IntercomPriority
    /** Conversation subject/title (may be ""). */
    title: string
    /** The primary customer contact id. */
    contactId: string
    /** The customer's email — the LOWERCASE join key to Shopify/Stripe (may be ""). */
    contactEmail: string
    /** Plaintext of the latest part (HTML stripped; may be ""). */
    lastMessageBody: string
    /** Who spoke last. */
    lastMessageAuthorType: IntercomAuthorType
    /** Lowercase tag names. */
    tags: string[]
    /** ISO 8601 (from Intercom unix `created_at`). */
    createdAt: string
    /** ISO 8601 (from Intercom unix `updated_at`). */
    updatedAt: string
  }
}

export interface IntercomContactContext {
  contact: {
    /** Bare Intercom contact id. */
    id: string
    /** Lowercase email (may be ""). */
    email: string
    name: string
    role: IntercomContactRole
    /** ISO 8601. */
    createdAt: string
    /** ISO 8601 (may be ""). */
    lastSeenAt: string
  }
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ──────────

export interface GetConversationParams {
  /** The conversation id — "{{t.conversationId}}". */
  id: string
}
export interface GetContactParams {
  /** The contact id — "{{conv.conversation.contactId}}". */
  id: string
}

/** `replyToConversation` — the CUSTOMER-FACING send (§9). `body` is the
 *  context-held draft; only an approved gate reaches this node. */
export interface ReplyToConversationParams {
  /** The conversation id. */
  id: string
  /** The reply body (the `{{draft}}` text the human approved). */
  body: string
  /** The admin sending the reply (Intercom requires an author for a reply). */
  adminId?: string
}

export interface CloseConversationParams {
  id: string
  /** The admin closing the conversation. */
  adminId?: string
  /** Optional closing note body. */
  body?: string
}

export interface TagConversationParams {
  id: string
  /** The Intercom tag id to attach. */
  tagId: string
  /** The admin attaching the tag (Intercom requires it). */
  adminId?: string
}

// ── Trigger payload shapes (what a verified webhook seeds a run with, §6.1) ──

/** The seed payload both `conversation.replied` and `conversation.created` carry:
 *  the keys `getConversation` / `getContact` / the cross-connector commerce reads
 *  (`shopify.searchOrders(email:)`, `stripe.getCustomer`) need immediately. */
export interface IntercomTriggerPayload {
  conversationId: string
  contactId: string
  /** Lowercase — the join key. */
  contactEmail: string
  lastMessageBody: string
  /** The webhook notification id (also the dedup key). */
  notificationId: string
  /** The underlying Intercom topic, e.g. "conversation.user.replied". */
  topic: string
}
