import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startStripeWebhookServer,
  STRIPE_VERIFIER,
  type StripeWebhookDelivery,
  type StripeWebhookServer
} from '../../src/main/stripe/stripe-webhook-server'
import { verifyWebhookSignature } from '../../src/main/webhooks/webhook-receiver'

const SECRET = 'whsec_stripe_test_secret'
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
const nowSec = () => Math.floor(Date.now() / 1000)

/** Build a valid Stripe-Signature header for a body at timestamp `t`. */
function stripeSig(body: string, t: number, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex')
  return `t=${t},v1=${v1}`
}

describe('STRIPE_VERIFIER config (§7.1) — the reference signsTimestamp case', () => {
  it('pins the Stripe scheme: hmac-sha256 hex over ${t}.${body} with a 300s window', () => {
    expect(STRIPE_VERIFIER).toMatchObject({
      scheme: 'hmac',
      algo: 'sha256',
      header: 'stripe-signature',
      encoding: 'hex',
      signsTimestamp: true,
      toleranceSec: 300
    })
  })

  it('parseHeader extracts t and the first v1 (key rotation sends multiple v1s)', () => {
    const parse = STRIPE_VERIFIER.scheme === 'hmac' ? STRIPE_VERIFIER.parseHeader : undefined
    expect(parse?.('t=123,v1=abc,v1=def')).toEqual({ timestamp: '123', signature: 'abc' })
    expect(parse?.('garbage')).toBeNull()
  })

  it('verifies a valid in-window signature and rejects a stale one (replay defense)', () => {
    const body = '{"type":"charge.refunded"}'
    const t = nowSec()
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'stripe-signature': stripeSig(body, t) },
        STRIPE_VERIFIER,
        SECRET
      )
    ).toBe(true)
    // 400s in the past → outside the 300s tolerance → rejected.
    const stale = stripeSig(body, t - 400)
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'stripe-signature': stale },
        STRIPE_VERIFIER,
        SECRET
      )
    ).toBe(false)
  })

  it('rejects a forged signature and a body signed WITHOUT the ${t}. prefix', () => {
    const body = '{"type":"charge.refunded"}'
    const t = nowSec()
    // signed over the body alone (no timestamp) — the classic replay/forgery.
    const forged = `t=${t},v1=${createHmac('sha256', SECRET).update(body).digest('hex')}`
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'stripe-signature': forged },
        STRIPE_VERIFIER,
        SECRET
      )
    ).toBe(false)
  })
})

describe('startStripeWebhookServer — end-to-end pipeline', () => {
  let receiver: StripeWebhookServer | undefined
  afterEach(() => {
    receiver?.close()
    receiver = undefined
  })

  async function post(r: StripeWebhookServer, body: string, sig: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${r.port}/stripe/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': sig },
      body
    })
    return res.status
  }

  it('verifies, parses a well-formed event, and delivers a StripeWebhookDelivery once', async () => {
    const seen: StripeWebhookDelivery[] = []
    receiver = await startStripeWebhookServer({ secret: SECRET })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_1', amount: 5000, currency: 'usd' } }
    })
    expect(await post(receiver, body, stripeSig(body, nowSec()))).toBe(200)
    await flush()
    expect(seen).toEqual([
      {
        eventId: 'evt_1',
        type: 'charge.dispute.created',
        data: { id: 'dp_1', charge: 'ch_1', amount: 5000, currency: 'usd' }
      }
    ])
  })

  it('401s a forged signature and never delivers', async () => {
    const seen: StripeWebhookDelivery[] = []
    receiver = await startStripeWebhookServer({ secret: SECRET })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({
      id: 'evt_2',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1' } }
    })
    expect(await post(receiver, body, 't=1,v1=deadbeef')).toBe(401)
    await flush()
    expect(seen).toHaveLength(0)
  })

  it('400s a verified-but-malformed event (no data.object) — no run seeded', async () => {
    receiver = await startStripeWebhookServer({ secret: SECRET, log: () => {} })
    const body = JSON.stringify({ id: 'evt_3', type: 'charge.refunded' }) // no data.object
    expect(await post(receiver, body, stripeSig(body, nowSec()))).toBe(400)
  })
})
