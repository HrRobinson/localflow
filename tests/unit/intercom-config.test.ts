import { describe, it, expect } from 'vitest'
import { baseUrlForConfig, parseIntercomConfig } from '../../src/main/intercom/intercom-config'
import { baseUrlForRegion } from '../../src/main/intercom/intercom-api'

describe('parseIntercomConfig — region coercion + base URL (§5, §8)', () => {
  it('parses region/environment/webhookUrl and defaults region to us', () => {
    expect(
      parseIntercomConfig({
        enabled: true,
        values: { region: 'eu', environment: 2, webhookUrl: 'https://t/intercom/webhook' }
      })
    ).toEqual({ region: 'eu', environment: 2, webhookUrl: 'https://t/intercom/webhook' })

    // Absent / bogus region → 'us'.
    expect(parseIntercomConfig({ enabled: true, values: { environment: 1 } })).toEqual({
      region: 'us',
      environment: 1
    })
    expect(
      parseIntercomConfig({ enabled: true, values: { region: 'mars', environment: 1 } })?.region
    ).toBe('us')
  })

  it('returns null when the required environment is absent (connector stays dormant)', () => {
    expect(parseIntercomConfig(undefined)).toBeNull()
    expect(parseIntercomConfig({ enabled: true, values: {} })).toBeNull()
  })

  it('maps each region to its distinct API base URL', () => {
    expect(baseUrlForRegion('us')).toBe('https://api.intercom.io')
    expect(baseUrlForRegion('eu')).toBe('https://api.eu.intercom.io')
    expect(baseUrlForRegion('au')).toBe('https://api.au.intercom.io')
    const cfg = parseIntercomConfig({ enabled: true, values: { region: 'au', environment: 1 } })!
    expect(baseUrlForConfig(cfg)).toBe('https://api.au.intercom.io')
  })
})
