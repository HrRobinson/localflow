import { describe, it, expect } from 'vitest'
import { WcApi } from '../../src/main/woocommerce/wc-api'
import { WoocommerceConnector } from '../../src/main/woocommerce/woocommerce-connector'
import type { WcWebhookEvent } from '../../src/main/woocommerce/wc-webhook-server'
import { MockWcTransport, ok } from './mock-wc-transport'

const STORE = 'https://shop.example.com'
const KEY = 'ck_live_KEY_do_not_leak_9f3a'
const SECRET = 'cs_live_SECRET_do_not_leak_2b7c'

function buildApi(transport: MockWcTransport): WcApi {
  return new WcApi({
    transport,
    storeUrl: STORE,
    reveal: (f) => (f === 'consumerKey' ? KEY : SECRET),
    sleep: () => Promise.resolve()
  })
}

const orderJson = {
  id: 4242,
  total: '129.95',
  currency: 'USD',
  status: 'processing',
  customer_id: 7,
  billing: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' }
}

const webhookEvent = (): WcWebhookEvent => ({
  topic: 'order.created',
  deliveryId: 'del-9',
  payload: {
    order: {
      id: '4242',
      total: 129.95,
      currency: 'USD',
      status: 'processing',
      email: 'ada@example.com'
    },
    customer: { id: '7', email: 'ada@example.com', name: 'Ada Lovelace' }
  }
})

