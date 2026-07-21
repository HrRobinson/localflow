/**
 * Shared HubSpot-connector types — the NORMALIZED, stable context shapes an
 * action writes to run context (§3.3), the pinned trigger/action ids the
 * templates track consumes (§3.1, §3.2), the action-param shapes the engine
 * templates, and the trigger payload a verified webhook seeds a run with.
 * Imported by both the main-process connector and any renderer palette surface.
 *
 * NO raw HubSpot v3 shape lives here — those (the `properties` bag, search
 * filter groups, the error envelope) are isolated in `src/main/hubspot/
 * hubspot-api.ts` (the API blast radius, §7.1). This file holds ONLY
 * saiife-facing, already-normalized vocabulary: ids as strings, money/counts
 * as numbers, enums lowercased — the exact types the edge-condition operators
 * and the agent node read (§3.3). No secret ever appears in these shapes: the
 * private-app token and the webhook client secret stay in the keychain (§4).
 */

// ── Pinned CRM vocabulary ids (§3 — the templates track consumes these) ──────

/** Webhook-backed trigger ids (§3.1). `deal.stageChanged` is DERIVED from a
 *  `deal.propertyChange` subscription filtered to the `dealstage` property;
 *  `form.submitted` is HubSpot's form-submission surface. */
export const HUBSPOT_TRIGGER_IDS = [
  'contact.created',
  'deal.stageChanged',
  'form.submitted'
] as const
export type HubSpotTriggerId = (typeof HUBSPOT_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions + the agent
 *  (§3.2). `searchContacts` is rate-capped client-side at 4/sec (§6). */
export const HUBSPOT_READ_ACTION_IDS = [
  'getContact',
  'getDeal',
  'getCompany',
  'searchContacts'
] as const

/** Gated-write action ids — the author places a gate before these (§3.2). */
export const HUBSPOT_WRITE_ACTION_IDS = [
  'createContact',
  'updateDeal',
  'logActivity',
  'createTask'
] as const

export type HubSpotActionId =
  (typeof HUBSPOT_READ_ACTION_IDS)[number] | (typeof HUBSPOT_WRITE_ACTION_IDS)[number]

// ── Context-field shapes (§3.3 — PINNED; guarded by the normalize tests) ─────

export interface HubSpotContactContext {
  contact: {
    /** HubSpot contact id (vid), as a string. */
    id: string
    email: string
    firstName: string
    lastName: string
    /** Display name (first + last). */
    name: string
    /** Company name property (if set). */
    company: string
    jobTitle: string
    /** Lowercase, e.g. "lead" | "marketingqualifiedlead" | "customer". */
    lifecycleStage: string
    /** `hs_lead_status`, lowercase. */
    leadStatus: string
    /** ISO 8601. */
    createdAt: string
    /** ISO 8601 (may be empty). */
    lastActivityAt: string
  }
}

export interface HubSpotDealContext {
  deal: {
    id: string
    /** `dealname`. */
    name: string
    /** `dealstage`, lowercase. */
    stage: string
    pipeline: string
    /** As a Number (major units), e.g. 4200. */
    amount: number
    /** ISO 4217. */
    currency: string
    ownerId: string
    /** ISO 8601 (may be empty). */
    closeDate: string
    isClosed: boolean
    isWon: boolean
    createdAt: string
  }
}

export interface HubSpotCompanyContext {
  company: {
    id: string
    name: string
    domain: string
    industry: string
    numEmployees: number
    /** As a Number. */
    annualRevenue: number
    country: string
  }
}

/** `searchContacts` result — the normalized contacts plus a total (§3.2). The
 *  element type is the full `HubSpotContactContext`, aligned with Shopify's
 *  `ShopifyOrderSearchContext` shape so the palette/conditions read alike. */
export interface HubSpotContactSearchContext {
  contacts: HubSpotContactContext[]
  total: number
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ──────────

export interface GetContactParams {
  id: string
}

export interface GetDealParams {
  id: string
}

export interface GetCompanyParams {
  id: string
}

export interface SearchContactsParams {
  /** Convenience: search by exact contact email. */
  email?: string
  /** A free-text query across default searchable properties. */
  query?: string
  /** Page size (HubSpot default/cap 100). */
  limit?: number
}

export interface CreateContactParams {
  email: string
  firstName?: string
  lastName?: string
  company?: string
  jobTitle?: string
  /** Extra raw HubSpot property names → values, merged last. */
  properties?: Record<string, string | number | boolean>
}

export interface UpdateDealParams {
  id: string
  /** `dealstage` — move the deal to a new stage. */
  stage?: string
  amount?: number
  ownerId?: string
  /** Extra raw HubSpot property names → values, merged last. */
  properties?: Record<string, string | number | boolean>
}

export interface LogActivityParams {
  /** The note body — the CRM audit trail of what the worker did. */
  note: string
  /** Object ids this note associates to (a contact, a deal). */
  contactId?: string
  dealId?: string
}

export interface CreateTaskParams {
  /** The task subject line. */
  subject: string
  /** The task body / notes. */
  body?: string
  /** The HubSpot owner the task is assigned to. */
  ownerId?: string
  /** ISO 8601 or epoch-ms due date. */
  dueDate?: string
  contactId?: string
  dealId?: string
}

// ── Trigger payload shape (what a verified webhook seeds a run with) ─────────

/**
 * The normalized payload one HubSpot subscription event maps to (§5.6). HubSpot
 * batches events in a single POST (an array); the normalizer emits ONE of these
 * per array element, keyed by HubSpot's per-event `eventId` for engine dedup.
 * `contactId`/`dealId` are the templatable ids a downstream `getContact`/
 * `getDeal` reads (`{{t.contactId}}`).
 */
export interface HubSpotTriggerPayload {
  /** The object id the event concerns, as a string. */
  objectId: string
  /** Present for a contact.creation event — the new contact's id. */
  contactId?: string
  /** Present for a deal.propertyChange event — the deal's id. */
  dealId?: string
  /** The raw HubSpot subscriptionType, e.g. "contact.creation". */
  subscriptionType: string
  /** For deal.propertyChange: the changed property (always `dealstage` here). */
  propertyName?: string
  /** For deal.propertyChange: the new property value (the new stage). */
  propertyValue?: string
  /** Epoch-ms the event occurred, as a string (when present). */
  occurredAt?: string
}
