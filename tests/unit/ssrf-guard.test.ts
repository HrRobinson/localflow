import { describe, it, expect } from 'vitest'
import { checkBaseUrl, blockedIpRange } from '../../src/main/net/ssrf-guard'

/**
 * The exhaustive range coverage lives in `wc-ssrf.test.ts` (which now exercises
 * the same promoted logic through the Woo delegate). This file adds only what is
 * NEW in the shared module: the `label` parameterization and a confirmation the
 * promoted behavior is intact.
 */
describe('checkBaseUrl — label parameterization', () => {
  it('names the connector-appropriate field in the reason (not Woo-specific)', () => {
    const http = checkBaseUrl('http://gitlab.internal.example.com', 'GitLab URL')
    expect(http.ok).toBe(false)
    if (!http.ok) {
      expect(http.reason).toContain('GitLab URL')
      expect(http.reason).not.toContain('Store URL')
    }

    const blocked = checkBaseUrl('https://127.0.0.1', 'Sentry URL')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.reason).toContain('Sentry URL')
      expect(blocked.reason).toMatch(/loopback/i)
    }
  })

  it('defaults the label to "Store URL" (byte-compatible with wc-ssrf)', () => {
    const r = checkBaseUrl('http://shop.example.com')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Store URL')
  })

  it('allows a plain public https host and keeps the URL', () => {
    const r = checkBaseUrl('https://gitlab.example.com/api', 'GitLab URL')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.host).toBe('gitlab.example.com')
  })
})

describe('blockedIpRange — promoted verbatim', () => {
  it('flags private/loopback/link-local and the IPv4-mapped hex form', () => {
    expect(blockedIpRange('127.0.0.1')).toMatch(/loopback/i)
    expect(blockedIpRange('10.1.2.3')).toMatch(/private/i)
    expect(blockedIpRange('169.254.169.254')).toMatch(/link-local/i)
    expect(blockedIpRange('::ffff:7f00:1')).toMatch(/loopback/i)
    expect(blockedIpRange('93.184.216.34')).toBeNull()
  })
})
