import { checkStoreUrl } from './wc-ssrf'

/**
 * Thin REST client for the WooCommerce `wc/v3` API (spec §4.2, §6). ALL WC
 * endpoint/HTTP knowledge lives here — the blast radius. HTTP transport is
 * INJECTED as a seam (`WcTransport`), exactly as `operator-guard.ts` injects its
 * `GuardRunner` and `CredentialStore` its `SecretBackend`, so tests drive it
 * with a `MockWcApi` transport and NO live HTTP happens (spec §9). Real HTTP is
 * DEFERRED (spec §11) — this module ships the client shape + the offline seam.
 *
 * Security posture:
 *  - Every call passes the store URL through the SSRF guard (`wc-ssrf`) BEFORE a
 *    request is built (spec §5.1) — a private/loopback/non-https URL is refused.
 *  - The consumer key/secret are fetched at call time via the injected `reveal`
 *    seam (bound, at live wiring, to the main-only CredentialStore plaintext
 *    exit), used ONLY to build the Basic-auth header, and are NEVER logged or
 *    returned (spec §4.6, §5).
 *  - Errors are human, actionable, and carry the real WC cause (spec §8); the
 *    client backs off on 429/5xx (no `Retry-After` to trust — spec §2.4).
 */

export type WcMethod = 'GET' | 'POST' | 'PUT'

