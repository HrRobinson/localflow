/**
 * Shared Shopify connector types — the NORMALIZED, stable shapes an action
 * writes to run context (§6.3) and the action-param shapes the engine templates.
 * Imported by main (the connector/normalizer) and any renderer palette surface.
 *
 * NO raw Shopify GraphQL shape lives here — those are isolated in
 * `src/main/shopify/shopify-admin.ts` (the API-version blast radius, §4.1). This
 * file holds ONLY localflow-facing, already-normalized vocabulary: money as a
 * `number`, statuses as lowercase enums, GIDs reduced to bare ids — the exact
 * types the (sibling-owned) edge-condition operators of §10 expect.
 */

// ── Pinned ecom vocabulary ids (§6 — the templates track consumes these) ─────

/** Webhook-backed trigger ids (§6.1). */
export const SHOPIFY_TRIGGER_IDS = [
  'order.created',
  'order.refundRequested',
  'order.flagged'
] as const
export type ShopifyTriggerId = (typeof SHOPIFY_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (§6.2). */
export const SHOPIFY_READ_ACTION_IDS = ['getOrder', 'getCustomer', 'searchOrders'] as const

/** Gated-mutation action ids — the author places a gate before these (§6.2). */
export const SHOPIFY_MUTATION_ACTION_IDS = [
  'refundOrder',
  'cancelOrder',
  'updateShippingAddress',
  'addOrderNote'
] as const

export type ShopifyActionId =
  | (typeof SHOPIFY_READ_ACTION_IDS)[number]
  | (typeof SHOPIFY_MUTATION_ACTION_IDS)[number]

// ── Normalized status enums (lowercase — exact `eq`/`ne` compares, §10) ──────

export type ShopifyOrderStatus = 'open' | 'closed' | 'cancelled'

export type ShopifyFinancialStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'partially_paid'
  | 'refunded'
  | 'partially_refunded'
  | 'voided'

export type ShopifyFulfillmentStatus = 'unfulfilled' | 'partial' | 'fulfilled' | 'restocked'

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ─────

export interface ShopifyOrderContext {
  order: {
    /** Numeric order id (GID reduced), e.g. "5123456789". */
    id: string
    /** Human order name, e.g. "#1001". */
    name: string
    /** total_price as a Number (major units), e.g. 42.5 — so `gt`/`lte` work. */
    total: number
    /** ISO 4217, e.g. "USD". */
    currency: string
    status: ShopifyOrderStatus
    financialStatus: ShopifyFinancialStatus
    fulfillmentStatus: ShopifyFulfillmentStatus
    /** Contact email on the order. */
    email: string
    /** ISO 8601. */
    createdAt: string
    /** Risk-derived (§6.1); true = high-risk / manual-review. */
    flagged: boolean
    /** Convenience for conditions. */
    lineItemCount: number
  }
  /** The order's customer; absent-customer → fields are empty strings. */
  customer: {
    id: string
    email: string
    name: string
  }
}

export interface ShopifyCustomerContext {
  customer: {
    id: string
    email: string
    name: string
    /** Lifetime order count (loyalty conditions). */
    ordersCount: number
    /** Lifetime spend as a Number. */
    totalSpent: number
    currency: string
  }
}

/** `searchOrders` result — the normalized orders plus a count (§6.2). */
export interface ShopifyOrderSearchContext {
  orders: ShopifyOrderContext[]
  count: number
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ──────────

export interface GetOrderParams {
  id: string
}

export interface GetCustomerParams {
  id: string
}

export interface SearchOrdersParams {
  /** A raw Shopify `orders(query:)` search string, e.g. "email:a@b.com". */
  query?: string
  /** Convenience: search by contact email (composed into a query). */
  email?: string
}

export interface RefundOrderParams {
  id: string
  /** Refund amount in major units; omitted → Shopify-calculated full refund. */
  amount?: number
  /** Restock the refunded line items. */
  restock?: boolean
}

export interface CancelOrderParams {
  id: string
  /** Cancellation reason, e.g. "customer", "fraud", "inventory". */
  reason?: string
  /** Also refund the order. */
  refund?: boolean
  /** Restock on cancel. */
  restock?: boolean
}

export interface UpdateShippingAddressParams {
  id: string
  address: {
    address1?: string
    address2?: string
    city?: string
    province?: string
    country?: string
    zip?: string
  }
}

export interface AddOrderNoteParams {
  id: string
  note: string
}

// ── Trigger payload shape (what a verified webhook seeds a run with) ─────────

/** The normalized payload the webhook server writes to the trigger node's
 *  context slot — enough for a downstream `getOrder` to template `{{t.orderId}}`. */
export interface ShopifyTriggerPayload {
  /** Numeric order id (GID reduced). */
  orderId: string
  /** Contact email, when present on the topic payload. */
  email?: string
  /** Risk-derived flag (true for the `order.flagged` derivation, §6.1). */
  flagged: boolean
  /** The Shopify topic that produced this, e.g. "orders/create". */
  topic: string
}
