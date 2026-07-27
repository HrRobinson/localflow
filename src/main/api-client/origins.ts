/**
 * The collection's origin allowlist (design §2, §3) — the scope enforcement
 * that makes a grant mean "you may act as THIS API's client".
 *
 * An origin is `scheme://host[:port]` ONLY: no paths, no wildcards, exact match
 * after normalisation. Deliberately strict — a prefix or suffix match would let
 * `https://api.stripe.com.evil.com` pass an `https://api.stripe.com` allowlist.
 *
 * ALWAYS called on the RESOLVED url, after templating, for the same reason the
 * SSRF guard is: a `{{base_url}}` that resolves outside the allowlist must be
 * caught on the resolved string, not the template.
 */

/** Reduce a URL to `scheme://host[:port]`, or null if it isn't a usable http(s) URL. */
export function normalizeOrigin(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // `URL.origin` already omits the default port for http/https.
  return u.origin
}

/** Whether a resolved URL falls inside one of the collection's declared origins. */
export function originAllowed(url: string, origins: string[]): boolean {
  const target = normalizeOrigin(url)
  if (target === null) return false
  return origins.some((o) => normalizeOrigin(o) === target)
}
