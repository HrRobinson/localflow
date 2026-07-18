import { describe, it, expect } from 'vitest'
import { parseHubspotConfig } from '../../src/main/hubspot/hubspot-config'

describe('parseHubspotConfig — validate at the boundary', () => {
  it('parses an enabled block with non-secret refs, defaulting apiBase', () => {
    expect(
      parseHubspotConfig({
        hubspot: {
          enabled: true,
          environment: 3,
          portalId: '12345',
          webhookUrl: 'https://t/hubspot/webhook'
        }
      })
    ).toEqual({
      enabled: true,
      apiBase: 'https://api.hubapi.com',
      environment: 3,
      portalId: '12345',
      webhookUrl: 'https://t/hubspot/webhook'
    })
  })

  it('honors a custom apiBase and omits absent optional refs', () => {
    expect(
      parseHubspotConfig({
        hubspot: { enabled: true, environment: 1, apiBase: 'https://eu.hubapi.com' }
      })
    ).toEqual({
      enabled: true,
      apiBase: 'https://eu.hubapi.com',
      environment: 1
    })
  })

  it('returns null for a disabled block, a missing/out-of-range environment, or garbage', () => {
    expect(parseHubspotConfig({ hubspot: { enabled: false, environment: 1 } })).toBeNull()
    expect(parseHubspotConfig({ hubspot: { enabled: true } })).toBeNull()
    expect(parseHubspotConfig({ hubspot: { enabled: true, environment: 12 } })).toBeNull()
    expect(parseHubspotConfig({ hubspot: { enabled: true, environment: 1.5 } })).toBeNull()
    expect(parseHubspotConfig(null)).toBeNull()
    expect(parseHubspotConfig({ nothubspot: {} })).toBeNull()
  })
})
