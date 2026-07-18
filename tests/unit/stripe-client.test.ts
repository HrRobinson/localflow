import { describe, it, expect, vi } from 'vitest'
import {
  StripeApiClient,
  type StripeRequest,
  type StripeResponse,
  type StripeTransport
} from '../../src/main/stripe/stripe-client'

const noSleep = (): Promise<void> => Promise.resolve()

/** A transport that answers each call from a scripted queue and records requests. */
function scripted(responses: StripeResponse[]): {
  transport: StripeTransport
  requests: StripeRequest[]
} {
  const requests: StripeRequest[] = []
  let i = 0
  return {
    requests,
    transport: (req) => {
      requests.push(req)
      return Promise.resolve(responses[Math.min(i++, responses.length - 1)])
    }
  }
}

describe('StripeApiClient — read paths', () => {
  it('GETs a charge and returns the raw body for the normalizer', async () => {
    const { transport, requests } = scripted([
      { status: 200, body: { id: 'ch_1', amount: 5000, currency: 'usd' } }
    ])
    const api = new StripeApiClient({ transport })
    const charge = await api.getCharge('ch_1')
    expect(charge).toMatchObject({ id: 'ch_1', amount: 5000 })
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/charges/ch_1' })
  })
})

describe('StripeApiClient — legible, actionable error mapping (§11)', () => {
  const cases: [number, StripeResponse['body'], RegExp][] = [
    [401, { error: { type: 'authentication_error' } }, /rejected the API key \(401\)/],
    [
      403,
      { error: { message: "can't write refunds" } },
      /lacks a required permission.*can't write refunds/
    ],
    [404, {}, /Stripe has no charge 'ch_x'/],
    [
      200,
      {
        error: {
          type: 'invalid_request_error',
          code: 'charge_already_refunded',
          message: 'already refunded'
        }
      },
      /Stripe refused the charge: already refunded \(`charge_already_refunded`\)/
    ]
  ]
  it.each(cases)('maps HTTP %s to a rejection', async (status, body, pattern) => {
    const { transport } = scripted([{ status, body }])
    const api = new StripeApiClient({ transport, sleep: noSleep })
    await expect(api.getCharge('ch_x')).rejects.toThrow(pattern)
  })

  it('rejects with the underlying cause when the transport itself throws', async () => {
    const api = new StripeApiClient({
      transport: () => Promise.reject(new Error('ECONNREFUSED')),
      sleep: noSleep
    })
    await expect(api.getCharge('ch_1')).rejects.toThrow(
      /Couldn't reach the Stripe API.*ECONNREFUSED/
    )
  })
})

describe('StripeApiClient — 429 backoff honoring Retry-After', () => {
  it('retries a 429 then succeeds, sleeping between attempts', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    const { transport } = scripted([
      { status: 429, body: { error: { type: 'rate_limit_error' } }, retryAfter: 2 },
      { status: 200, body: { id: 'ch_1', amount: 100, currency: 'usd' } }
    ])
    const api = new StripeApiClient({ transport, sleep })
    const charge = await api.getCharge('ch_1')
    expect(charge).toMatchObject({ id: 'ch_1' })
    expect(sleep).toHaveBeenCalledWith(2000) // Retry-After: 2s honored
  })

  it('rejects legibly after exhausting retries (not swallowed)', async () => {
    const { transport } = scripted([{ status: 429, body: {}, retryAfter: 1 }])
    const api = new StripeApiClient({ transport, sleep: noSleep, maxRateLimitRetries: 2 })
    await expect(api.getCharge('ch_1')).rejects.toThrow(/Stripe throttled the request/)
  })
})

describe('StripeApiClient — mutations send an Idempotency-Key + convert the result', () => {
  it('createRefund posts /v1/refunds with the idempotency key and normalizes the minor result', async () => {
    const { transport, requests } = scripted([
      { status: 200, body: { id: 're_1', amount: 5000, currency: 'usd' } }
    ])
    const api = new StripeApiClient({ transport })
    const result = await api.createRefund({
      chargeId: 'ch_1',
      amount: 5000,
      idempotencyKey: 'lf_abc'
    })
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/refunds',
      form: { charge: 'ch_1', amount: 5000 },
      idempotencyKey: 'lf_abc'
    })
    // The result's own minor amount is converted back to MAJOR + uppercase currency.
    expect(result).toEqual({ refundId: 're_1', amount: 50, currency: 'USD' })
  })

  it('cancelSubscription DELETEs the subscription path', async () => {
    const { transport, requests } = scripted([
      { status: 200, body: { id: 'sub_1', status: 'canceled' } }
    ])
    const api = new StripeApiClient({ transport })
    const out = await api.cancelSubscription({ subscriptionId: 'sub_1', idempotencyKey: 'lf_x' })
    expect(requests[0]).toMatchObject({ method: 'DELETE', path: '/v1/subscriptions/sub_1' })
    expect(out).toEqual({ subscriptionId: 'sub_1', status: 'canceled' })
  })
})
