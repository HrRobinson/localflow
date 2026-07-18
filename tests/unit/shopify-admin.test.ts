import { describe, it, expect, vi } from 'vitest'
import {
  ShopifyAdminApi,
  MockShopifyApi,
  type GraphqlTransport,
  type GraphqlResult
} from '../../src/main/shopify/shopify-admin'

const ok = (data: Record<string, unknown>): GraphqlResult => ({ status: 200, body: { data } })

const transportOf = (result: GraphqlResult): GraphqlTransport => vi.fn(async () => result)

describe('ShopifyAdminApi (real client over an injected transport)', () => {
  it('order() sends a query and returns the raw node from data', async () => {
    const node = { id: 'gid://shopify/Order/42', name: '#1001' }
    const transport = transportOf(ok({ order: node }))
    const api = new ShopifyAdminApi({ transport })
    await expect(api.order('42')).resolves.toEqual(node)
    expect(transport).toHaveBeenCalledOnce()
  })

  it('rejects a 401 with a legible "re-enter the token" message, never the token', async () => {
    const api = new ShopifyAdminApi({
      transport: async () => ({ status: 401, body: { errors: [{ message: 'Invalid API key' }] } })
    })
    await expect(api.order('42')).rejects.toThrow(/401 Unauthorized.*re-enter it in Settings/s)
  })

  it('rejects a missing-scope failure carrying the verbatim scope requirement', async () => {
    const api = new ShopifyAdminApi({
      transport: async () => ({
        status: 200,
        body: {
          errors: [
            {
              message: 'Access denied for refundCreate. Requires write_orders.',
              extensions: { code: 'ACCESS_DENIED' }
            }
          ]
        }
      })
    })
    await expect(api.refundCreate({ orderId: '42' })).rejects.toThrow(/write_orders/)
  })

  it('forwards a mutation userErrors[] verbatim as a rejection (the pinned failure convention)', async () => {
    const api = new ShopifyAdminApi({
      transport: async () => ({
        status: 200,
        body: {
          data: {
            refundCreate: {
              refund: null,
              userErrors: [{ field: ['orderId'], message: 'Order has already been fully refunded' }]
            }
          }
        }
      })
    })
    await expect(api.refundCreate({ orderId: '42' })).rejects.toThrow(/already been fully refunded/)
  })

  it('retries on THROTTLED honoring the bucket, then resolves', async () => {
    const throttled: GraphqlResult = {
      status: 200,
      body: {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } }
      }
    }
    const transport = vi
      .fn<GraphqlTransport>()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(ok({ order: { id: 'gid://shopify/Order/42' } }))
    const api = new ShopifyAdminApi({ transport, sleep: async () => {} })
    await expect(api.order('42')).resolves.toEqual({ id: 'gid://shopify/Order/42' })
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('rejects after exhausting throttle retries with the bucket state', async () => {
    const throttled: GraphqlResult = {
      status: 200,
      body: {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } }
      }
    }
    const api = new ShopifyAdminApi({
      transport: async () => throttled,
      sleep: async () => {},
      maxThrottleRetries: 2
    })
    await expect(api.order('42')).rejects.toThrow(/throttled/i)
  })
})

describe('MockShopifyApi (the test seam)', () => {
  it('returns seeded nodes and records mutation calls', async () => {
    const mock = new MockShopifyApi({
      orders: { '42': { id: 'gid://shopify/Order/42', name: '#1001' } }
    })
    await expect(mock.order('42')).resolves.toMatchObject({ name: '#1001' })
    await mock.refundCreate({ orderId: '42', amount: 10 })
    expect(mock.calls.refundCreate).toEqual([{ orderId: '42', amount: 10 }])
  })

  it('rejects a seeded userErrors failure verbatim', async () => {
    const mock = new MockShopifyApi({
      refundError: 'Order has already been fully refunded'
    })
    await expect(mock.refundCreate({ orderId: '42' })).rejects.toThrow(
      /already been fully refunded/
    )
  })

  it('rejects an unknown order id legibly (not a bare 404)', async () => {
    const mock = new MockShopifyApi({})
    await expect(mock.order('999')).rejects.toThrow(/no order '999'/)
  })
})
