import { describe, it, expect } from 'vitest'
import {
  parsePagerDutyConfig,
  baseUrlForRegion,
  isPagerDutyRegion,
  DEFAULT_PAGERDUTY_REGION,
  PAGERDUTY_REST_BASE_URLS
} from '../../src/main/pagerduty/pagerduty-config'
import type { IntegrationConfigEntry } from '../../src/shared/integrations'

const entry = (values: Record<string, unknown>): IntegrationConfigEntry => ({
  enabled: true,
  values: values as IntegrationConfigEntry['values']
})

describe('parsePagerDutyConfig', () => {
  it('returns null when required non-secret refs are absent (opt-in dormancy)', () => {
    expect(parsePagerDutyConfig(undefined)).toBeNull()
    expect(parsePagerDutyConfig(entry({ environment: 1 }))).toBeNull() // no fromEmail
    expect(parsePagerDutyConfig(entry({ fromEmail: 'a@b.com' }))).toBeNull() // no environment
  })

  it('defaults region to us and trims fromEmail', () => {
    const cfg = parsePagerDutyConfig(entry({ fromEmail: '  bot@acme.com ', environment: 2 }))
    expect(cfg).toEqual({
      region: 'us',
      fromEmail: 'bot@acme.com',
      environment: 2
    })
  })

  it('carries the eu region and the optional service/escalation/webhook refs', () => {
    const cfg = parsePagerDutyConfig(
      entry({
        fromEmail: 'bot@acme.com',
        environment: 3,
        region: 'eu',
        serviceId: 'PSVC01',
        escalationPolicyId: 'PEP01',
        webhookUrl: 'https://tunnel.example/pagerduty/webhook'
      })
    )
    expect(cfg).toMatchObject({
      region: 'eu',
      serviceId: 'PSVC01',
      escalationPolicyId: 'PEP01',
      webhookUrl: 'https://tunnel.example/pagerduty/webhook'
    })
  })

  it('falls back to the default region for an unknown value (never mints a rogue URL)', () => {
    const cfg = parsePagerDutyConfig(
      entry({ fromEmail: 'bot@acme.com', environment: 1, region: 'evil-host' })
    )
    expect(cfg?.region).toBe(DEFAULT_PAGERDUTY_REGION)
  })
})

describe('region → fixed base URL (no SSRF, §4.5)', () => {
  it('maps us and eu to the fixed PagerDuty-owned hosts', () => {
    expect(baseUrlForRegion('us')).toBe('https://api.pagerduty.com')
    expect(baseUrlForRegion('eu')).toBe('https://api.eu.pagerduty.com')
    expect(PAGERDUTY_REST_BASE_URLS.us).toBe('https://api.pagerduty.com')
  })

  it('isPagerDutyRegion only accepts the closed set', () => {
    expect(isPagerDutyRegion('us')).toBe(true)
    expect(isPagerDutyRegion('eu')).toBe(true)
    expect(isPagerDutyRegion('http://169.254.169.254')).toBe(false)
    expect(isPagerDutyRegion(undefined)).toBe(false)
  })
})
