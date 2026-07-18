import { describe, it, expect } from 'vitest'
import {
  normalizeCharge,
  normalizeCustomer,
  normalizeDispute,
  normalizeSubscription,
  majorToMinor,
  triggersForType,
  eventToPayload
} from '../../src/main/stripe/stripe-normalize'
import type { RawCharge, RawDispute, RawSubscription } from '../../src/main/stripe/stripe-client'
import { normalizeOrder } from '../../src/main/shopify/shopify-normalize'
import type { StripeDisputePayload, StripeInvoiceFailedPayload } from '../../src/shared/stripe'

const fullCharge: RawCharge = {
  id: 'ch_123',
  amount: 5000, // minor units
  currency: 'usd', // lowercase on the wire
  amount_refunded: 1000,
  status: 'succeeded',
  paid: true,
  refunded: false,
  disputed: true,
  customer: 'cus_9',
  receipt_email: 'buyer@example.com',
  payment_intent: 'pi_7',
  created: 1_700_000_000
}

describe('normalizeCharge — the money-convention correctness boundary (§6.3)', () => {
  it('converts minor→major (USD 5000→50), uppercases currency, ISO-dates the unix ts', () => {
    const ctx = normalizeCharge(fullCharge)
    expect(ctx.charge).toEqual({
      id: 'ch_123',
      amount: 50, // 5000 minor USD → 50 MAJOR
      currency: 'USD', // lowercase "usd" → UPPERCASE (matches Shopify)
      amountRefunded: 10, // 1000 minor USD → 10 MAJOR
      status: 'succeeded',
      paid: true,
      refunded: false,
      disputed: true,
      customerId: 'cus_9',
      email: 'buyer@example.com',
      paymentIntentId: 'pi_7',
      createdAt: '2023-11-14T22:13:20.000Z'
    })
    expect(typeof ctx.charge.amount).toBe('number')
  })

  it('handles zero-decimal (JPY 5000→5000) and three-decimal (BHD 5000→5.0) currencies', () => {
    expect(normalizeCharge({ amount: 5000, currency: 'jpy' }).charge.amount).toBe(5000)
    expect(normalizeCharge({ amount: 5000, currency: 'bhd' }).charge.amount).toBe(5)
    // BHD three-decimal: 4200 minor → 4.2 major (distinct from USD's 42).
    expect(normalizeCharge({ amount: 4200, currency: 'bhd' }).charge.amount).toBe(4.2)
    expect(normalizeCharge({ amount: 4200, currency: 'usd' }).charge.amount).toBe(42)
  })

  it('falls back to billing_details.email and empty strings for absent ids', () => {
    const ctx = normalizeCharge({
      amount: 100,
      currency: 'usd',
      billing_details: { email: 'b@x.io' }
    })
    expect(ctx.charge.email).toBe('b@x.io')
    expect(ctx.charge.customerId).toBe('')
    expect(ctx.charge.paymentIntentId).toBe('')
  })

  it('never throws on a sparse/garbage object — safe defaults', () => {
    const ctx = normalizeCharge({})
    expect(ctx.charge).toMatchObject({
      id: '',
      amount: 0,
      currency: '',
      status: 'pending',
      createdAt: ''
    })
  })
})

// ── The cross-connector equal-scale proof (§6.3, §7.3) ───────────────────────
describe('a Stripe amount compares equal-scale to a Shopify amount', () => {
  it('Stripe minor 5000 USD and Shopify "50.00" USD normalize to the SAME number + currency', () => {
    const stripe = normalizeCharge({ amount: 5000, currency: 'usd' }).charge
    const shopify = normalizeOrder({
      totalPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } }
    }).order
    // Same SCALE (major units) — the 100×-bug this boundary prevents (§6.3).
    expect(stripe.amount).toBe(shopify.total)
    expect(stripe.amount).toBe(50)
    // Same CURRENCY casing — a lowercase "usd" would silently never match "USD".
    expect(stripe.currency).toBe(shopify.currency)
    expect(stripe.currency).toBe('USD')
  })

  it('WITHOUT conversion the raw minor integer would be 100× the Shopify total (the bug)', () => {
    const rawMinor = 5000
    const shopifyTotal = normalizeOrder({
      totalPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } }
    }).order.total
    expect(rawMinor).not.toBe(shopifyTotal) // 5000 !== 50 — a misroute on `lte 50`
    expect(normalizeCharge({ amount: rawMinor, currency: 'usd' }).charge.amount).toBe(shopifyTotal)
  })
})

