import { describe, it, expect } from 'vitest'
import {
  WebhookBindingRegistry,
  type HostedWebhookBinding
} from '../../src/main/hosted/webhook-bindings'
import {
  shopifyWebhookBinding,
  type ShopifyWebhookDelivery
} from '../../src/main/shopify/shopify-webhook-server'
import { hubspotWebhookBinding } from '../../src/main/hubspot/hubspot-verifier'

describe('WebhookBindingRegistry', () => {
  it('registers a binding and looks it up by integration id', () => {
    const registry = new WebhookBindingRegistry()
    const binding: HostedWebhookBinding = {
      integration: 'linear',
      verifier: { scheme: 'hmac', header: 'linear-signature' },
      parse: () => ({}),
      deliver: () => {},
      secretRef: 'webhookSecret'
    }
    registry.register(binding)
    expect(registry.lookup('linear')).toBe(binding)
  })

  it('returns undefined for an integration with no registered binding', () => {
    expect(new WebhookBindingRegistry().lookup('github')).toBeUndefined()
  })
})

describe('shopifyWebhookBinding factory', () => {
  it('wires the Shopify verifier + parse + dedup + secretRef and the given deliver', () => {
    const delivered: ShopifyWebhookDelivery[] = []
    const binding = shopifyWebhookBinding((d) => {
      delivered.push(d)
    })
    expect(binding.integration).toBe('shopify')
    expect(binding.verifier).toEqual({
      scheme: 'hmac',
      header: 'x-shopify-hmac-sha256',
      encoding: 'base64'
    })
    expect(binding.secretRef).toBe('webhookSecret')
    expect(typeof binding.dedup).toBe('function')
    expect(binding.maxBodyBytes).toBe(1_048_576)
    // The dedup short-circuit closes over its own seen-set.
    const headers = { 'x-shopify-webhook-id': 'id-1' }
    expect(binding.dedup!(headers)).toBeNull()
    expect(binding.dedup!(headers)).toBe(200)
    // The deliver is the exact callback we passed.
    const sample: ShopifyWebhookDelivery = { webhookId: 'w', topic: 'orders/create', payload: {} }
    void binding.parse
    binding.deliver(sample)
    expect(delivered).toEqual([sample])
  })
})

describe('hubspotWebhookBinding factory', () => {
  it('wires the v3 verifier + parse + client-secret ref + the public URL it signs', () => {
    const binding = hubspotWebhookBinding(() => {}, {
      publicUrl: 'https://relay.example.com/t/abc/hubspot'
    })
    expect(binding.integration).toBe('hubspot')
    expect(binding.verifier.scheme).toBe('hmac')
    expect(binding.secretRef).toBe('webhookClientSecret')
    expect(binding.publicUrl).toBe('https://relay.example.com/t/abc/hubspot')
    expect(binding.dedup).toBeUndefined()
  })
})