export interface WcRequest {
  method: WcMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface WcResponse {
  status: number
  body: string
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface WcTransport {
  send(req: WcRequest): Promise<WcResponse>
}

export interface WcApiDeps {
  transport: WcTransport
  /** The user-supplied store base URL (non-secret ref from config.json). */
  storeUrl: string
  /** Main-only plaintext exit for the two keychain secrets (never stored here). */
  reveal: (field: 'consumerKey' | 'consumerSecret') => string
  /** Injectable delay so tests run without real backoff waits. */
  sleep?: (ms: number) => Promise<void>
  /** Max retry attempts on 429/5xx/timeout before giving up (default 3). */
  maxRetries?: number
}

export interface RefundParams {
  amount?: string
  lineItems?: unknown[]
  apiRefund: boolean
}

export interface OrderNoteParams {
  note: string
  customerNote: boolean
}

export interface SearchOrdersParams {
  search?: string
  status?: string
  customer?: string
  after?: string
}

const API_PREFIX = '/wp-json/wc/v3'
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class WcApi {
  private readonly transport: WcTransport
  private readonly storeUrl: string
  private readonly reveal: WcApiDeps['reveal']
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(deps: WcApiDeps) {
    this.transport = deps.transport
    this.storeUrl = deps.storeUrl
    this.reveal = deps.reveal
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? 3
  }

  // ── Reads (spec §6.2) ───────────────────────────────────────────────────────

  getOrder(orderId: string): Promise<unknown> {
    return this.request('GET', `/orders/${encodeURIComponent(orderId)}`)
  }

  getCustomer(customerId: string): Promise<unknown> {
    return this.request('GET', `/customers/${encodeURIComponent(customerId)}`)
  }

  searchOrders(params: SearchOrdersParams): Promise<unknown> {
    const query = new URLSearchParams()
    if (params.search) query.set('search', params.search)
    if (params.status) query.set('status', params.status)
    if (params.customer) query.set('customer', params.customer)
    if (params.after) query.set('after', params.after)
    const suffix = query.toString()
    return this.request('GET', `/orders${suffix ? `?${suffix}` : ''}`)
  }

  // ── Gated mutations (spec §6.3) ─────────────────────────────────────────────

  createRefund(orderId: string, params: RefundParams): Promise<unknown> {
    const body: Record<string, unknown> = { api_refund: params.apiRefund }
    if (params.amount !== undefined) body.amount = params.amount
    if (params.lineItems !== undefined) body.line_items = params.lineItems
    return this.request('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, body)
  }

  /** PUT a partial order body — used by both cancelOrder and updateShippingAddress. */
  updateOrder(orderId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/orders/${encodeURIComponent(orderId)}`, body)
  }

  createOrderNote(orderId: string, params: OrderNoteParams): Promise<unknown> {
    return this.request('POST', `/orders/${encodeURIComponent(orderId)}/notes`, {
      note: params.note,
      customer_note: params.customerNote
    })
  }

  // ── Transport + error mapping ───────────────────────────────────────────────

  private async request(method: WcMethod, path: string, body?: unknown): Promise<unknown> {
    // SSRF guard BEFORE any request is built (spec §5.1). Refuse a private/
    // loopback/non-https store URL with the legible reason.
    const check = checkStoreUrl(this.storeUrl)
    if (!check.ok) throw new Error(check.reason)

    const url = `${trimTrailingSlash(check.url.href)}${API_PREFIX}${path}`
    const host = check.url.host
    const req: WcRequest = {
      method,
      url,
      headers: this.authHeaders(body !== undefined)
    }
    if (body !== undefined) req.body = JSON.stringify(body)

    let lastErr: Error | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(backoffMs(attempt))
      let res: WcResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        // A network failure (DNS/refused/timeout) is retryable — capture and back off.
        lastErr = new Error(
          `WooCommerce store ${host} is unreachable (${(err as Error).message}) — check the Store URL in Settings.`,
          { cause: err }
        )
        continue
      }
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      if (res.status === 429 || res.status >= 500) {
        // Host throttle / overloaded shared hosting — no Retry-After to honor.
        lastErr = new Error(
          `The store returned ${res.status} — backing off and retrying (no rate-limit header to honor).`
        )
        continue
      }
      // Non-retryable 4xx — map to the actionable §8 message and stop.
      throw mapClientError(res, path)
    }
    throw (
      lastErr ??
      new Error(`WooCommerce request to ${host} failed after ${this.maxRetries} retries.`)
    )
  }

  /** Build the Basic-auth header from the keychain secrets. The key/secret are
   *  read here and used ONLY for this header — never logged or returned. */
  private authHeaders(hasBody: boolean): Record<string, string> {
    const key = this.reveal('consumerKey')
    const secret = this.reveal('consumerSecret')
    const headers: Record<string, string> = {
      Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'),
      Accept: 'application/json'
    }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }
}

function trimTrailingSlash(href: string): string {
  return href.endsWith('/') ? href.slice(0, -1) : href
}

/** Capped exponential backoff: 200ms, 400ms, 800ms, … no `Retry-After` (spec §2.4). */
function backoffMs(attempt: number): number {
  return Math.min(200 * 2 ** (attempt - 1), 5_000)
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Extract WC's `{ message }` from an error body, if present. */
function wcMessage(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (typeof data === 'object' && data !== null && 'message' in data) {
      const m = (data as { message: unknown }).message
      if (typeof m === 'string' && m.length > 0) return m
    }
  } catch {
    /* not JSON — fall through */
  }
  return undefined
}

/** Map a non-retryable 4xx to the actionable, real-cause message (spec §8). */
function mapClientError(res: WcResponse, path: string): Error {
  const detail = wcMessage(res.body)
  switch (res.status) {
    case 401:
      return new Error(
        'WooCommerce rejected the API keys (401) — regenerate a key in ' +
          'WooCommerce ▸ Settings ▸ Advanced ▸ REST API and re-enter both parts.'
      )
    case 403:
      return new Error(
        'The stored WooCommerce key is read-only — this action needs a Read/Write key. ' +
          'Regenerate it and re-enter.'
      )
    case 404:
      return new Error(
        `That resource isn't in this store (404 on ${path}) — it may be trashed or from another store.`
      )
    default:
      return new Error(
        detail
          ? `WooCommerce rejected the request (${res.status}): ${detail}`
          : `WooCommerce rejected the request (${res.status}) on ${path}.`
      )
  }
}
