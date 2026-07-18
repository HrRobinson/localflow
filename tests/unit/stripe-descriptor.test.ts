import { describe, it, expect } from 'vitest'
import { stripeDescriptor } from '../../src/main/stripe/stripe-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  STRIPE_TRIGGER_IDS,
  STRIPE_READ_ACTION_IDS,
  STRIPE_MUTATION_ACTION_IDS
} from '../../src/shared/stripe'

describe('stripe descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('stripe')
    expect(DESCRIPTOR_DEFS.stripe).toBe(stripeDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('stripe')
  })

  it('pins the exact secret fields (§5) — restricted key + webhook secret, keychain only', () => {
    const secretKeys = stripeDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['restrictedKey', 'webhookSecret'])
  })

  it('pins the exact required fields (§5)', () => {
    const requiredKeys = stripeDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['restrictedKey', 'webhookSecret', 'environment'])
  })

  it('advertises a RESTRICTED key (rk_), never a full secret key (sk_)', () => {
    const key = stripeDescriptor.configFields.find((f) => f.key === 'restrictedKey')
    expect(key?.placeholder).toBe('rk_live_…')
    expect(JSON.stringify(stripeDescriptor)).not.toContain('sk_')
  })

  it('gives every field a valid FieldType', () => {
    for (const f of stripeDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the trigger ids the templates track consumes (§6.1)', () => {
    expect(stripeDescriptor.triggers.map((t) => t.id)).toEqual([
      'charge.dispute.created',
      'charge.refunded',
      'invoice.payment_failed'
    ])
    expect(stripeDescriptor.triggers.map((t) => t.id)).toEqual([...STRIPE_TRIGGER_IDS])
  })

  it('pins the read + gated-mutation action ids (§6.2)', () => {
    expect(stripeDescriptor.actions.map((a) => a.id)).toEqual([
      ...STRIPE_READ_ACTION_IDS,
      ...STRIPE_MUTATION_ACTION_IDS
    ])
    // The three money mutations are all present and gated (§9).
    expect([...STRIPE_MUTATION_ACTION_IDS]).toEqual([
      'createRefund',
      'respondToDispute',
      'cancelSubscription'
    ])
  })
})
