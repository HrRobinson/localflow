import { minorToMajor, currencyDecimals } from '../../shared/money'
import type { RawCharge, RawCustomer, RawDispute, RawSubscription } from './stripe-client'
import type {
  StripeChargeContext,
  StripeChargeStatus,
  StripeCustomerContext,
  StripeDisputeContext,
  StripeDisputeStatus,
  StripeSubscriptionContext,
  StripeSubscriptionStatus,
  StripeTriggerId,
  StripeTriggerPayload
} from '../../shared/stripe'

/**
 * PURE normalization (spec §6.3, §10) — the correctness boundary the conditions
 * track depends on. A raw Stripe object (or a raw webhook event's `data.object`)
 * becomes the PINNED context/trigger shape. This is where the money convention is
 * enforced: EVERY amount is converted from Stripe's MINOR-unit integer to a
 * MAJOR-unit `number` via the shared `minorToMajor(amount, currency)`, and
 * `currency` is UPPERCASED (Stripe's wire form is lowercase `"usd"`), so a Stripe
 * amount and a Shopify `order.total` live on the SAME scale and a lowercase `"usd"`
 * compares equal to Shopify's `"USD"` (§6.3 — the 100×-and-case-mismatch bug this
 * boundary prevents). Unix timestamps become ISO 8601; Stripe ids stay bare.
 * Never throws — a sparse/garbage object normalizes to safe defaults so a
 * malformed read never crashes a run (mirrors `shopify-normalize.ts`).
 */

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** UPPERCASE ISO 4217 (Stripe sends lowercase). Empty stays empty. */
function upperCurrency(v: unknown): string {
  return str(v).toUpperCase()
}

/** Stripe unix seconds → ISO 8601; absent/invalid → ''. */
function isoFromUnix(sec: unknown): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return ''
  return new Date(sec * 1000).toISOString()
}

/** Convert a MAJOR-unit amount (the author-facing value) back to Stripe's
 *  MINOR-unit integer for an outgoing mutation. Reuses the shared exponent table
 *  (`currencyDecimals`) — the inverse of `minorToMajor`, so the two never drift. */
export function majorToMinor(major: number, currency: string): number {
  if (!Number.isFinite(major)) return 0
  return Math.round(major * 10 ** currencyDecimals(currency))
}

const CHARGE_STATUS: Record<string, StripeChargeStatus> = {
  succeeded: 'succeeded',
  pending: 'pending',
  failed: 'failed'
}

const DISPUTE_STATUS: Record<string, StripeDisputeStatus> = {
  warning_needs_response: 'warning_needs_response',
  needs_response: 'needs_response',
  under_review: 'under_review',
  won: 'won',
  lost: 'lost',
  charge_refunded: 'charge_refunded'
}

const SUBSCRIPTION_STATUS: Record<string, StripeSubscriptionStatus> = {
  active: 'active',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  incomplete: 'incomplete',
  trialing: 'trialing',
  paused: 'paused'
}

export function normalizeCharge(raw: RawCharge): StripeChargeContext {
  const currency = upperCurrency(raw.currency)
  const email = str(raw.receipt_email) || str(raw.billing_details?.email)
  return {
    charge: {
      id: str(raw.id),
      amount: minorToMajor(Number(raw.amount ?? 0), currency),
      currency,
      amountRefunded: minorToMajor(Number(raw.amount_refunded ?? 0), currency),
      status: CHARGE_STATUS[str(raw.status)] ?? 'pending',
      paid: raw.paid === true,
      refunded: raw.refunded === true,
      disputed: raw.disputed === true,
      customerId: str(raw.customer),
      email,
      paymentIntentId: str(raw.payment_intent),
      createdAt: isoFromUnix(raw.created)
    }
  }
}

export function normalizeDispute(raw: RawDispute): StripeDisputeContext {
  const currency = upperCurrency(raw.currency)
  return {
    dispute: {
      id: str(raw.id),
      chargeId: str(raw.charge),
      amount: minorToMajor(Number(raw.amount ?? 0), currency),
      currency,
      reason: str(raw.reason),
      status: DISPUTE_STATUS[str(raw.status)] ?? 'needs_response',
      evidenceDueBy: isoFromUnix(raw.evidence_details?.due_by)
    }
  }
}

export function normalizeCustomer(raw: RawCustomer): StripeCustomerContext {
  return {
    customer: {
      id: str(raw.id),
      email: str(raw.email),
      name: str(raw.name),
      currency: upperCurrency(raw.currency),
      delinquent: raw.delinquent === true
    }
  }
}

export function normalizeSubscription(raw: RawSubscription): StripeSubscriptionContext {
  const currency = upperCurrency(raw.currency)
  const unitAmount = raw.items?.data?.[0]?.price?.unit_amount
  return {
    subscription: {
      id: str(raw.id),
      customerId: str(raw.customer),
      status: SUBSCRIPTION_STATUS[str(raw.status)] ?? 'active',
      amount: minorToMajor(Number(unitAmount ?? 0), currency),
      currency,
      currentPeriodEnd: isoFromUnix(raw.current_period_end),
      cancelAtPeriodEnd: raw.cancel_at_period_end === true
    }
  }
}

// ── Webhook event → trigger payload (§7.2) ───────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Which pinned trigger id(s) a verified Stripe `event.type` fires. All three are
 * native 1:1 events; an unsupported type fires nothing (§6.1, §7.2).
 */
export function triggersForType(type: string): StripeTriggerId[] {
  switch (type) {
    case 'charge.dispute.created':
      return ['charge.dispute.created']
    case 'charge.refunded':
      return ['charge.refunded']
    case 'invoice.payment_failed':
      return ['invoice.payment_failed']
    default:
      return []
  }
}

/**
 * Normalize a verified event's `type` + `data.object` into a `StripeTriggerPayload`,
 * or `null` when the type is unsupported or the object is unusable (so no run is
 * ever seeded on an unexpected shape — §7.2). Amounts are ALREADY major-unit and
 * currency UPPERCASE, so a downstream `{{t.amount}}` composes with Shopify.
 */
export function eventToPayload(
  type: string,
  data: unknown,
  eventId: string
): StripeTriggerPayload | null {
  if (!isObj(data)) return null
  switch (type) {
    case 'charge.dispute.created': {
      const currency = upperCurrency(data.currency)
      const disputeId = str(data.id)
      const chargeId = str(data.charge)
      if (disputeId.length === 0 && chargeId.length === 0) return null
      return {
        disputeId,
        chargeId,
        amount: minorToMajor(Number(data.amount ?? 0), currency),
        currency,
        reason: str(data.reason),
        evidenceDueBy: isoFromUnix(
          isObj(data.evidence_details) ? data.evidence_details.due_by : undefined
        ),
        eventId,
        type
      }
    }
    case 'charge.refunded': {
      const currency = upperCurrency(data.currency)
      const chargeId = str(data.id)
      if (chargeId.length === 0) return null
      const email = str(data.receipt_email)
      const payload = {
        chargeId,
        amountRefunded: minorToMajor(Number(data.amount_refunded ?? 0), currency),
        currency,
        eventId,
        type
      } as StripeTriggerPayload & { email?: string }
      if (email.length > 0) payload.email = email
      return payload
    }
    case 'invoice.payment_failed': {
      const currency = upperCurrency(data.currency)
      const invoiceId = str(data.id)
      if (invoiceId.length === 0) return null
      return {
        invoiceId,
        subscriptionId: str(data.subscription),
        customerId: str(data.customer),
        amountDue: minorToMajor(Number(data.amount_due ?? 0), currency),
        currency,
        eventId,
        type
      }
    }
    default:
      return null
  }
}
