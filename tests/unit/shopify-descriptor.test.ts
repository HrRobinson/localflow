import { describe, it, expect } from 'vitest'
import { shopifyDescriptor } from '../../src/main/shopify/shopify-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  SHOPIFY_TRIGGER_IDS,
  SHOPIFY_READ_ACTION_IDS,
  SHOPIFY_MUTATION_ACTION_IDS
} from '../../src/shared/shopify'

describe('shopify descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('shopify')
    expect(DESCRIPTOR_DEFS.shopify).toBe(shopifyDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('shopify')
  })

  it('pins the exact secret fields (§5) — token + webhook secret, keychain only', () => {
    const secretKeys = shopifyDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['adminToken', 'webhookSecret'])
  })

  it('pins the exact required fields (§5)', () => {
    const requiredKeys = shopifyDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['adminToken', 'webhookSecret', 'shopDomain', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of shopifyDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the ecom trigger ids the templates track consumes (§6.1)', () => {
    expect(shopifyDescriptor.triggers.map((t) => t.id)).toEqual([
      'order.created',
      'order.refundRequested',
      'order.flagged'
    ])
    expect(shopifyDescriptor.triggers.map((t) => t.id)).toEqual([...SHOPIFY_TRIGGER_IDS])
  })

  it('pins the read + gated-mutation action ids (§6.2)', () => {
    expect(shopifyDescriptor.actions.map((a) => a.id)).toEqual([
      ...SHOPIFY_READ_ACTION_IDS,
      ...SHOPIFY_MUTATION_ACTION_IDS
    ])
  })

  it('never places a secret VALUE in the static descriptor (only placeholders)', () => {
    const serialized = JSON.stringify(shopifyDescriptor)
    expect(serialized).not.toContain('shpat_real')
  })
})