describe('WoocommerceConnector — read dispatch', () => {
  it('getOrder → GET orders/<id>, normalized to order.* / customer.*', async () => {
    const t = new MockWcTransport(() => ok(orderJson))
    const out = await new WoocommerceConnector({ api: buildApi(t) }).invokeAction('getOrder', {
      orderId: '4242'
    })
    expect(t.requests[0].url).toBe('https://shop.example.com/wp-json/wc/v3/orders/4242')
    expect(out).toEqual({
      order: {
        id: '4242',
        total: 129.95,
        currency: 'USD',
        status: 'processing',
        email: 'ada@example.com'
      },
      customer: { id: '7', email: 'ada@example.com', name: 'Ada Lovelace' }
    })
  })

  it('getCustomer → GET customers/<id>, normalized customer view', async () => {
    const t = new MockWcTransport(() =>
      ok({ id: 7, email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' })
    )
    const out = await new WoocommerceConnector({ api: buildApi(t) }).invokeAction('getCustomer', {
      customerId: '7'
    })
    expect(t.requests[0].url).toBe('https://shop.example.com/wp-json/wc/v3/customers/7')
    expect(out).toEqual({ id: '7', email: 'ada@example.com', name: 'Ada Lovelace' })
  })

  it('rejects a read with a missing id, legibly, before any request', async () => {
    const t = new MockWcTransport(() => ok(orderJson))
    await expect(
      new WoocommerceConnector({ api: buildApi(t) }).invokeAction('getOrder', {})
    ).rejects.toThrow(/orderId/i)
    expect(t.requests).toHaveLength(0)
  })
})

describe('WoocommerceConnector — gated mutation dispatch', () => {
  it('refundOrder → POST orders/<id>/refunds, api_refund defaults to record-only (false)', async () => {
    const t = new MockWcTransport(() => ok({ id: 1 }))
    await new WoocommerceConnector({ api: buildApi(t) }).invokeAction('refundOrder', {
      orderId: '4242',
      amount: '5.00'
    })
    const req = t.requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://shop.example.com/wp-json/wc/v3/orders/4242/refunds')
    expect(JSON.parse(req.body ?? '{}')).toEqual({ amount: '5.00', api_refund: false })
  })

  it('refundOrder honors an explicit viaGateway opt-in', async () => {
    const t = new MockWcTransport(() => ok({ id: 1 }))
    await new WoocommerceConnector({ api: buildApi(t) }).invokeAction('refundOrder', {
      orderId: '4242',
      viaGateway: true
    })
    expect(JSON.parse(t.requests[0].body ?? '{}')).toEqual({ api_refund: true })
  })

  it('cancelOrder → PUT orders/<id> { status: cancelled }', async () => {
    const t = new MockWcTransport(() => ok({ id: 4242 }))
    await new WoocommerceConnector({ api: buildApi(t) }).invokeAction('cancelOrder', {
      orderId: '4242'
    })
    expect(t.requests[0].method).toBe('PUT')
    expect(JSON.parse(t.requests[0].body ?? '{}')).toEqual({ status: 'cancelled' })
  })

  it('updateShippingAddress → PUT orders/<id> { shipping }', async () => {
    const t = new MockWcTransport(() => ok({ id: 4242 }))
    await new WoocommerceConnector({ api: buildApi(t) }).invokeAction('updateShippingAddress', {
      orderId: '4242',
      shipping: { address_1: '1 New St', city: 'Metropolis' }
    })
    expect(JSON.parse(t.requests[0].body ?? '{}')).toEqual({
      shipping: { address_1: '1 New St', city: 'Metropolis' }
    })
  })

  it('addOrderNote → POST orders/<id>/notes { note, customer_note }', async () => {
    const t = new MockWcTransport(() => ok({ id: 1 }))
    await new WoocommerceConnector({ api: buildApi(t) }).invokeAction('addOrderNote', {
      orderId: '4242',
      note: 'Refund processed',
      customerNote: true
    })
    expect(t.requests[0].url).toBe('https://shop.example.com/wp-json/wc/v3/orders/4242/notes')
    expect(JSON.parse(t.requests[0].body ?? '{}')).toEqual({
      note: 'Refund processed',
      customer_note: true
    })
  })

  it('rejects an unknown action id legibly', async () => {
    const t = new MockWcTransport(() => ok({}))
    await expect(
      new WoocommerceConnector({ api: buildApi(t) }).invokeAction('deleteEverything', {})
    ).rejects.toThrow(/unknown WooCommerce action/i)
    expect(t.requests).toHaveLength(0)
  })
})

describe('WoocommerceConnector — subscribe fan-out + authority', () => {
  it('a webhook event fans out to the matching topic handler as a SeedEvent', () => {
    const t = new MockWcTransport(() => ok({}))
    const connector = new WoocommerceConnector({ api: buildApi(t) })
    const seen: unknown[] = []
    connector.subscribe('order.created', (e) => seen.push(e))
    connector.deliver(webhookEvent())
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ eventId: 'del-9', payload: { order: { total: 129.95 } } })
  })

  it('does not deliver to a handler subscribed to a different topic', () => {
    const t = new MockWcTransport(() => ok({}))
    const connector = new WoocommerceConnector({ api: buildApi(t) })
    const seen: unknown[] = []
    connector.subscribe('order.refundRequested', (e) => seen.push(e))
    connector.deliver(webhookEvent())
    expect(seen).toHaveLength(0)
  })

  it('unsubscribe stops further delivery', () => {
    const t = new MockWcTransport(() => ok({}))
    const connector = new WoocommerceConnector({ api: buildApi(t) })
    const seen: unknown[] = []
    const off = connector.subscribe('order.created', (e) => seen.push(e))
    off()
    connector.deliver(webhookEvent())
    expect(seen).toHaveLength(0)
  })

  it('★ AUTHORITY: a delivered trigger NEVER fires a mutation on its own', () => {
    // The connector exposes mutations; it only ever runs one an action node
    // invoked. A webhook arriving must make ZERO write calls to the store.
    const t = new MockWcTransport(() => ok({}))
    const connector = new WoocommerceConnector({ api: buildApi(t) })
    connector.subscribe('order.created', () => {})
    connector.deliver(webhookEvent())
    expect(t.requests).toHaveLength(0)
  })
})

/** ★ The load-bearing secret invariant (spec §9): no consumer key/secret VALUE
 *  ever appears in a returned value, a log line, or an error surfaced onward. */
describe('WoocommerceConnector — no secret leak', () => {
  it('never surfaces the consumer key/secret through outputs, logs, or errors', async () => {
    const logs: string[] = []
    const t = new MockWcTransport(() => ok(orderJson))
    const connector = new WoocommerceConnector({ api: buildApi(t), log: (m) => logs.push(m) })

    const read = await connector.invokeAction('getOrder', { orderId: '4242' })
    connector.subscribe('order.created', () => {
      throw new Error('handler boom') // force a route+reason log
    })
    connector.deliver(webhookEvent())

    let errMsg = ''
    try {
      const bad = new MockWcTransport(() => ({ status: 401, body: '' }))
      await new WoocommerceConnector({ api: buildApi(bad) }).invokeAction('getOrder', {
        orderId: '1'
      })
    } catch (e) {
      errMsg = (e as Error).message
    }

    const surfaced = [JSON.stringify(read), logs.join('\n'), errMsg].join('\n')
    expect(surfaced).not.toContain(KEY)
    expect(surfaced).not.toContain(SECRET)
    // …and the Authorization header carrying them is never logged either.
    expect(logs.join('\n')).not.toMatch(/Authorization|Basic /)
  })
})
