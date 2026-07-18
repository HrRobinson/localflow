/**
 * Shared Stripe connector types — the NORMALIZED, stable shapes an action (or a
 * verified webhook) writes to run context (spec §6.3) and the action-param shapes
 * the engine templates. Imported by main (the connector/normalizer) and any
 * renderer palette surface. Mirrors `src/shared/shopify.ts`.
 *
 * NO raw Stripe request/response shape lives here — those are isolated in
 * `src/main/stripe/stripe-client.ts` (the API-version blast radius, §4.1). This
 * file holds ONLY localflow-facing, already-normalized vocabulary: money as a
 * MAJOR-unit `number` (via `minorToMajor`, §6.3), `currency` as an UPPERCASE ISO
 * 4217 string (so it compares equal to Shopify's `order.currency`), Stripe ids as
 * bare strings, and lowercase status enums — the exact types the (sibling-owned)
 * edge-condition operators of §10 expect.
 */

// ── Pinned Stripe vocabulary ids (§6 — the templates track consumes these) ───

/** Webhook-backed trigger ids (§6.1) — all native 1:1 Stripe events. */
export const STRIPE_TRIGGER_IDS = [
  'charge.dispute.created',
  'charge.refunded',
  'invoice.payment_failed'
] as const
export type StripeTriggerId = (typeof STRIPE_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (§6.2). */
export const STRIPE_READ_ACTION_IDS = [
  'getCharge',
  'getCustomer',
  'getDispute',
  'getSubscription'
] as const

/**
 * Gated-mutation action ids — the author places a gate before these (§6.2, §9).
 * ALL THREE move or contest money, so the connector treats them uniformly as
 * gated money actions; none ever auto-runs.
 */
export const STRIPE_MUTATION_ACTION_IDS = [
  'createRefund',
  'respondToDispute',
  'cancelSubscription'
] as const

export type StripeActionId =
  (typeof STRIPE_READ_ACTION_IDS)[number] | (typeof STRIPE_MUTATION_ACTION_IDS)[number]

// ── Normalized status enums (lowercase — exact `eq`/`ne` compares, §10) ──────

export type StripeChargeStatus = 'succeeded' | 'pending' | 'failed'

export type StripeDisputeStatus =
  'warning_needs_response' | 'needs_response' | 'under_review' | 'won' | 'lost' | 'charge_refunded'

export type StripeSubscriptionStatus =
  'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'trialing' | 'paused'

// ── Context-field shapes (§6.3 — PINNED; guarded by the normalize tests) ─────

export interface StripeChargeContext {
  charge: {
    /** "ch_…". */
    id: string
    /** MAJOR units, e.g. 50 (from minor 5000 USD), 5000 (¥5000). */
    amount: number
    /** ISO 4217, UPPERCASE, e.g. "USD" (matches Shopify). */
    currency: string
    /** MAJOR units — already refunded. */
    amountRefunded: number
    status: StripeChargeStatus
    paid: boolean
    /** Fully refunded. */
    refunded: boolean
    /** A dispute exists on this charge. */
    disputed: boolean
    /** "cus_…" (may be ""). */
    customerId: string
    /** Receipt/billing email (may be ""). */
    email: string
    /** "pi_…" (may be ""). */
    paymentIntentId: string
    /** ISO 8601 (from Stripe unix `created`). */
    createdAt: string
  }
}

export interface StripeDisputeContext {
  dispute: {
    /** "dp_…". */
    id: string
    /** "ch_…" the dispute is against. */
    chargeId: string
    /** MAJOR units — disputed amount. */
    amount: number
    /** ISO 4217, UPPERCASE. */
    currency: string
    /** Stripe reason, e.g. "fraudulent", "product_not_received". */
    reason: string
    status: StripeDisputeStatus
    /** ISO 8601 — the response deadline (empty if none). */
    evidenceDueBy: string
  }
}

export interface StripeCustomerContext {
  customer: {
    /** "cus_…". */
    id: string
    email: string
    name: string
    /** Default currency, UPPERCASE (may be ""). */
    currency: string
    /** Has an unpaid invoice. */
    delinquent: boolean
  }
}

export interface StripeSubscriptionContext {
  subscription: {
    /** "sub_…". */
    id: string
    /** "cus_…". */
    customerId: string
    status: StripeSubscriptionStatus
    /** MAJOR units — recurring amount. */
    amount: number
    /** ISO 4217, UPPERCASE. */
    currency: string
    /** ISO 8601. */
    currentPeriodEnd: string
    cancelAtPeriodEnd: boolean
  }
}

// ── Action param shapes (what a flow node passes to `invokeAction`) ──────────

export interface GetChargeParams {
  id: string
}
export interface GetCustomerParams {
  id: string
}
export interface GetDisputeParams {
  id: string
}
export interface GetSubscriptionParams {
  id: string
}

export interface CreateRefundParams {
  /** The charge id to refund — "ch_…". */
  id: string
  /** Refund amount in MAJOR units; omitted → Stripe-calculated full refund. */
  amount?: number
  /** ISO 4217 currency for the amount (major→minor conversion); defaults to USD. */
  currency?: string
  /** Optional Stripe refund reason, e.g. "fraudulent", "requested_by_customer". */
  reason?: string
}

export interface RespondToDisputeParams {
  /** The dispute id — "dp_…". */
  id: string
  /** Structured evidence to contest the dispute. */
  evidence?: Record<string, unknown>
  /** `true` accepts the chargeback (submits nothing to contest). */
  close?: boolean
}

export interface CancelSubscriptionParams {
  /** The subscription id — "sub_…". */
  id: string
  /** Invoice immediately for pending proration. */
  invoiceNow?: boolean
  /** Prorate on cancel. */
  prorate?: boolean
}

// ── Trigger payload shapes (what a verified webhook seeds a run with, §7.2) ──

/** `charge.dispute.created` — amounts MAJOR-unit, currency UPPERCASE. */
export interface StripeDisputePayload {
  disputeId: string
  chargeId: string
  amount: number
  currency: string
  reason: string
  evidenceDueBy: string
  eventId: string
  type: string
}

/** `charge.refunded`. */
export interface StripeRefundPayload {
  chargeId: string
  amountRefunded: number
  currency: string
  email?: string
  eventId: string
  type: string
}

/** `invoice.payment_failed`. */
export interface StripeInvoiceFailedPayload {
  invoiceId: string
  subscriptionId: string
  customerId: string
  amountDue: number
  currency: string
  eventId: string
  type: string
}

export type StripeTriggerPayload =
  StripeDisputePayload | StripeRefundPayload | StripeInvoiceFailedPayload
