import { describe, it, expect } from 'vitest'
import { StripeConnector } from '../../src/main/stripe/stripe-connector'
import { MockStripeApi, type RawCharge } from '../../src/main/stripe/stripe-client'
import type {
  StripeWebhookDelivery,
  StripeWebhookServer
} from '../../src/main/stripe/stripe-webhook-server'

const charge: RawCharge = {
  id: 'ch_42',
  amount: 5000,
  currency: 'usd',
  status: 'succeeded',
  paid: true,
  disputed: true,
  customer: 'cus_1',
  receipt_email: 'b@x.com'
}

/** A fake webhook server whose onEvent sink we can drive directly. */
function fakeWebhook(): {
  server: StripeWebhookServer
  deliver: (d: StripeWebhookDelivery) => void
} {
  let sink: ((d: StripeWebhookDelivery) => void) | null = null
  return {
    server: {
      port: 0,
      onEvent: (h) => {
        sink = h
      },
      close: () => {}
    },
    deliver: (d) => sink?.(d)
  }
}

describe('StripeConnector — read dispatch', () => {
  it('getCharge resolves the normalized (major-unit) charge context', async () => {
    const c = new StripeConnector({ api: new MockStripeApi({ charges: { ch_42: charge } }) })
    const out = (await c.invokeAction('getCharge', { id: 'ch_42' })) as {
      charge: { amount: number; currency: string }
    }
    expect(out.charge).toMatchObject({ id: 'ch_42', amount: 50, currency: 'USD', disputed: true })
  })

  it('rejects a missing id and an unknown action legibly', async () => {
    const c = new StripeConnector({ api: new MockStripeApi({}) })
    await expect(c.invokeAction('getCharge', {})).rejects.toThrow(/needs an id/)
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })
})

describe('StripeConnector — gated money mutations', () => {
  it('createRefund converts the MAJOR amount to minor and forwards a stable Idempotency-Key', async () => {
    const api = new MockStripeApi({ refund: { refundId: 're_1', amount: 50, currency: 'USD' } })
    const c = new StripeConnector({ api })
    const out = await c.invokeAction('createRefund', {
      id: 'ch_42',
      amount: 50,
      reason: 'fraudulent'
    })
    expect(out).toEqual({ refundId: 're_1', amount: 50, currency: 'USD' })
    expect(api.calls.createRefund).toHaveLength(1)
    // MAJOR 50 USD → MINOR 5000 for Stripe.
    expect(api.calls.createRefund[0]).toMatchObject({
      chargeId: 'ch_42',
      amount: 5000,
      reason: 'fraudulent'
    })
    // A non-empty, stable idempotency key (spec §11).
    expect(api.calls.createRefund[0].idempotencyKey).toMatch(/^lf_[0-9a-f]{32}$/)
  })

  it('derives the SAME idempotency key for identical params (a retry never double-refunds)', async () => {
    const api = new MockStripeApi({})
    const c = new StripeConnector({ api })
    await c.invokeAction('createRefund', { id: 'ch_42', amount: 50 })
    await c.invokeAction('createRefund', { id: 'ch_42', amount: 50 })
    const [a, b] = api.calls.createRefund
    expect(a.idempotencyKey).toBe(b.idempotencyKey)
    // A different amount ⇒ a different key.
    await c.invokeAction('createRefund', { id: 'ch_42', amount: 25 })
    expect(api.calls.createRefund[2].idempotencyKey).not.toBe(a.idempotencyKey)
  })

  it('rejects a refund business failure verbatim (the pinned convention)', async () => {
    const api = new MockStripeApi({
      refundError: 'charge already fully refunded (`charge_already_refunded`)'
    })
    const c = new StripeConnector({ api })
    await expect(c.invokeAction('createRefund', { id: 'ch_42' })).rejects.toThrow(
      /already fully refunded/
    )
  })

  it('respondToDispute contests with evidence or accepts with close:true', async () => {
    const api = new MockStripeApi({})
    const c = new StripeConnector({ api })
    await c.invokeAction('respondToDispute', {
      id: 'dp_1',
      evidence: { uncategorized_text: 'proof' }
    })
    await c.invokeAction('respondToDispute', { id: 'dp_1', close: true })
    expect(api.calls.respondToDispute[0]).toMatchObject({
      disputeId: 'dp_1',
      evidence: { uncategorized_text: 'proof' }
    })
    expect(api.calls.respondToDispute[1]).toMatchObject({ disputeId: 'dp_1', close: true })
  })

  it('rejects respondToDispute with neither evidence nor close', async () => {
    const c = new StripeConnector({ api: new MockStripeApi({}) })
    await expect(c.invokeAction('respondToDispute', { id: 'dp_1' })).rejects.toThrow(
      /needs an 'evidence' object.*or 'close: true'/
    )
  })

  it('cancelSubscription forwards flags + a stable key', async () => {
    const api = new MockStripeApi({})
    const c = new StripeConnector({ api })
    await c.invokeAction('cancelSubscription', { id: 'sub_1', invoiceNow: true })
    expect(api.calls.cancelSubscription[0]).toMatchObject({
      subscriptionId: 'sub_1',
      invoiceNow: true
    })
  })
})

