import { promises as dnsPromises } from 'node:dns'
import type { ResolvedRequest } from '../../shared/http'
import { checkBaseUrl, blockedIpRange } from '../net/ssrf-guard'

/**
 * The outbound HTTP transport (spec §4.2, §4.5). ALL request/response shapes
 * live ONLY here (the blast radius for any transport change), and EVERY resolved
 * URL is forced through the shared `ssrf-guard` BEFORE a socket opens — the
 * deterministic floor under the author's gates (§4.5). The real socket work is
 * isolated behind an `HttpTransport` interface so tests inject a
 * `MockHttpTransport`; no test opens a real socket. Failure follows the pinned
 * convention: every error path REJECTS with the real cause (status + a bounded
 * body excerpt, the remote's `Retry-After`, or the transport error code) — and
 * NEVER a secret (the request auth header is never logged or echoed, §9).
 */

/** The literal request the transport dials — final headers (auth already
 *  applied by the connector), never re-templated here. */
export interface HttpRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs?: number
  /** The node's `allowLocal` opt-in (§4.5), carried through so a transport that
   *  does its own dial-time resolution check (see `FetchHttpTransport`) can
   *  honor the same author opt-in as the string-level guard. */
  allowLocal?: boolean
}

/** A raw HTTP response — status + lowercased headers + the body as a string. */
export interface HttpRawResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** The seam the real socket transport implements and tests replace. */
export interface HttpTransport {
  send(req: HttpRequest): Promise<HttpRawResponse>
}

/**
 * Thrown by `guardUrl` (string-level) and `FetchHttpTransport`'s dial-time
 * DNS-rebind check — a rejection of the REQUEST, never the upstream. Callers
 * (`ApiSender.send`) use this to report a guard refusal as 400, distinct from
 * a genuine transport failure (502): a guard rejection can never succeed on
 * retry, so conflating the two invites an agent to retry a URL that never can.
 */
export class SsrfGuardError extends Error {}

const BODY_EXCERPT_MAX = 500

/** A bounded, single-line excerpt of a remote body for an error message. */
function excerpt(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ')
  return trimmed.length > BODY_EXCERPT_MAX ? `${trimmed.slice(0, BODY_EXCERPT_MAX)}…` : trimmed
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Guard a resolved URL before any dial. Default: https-only, no embedded
 * credentials, reject IP-literal/`localhost` private/loopback/link-local/metadata
 * ranges (via the shared guard). `allowLocal` is the explicit, author-visible
 * opt-in for a legitimate local target (§4.5) — it permits `http://` and
 * loopback/LAN, but still requires a parseable http(s) URL.
 *
 * NOTE the full scope of the opt-in: `allowLocal` disables the SSRF guard
 * ENTIRELY for this request — not just loopback, but also the cloud-metadata
 * ranges here AND the dial-time DNS-rebind re-check in `FetchHttpTransport`.
 * It is safe only because it is author-set (per-node on the canvas connector,
 * per-collection for the agent API client) and the target stays constrained by
 * the node/collection's own allowlist. Never enable it from untrusted input.
 */
export function guardUrl(url: string, allowLocal: boolean): void {
  if (allowLocal) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new SsrfGuardError(`Refusing to call "${url}" — it isn't a valid URL.`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new SsrfGuardError(`Refusing to call "${url}" — only http(s) URLs are allowed.`)
    }
    return
  }
  const check = checkBaseUrl(url, 'URL')
  if (!check.ok) {
    throw new SsrfGuardError(
      `${check.reason} Set \`allowLocal: true\` on this node only if you intend a local target.`
    )
  }
}

export class HttpClient {
  private readonly transport: HttpTransport

  constructor(deps: { transport: HttpTransport }) {
    this.transport = deps.transport
  }

  /**
   * Guard → dial → return the raw response for ANY status (design §7). The
   * agent API client uses this instead of `send`: a 404 is a normal, informative
   * result it must iterate on, and `send`'s rejection message embeds a body
   * excerpt that would route raw response content around the redaction model.
   * Still enforces the SSRF guard before a socket opens, and still maps a
   * transport failure to the pinned legible reject.
   */
  async sendRaw(req: ResolvedRequest): Promise<HttpRawResponse> {
    guardUrl(req.url, req.allowLocal)

    try {
      return await this.transport.send({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs,
        allowLocal: req.allowLocal
      })
    } catch (err) {
      // A dial-time guard rejection (`FetchHttpTransport`'s DNS-rebind check)
      // fires from INSIDE `transport.send`, so it lands in this catch too —
      // pass it through unwrapped so it stays distinguishable from a genuine
      // transport failure below (see `SsrfGuardError`'s doc).
      if (err instanceof SsrfGuardError) throw err
      // NEVER interpolate `err.message` here (finding C1): undici's `Headers`
      // implementation embeds the ENTIRE offending header value in its
      // TypeError when a header carries an embedded LF/NUL ("Headers.append:
      // "<value>" is an invalid header value."), and that value can be a
      // withheld field chained in via `$ref` (or the collection credential
      // itself) — this catch is the one place that value would otherwise
      // reach the agent verbatim, with no gate, no scrub, no audit signal.
      // `err.code` (a Node error code like `ECONNREFUSED`/`ENOTFOUND`) never
      // carries request content, so it is safe to surface — but a real
      // `fetch()` failure never sets `err.code` itself; the Node error code
      // lives one level down, on `err.cause.code` (verified against a real
      // DNS miss: `fetch('https://no-such-host.invalid/')` throws with
      // `err.code === undefined` and `err.cause.code === 'ENOTFOUND'`).
      // Without this fallback every real transport failure surfaced the
      // generic label below, never the actual code. `err.cause.code` is
      // exactly as contentless as `err.code` — still just a short Node error
      // code string, never a header value or URL path — so reading it does
      // NOT reopen C1. A transport error with neither gets the fixed,
      // contentless label, still never `.message`.
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code ??
        'transport error'
      throw new Error(
        `Couldn't reach ${hostOf(req.url)} (${code}) — check the URL and that the host is reachable.`,
        { cause: err }
      )
    }
  }

