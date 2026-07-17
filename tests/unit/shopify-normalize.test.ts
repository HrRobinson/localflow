import { describe, it, expect } from 'vitest'
import {
  normalizeOrder,
  normalizeCustomer,
  webhookToPayload,
  triggersForTopic
} from '../../src/main/shopify/shopify-normalize'
import type { RawOrderNode, RawCustomerNode } from '../../src/main/shopify/shopify-admin'

const fullOrder: RawOrderNode = {
  id: 'gid://shopify/Order/5123456789',
  name: '#1001',
  email: 'buyer@example.com',
  createdAt: '2026-07-17T10:00:00Z',
  closed: false,
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  totalPriceSet: { shopMoney: { amount: '42.50', currencyCode: 'USD' } },
  lineItems: { nodes: [{ id: 'a' }, { id: 'b' }] },
  risk: { assessments: [{ riskLevel: 'LOW' }] },
  customer: {
    id: 'gid://shopify/Customer/777',
    email: 'buyer@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace'
  }
}

describe('normalizeOrder', () => {
  it('reduces GIDs, coerces money to a number, and lowercases status enums', () => {
    const ctx = normalizeOrder(fullOrder)
    expect(ctx.order).toMatchObject({
      id: '5123456789',
      name: '#1001',
      total: 42.5,
      currency: 'USD',
      status: 'open',
      financialStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      email: 'buyer@example.com',
      flagged: false,
      lineItemCount: 2
    })
    // money is a NUMBER, not a lexical string — the correctness boundary (§6.3).
    expect(typeof ctx.order.total).toBe('number')
    expect(ctx.customer).toEqual({ id: '777', email: 'buyer@example.com', name: 'Ada Lovelace' })
  })

  it('maps PARTIALLY_FULFILLED to partial and derives flagged from a HIGH risk', () => {
    const ctx = normalizeOrder({
      ...fullOrder,
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      risk: { assessments: [{ riskLevel: 'LOW' }, { riskLevel: 'HIGH' }] }
    })
    expect(ctx.order.fulfillmentStatus).toBe('partial')
    expect(ctx.order.flagged).toBe(true)
  })

  it('marks a cancelled order and an already-closed order', () => {
    expect(normalizeOrder({ ...fullOrder, cancelledAt: '2026-07-17T11:00:00Z' }).order.status).toBe(
      'cancelled'
    )
    expect(normalizeOrder({ ...fullOrder, closed: true }).order.status).toBe('closed')
  })

  it('yields empty customer fields when the order has no customer', () => {
    const ctx = normalizeOrder({ ...fullOrder, customer: null })
    expect(ctx.customer).toEqual({ id: '', email: '', name: '' })
  })

  it('never throws on a sparse/garbage node — normalizes to safe defaults', () => {
    const ctx = normalizeOrder({ id: 'gid://shopify/Order/9' })
    expect(ctx.order.id).toBe('9')
    expect(ctx.order.total).toBe(0)
    expect(ctx.order.financialStatus).toBe('pending')
    expect(ctx.order.fulfillmentStatus).toBe('unfulfilled')
  })
})

describe('normalizeCustomer', () => {
  it('coerces numberOfOrders (string) and amountSpent to numbers', () => {
    const raw: RawCustomerNode = {
      id: 'gid://shopify/Customer/777',
      email: 'buyer@example.com',
      displayName: 'Ada Lovelace',
      numberOfOrders: '12',
      amountSpent: { amount: '1999.99', currencyCode: 'USD' }
    }
    expect(normalizeCustomer(raw).customer).toEqual({
      id: '777',
      email: 'buyer@example.com',
      name: 'Ada Lovelace',
      ordersCount: 12,
      totalSpent: 1999.99,
      currency: 'USD'
    })
  })

  it('falls back to first+last when displayName is absent', () => {
    expect(
      normalizeCustomer({ id: 'gid://shopify/Customer/1', firstName: 'Grace', lastName: 'Hopper' })
        .customer.name
    ).toBe('Grace Hopper')
  })
})

describe('webhook → trigger payload', () => {
  it('normalizes an orders/create body to an order.created trigger payload', () => {
    const payload = webhookToPayload('orders/create', {
      id: 5123456789,
      email: 'buyer@example.com'
    })
    expect(payload).toEqual({
      orderId: '5123456789',
      email: 'buyer@example.com',
      flagged: false,
      topic: 'orders/create'
    })
    expect(triggersForTopic('orders/create', payload!)).toEqual(['order.created'])
  })

  it('also fires order.flagged when the orders/create body is high-risk', () => {
    const payload = webhookToPayload('orders/create', { id: 1, email: 'x@y.com', flagged: true })
    expect(payload!.flagged).toBe(true)
    expect(triggersForTopic('orders/create', payload!)).toEqual(['order.created', 'order.flagged'])
  })

  it('maps returns/request (order_id) to order.refundRequested', () => {
    const payload = webhookToPayload('returns/request', { order_id: 42 })
    expect(payload!.orderId).toBe('42')
    expect(triggersForTopic('returns/request', payload!)).toEqual(['order.refundRequested'])
  })

  it('drops an unknown/unsupported topic (no run seeds)', () => {
    expect(webhookToPayload('orders/create', {})).toBeNull()
    expect(
      triggersForTopic('orders/edited', { orderId: '1', flagged: false, topic: 'orders/edited' })
    ).toEqual([])
  })
})
