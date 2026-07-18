import type { ResolvedRequest } from '../../shared/http'
import { checkBaseUrl } from '../net/ssrf-guard'

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
 * ranges (via the shared guard). `allowLocal` is the explicit, per-node,
 * author-visible opt-in for a legitimate local target (§4.5) — it permits
 * `http://` and loopback/LAN, but still requires a parseable http(s) URL.
 */
export function guardUrl(url: string, allowLocal: boolean): void {
  if (allowLocal) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new Error(`Refusing to call "${url}" — it isn't a valid URL.`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Refusing to call "${url}" — only http(s) URLs are allowed.`)
    }
    return
  }
  const check = checkBaseUrl(url, 'URL')
  if (!check.ok) {
    throw new Error(
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
   * Guard → dial → map the result. Resolves the raw response on a 2xx; REJECTS
   * on a non-2xx (status + body excerpt), a 429 (the remote's `Retry-After`
   * verbatim), or a transport error (the Node error code). Never returns a
   * non-2xx as a resolved value; never renders a secret.
   */
  async send(req: ResolvedRequest): Promise<HttpRawResponse> {
    guardUrl(req.url, req.allowLocal)

    let res: HttpRawResponse
    try {
      res = await this.transport.send({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs
      })
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).message
      throw new Error(
        `Couldn't reach ${hostOf(req.url)} (${code}) — check the URL and that the host is reachable.`,
        { cause: err }
      )
    }

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

/**
 * The real socket transport — the ONE place a live outbound HTTP call is made
 * (wraps the runtime's global `fetch`; §4.2). Honors `timeoutMs` via an
 * `AbortController`, lowercases response header keys, and reads the body as
 * text (the normalizer decides JSON-vs-string). A network/timeout failure
 * throws so `HttpClient.send` maps it to the pinned legible reject.
 */
export class FetchHttpTransport implements HttpTransport {
  async send(req: HttpRequest): Promise<HttpRawResponse> {
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
