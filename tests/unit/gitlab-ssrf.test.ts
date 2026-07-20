import { describe, it, expect } from 'vitest'
import { checkBaseUrl, blockedIpRange } from '../../src/main/net/ssrf-guard'

/**
 * The self-host explicit-allow (§5.1) is the GitLab connector's PRIMARY security
 * surface: a self-managed GitLab on the LAN is exactly a private-range host the
 * user explicitly entered. These tests cover ONLY the allow additions; the base
 * range coverage lives in `ssrf-guard.test.ts` / `wc-ssrf.test.ts`.
 */

describe('checkBaseUrl — self-host explicit-allow (§5.1)', () => {
  it('a public gitlab.com base passes with no allow (SaaS needs none)', () => {
    const r = checkBaseUrl('https://gitlab.com', { label: 'GitLab base URL' })
    expect(r.ok).toBe(true)
  })

  it('an UNLISTED private/loopback base is refused (default block)', () => {
    for (const url of ['https://192.168.1.10', 'https://127.0.0.1', 'https://10.0.0.5']) {
      const r = checkBaseUrl(url, { label: 'GitLab base URL' })
      expect(r.ok).toBe(false)
    }
  })

  it('ADMITS the user’s configured private baseUrl when allowHost matches', () => {
    const r = checkBaseUrl('https://192.168.1.10', {
      label: 'GitLab base URL',
      allowHost: '192.168.1.10'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.host).toBe('192.168.1.10')
  })

  it('admits a private DNS self-host name when it matches allowHost', () => {
    const r = checkBaseUrl('https://gitlab.internal.lan', {
      label: 'GitLab base URL',
      allowHost: 'gitlab.internal.lan'
    })
    expect(r.ok).toBe(true)
  })

  it('a DIFFERENT private target stays blocked even when an allowHost is set', () => {
    const r = checkBaseUrl('https://192.168.1.99', {
      label: 'GitLab base URL',
      allowHost: '192.168.1.10' // the configured host — NOT this one
    })
    expect(r.ok).toBe(false)
  })

  it('★ cloud metadata (169.254.169.254) is refused EVEN when allowHost matches it', () => {
    const r = checkBaseUrl('https://169.254.169.254', {
      label: 'GitLab base URL',
      allowHost: '169.254.169.254'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/metadata/i)
  })

  it('http:// is refused (would put the PAT in the clear) even with an allowHost', () => {
    const r = checkBaseUrl('http://192.168.1.10', {
      label: 'GitLab base URL',
      allowHost: '192.168.1.10'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/https/i)
  })

  it('embedded credentials are refused even with an allowHost', () => {
    const r = checkBaseUrl('https://user:pass@192.168.1.10', {
      label: 'GitLab base URL',
      allowHost: '192.168.1.10'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/credential/i)
  })
})

describe('checkBaseUrl — hex-tail IPv4-mapped IPv6 metadata bypass (CRITICAL)', () => {
  it('★ the WHATWG hex-tail form of the metadata IP is blocked even when allowHost matches it', () => {
    // `new URL('https://[::ffff:169.254.169.254]/')` normalizes `.hostname` to the
    // HEX tail `[::ffff:a9fe:a9fe]` — the dotted-decimal string match alone misses
    // this form entirely, admitting metadata whenever allowHost happens to be the
    // hex form of the connector's own configured self-host.
    const r = checkBaseUrl('https://[::ffff:169.254.169.254]/', {
      label: 'GitLab base URL',
      allowHost: '::ffff:a9fe:a9fe'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/metadata/i)
  })

  it('the plain dotted-decimal metadata address is still blocked', () => {
    const r = checkBaseUrl('https://169.254.169.254', { label: 'GitLab base URL' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/metadata/i)
  })

  it('a legit private self-host still ADMITS when allowHost matches (no regression)', () => {
    const r = checkBaseUrl('https://192.168.1.10', {
      label: 'GitLab base URL',
      allowHost: '192.168.1.10'
    })
    expect(r.ok).toBe(true)
  })
})

describe('blockedIpRange — dial-time pinned-IP allow (§5.1 DNS-rebind defense)', () => {
  it('★ the hex-tail mapped metadata IP is blocked at dial-time even when it is in allowIps', () => {
    const range = blockedIpRange('::ffff:a9fe:a9fe', { allowIps: ['::ffff:a9fe:a9fe'] })
    expect(range).not.toBeNull()
  })

  it('a DNS-rebind to a different private IP is still blocked (no regression)', () => {
    expect(blockedIpRange('192.168.1.55', { allowIps: ['192.168.1.10'] })).toMatch(/private/i)
  })

  it('admits the exact pinned IP the connector resolved for the self-host', () => {
    expect(blockedIpRange('192.168.1.10', { allowIps: ['192.168.1.10'] })).toBeNull()
  })

  it('★ a DNS-rebind flip to a DIFFERENT private IP is still blocked at connect', () => {
    expect(blockedIpRange('192.168.1.99', { allowIps: ['192.168.1.10'] })).toMatch(/private/i)
  })

  it('never admits cloud metadata even if it appears in the allow list', () => {
    expect(blockedIpRange('169.254.169.254', { allowIps: ['169.254.169.254'] })).not.toBeNull()
  })

  it('is byte-compatible with the no-allow default call', () => {
    expect(blockedIpRange('93.184.216.34')).toBeNull()
    expect(blockedIpRange('10.0.0.1')).toMatch(/private/i)
  })
})
