import type { RefValue } from './request-resolve'

/**
 * The ABSOLUTE tier of the response guarantee (design §4.1): the exact value of
 * the credential injected into a request is replaced in the stored body at
 * ingest, before anything can read it. Not withheld, not gate-able —
 * unreachable by any path. There is no legitimate reason for an agent to read
 * back the credential it just sent.
 *
 * Exact-match by construction (`split`/`join`, never a regex), so a secret
 * containing regex metacharacters is handled literally and the whole tier is
 * fully testable.
 */

export const REDACTED = '[redacted]'

/** Every encoding of a secret that could appear in a response body. */
export function scrubForms(secret: string): string[] {
  if (secret.length === 0) return []
  const forms = new Set<string>([secret])
  forms.add(Buffer.from(secret, 'utf8').toString('base64'))
  forms.add(encodeURIComponent(secret))
  // application/x-www-form-urlencoded (OAuth exchanges, URLSearchParams) escapes
  // a different set than RFC 3986 percent-encoding — space as `+`, plus
  // `!'()~` where encodeURIComponent leaves them bare. Build it with the real
  // serializer rather than patching encodeURIComponent output, so the full
  // escape-set delta is covered by construction.
  forms.add(new URLSearchParams([['x', secret]]).toString().slice(2))
  return [...forms]
}

/**
 * Replace every occurrence of every form with `[redacted]`. Longest-first so a
 * form that is a substring of another can never leave a partial behind.
 */
export function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue
    out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Finding 2 — a `$ref`-chained value joins the NEXT request's scrub set
 * (design §4.4's compensating control for `pullForChain` bypassing the
 * withheld gate). A prior fix gated this on LENGTH (a fixed 8-character
 * minimum), reasoning that a short chained value was more likely to be an
 * ordinary scalar (a page number, a flag) than a credential, and scrubbing it
 * anyway risked an exact-match `split`/`join` corrupting unrelated bytes in
 * the next response by coincidence.
 *
 * Length is the wrong axis. A chained value that was NOT withheld was already
 * readable straight out of the response it came from — scrubbing it from the
 * NEXT response protects nothing, since the agent could always just re-read
 * the first one. A chained value that WAS withheld must be scrubbed
 * regardless of length: a short withheld field (a `session_id` a few
 * characters long) leaking back in the clear on echo is exactly the leak
 * §4.1's withhold tier exists to prevent, and length was never a proxy for
 * that — only whether `pull` would have refused it directly.
 */

/** Chained ref values worth adding to a response's scrub set: exactly the
 *  ones that were withheld (finding 2) — see the note above. */
export function chainScrubCandidates(values: readonly RefValue[]): string[] {
  return values.filter((v) => v.withheld).map((v) => v.value)
}
