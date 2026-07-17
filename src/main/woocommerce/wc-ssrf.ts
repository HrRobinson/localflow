/**
 * Store-URL SSRF guard (spec §5.1) — a REAL, pure security control on the
 * user-supplied, self-hosted WooCommerce store URL. Because the connector makes
 * OUTBOUND requests to an address the user chose, a mistyped or hostile URL
 * could target loopback / RFC-1918 / link-local (`169.254.169.254` cloud
 * metadata). Every call passes through this validator BEFORE the request.
 *
 * Two entry points:
 *  - `checkStoreUrl(raw)` — validate the literal URL: https-only, no embedded
 *    credentials, and if the host is an IP literal (or `localhost`) it must not
 *    be private/loopback/link-local.
 *  - `blockedIpRange(ip)` — the post-DNS hook a real transport calls with the IP
 *    it ACTUALLY dialed, so a DNS-rebinding flip between validate and connect
 *    can't redirect the request to a private IP (spec §5.1). Returns a legible
 *    range label when blocked, else null.
 *
 * Pure and heavily unit-tested; it never resolves DNS itself (that belongs to
 * the transport, which is deferred with real HTTP — spec §11 DEFER).
 */

export type StoreUrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Parse `a.b.c.d` into four octets, or null if it isn't a valid IPv4 literal. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = IPV4.exec(host)
  if (!m) return null
  const octets = m.slice(1, 5).map((s) => Number(s))
  if (octets.some((n) => n < 0 || n > 255)) return null
  return octets as [number, number, number, number]
}

/** Range label if this IPv4 is private/loopback/link-local/unspecified, else null. */
function blockedIpv4(octets: [number, number, number, number]): string | null {
  const [a, b] = octets
  if (a === 0) return 'unspecified (0.0.0.0/8)'
  if (a === 127) return 'loopback (127.0.0.0/8)'
  if (a === 10) return 'private (10.0.0.0/8)'
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16.0.0/12)'
  if (a === 192 && b === 168) return 'private (192.168.0.0/16)'
  if (a === 169 && b === 254) return 'link-local (169.254.0.0/16)'
  return null
}

/** Range label if this IPv6 literal is loopback/unique-local/link-local/unspec,
 *  else null. Brackets (`[::1]`) are stripped by the caller. Coarse but covers
 *  the spec's named ranges (`::1`, `fc00::/7`, `fe80::/10`). */
function blockedIpv6(host: string): string | null {
  const h = host.toLowerCase()
  if (h === '::1') return 'loopback (::1)'
  if (h === '::' || h === '::0') return 'unspecified (::)'
  // ::ffff:127.0.0.1 style IPv4-mapped — defer to the IPv4 check on the tail.
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) {
    const v4 = parseIpv4(mapped[1])
    if (v4) return blockedIpv4(v4)
  }
  const head = h.split(':')[0]
  // fc00::/7 → first hextet 0xfc00–0xfdff (fc/fd prefix).
  if (head.startsWith('fc') || head.startsWith('fd')) return 'unique-local (fc00::/7)'
  // fe80::/10 → link-local.
  if (
    head.startsWith('fe8') ||
    head.startsWith('fe9') ||
    head.startsWith('fea') ||
    head.startsWith('feb')
  )
    return 'link-local (fe80::/10)'
  return null
}

/**
 * The range label if a resolved IP (v4 or v6 literal, no brackets) is
 * private/loopback/link-local, else null. This is the hook the transport calls
 * with the IP it dialed.
 */
export function blockedIpRange(ip: string): string | null {
  const v4 = parseIpv4(ip)
  if (v4) return blockedIpv4(v4)
  if (ip.includes(':')) return blockedIpv6(ip)
  return null
}

/**
 * Validate the literal store URL before any request. Rejects non-https,
 * embedded credentials, an unparseable URL, and an IP-literal / `localhost` host
 * that lands in a private/loopback/link-local range. A DNS hostname passes here
 * and is re-checked against its RESOLVED IP by `blockedIpRange` at dial time.
 */
export function checkStoreUrl(raw: string): StoreUrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `Store URL "${raw}" isn't a valid URL — fix it in Settings.` }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason:
        'Store URL must be https:// — plain HTTP would send the API keys in the clear. Fix it in Settings.'
    }
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      reason: 'Store URL must not embed credentials (user:pass@host) — remove them in Settings.'
    }
  }
  // `URL` keeps IPv6 hosts bracketed; strip for the range check.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return {
      ok: false,
      reason: `Store URL "${host}" is a loopback name — refusing to call it (spec §5.1).`
    }
  }
  const range = blockedIpRange(host)
  if (range) {
    return {
      ok: false,
      reason: `Store URL "${host}" is a private/loopback address (${range}) — refusing to call it.`
    }
  }
  return { ok: true, url }
}
