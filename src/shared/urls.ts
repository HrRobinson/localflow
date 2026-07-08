/**
 * The one URL gate for browser panes. Everything that accepts a URL —
 * create, navigate, persist, open-external — goes through here: http(s)
 * only, parsed for real with `new URL`. Scheme-less user input
 * ("docs.example.com", "localhost:5173") gets an https:// prefix before
 * parsing; anything that declares another scheme (file:, javascript:,
 * data:, mailto:, …) is rejected, never rewritten.
 */
export function normalizeHttpUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  // A colon followed by a digit is a port (localhost:5173), not a scheme.
  // Any other "scheme:" prefix is explicit and must not be rewritten.
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?![0-9])/.test(trimmed)
  const candidate = hasExplicitScheme ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.hostname.length === 0) return null
    return url.href
  } catch {
    return null
  }
}

/** Strict check for already-formed URLs (navigation targets, open-external). */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