  /**
   * Guard → dial → map the result. Resolves the raw response on a 2xx; REJECTS
   * on a non-2xx (status + body excerpt), a 429 (the remote's `Retry-After`
   * verbatim), or a transport error (the Node error code). Never returns a
   * non-2xx as a resolved value; never renders a secret.
   */
  async send(req: ResolvedRequest): Promise<HttpRawResponse> {
    const res = await this.sendRaw(req)

    if (res.status === 429) {
      const retryAfter = res.headers['retry-after']
      const hint = retryAfter ? `; Retry-After: ${retryAfter}` : ''
      throw new Error(`${req.url} is rate-limited (429${hint}) — the remote asked us to back off.`)
    }

    if (res.status < 200 || res.status > 299) {
      throw new Error(`${req.method} ${req.url} returned ${res.status} — ${excerpt(res.body)}`)
    }

    return res
  }
}

/** A resolved DNS record — the subset of Node's `dns.lookup(host, {all:true})`
 *  result this guard needs. */
export interface DnsRecord {
  address: string
  family: number
}

/** The DNS-resolution seam `FetchHttpTransport` dials through — injected so
 *  tests reproduce a DNS-rebind-style bypass (a public hostname resolving to a
 *  private/loopback/metadata IP) with zero real network I/O. Default wraps
 *  Node's real `dns.promises.lookup` with `{all: true}` so every A/AAAA record
 *  is checked, not just the first. */
export type DnsLookupFn = (hostname: string, options: { all: true }) => Promise<DnsRecord[]>

const defaultDnsLookup: DnsLookupFn = (hostname, options) => dnsPromises.lookup(hostname, options)

/**
 * The real socket transport — the ONE place a live outbound HTTP call is made
 * (wraps the runtime's global `fetch`; §4.2). Honors `timeoutMs` via an
 * `AbortController`, lowercases response header keys, and reads the body as
 * text (the normalizer decides JSON-vs-string). A network/timeout failure
 * throws so `HttpClient.send` maps it to the pinned legible reject.
 *
 * Also the DIAL-TIME SSRF guard: `HttpClient.guardUrl` / `checkBaseUrl` are
 * string-level — they only pattern-match a literal IP or `localhost` in the
 * URL text and never resolve DNS. A hostname that LOOKS public but whose
 * A-record points at a private/loopback/link-local/metadata address (e.g. a
 * `*.sslip.io` wildcard host resolving to `169.254.169.254`) sails straight
 * through that check. Before every `fetch`, this transport resolves the URL's
 * hostname and runs every resolved IP through the shared `blockedIpRange` —
 * the same range table the string check uses — and rejects on the first hit,
 * BEFORE a socket opens.
 */
export class FetchHttpTransport implements HttpTransport {
  private readonly lookup: DnsLookupFn

  constructor(deps: { lookup?: DnsLookupFn } = {}) {
    this.lookup = deps.lookup ?? defaultDnsLookup
  }

  async send(req: HttpRequest): Promise<HttpRawResponse> {
    await this.guardResolvedAddress(req.url, req.allowLocal ?? false)

    const controller = new AbortController()
    const timer =
      req.timeoutMs !== undefined ? setTimeout(() => controller.abort(), req.timeoutMs) : undefined
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: 'manual'
      })
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      return { status: res.status, headers, body: await res.text() }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Resolve the URL's hostname and reject if ANY resolved IP is
   * private/loopback/link-local/metadata (via the shared `blockedIpRange`).
   * `allowLocal` is the author's explicit per-node opt-in (§4.5) and disables
   * this check entirely, matching the string-level guard's allowance. An
   * unparseable URL or a DNS failure is left to surface naturally at `fetch()`
   * — not this guard's job to diagnose.
   *
   * Residual: this resolves once and pins the reject to that answer, but does
   * NOT pin the subsequent `fetch()` to the checked IP — a DNS-rebind that
   * flips the answer between this resolve and the dial a few lines below is a
   * known, accepted gap (fetch() has no clean way to dial a specific IP while
   * keeping the original Host/SNI). At minimum, a blocked resolution is always
   * rejected here.
   */
  private async guardResolvedAddress(url: string, allowLocal: boolean): Promise<void> {
    if (allowLocal) return

    let hostname: string
    try {
      hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
    } catch {
      return
    }

    let records: DnsRecord[]
    try {
      records = await this.lookup(hostname, { all: true })
    } catch {
      return
    }

    for (const { address } of records) {
      const range = blockedIpRange(address)
      if (range) {
        throw new SsrfGuardError(
          `Refusing to call "${url}" — "${hostname}" resolves to a private/loopback/metadata ` +
            `address (${address}, ${range}).`
        )
      }
    }
  }
}

/** Test transport (spec §10): canned status/headers/body, or a thrown transport
 *  error. Records every request so a test can assert what was (or was NOT) sent. */
export class MockHttpTransport implements HttpTransport {
  readonly requests: HttpRequest[] = []
  private readonly responder: (req: HttpRequest) => HttpRawResponse | Promise<HttpRawResponse>

  constructor(responder: (req: HttpRequest) => HttpRawResponse | Promise<HttpRawResponse>) {
    this.responder = responder
  }

  send(req: HttpRequest): Promise<HttpRawResponse> {
    this.requests.push(req)
    return Promise.resolve(this.responder(req))
  }
}
