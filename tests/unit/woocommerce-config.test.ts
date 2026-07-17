import { describe, it, expect } from 'vitest'
import { parseWoocommerceConfig } from '../../src/main/woocommerce/woocommerce-config'

const valid = {
  woocommerce: { enabled: true, storeUrl: 'https://shop.example.com', environment: 2 }
}

describe('parseWoocommerceConfig', () => {
  it('parses a well-typed, enabled block', () => {
    expect(parseWoocommerceConfig(valid)).toEqual({
      enabled: true,
      storeUrl: 'https://shop.example.com',
      environment: 2
    })
  })

  it('disables (null) when absent, disabled, or not an object', () => {
    expect(parseWoocommerceConfig({})).toBeNull()
    expect(parseWoocommerceConfig(null)).toBeNull()
    expect(parseWoocommerceConfig([1, 2])).toBeNull()
    expect(parseWoocommerceConfig({ woocommerce: null })).toBeNull()
    expect(parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, enabled: false } })).toBeNull()
    expect(parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, enabled: 'true' } })).toBeNull()
  })

  it('disables when the store URL is missing, non-https, or SSRF-blocked', () => {
    expect(parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, storeUrl: '' } })).toBeNull()
    expect(
      parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, storeUrl: 'http://shop.example.com' } })
    ).toBeNull()
    expect(
      parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, storeUrl: 'https://127.0.0.1' } })
    ).toBeNull()
    expect(
      parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, storeUrl: 'https://192.168.1.9' } })
    ).toBeNull()
  })

  it('disables when the environment is out of the 1-9 range', () => {
    expect(parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, environment: 0 } })).toBeNull()
    expect(parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, environment: 10 } })).toBeNull()
    expect(parseWoocommerceConfig({ woocommerce: { ...valid.woocommerce, environment: 1.5 } })).toBeNull()
  })
})
