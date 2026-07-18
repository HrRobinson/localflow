/**
 * Shared SSRF guard for user-supplied self-host base URLs (promoted verbatim in
 * behavior from `woocommerce/wc-ssrf.ts`). Because a self-host connector makes
 * OUTBOUND requests to an address the user chose, a mistyped or hostile URL
 * could target loopback / RFC-1918 / link-local (`169.254.169.254` cloud
 * metadata). Every self-host connector (Woo, and future GitLab / GHES /
 * self-host Sentry / PostHog / Grafana) routes its base URL through here BEFORE
 * the first request.
 *
 * Two entry points:
 *  - `checkBaseUrl(raw, label?)` — validate the literal URL: https-only, no
 *    embedded credentials, and if the host is an IP literal (or `localhost`) it
 *    must not be private/loopback/link-local. `label` names the field for the
 *    error text ('Store URL', 'GitLab URL', …) so every connector gets a
 *    legible, connector-appropriate message.
 *  - `blockedIpRange(ip)` — the post-DNS hook a real transport calls with the IP
 *    it ACTUALLY dialed, so a DNS-rebinding flip between validate and connect
 *    can't redirect the request to a private IP. Returns a legible range label
 *    when blocked, else null.
 *
 * Pure and heavily unit-tested; it never resolves DNS itself (that belongs to
 * the transport, which is deferred with real HTTP).
 */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

/**
 * Options for `checkBaseUrl`. The bare-string form (`checkBaseUrl(raw, 'GitLab
 * URL')`) is preserved for the WooCommerce callers; the object form adds the
 * self-host explicit-allow (§5.1).
 */
export interface CheckBaseUrlOptions {
  /** Names the field in the error text (default 'Store URL'). */
  label?: string
  /**
   * The self-host explicit-allow (§5.1). When the URL's host EQUALS this host
   * (case-insensitively — the user's own configured `baseUrl` host, name or IP
   * literal), a private/loopback/link-local address is ADMITTED instead of
   * blocked. This is the connector's primary path: a self-managed GitLab on the
   * LAN is exactly a private-range host the user explicitly entered. Every OTHER
   * private target stays blocked, and cloud metadata (`169.254.169.254`) is
   * refused even when it matches `allowHost`.
   */
  allowHost?: string
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * The cloud-metadata addresses that stay blocked UNCONDITIONALLY — even under an
 * explicit self-host allow (§5.1): AWS/GCP/Azure IMDS `169.254.169.254`, its
 * IPv4-mapped IPv6 form, and the AWS IPv6 metadata address. A self-hosted GitLab
 * never legitimately lives here, and an SSRF to the metadata endpoint is the
 * canonical credential-theft target, so `allowHost` never reaches it.
 */
function isCloudMetadata(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '169.254.169.254') return true
  if (h === 'fd00:ec2::254') return true
  const mapped = h.match(/^::ffff:(.+)$/)
  if (mapped && mapped[1] === '169.254.169.254') return true
  return false
}

/** Case-insensitive host match for the explicit-allow (§5.1). Bracket-stripped
 *  so an IPv6 literal `baseUrl` and its `allowHost` compare equal. */
function hostMatchesAllow(host: string, allowHost: string | undefined): boolean {
  if (allowHost === undefined || allowHost.length === 0) return false
  const norm = (h: string): string => h.toLowerCase().replace(/^\[|\]$/g, '')
  return norm(host) === norm(allowHost)
}

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
 *  the named ranges (`::1`, `fc00::/7`, `fe80::/10`). */