describe('majorToMinor — the inverse used for outgoing refunds', () => {
  it('round-trips per currency class (USD, JPY, BHD)', () => {
    expect(majorToMinor(50, 'USD')).toBe(5000)
    expect(majorToMinor(5000, 'JPY')).toBe(5000)
    expect(majorToMinor(4.2, 'BHD')).toBe(4200)
  })
})

describe('normalizeDispute / normalizeCustomer / normalizeSubscription', () => {
  it('normalizes a dispute (amount major, currency upper, due_by ISO)', () => {
    const raw: RawDispute = {
      id: 'dp_1',
      charge: 'ch_123',
      amount: 5000,
      currency: 'usd',
      reason: 'fraudulent',
      status: 'needs_response',
      evidence_details: { due_by: 1_700_000_000 }
    }
    expect(normalizeDispute(raw).dispute).toEqual({
      id: 'dp_1',
      chargeId: 'ch_123',
      amount: 50,
      currency: 'USD',
      reason: 'fraudulent',
      status: 'needs_response',
      evidenceDueBy: '2023-11-14T22:13:20.000Z'
    })
  })

  it('normalizes a customer with uppercase default currency', () => {
    expect(
      normalizeCustomer({
        id: 'cus_1',
        email: 'a@b.io',
        name: 'Ada',
        currency: 'eur',
        delinquent: true
      }).customer
    ).toEqual({ id: 'cus_1', email: 'a@b.io', name: 'Ada', currency: 'EUR', delinquent: true })
  })

  it('normalizes a subscription (unit_amount minor→major)', () => {
    const raw: RawSubscription = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      currency: 'usd',
      current_period_end: 1_700_000_000,
      cancel_at_period_end: false,
      items: { data: [{ price: { unit_amount: 1500 } }] }
    }
    expect(normalizeSubscription(raw).subscription).toMatchObject({
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      amount: 15,
      currency: 'USD',
      cancelAtPeriodEnd: false
    })
  })
})

describe('event → trigger payload (§7.2)', () => {
  it('maps charge.dispute.created to its normalized payload (amount major, currency upper)', () => {
    const payload = eventToPayload(
      'charge.dispute.created',
      {
        id: 'dp_1',
        charge: 'ch_9',
        amount: 5000,
        currency: 'usd',
        reason: 'fraudulent',
        evidence_details: { due_by: 1_700_000_000 }
      },
      'evt_1'
    ) as StripeDisputePayload
    expect(payload).toEqual({
      disputeId: 'dp_1',
      chargeId: 'ch_9',
      amount: 50,
      currency: 'USD',
      reason: 'fraudulent',
      evidenceDueBy: '2023-11-14T22:13:20.000Z',
      eventId: 'evt_1',
      type: 'charge.dispute.created'
    })
    expect(triggersForType('charge.dispute.created')).toEqual(['charge.dispute.created'])
  })

  it('maps invoice.payment_failed with major-unit amountDue', () => {
    const payload = eventToPayload(
      'invoice.payment_failed',
      { id: 'in_1', subscription: 'sub_1', customer: 'cus_1', amount_due: 2500, currency: 'usd' },
      'evt_2'
    ) as StripeInvoiceFailedPayload
    expect(payload).toMatchObject({
      invoiceId: 'in_1',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      amountDue: 25,
      currency: 'USD'
    })
    expect(triggersForType('invoice.payment_failed')).toEqual(['invoice.payment_failed'])
  })

  it('returns null for an unsupported type or a non-object data (no run seeds)', () => {
    expect(eventToPayload('customer.created', { id: 'cus_1' }, 'evt_3')).toBeNull()
    expect(eventToPayload('charge.refunded', 'not-an-object', 'evt_4')).toBeNull()
    expect(triggersForType('customer.created')).toEqual([])
  })
})
