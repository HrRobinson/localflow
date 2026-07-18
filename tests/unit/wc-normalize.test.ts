import { describe, it, expect } from 'vitest'
import { normalizeOrder, normalizeCustomer } from '../../src/main/woocommerce/wc-normalize'

/** A registered-customer order fixture (raw WC `wc/v3` order shape). */
const registeredOrder = {
  id: 4242,
  total: '129.95',
  currency: 'USD',
  status: 'processing',
  customer_id: 7,
  billing: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' }
}

/** A guest order: `customer_id: 0`, identity keyed on `billing.email` (spec §2.5). */
const guestOrder = {
  id: 4243,
  total: '10.00',
  currency: 'EUR',
  status: 'on-hold',
  customer_id: 0,
  billing: { email: 'guest@example.com', first_name: 'Guest', last_name: '' }
}

describe('normalizeOrder', () => {
  it('maps a registered order to numeric total + enum status + customer id', () => {
    expect(normalizeOrder(registeredOrder)).toEqual({
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

  it('omits customer.id for a guest order and keeps email as the stable key', () => {
    const p = normalizeOrder(guestOrder)
    expect(p.customer.id).toBeUndefined()
    expect('id' in p.customer).toBe(false)
    expect(p.customer.email).toBe('guest@example.com')
    expect(p.customer.name).toBe('Guest')
    expect(p.order.email).toBe('guest@example.com')
  })

  it('parses total as a NUMBER so a condition can compare it numerically', () => {
    expect(normalizeOrder(registeredOrder).order.total).toBe(129.95)
    expect(typeof normalizeOrder(registeredOrder).order.total).toBe('number')
  })

  it.each(['processing', 'on-hold', 'completed', 'refunded', 'cancelled', 'failed', 'pending'])(
    'passes through the WC status enum value %s unchanged',
    (status) => {
      expect(normalizeOrder({ ...registeredOrder, status }).order.status).toBe(status)
    }
  )

  it('is defensive: a non-numeric/absent total becomes 0, missing email an empty string', () => {
    const p = normalizeOrder({ id: 1, currency: 'USD', status: 'pending', customer_id: 0 })
    expect(p.order.total).toBe(0)
    expect(p.order.email).toBe('')
    expect(p.customer.email).toBe('')
  })
})

describe('normalizeCustomer', () => {
  it('maps a registered customer record', () => {
    expect(
      normalizeCustomer({
        id: 7,
        email: 'ada@example.com',
        first_name: 'Ada',
        last_name: 'Lovelace'
      })
    ).toEqual({ id: '7', email: 'ada@example.com', name: 'Ada Lovelace' })
  })

  it('omits id when the record has none (id 0)', () => {
    const c = normalizeCustomer({ id: 0, email: 'g@example.com', first_name: 'G', last_name: '' })
    expect(c.id).toBeUndefined()
    expect(c.name).toBe('G')
  })
})
