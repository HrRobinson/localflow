import { describe, it, expect } from 'vitest'
import { normalizeShopDomain, parseShopifyConfig } from '../../src/main/shopify/shopify-config'
import { DEFAULT_API_VERSION } from '../../src/main/shopify/shopify-admin'

describe('normalizeShopDomain', () => {
  it('strips scheme, path, and casing to the bare host', () => {
    expect(normalizeShopDomain('https://My-Store.myshopify.com/admin')).toBe(
      'my-store.myshopify.com'
    )
    expect(normalizeShopDomain('  store.myshopify.com  ')).toBe('store.myshopify.com')
  })
})

describe('parseShopifyConfig', () => {
  it('defaults the api version and carries the optional webhook url', () => {
    const cfg = parseShopifyConfig({
      enabled: true,
      values: {
        shopDomain: 'store.myshopify.com',
        environment: 3,
        webhookUrl: 'https://t/shopify/webhook'
      }
    })
    expect(cfg).toEqual({
      shopDomain: 'store.myshopify.com',
      apiVersion: DEFAULT_API_VERSION,
      environment: 3,
      webhookUrl: 'https://t/shopify/webhook'
    })
  })

  it('returns null when required refs are absent (connector stays dormant)', () => {
    expect(parseShopifyConfig(undefined)).toBeNull()
    expect(parseShopifyConfig({ enabled: true, values: { environment: 3 } })).toBeNull()
    expect(
      parseShopifyConfig({ enabled: true, values: { shopDomain: 'x.myshopify.com' } })
    ).toBeNull()
  })
})