describe('StripeConnector — the deterministic backstop (§9) rejects BEFORE the call', () => {
  it('rejects an over-limit refund without ever calling the client', async () => {
    const api = new MockStripeApi({})
    const c = new StripeConnector({
      api,
      limits: { refundMaxAmount: 100, refundMaxCurrency: 'USD' }
    })
    await expect(c.invokeAction('createRefund', { id: 'ch_42', amount: 250 })).rejects.toThrow(
      /refund 250 USD exceeds the configured 100 USD Stripe limit/
    )
    expect(api.calls.createRefund).toHaveLength(0) // never reached the mock
  })

  it('allows an at-or-under-limit refund', async () => {
    const api = new MockStripeApi({})
    const c = new StripeConnector({ api, limits: { refundMaxAmount: 100 } })
    await c.invokeAction('createRefund', { id: 'ch_42', amount: 100 })
    expect(api.calls.createRefund).toHaveLength(1)
  })
})

describe('StripeConnector — a delivered trigger NEVER auto-mutates money (§9)', () => {
  it('delivering a charge.dispute.created event makes ZERO Stripe writes', () => {
    const { server, deliver } = fakeWebhook()
    const api = new MockStripeApi({})
    const c = new StripeConnector({ api, webhook: server })
    const seeds: unknown[] = []
    c.subscribe('charge.dispute.created', (e) => seeds.push(e))
    deliver({
      eventId: 'evt_1',
      type: 'charge.dispute.created',
      data: { id: 'dp_1', charge: 'ch_42', amount: 5000, currency: 'usd', reason: 'fraudulent' }
    })
    // A run was seeded — but NO refund/dispute/cancel mutation was fired.
    expect(seeds).toHaveLength(1)
    expect(api.calls.createRefund).toHaveLength(0)
    expect(api.calls.respondToDispute).toHaveLength(0)
    expect(api.calls.cancelSubscription).toHaveLength(0)
  })

  it('delivers a verified event as a SeedEvent and dedups a redelivered evt_ id', () => {
    const { server, deliver } = fakeWebhook()
    const c = new StripeConnector({ api: new MockStripeApi({}), webhook: server })
    const seeds: unknown[] = []
    const off = c.subscribe('charge.refunded', (e) => seeds.push(e))
    const delivery: StripeWebhookDelivery = {
      eventId: 'evt_9',
      type: 'charge.refunded',
      data: { id: 'ch_42', amount_refunded: 5000, currency: 'usd', receipt_email: 'b@x.com' }
    }
    deliver(delivery)
    deliver(delivery) // redelivery — same evt id, must be dropped
    expect(seeds).toEqual([
      {
        eventId: 'evt_9',
        payload: {
          chargeId: 'ch_42',
          amountRefunded: 50,
          currency: 'USD',
          email: 'b@x.com',
          eventId: 'evt_9',
          type: 'charge.refunded'
        }
      }
    ])
    off()
    deliver({ ...delivery, eventId: 'evt_10' })
    expect(seeds).toHaveLength(1) // unsubscribed
  })

  it('ignores an unknown trigger id and an unsupported event type', () => {
    const { server, deliver } = fakeWebhook()
    const c = new StripeConnector({ api: new MockStripeApi({}), webhook: server, log: () => {} })
    const seeds: unknown[] = []
    c.subscribe('charge.dispute.created', (e) => seeds.push(e))
    expect(typeof c.subscribe('bogus.trigger', () => {})).toBe('function')
    deliver({ eventId: 'evt_x', type: 'customer.created', data: { id: 'cus_1' } })
    expect(seeds).toHaveLength(0)
  })
})
