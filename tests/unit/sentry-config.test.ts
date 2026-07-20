import { describe, it, expect } from 'vitest'
import {
  parseSentryConfig,
  normalizeSlug,
  DEFAULT_SENTRY_BASE_URL
} from '../../src/main/sentry/sentry-config'
import type { IntegrationConfigEntry } from '../../src/shared/integrations'

const entry = (values: Record<string, unknown>): IntegrationConfigEntry => ({
  enabled: true,
  values: values as IntegrationConfigEntry['values']
})

describe('parseSentryConfig', () => {
  it('returns null when required non-secret refs are absent (opt-in dormancy)', () => {
    expect(parseSentryConfig(undefined)).toBeNull()
    expect(parseSentryConfig(entry({ environment: 1 }))).toBeNull() // no orgSlug
    expect(parseSentryConfig(entry({ orgSlug: 'my-org' }))).toBeNull() // no environment
  })

  it('defaults baseUrl to https://sentry.io and normalizes slugs', () => {
    const cfg = parseSentryConfig(entry({ orgSlug: '  My-Org ', environment: 2 }))
    expect(cfg).toEqual({
      orgSlug: 'my-org',
      baseUrl: DEFAULT_SENTRY_BASE_URL,
      environment: 2
    })
  })

  it('carries an optional projectSlug and self-host baseUrl (trailing slash stripped)', () => {
    const cfg = parseSentryConfig(
      entry({
        orgSlug: 'org',
        projectSlug: 'Frontend',
        baseUrl: 'https://sentry.mycorp.com/',
        environment: 3,
        webhookUrl: 'https://tunnel.example/sentry/webhook'
      })
    )
    expect(cfg).toMatchObject({
      projectSlug: 'frontend',
      baseUrl: 'https://sentry.mycorp.com',
      webhookUrl: 'https://tunnel.example/sentry/webhook'
    })
  })

  it('normalizeSlug lowercases and trims', () => {
    expect(normalizeSlug('  ACME-Corp  ')).toBe('acme-corp')
  })
})