function blockedIpv6(host: string): string | null {
  const h = host.toLowerCase()
  if (h === '::1') return 'loopback (::1)'
  if (h === '::' || h === '::0') return 'unspecified (::)'
  // IPv4-mapped IPv6 (::ffff:0:0/96). WHATWG `new URL()` normalizes
  // `[::ffff:127.0.0.1]` to the HEX tail `::ffff:7f00:1`, so we must catch BOTH
  // the dotted-decimal tail AND the hex tail, reconstruct the embedded IPv4, and
  // run it through the existing IPv4 range check (so loopback/RFC-1918/link-local/
  // metadata all apply). Anything ::ffff:-prefixed we can't cleanly reconstruct
  // is rejected outright — mapped addresses have no legitimate public-store use.
  const mapped = h.match(/^::ffff:(.+)$/)
  if (mapped) {
    const tail = mapped[1]
    const v4dotted = parseIpv4(tail)
    if (v4dotted) return blockedIpv4(v4dotted)
    const groups = tail.split(':')
    if (
      groups.length >= 1 &&
      groups.length <= 2 &&
      groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))
    ) {
      const nums = groups.map((g) => parseInt(g, 16))
      const hi = groups.length === 2 ? nums[0] : 0
      const lo = nums[groups.length - 1]
      const octets: [number, number, number, number] = [
        (hi >> 8) & 0xff,
        hi & 0xff,
        (lo >> 8) & 0xff,
        lo & 0xff
      ]
      return blockedIpv4(octets)
    }
    return 'IPv4-mapped IPv6 (::ffff:0:0/96)'
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
 * with the IP it ACTUALLY dialed, so a DNS-rebinding flip between validate and
 * connect can't redirect a request to a private IP.
 *
 * `allow.allowIps` is the self-host pinned-IP allow (§5.1): the IP the connector
 * resolved for the user's configured `baseUrl` at validate time. A later dial to
 * that exact pinned IP is admitted even on a private range; a dial to a DIFFERENT
 * private IP (the rebind attack) is still blocked. Cloud metadata is refused even
 * if it somehow appears in `allowIps`.
 */
export function blockedIpRange(ip: string, allow: { allowIps?: string[] } = {}): string | null {
  // The pinned-IP allow admits an exact match — but NEVER cloud metadata, which
  // stays blocked even if it somehow appears in `allowIps` (§5.1). A metadata IP
  // that is not allowed still falls through to `blockedIpv4` and is labeled
  // link-local (it lives in 169.254.0.0/16), so the default behavior is unchanged.
  const allowed = allow.allowIps?.some((a) => hostMatchesAllow(ip, a)) ?? false
  if (allowed && !isCloudMetadata(ip)) return null
  const v4 = parseIpv4(ip)
  if (v4) return blockedIpv4(v4)
  if (ip.includes(':')) return blockedIpv6(ip)
  return null
}

/**
 * Validate a user-supplied self-host base URL before any request. Rejects
 * non-https, embedded credentials, an unparseable URL, and an IP-literal /
 * `localhost` host that lands in a private/loopback/link-local range. A DNS
 * hostname passes here and is re-checked against its RESOLVED IP by
 * `blockedIpRange` at dial time.
 *
 * The second argument is either a `label` string (default 'Store URL', for
 * backward compatibility with the WooCommerce reasons) OR a `CheckBaseUrlOptions`
 * object carrying the self-host `allowHost` (§5.1).
 */
export function checkBaseUrl(
  raw: string,
  labelOrOptions: string | CheckBaseUrlOptions = {}
): UrlCheck {
  const options: CheckBaseUrlOptions =
    typeof labelOrOptions === 'string' ? { label: labelOrOptions } : labelOrOptions
  const label = options.label ?? 'Store URL'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `${label} "${raw}" isn't a valid URL — fix it in Settings.` }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `${label} must be https:// — plain HTTP would send the API keys in the clear. Fix it in Settings.`
    }
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      reason: `${label} must not embed credentials (user:pass@host) — remove them in Settings.`
    }
  }
  // `URL` keeps IPv6 hosts bracketed; strip for the range check.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // Cloud metadata is refused UNCONDITIONALLY — even if the user "allowed" it (§5.1).
  if (isCloudMetadata(host)) {
    return {
      ok: false,
      reason: `${label} "${host}" is a cloud-metadata address — always refused, even for a self-hosted instance.`
    }
  }
  // The self-host explicit-allow: the user's own configured host is admitted even
  // on a private range (a self-managed GitLab on the LAN is the primary case, §5.1).
  if (hostMatchesAllow(host, options.allowHost)) {
    return { ok: true, url }
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return {
      ok: false,
      reason: `${label} "${host}" is a loopback name — refusing to call it (spec §5.1).`
    }
  }
  const range = blockedIpRange(host)
  if (range) {
    return {
      ok: false,
      reason: `${label} "${host}" is a private/loopback address (${range}) — if this is your self-hosted instance, add it to the allowed hosts in Settings; cloud-metadata addresses are always refused.`
    }
  }
  return { ok: true, url }
}
