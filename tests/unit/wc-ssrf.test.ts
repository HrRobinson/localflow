import { describe, it, expect } from 'vitest'
import { checkStoreUrl, blockedIpRange } from '../../src/main/woocommerce/wc-ssrf'

/**
 * ★ A store URL is attacker-influenced input (user-supplied, self-hosted). This
 * guard is a REAL security control, not a formality — exercise it hard (spec §5.1).
 */
describe('checkStoreUrl', () => {
  it('allows a plain public https host', () => {
    const r = checkStoreUrl('https://shop.example.com')
    expect(r.ok).toBe(true)
  })

  it('allows a public https host with a path/port and keeps the URL', () => {
    const r = checkStoreUrl('https://shop.example.com:8443/wp-json')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.host).toBe('shop.example.com:8443')
  })

  it('rejects plain http — keys would go in the clear', () => {
    const r = checkStoreUrl('http://shop.example.com')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/https/i)
  })

  it('rejects a URL that embeds credentials', () => {
    const r = checkStoreUrl('https://user:pass@shop.example.com')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/credential/i)
  })

  it('rejects garbage that is not a URL at all', () => {
    expect(checkStoreUrl('not a url').ok).toBe(false)
    expect(checkStoreUrl('').ok).toBe(false)
  })

  it.each([
    ['https://127.0.0.1', 'loopback IPv4'],
    ['https://127.5.6.7', '127/8 loopback'],
    ['https://10.0.0.5', '10/8 private'],
    ['https://172.16.4.4', '172.16/12 private'],
    ['https://172.31.255.1', '172.16/12 upper edge'],
    ['https://192.168.1.10', '192.168/16 private'],
    ['https://169.254.169.254', 'link-local metadata endpoint'],
    ['https://0.0.0.0', 'unspecified'],
    ['https://[::1]', 'loopback IPv6'],
    ['https://[fc00::1]', 'IPv6 unique-local'],
    ['https://[fe80::1]', 'IPv6 link-local'],
    ['https://[::ffff:127.0.0.1]', 'IPv4-mapped loopback (dotted)'],
    ['https://[::ffff:169.254.169.254]', 'IPv4-mapped cloud metadata (dotted)'],
    ['https://[::ffff:10.0.0.1]', 'IPv4-mapped RFC-1918 (dotted)'],
    ['https://[::ffff:192.168.1.1]', 'IPv4-mapped RFC-1918 (dotted)'],
    ['https://localhost', 'localhost name']
  ])('blocks a private/loopback/link-local target: %s (%s)', (url) => {
    const r = checkStoreUrl(url)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/private|loopback|link-local|refus/i)
  })

  it('does NOT block a public 172.x host outside the 172.16/12 range', () => {
    expect(checkStoreUrl('https://172.15.0.1').ok).toBe(true)
    expect(checkStoreUrl('https://172.32.0.1').ok).toBe(true)
  })
})

/** The post-DNS-resolution hook a real transport calls with the IP it actually
 *  dialed (spec §5.1 — guard the resolved IP, not just the literal host). */
describe('blockedIpRange', () => {
  it('flags private/loopback/link-local resolved IPs with a range label', () => {
    expect(blockedIpRange('127.0.0.1')).toMatch(/loopback/i)
    expect(blockedIpRange('10.1.2.3')).toMatch(/private/i)
    expect(blockedIpRange('169.254.169.254')).toMatch(/link-local/i)
    expect(blockedIpRange('::1')).toMatch(/loopback/i)
    expect(blockedIpRange('fc00::abcd')).toMatch(/unique-local|private/i)
  })

  it('flags IPv4-mapped IPv6 in the hex form WHATWG normalizes to (spec §5.1)', () => {
    // `new URL('[::ffff:127.0.0.1]')` normalizes to `::ffff:7f00:1`, so the
    // post-DNS hook sees the hex tail — it must still resolve to the IPv4 range.
    expect(blockedIpRange('::ffff:7f00:1')).toMatch(/loopback/i)
    expect(blockedIpRange('::ffff:a9fe:a9fe')).toMatch(/link-local/i)
    expect(blockedIpRange('::ffff:0a00:0001')).toMatch(/private/i)
    // Upper-case hex must be handled too.
    expect(blockedIpRange('::FFFF:7F00:1')).toMatch(/loopback/i)
  })

  it('returns null for a public resolved IP', () => {
    expect(blockedIpRange('93.184.216.34')).toBeNull()
    expect(blockedIpRange('2606:2800:220:1:248:1893:25c8:1946')).toBeNull()
  })

  it('does NOT over-block a genuinely public IPv4-mapped address', () => {
    // ::ffff:5db8:d822 == 93.184.216.34 (a public host) — must NOT be blocked.
    expect(blockedIpRange('::ffff:5db8:d822')).toBeNull()
    expect(blockedIpRange('::ffff:93.184.216.34')).toBeNull()
  })
})
