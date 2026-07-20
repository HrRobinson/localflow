import { checkBaseUrl } from '../net/ssrf-guard'

/**
 * Thin REST client for the GitLab v4 API (spec §4.2, §6). ALL GitLab
 * endpoint/HTTP knowledge lives here — the blast radius for any API bump. HTTP
 * transport is INJECTED as a seam (`GitLabTransport`), exactly as `wc-api.ts`
 * injects its `WcTransport`, so tests drive it with a mock transport and NO live
 * HTTP happens (spec §12). Real HTTP is DEFERRED (foundation slice) — this module
 * ships the client shape + the offline seam.
 *
 * Security posture:
 *  - Every call passes the user-supplied `baseUrl` through the SHARED SSRF guard
 *    (`net/ssrf-guard`) BEFORE a request is built (spec §5.1): non-https, embedded
 *    credentials, and cloud metadata are refused; a private/loopback self-host is
 *    refused UNLESS it matches the connector's `allowHost` (the explicit self-host
 *    allow — the primary case here, §5.1).
 *  - The PAT is fetched at call time via the injected `reveal` seam (bound, at
 *    live wiring, to the main-only CredentialStore plaintext exit), used ONLY to
 *    build the `PRIVATE-TOKEN` header, and is NEVER logged or returned (spec §5).
 *  - Errors are human, actionable, and carry the real GitLab cause (spec §11);
 *    the client honors `Retry-After` on 429/5xx (self-host may send none → capped
 *    exponential backoff, like the Woo client — spec §2.4).
 */

export type GitLabMethod = 'GET' | 'POST' | 'PUT'

