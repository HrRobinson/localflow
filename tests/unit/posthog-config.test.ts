import { describe, it, expect } from 'vitest'
import { parsePostHogConfig } from '../../src/main/posthog/posthog-config'

/**
 * Validate-at-the-boundary parsing of the non-secret `posthog` block (spec §5,
 * §8). Garbage DISABLES the feature (returns null) rather than throwing; the host
 * is SSRF-guarded at the config boundary; secrets never live here.
 */

const base = {
  posthog: {
    enabled: true,
    projectApiKey: 'phc_public',
    host: 'https://us.posthog.com',
    environment: 1
  }
}

describe('parsePostHogConfig', () => {
  it('accepts a well-formed block', () => {
    expect(parsePostHogConfig(base)).toEqual({
      enabled: true,
      projectApiKey: 'phc_public',
      host: 'https://us.posthog.com',
      environment: 1
    })
  })

  it('honors an optional pollSeconds (clamped)', () => {
    expect(parsePostHogConfig({ posthog: { ...base.posthog, pollSeconds: 30 } })?.pollSeconds).toBe(
      30
    )
    expect(
      parsePostHogConfig({ posthog: { ...base.posthog, pollSeconds: 99999 } })?.pollSeconds
    ).toBe(3600)
  })

  it('disables (null) on a disabled/absent block or missing required refs', () => {
    expect(parsePostHogConfig({ posthog: { ...base.posthog, enabled: false } })).toBeNull()
    expect(parsePostHogConfig({})).toBeNull()
    expect(parsePostHogConfig({ posthog: { ...base.posthog, projectApiKey: '' } })).toBeNull()
    expect(parsePostHogConfig({ posthog: { ...base.posthog, environment: 12 } })).toBeNull()
  })

  it('disables on a non-https / private / loopback host (SSRF at the boundary)', () => {
    expect(
      parsePostHogConfig({ posthog: { ...base.posthog, host: 'http://us.posthog.com' } })
    ).toBeNull()
    expect(
      parsePostHogConfig({ posthog: { ...base.posthog, host: 'https://127.0.0.1' } })
    ).toBeNull()
    expect(
      parsePostHogConfig({ posthog: { ...base.posthog, host: 'https://169.254.169.254' } })
    ).toBeNull()
  })

  it('allows a localhost self-host ONLY behind the explicit opt-in', () => {
    const localhost = { ...base.posthog, host: 'https://localhost:8000' }
    expect(parsePostHogConfig({ posthog: localhost })).toBeNull()
    const opted = parsePostHogConfig({ posthog: { ...localhost, allowInsecureLocalHost: true } })
    expect(opted).toMatchObject({ host: 'https://localhost:8000', allowInsecureLocalHost: true })
  })

  it('never returns a personalApiKey field even if one is hand-edited into the block', () => {
    const withSecret = { posthog: { ...base.posthog, personalApiKey: 'phx_leak' } }
    const parsed = parsePostHogConfig(withSecret)
    expect(parsed).not.toHaveProperty('personalApiKey')
    expect(JSON.stringify(parsed)).not.toContain('phx_leak')
  })
})
