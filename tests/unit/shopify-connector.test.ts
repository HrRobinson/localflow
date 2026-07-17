import { describe, it, expect, vi } from 'vitest'
import { ShopifyConnector } from '../../src/main/shopify/shopify-connector'
import { MockShopifyApi, type RawOrderNode } from '../../src/main/shopify/shopify-admin'
import type {
  ShopifyWebhookDelivery,
  ShopifyWebhookServer
} from '../../src/main/shopify/shopify-webhook-server'

const orderNode: RawOrderNode = {
  id: 'gid://shopify/Order/42',
  name: '#1001',
  email: 'b@x.com',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  totalPriceSet: { shopMoney: { amount: '42.50', currencyCode: 'USD' } },
  lineItems: { nodes: [{ id: 'a' }] }
}

/** A fake webhook server whose onEvent sink we can drive directly. */
function fakeWebhook(): {
  server: ShopifyWebhookServer
  deliver: (d: ShopifyWebhookDelivery) => void
} {
  let sink: ((d: ShopifyWebhookDelivery) => void) | null = null
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

describe('ShopifyConnector — action dispatch', () => {
  it('getOrder resolves the normalized order context', async () => {
    const c = new ShopifyConnector({ api: new MockShopifyApi({ orders: { '42': orderNode } }) })
    const out = (await c.invokeAction('getOrder', { id: '42' })) as { order: { total: number } }
    expect(out.order).toMatchObject({ id: '42', total: 42.5, financialStatus: 'paid' })
  })

  it('searchOrders builds an email query and returns normalized orders + count', async () => {
    const api = new MockShopifyApi({ searchResults: [orderNode] })
    const spy = vi.spyOn(api, 'orders')
    const c = new ShopifyConnector({ api })
    const out = (await c.invokeAction('searchOrders', { email: 'b@x.com' })) as { count: number }
    expect(spy).toHaveBeenCalledWith({ query: 'email:b@x.com' })
    expect(out.count).toBe(1)
  })

  it('refundOrder maps params to refundCreate and resolves its result', async () => {
    const api = new MockShopifyApi({
      orders: { '42': orderNode },
      refund: { refundId: 'r9', amount: 42.5 }
    })
    const c = new ShopifyConnector({ api })
    const out = await c.invokeAction('refundOrder', { id: '42', amount: '42.5', restock: 'true' })
    expect(out).toEqual({ refundId: 'r9', amount: 42.5 })
    expect(api.calls.refundCreate).toEqual([{ orderId: '42', amount: 42.5, restock: true }])
  })

  it('rejects a refund userErrors failure verbatim (the pinned convention)', async () => {
    const api = new MockShopifyApi({ refundError: 'Order has already been fully refunded' })
    const c = new ShopifyConnector({ api })
    await expect(c.invokeAction('refundOrder', { id: '42' })).rejects.toThrow(
      /already been fully refunded/
    )
  })

  it('rejects updateShippingAddress on an already-fulfilled order, before mutating', async () => {
    const fulfilled: RawOrderNode = { ...orderNode, displayFulfillmentStatus: 'FULFILLED' }
    const api = new MockShopifyApi({ orders: { '42': fulfilled } })
    const c = new ShopifyConnector({ api })
    await expect(
      c.invokeAction('updateShippingAddress', { id: '42', address: { city: 'NYC' } })
    ).rejects.toThrow(/already fulfilled/)
    expect(api.calls.orderUpdate).toHaveLength(0)
  })

  it('rejects a missing id and an unknown action legibly', async () => {
    const c = new ShopifyConnector({ api: new MockShopifyApi({}) })
    await expect(c.invokeAction('getOrder', {})).rejects.toThrow(/needs an order id/)
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })
})

describe('ShopifyConnector — trigger subscription', () => {
  it('delivers a verified orders/create webhook as a SeedEvent to order.created', () => {
    const { server, deliver } = fakeWebhook()
    const c = new ShopifyConnector({ api: new MockShopifyApi({}), webhook: server })
    const seeds: unknown[] = []
    const off = c.subscribe('order.created', (e) => seeds.push(e))
    deliver({ webhookId: 'wh-1', topic: 'orders/create', payload: { id: 42, email: 'b@x.com' } })
    expect(seeds).toEqual([
      {
        eventId: 'wh-1',
        payload: { orderId: '42', email: 'b@x.com', flagged: false, topic: 'orders/create' }
      }
    ])
    off()
    deliver({ webhookId: 'wh-2', topic: 'orders/create', payload: { id: 43 } })
    expect(seeds).toHaveLength(1) // unsubscribed
  })

  it('fans a high-risk orders/create out to order.flagged too', () => {
    const { server, deliver } = fakeWebhook()
    const c = new ShopifyConnector({ api: new MockShopifyApi({}), webhook: server })
    const flagged: unknown[] = []
    c.subscribe('order.flagged', (e) => flagged.push(e))
    deliver({ webhookId: 'wh-3', topic: 'orders/create', payload: { id: 42, flagged: true } })
    expect(flagged).toHaveLength(1)
  })

  it('ignores an unknown trigger id and an unsupported topic', () => {
    const { server, deliver } = fakeWebhook()
    const c = new ShopifyConnector({ api: new MockShopifyApi({}), webhook: server, log: () => {} })
    const seeds: unknown[] = []
    c.subscribe('order.created', (e) => seeds.push(e))
    expect(typeof c.subscribe('bogus.trigger', () => {})).toBe('function')
    deliver({ webhookId: 'wh-4', topic: 'orders/edited', payload: { id: 42 } })
    expect(seeds).toHaveLength(0)
  })
})