export interface GitLabRequest {
  method: GitLabMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface GitLabResponse {
  status: number
  body: string
  /** Response headers (lower-cased) — `retry-after` is honored on 429/5xx. */
  headers?: Record<string, string>
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface GitLabTransport {
  send(req: GitLabRequest): Promise<GitLabResponse>
}

/**
 * The read + write surface the connector dispatches to (spec §6.2, §12). The
 * connector is written against this INTERFACE so tests inject a mock returning
 * canned nodes and error envelopes without a live instance.
 */
export interface GitLabApi {
  getIssue(iid: string): Promise<unknown>
  getMR(iid: string): Promise<unknown>
  getPipeline(id: string): Promise<unknown>
  searchIssues(params: SearchIssuesParams): Promise<unknown>
  createNote(issueIid: string, body: string): Promise<unknown>
  updateIssue(iid: string, patch: Record<string, unknown>): Promise<unknown>
  createIssue(patch: Record<string, unknown>): Promise<unknown>
  createMR(patch: Record<string, unknown>): Promise<unknown>
  mergeMR(iid: string, patch: Record<string, unknown>): Promise<unknown>
}

export interface SearchIssuesParams {
  search?: string
  state?: string
  labels?: string
}

export interface GitLabApiDeps {
  transport: GitLabTransport
  /** The user-supplied base URL (non-secret ref from config.json). */
  baseUrl: string
  /** Project path or numeric id (`group/project` or `42`) — url-encoded per call. */
  projectPath: string
  /** Main-only plaintext exit for the PAT (never stored on `this`). */
  reveal: () => string
  /**
   * The self-host explicit-allow host (§5.1). Bound to the configured `baseUrl`
   * host so a private/LAN self-host is admitted while every OTHER private target
   * stays blocked. Omit (SaaS `gitlab.com`) and the default guard applies.
   */
  allowHost?: string
  /** Injectable delay so tests run without real backoff waits. */
  sleep?: (ms: number) => Promise<void>
  /** Max retry attempts on 429/5xx/timeout before giving up (default 3). */
  maxRetries?: number
}

const API_PREFIX = '/api/v4'
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class GitLabRestApi implements GitLabApi {
  private readonly transport: GitLabTransport
  private readonly baseUrl: string
  private readonly projectPath: string
  private readonly reveal: () => string
  private readonly allowHost?: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(deps: GitLabApiDeps) {
    this.transport = deps.transport
    this.baseUrl = deps.baseUrl
    this.projectPath = deps.projectPath
    this.reveal = deps.reveal
    this.allowHost = deps.allowHost
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? 3
  }

  // ── Reads (spec §6.2) ───────────────────────────────────────────────────────

  getIssue(iid: string): Promise<unknown> {
    return this.request('GET', `/issues/${encodeURIComponent(iid)}`)
  }

  getMR(iid: string): Promise<unknown> {
    return this.request('GET', `/merge_requests/${encodeURIComponent(iid)}`)
  }

  getPipeline(id: string): Promise<unknown> {
    return this.request('GET', `/pipelines/${encodeURIComponent(id)}`)
  }

  searchIssues(params: SearchIssuesParams): Promise<unknown> {
    const query = new URLSearchParams()
    if (params.search) query.set('search', params.search)
    if (params.state) query.set('state', params.state)
    if (params.labels) query.set('labels', params.labels)
    const suffix = query.toString()
    return this.request('GET', `/issues${suffix ? `?${suffix}` : ''}`)
  }

  // ── Gated writes (spec §6.2) ────────────────────────────────────────────────

  createNote(issueIid: string, body: string): Promise<unknown> {
    return this.request('POST', `/issues/${encodeURIComponent(issueIid)}/notes`, { body })
  }

  updateIssue(iid: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/issues/${encodeURIComponent(iid)}`, patch)
  }

  createIssue(patch: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/issues`, patch)
  }

  createMR(patch: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/merge_requests`, patch)
  }

  mergeMR(iid: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.request('PUT', `/merge_requests/${encodeURIComponent(iid)}/merge`, patch)
  }

  // ── Transport + error mapping ───────────────────────────────────────────────

  private async request(
    method: GitLabMethod,
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    // SSRF guard BEFORE any request is built (spec §5.1). The explicit-allow
    // admits the user's configured self-host while blocking every other private
    // target and cloud metadata unconditionally.
    const check = checkBaseUrl(this.baseUrl, {
      label: 'GitLab base URL',
      allowHost: this.allowHost
    })
    if (!check.ok) throw new Error(check.reason)

    const project = encodeURIComponent(this.projectPath)
    const base = `${trimTrailingSlash(check.url.href)}${API_PREFIX}/projects/${project}`
    const host = check.url.host
    const req: GitLabRequest = {
      method,
      url: `${base}${path}`,
      headers: this.authHeaders(body !== undefined)
    }
    if (body !== undefined) req.body = JSON.stringify(body)

    let lastErr: Error | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.retryDelayMs(attempt))
      let res: GitLabResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        // A network failure (DNS/refused/timeout) is retryable — capture and back off.
        lastErr = new Error(
          `GitLab at ${host} is unreachable (${(err as Error).message}) — check the base URL in Settings.`,
          { cause: err }
        )
        continue
      }
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(retryMessage(res))
        this.pendingRetryAfterMs = retryAfterMs(res)
        continue
      }
      // Non-retryable 4xx — map to the actionable §11 message and stop.
      throw mapClientError(res, path, this.projectPath)
    }
    throw lastErr ?? new Error(`GitLab request to ${host} failed after ${this.maxRetries} retries.`)
  }

  /** Retry-After (ms) captured from the most recent 429/5xx, honored on the next
   *  attempt; else capped exponential backoff (self-host often sends no header). */
  private pendingRetryAfterMs: number | undefined
  private retryDelayMs(attempt: number): number {
    if (this.pendingRetryAfterMs !== undefined) {
      const ms = this.pendingRetryAfterMs
      this.pendingRetryAfterMs = undefined
      return ms
    }
    return backoffMs(attempt)
  }

  /** Build the `PRIVATE-TOKEN` header from the keychain PAT. Read here and used
   *  ONLY for this header — never logged or returned. */
  private authHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.reveal(),
      Accept: 'application/json'
    }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }
}

function trimTrailingSlash(href: string): string {
  return href.endsWith('/') ? href.slice(0, -1) : href
}

/** Capped exponential backoff: 200ms, 400ms, 800ms, … the self-host fallback
 *  when no `Retry-After` is sent (spec §2.4). */
function backoffMs(attempt: number): number {
  return Math.min(200 * 2 ** (attempt - 1), 5_000)
}

/** `Retry-After` in ms if the response carries it (seconds per the RFC), else
 *  undefined so the caller falls back to capped backoff. */
function retryAfterMs(res: GitLabResponse): number | undefined {
  const raw = res.headers?.['retry-after']
  if (typeof raw !== 'string') return undefined
  const secs = Number(raw)
  if (!Number.isFinite(secs) || secs < 0) return undefined
  return Math.min(secs * 1000, 30_000)
}

function retryMessage(res: GitLabResponse): string {
  const raw = res.headers?.['retry-after']
  if (typeof raw === 'string' && Number.isFinite(Number(raw))) {
    return `GitLab throttled the request (${res.status}) — retry in ~${Number(raw)}s.`
  }
  return `GitLab returned ${res.status} — backing off and retrying (no Retry-After header to honor).`
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Extract GitLab's `{ message }` / `{ error }` from an error body, if present. */
function gitlabMessage(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (typeof data === 'object' && data !== null) {
      const rec = data as Record<string, unknown>
      const m = rec.message ?? rec.error
      if (typeof m === 'string' && m.length > 0) return m
      // GitLab sometimes nests validation errors under `message: {...}`.
      if (m && typeof m === 'object') return JSON.stringify(m)
    }
  } catch {
    /* not JSON — fall through */
  }
  return undefined
}

/** Map a non-retryable 4xx to the actionable, real-cause message (spec §11). */
function mapClientError(res: GitLabResponse, path: string, projectPath: string): Error {
  const detail = gitlabMessage(res.body)
  switch (res.status) {
    case 401:
      return new Error(
        'GitLab rejected the access token (401) — it was revoked or is wrong; re-enter it in Settings.'
      )
    case 403:
      return new Error(
        'GitLab refused the request (403): the token is missing the `api` scope ' +
          "(read-only `read_api` can't write) — regenerate it with `api` and re-enter."
      )
    case 404:
      return new Error(
        `GitLab has no resource at ${path} in \`${projectPath}\` (404) — ` +
          'it may be from another project or was deleted.'
      )
    default:
      return new Error(
        detail
          ? `GitLab rejected the request (${res.status}): ${detail}`
          : `GitLab rejected the request (${res.status}) on ${path}.`
      )
  }
}
