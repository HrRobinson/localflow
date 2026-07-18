import { describe, it, expect } from 'vitest'
import { WcApi } from '../../src/main/woocommerce/wc-api'
import { MockWcTransport, ok, err } from './mock-wc-transport'

const STORE = 'https://shop.example.com'
const KEY = 'ck_live_KEY_do_not_leak'
const SECRET = 'cs_live_SECRET_do_not_leak'

function build(transport: MockWcTransport, storeUrl = STORE): WcApi {
  return new WcApi({
    transport,
    storeUrl,
    reveal: (field) => (field === 'consumerKey' ? KEY : SECRET),
    // Deterministic + fast: no real backoff delay in tests.
    sleep: () => Promise.resolve()
  })
}

const expectedAuth = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64')

describe('WcApi reads', () => {
  it('getOrder GETs wc/v3/orders/<id> with a Basic-auth header and parses JSON', async () => {
    const t = new MockWcTransport(() => ok({ id: 4242, total: '10.00' }))
    const out = await build(t).getOrder('4242')
    expect(out).toEqual({ id: 4242, total: '10.00' })
    expect(t.requests).toHaveLength(1)
    const req = t.requests[0]
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://shop.example.com/wp-json/wc/v3/orders/4242')
    expect(req.headers['Authorization']).toBe(expectedAuth)
  })

  it('getCustomer GETs wc/v3/customers/<id>', async () => {
    const t = new MockWcTransport(() => ok({ id: 7 }))
    await build(t).getCustomer('7')
    expect(t.requests[0].url).toBe('https://shop.example.com/wp-json/wc/v3/customers/7')
  })

  it('searchOrders builds a query string from the given filters', async () => {
    const t = new MockWcTransport(() => ok([]))
    await build(t).searchOrders({ search: 'ada', status: 'processing', customer: '7' })
    const url = new URL(t.requests[0].url)
    expect(url.pathname).toBe('/wp-json/wc/v3/orders')
    expect(url.searchParams.get('search')).toBe('ada')
    expect(url.searchParams.get('status')).toBe('processing')
    expect(url.searchParams.get('customer')).toBe('7')
  })
})

describe('WcApi mutations', () => {
  it('createRefund POSTs to orders/<id>/refunds with api_refund flag + amount', async () => {
    const t = new MockWcTransport(() => ok({ id: 99 }))
    await build(t).createRefund('4242', { amount: '5.00', apiRefund: true })
    const req = t.requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://shop.example.com/wp-json/wc/v3/orders/4242/refunds')
    expect(JSON.parse(req.body ?? '{}')).toEqual({ amount: '5.00', api_refund: true })
  })

  it('updateOrder PUTs a partial body to orders/<id> (cancel / re-address)', async () => {
    const t = new MockWcTransport(() => ok({ id: 4242, status: 'cancelled' }))
    await build(t).updateOrder('4242', { status: 'cancelled' })
    const req = t.requests[0]
    expect(req.method).toBe('PUT')
    expect(req.url).toBe('https://shop.example.com/wp-json/wc/v3/orders/4242')
    expect(JSON.parse(req.body ?? '{}')).toEqual({ status: 'cancelled' })
  })

  it('createOrderNote POSTs to orders/<id>/notes with the customer_note flag', async () => {
    const t = new MockWcTransport(() => ok({ id: 1 }))
    await build(t).createOrderNote('4242', { note: 'shipped', customerNote: true })
    const req = t.requests[0]
    expect(req.url).toBe('https://shop.example.com/wp-json/wc/v3/orders/4242/notes')
    expect(JSON.parse(req.body ?? '{}')).toEqual({ note: 'shipped', customer_note: true })
  })
})

describe('WcApi errors (spec §8 — human, actionable, real cause)', () => {
  it('401 → a "rejected the API keys" message naming the fix', async () => {
    const t = new MockWcTransport(() => err(401))
    await expect(build(t).getOrder('1')).rejects.toThrow(/rejected the API keys \(401\)/i)
  })

  it('403 → a read-only-key message pointing at Read/Write', async () => {
    const t = new MockWcTransport(() => err(403))
    await expect(build(t).createRefund('1', { apiRefund: true })).rejects.toThrow(/read-only/i)
  })

  it('404 → an order-not-in-this-store message', async () => {
    const t = new MockWcTransport(() => err(404))
    await expect(build(t).getOrder('999')).rejects.toThrow(/isn't in this store|404/i)
  })

  it('400 → forwards the verbatim WC body message, not a generic "failed"', async () => {
    const t = new MockWcTransport(() => err(400, 'Invalid refund amount'))
    await expect(build(t).createRefund('1', { amount: '9999', apiRefund: true })).rejects.toThrow(
      /Invalid refund amount/
    )
  })

  it('a transport (network) failure surfaces an "unreachable" message with the host', async () => {
    const t = new MockWcTransport(() => {
      throw new Error('ECONNREFUSED')
    })
    await expect(build(t).getOrder('1')).rejects.toThrow(/unreachable/i)
  })

  it('refuses a private/loopback store URL BEFORE any request (SSRF guard)', async () => {
    const t = new MockWcTransport(() => ok({}))
    await expect(build(t, 'https://169.254.169.254').getOrder('1')).rejects.toThrow(
      /private|loopback|refus/i
    )
    expect(t.requests).toHaveLength(0)
  })

  it('refuses a non-https store URL BEFORE any request', async () => {
    const t = new MockWcTransport(() => ok({}))
    await expect(build(t, 'http://shop.example.com').getOrder('1')).rejects.toThrow(/https/i)
    expect(t.requests).toHaveLength(0)
  })
})

describe('WcApi backoff (spec §2.4 — no Retry-After to honor)', () => {
  it('retries a 429 with capped backoff then succeeds', async () => {
    let calls = 0
    const t = new MockWcTransport(() => {
      calls += 1
      return calls < 3 ? err(429) : ok({ id: 4242 })
    })
    const out = await build(t).getOrder('4242')
    expect(out).toEqual({ id: 4242 })
    expect(calls).toBe(3)
  })

  it('gives up after the retry cap and throws a legible 5xx message', async () => {
    const t = new MockWcTransport(() => err(503))
    await expect(build(t).getOrder('4242')).rejects.toThrow(/503/)
    // 1 initial + capped retries — bounded, never infinite.
    expect(t.requests.length).toBeGreaterThan(1)
    expect(t.requests.length).toBeLessThanOrEqual(4)
  })
})
