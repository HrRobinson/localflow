import { describe, it, expect } from 'vitest'
import { parseStripeConfig, modeFromKeyPrefix } from '../../src/main/stripe/stripe-config'
import { DEFAULT_API_VERSION } from '../../src/main/stripe/stripe-client'
import type { IntegrationConfigEntry } from '../../src/shared/integrations'

/**
 * `stripe-config.ts` is a foundation-slice module (wiring deferred, spec §4.2) —
 * this pins its two pure functions so it doesn't ship unverified: the non-secret
 * `StripeConfig` coercion (`parseStripeConfig`) and the test-vs-live key-prefix
 * guard (`modeFromKeyPrefix`).
 */

describe('parseStripeConfig', () => {
  it('builds a full StripeConfig from a valid entry', () => {
    const entry: IntegrationConfigEntry = {
      enabled: true,
      values: {
        accountId: 'acct_1',
        apiVersion: '2024-01-01',
        environment: 3,
        webhookUrl: 'https://relay.example/hooks/stripe',
        mode: 'test'
      }
    }
    expect(parseStripeConfig(entry)).toEqual({
      accountId: 'acct_1',
      apiVersion: '2024-01-01',
      environment: 3,
      webhookUrl: 'https://relay.example/hooks/stripe',
      mode: 'test'
    })
  })

  it('defaults accountId/apiVersion and omits optional fields when only environment is given', () => {
    const entry: IntegrationConfigEntry = { enabled: true, values: { environment: 1 } }
    expect(parseStripeConfig(entry)).toEqual({
      accountId: '',
      apiVersion: DEFAULT_API_VERSION,
      environment: 1
    })
  })

  it('returns null for an undefined entry (the connector stays dormant)', () => {
    expect(parseStripeConfig(undefined)).toBeNull()
  })

  it('returns null (garbage-disables) when environment is missing', () => {
    const entry: IntegrationConfigEntry = { enabled: true, values: {} }
    expect(parseStripeConfig(entry)).toBeNull()
  })

  it('returns null (garbage-disables) when environment is the wrong type', () => {
    const entry: IntegrationConfigEntry = {
      enabled: true,
      values: { environment: '3' as unknown as number }
    }
    expect(parseStripeConfig(entry)).toBeNull()
  })

  it('drops a non-string accountId/apiVersion/webhookUrl to their safe defaults, never crashes', () => {
    const entry: IntegrationConfigEntry = {
      enabled: true,
      values: {
        environment: 2,
        accountId: 42 as unknown as string,
        apiVersion: 7 as unknown as string,
        webhookUrl: 9 as unknown as string
      }
    }
    expect(parseStripeConfig(entry)).toEqual({
      accountId: '',
      apiVersion: DEFAULT_API_VERSION,
      environment: 2
    })
  })

  it('ignores an out-of-enum mode value instead of accepting garbage', () => {
    const entry: IntegrationConfigEntry = {
      enabled: true,
      values: { environment: 1, mode: 'sandbox' as unknown as string }
    }
    expect(parseStripeConfig(entry)).toEqual({
      accountId: '',
      apiVersion: DEFAULT_API_VERSION,
      environment: 1
    })
  })
})

describe('modeFromKeyPrefix', () => {
  it('recognizes rk_test_ and sk_test_ as test mode', () => {
    expect(modeFromKeyPrefix('rk_test_abc123')).toBe('test')
    expect(modeFromKeyPrefix('sk_test_abc123')).toBe('test')
  })

  it('recognizes rk_live_ and sk_live_ as live mode', () => {
    expect(modeFromKeyPrefix('rk_live_abc123')).toBe('live')
    expect(modeFromKeyPrefix('sk_live_abc123')).toBe('live')
  })

  it('returns undefined for a key with no recognizable prefix', () => {
    expect(modeFromKeyPrefix('not_a_stripe_key')).toBeUndefined()
    expect(modeFromKeyPrefix('')).toBeUndefined()
  })
})
