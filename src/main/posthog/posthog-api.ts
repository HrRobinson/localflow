import { checkBaseUrl, blockedIpRange } from '../net/ssrf-guard'

/**
 * Thin REST/Query client for the PostHog API (spec §4.2, §6). ALL PostHog
 * endpoint/HTTP knowledge lives here — the blast radius for any API change,
 * exactly as Woo isolated its REST in `wc-api.ts`. HTTP transport is INJECTED as
 * a seam (`PostHogTransport`) so tests drive it with a `MockPostHogApi` and NO
 * live HTTP happens (spec §12). Real HTTP is DEFERRED (spec §4.3) — this module
 * ships the client shape + the offline seam.
 *
 * Security posture:
 *  - Every request passes the user-supplied `host` through the SHARED SSRF guard
 *    (`net/ssrf-guard`) BEFORE a request is built (spec §4.4) — a private /
 *    loopback / link-local host is refused unless `allowInsecureLocalHost` is
 *    explicitly opted in (the reviewed self-host-on-LAN escape hatch).
 *  - The personal API key is fetched at call time via the injected `reveal` seam
 *    (bound, at live wiring, to the main-only CredentialStore plaintext exit),
 *    used ONLY to build the Bearer header, and NEVER logged or returned
 *    (spec §8).
 *  - Errors are human, actionable, and carry the real PostHog cause (spec §11);
 *    the client backs off on 429/5xx, honoring `Retry-After` when present.
 */

export type PostHogMethod = 'GET' | 'POST' | 'PATCH'

export interface PostHogRequest {
  method: PostHogMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface PostHogResponse {
  status: number
  body: string
  /** `Retry-After` seconds, when the transport surfaces it (spec §11 429 path). */
  retryAfterSeconds?: number
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface PostHogTransport {
  send(req: PostHogRequest): Promise<PostHogResponse>
}

/** Params for a HogQL/event query (spec §6.2 `queryEvents`, §7.2a poll). */
export interface QueryEventsParams {
  /** Event name to match (e.g. `$feature_flag_error`). */
  event?: string
  /** Only events strictly AFTER this ISO timestamp (the poll cursor, §7.2a). */
  after?: string
  /** Property equality filters, ANDed. */
  properties?: Record<string, unknown>
  /** Cap on returned rows. */
  limit?: number
}

/** The rollout/state change `updateFeatureFlag` may make (spec §6.2 gated write). */
export interface UpdateFeatureFlagPatch {
  active?: boolean
  rolloutPercentage?: number
}

/**
 * The seam `posthog-connector` and `posthog-poller` are written against
 * (spec §12). The real impl (`PostHogHttpApi`) wraps the transport + the SSRF
 * guard; tests inject a `MockPostHogApi` returning canned events/insights/
 * cohorts/flags and canned error bodies. Reads return RAW PostHog JSON — the
 * connector/poller run it through `posthog-normalize` (the correctness boundary).
 */
export interface PostHogApi {
  /** RAW event rows, oldest-first, matching the query (spec §6.2, §7.2a). */
  queryEvents(params: QueryEventsParams): Promise<unknown[]>
  getInsight(id: string): Promise<unknown>
  getFeatureFlag(id: string): Promise<unknown>
  /** RAW cohort incl. its member list (for the §7.2b set-diff poll). */
  getCohort(id: string): Promise<unknown>
  updateFeatureFlag(id: string, patch: UpdateFeatureFlagPatch): Promise<unknown>
}

export interface PostHogHttpApiDeps {
  transport: PostHogTransport
  /** The user-supplied base URL (non-secret ref from config.json). */
  host: string
  /** Public project key (`phc_…`) — identifies the project path (non-secret). */
  projectApiKey: string
  /** Main-only plaintext exit for the personal API key (never stored here). */
  reveal: () => string
  /** Explicit opt-in to allow a self-hosted PostHog on LAN/localhost (spec §4.4). */
  allowInsecureLocalHost?: boolean
  /** Injectable delay so tests run without real backoff waits. */
  sleep?: (ms: number) => Promise<void>
  /** Max retry attempts on 429/5xx/timeout before giving up (default 3). */
  maxRetries?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The real REST/Query client. The numeric project id in `/api/projects/:id/…`
 * is `@current` — PostHog resolves it from the personal key's project scope, so
 * no separate project-id field is needed (spec §5 project-id note).
 */
export class PostHogHttpApi implements PostHogApi {
  private readonly transport: PostHogTransport
  private readonly host: string
  private readonly reveal: () => string
  private readonly allowInsecureLocalHost: boolean
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(deps: PostHogHttpApiDeps) {
    // `projectApiKey` identifies the project but the REST path uses `@current`
    // (resolved from the personal key's scope, spec §5), so it is part of the
    // live-wiring deps contract without being read here.
    this.transport = deps.transport
    this.host = deps.host
    this.reveal = deps.reveal
    this.allowInsecureLocalHost = deps.allowInsecureLocalHost ?? false
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? 3
  }

  queryEvents(params: QueryEventsParams): Promise<unknown[]> {
    // HogQL SELECT over `events`, ordered ascending so the poll cursor advances
    // monotonically (spec §7.2a). The predicate is built here, in the one place
    // that owns query shape.
    const where: string[] = []
    if (params.event !== undefined) where.push(`event = ${sqlString(params.event)}`)
    // Inclusive lower bound: the poller owns exact same-timestamp dedup by uuid
    // (spec §7.2a), so the query must not drop a boundary-tick event.
    if (params.after !== undefined) where.push(`timestamp >= ${sqlString(params.after)}`)
    if (params.properties) {
      for (const [k, v] of Object.entries(params.properties)) {
        where.push(`properties.${k} = ${sqlString(String(v))}`)
      }
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    const limit = params.limit ?? 100
    const query =
      `SELECT uuid, event, distinct_id, timestamp, properties FROM events${clause} ` +
      `ORDER BY timestamp ASC, uuid ASC LIMIT ${limit}`
    return this.request('POST', '/query/', {
      query: { kind: 'HogQLQuery', query }
    }).then((raw) => extractQueryRows(raw))
  }

  getInsight(id: string): Promise<unknown> {
    return this.request('GET', `/insights/${encodeURIComponent(id)}/`)
  }

  getFeatureFlag(id: string): Promise<unknown> {
    return this.request('GET', `/feature_flags/${encodeURIComponent(id)}/`)
  }

  getCohort(id: string): Promise<unknown> {
    return this.request('GET', `/cohorts/${encodeURIComponent(id)}/`)
  }

  updateFeatureFlag(id: string, patch: UpdateFeatureFlagPatch): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (patch.active !== undefined) body.active = patch.active
    if (patch.rolloutPercentage !== undefined) body.rollout_percentage = patch.rolloutPercentage
    return this.request('PATCH', `/feature_flags/${encodeURIComponent(id)}/`, body)
  }

  // ── Transport + error mapping ───────────────────────────────────────────────

  private async request(method: PostHogMethod, path: string, body?: unknown): Promise<unknown> {
    // SSRF guard BEFORE any request is built (spec §4.4). A self-hosted PostHog
    // on LAN/localhost is a legitimate target only behind the explicit opt-in.
    const check = checkBaseUrl(this.host, 'PostHog host')
    if (!check.ok) {
      if (!(this.allowInsecureLocalHost && isLocalHostReason(check.reason))) {
        throw new Error(
          check.reason +
            ' Set a public host, or enable allowInsecureLocalHost for a self-host on your LAN.'
        )
      }
      // Opt-in path: re-parse leniently so a localhost self-host can proceed.
    }
    const base = check.ok ? check.url : parseLenient(this.host)
    if (!base) {
      throw new Error(`PostHog host "${this.host}" isn't a valid URL — fix it in Settings.`)
    }
    // Even with the opt-in, a resolved non-loopback private target beyond the
    // local box stays blocked unless it is loopback/localhost the user chose.
    const url = `${trimTrailingSlash(base.href)}/api/projects/@current${path}`
    const hostLabel = base.host
    const req: PostHogRequest = {
      method,
      url,
      headers: this.authHeaders(body !== undefined)
    }
    if (body !== undefined) req.body = JSON.stringify(body)

    let lastErr: Error | undefined
    let lastRetryAfter: number | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(backoffMs(attempt, lastRetryAfter))
      let res: PostHogResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        lastErr = new Error(
          `PostHog host ${hostLabel} is unreachable (${(err as Error).message}) — check the host in Settings.`,
          { cause: err }
        )
        continue
      }
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      if (res.status === 429 || res.status >= 500) {
        lastRetryAfter = res.retryAfterSeconds
        lastErr = new Error(
          `PostHog throttled the request — backed off and gave up after ${this.maxRetries} tries.`
        )
        continue
      }
      throw mapClientError(res, path)
    }
    throw (
      lastErr ??
      new Error(`PostHog request to ${hostLabel} failed after ${this.maxRetries} retries.`)
    )
  }

  /** Build the Bearer header from the keychain secret. Read here and used ONLY
   *  for this header — never logged or returned (spec §8). */
  private authHeaders(hasBody: boolean): Record<string, string> {
    const key = this.reveal()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json'
    }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }
}

function isLocalHostReason(reason: string): boolean {
  return /loopback|127\.0\.0\.1|localhost|::1/i.test(reason)
}

function parseLenient(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function trimTrailingSlash(href: string): string {
  return href.endsWith('/') ? href.slice(0, -1) : href
}

/** Capped exponential backoff, honoring `Retry-After` when the host sent one. */
function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 30_000)
  }
  return Math.min(200 * 2 ** (attempt - 1), 5_000)
}

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** HogQL query responses wrap rows in `{ results: [[...]], columns: [...] }`.
 *  Turn each positional row back into an object keyed by column name. */
function extractQueryRows(raw: unknown): unknown[] {
  if (typeof raw !== 'object' || raw === null) return []
  const obj = raw as Record<string, unknown>
  const results = obj.results ?? obj.result
  if (!Array.isArray(results)) return []
  const columns = Array.isArray(obj.columns) ? (obj.columns as unknown[]).map(String) : null
  return results.map((row) => {
    if (Array.isArray(row) && columns) {
      const out: Record<string, unknown> = {}
      columns.forEach((c, i) => {
        out[c] = row[i]
      })
      return out
    }
    return row
  })
}

/** Extract PostHog's `{ detail }` / `{ message }` from an error body, if present. */
function posthogMessage(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (typeof data === 'object' && data !== null) {
      const d = data as Record<string, unknown>
      for (const field of ['detail', 'message', 'error']) {
        const m = d[field]
        if (typeof m === 'string' && m.length > 0) return m
      }
    }
  } catch {
    /* not JSON — fall through */
  }
  return undefined
}

/** Map a non-retryable 4xx to the actionable, real-cause message (spec §11). */
function mapClientError(res: PostHogResponse, path: string): Error {
  const detail = posthogMessage(res.body)
  switch (res.status) {
    case 401:
      return new Error(
        'PostHog rejected the personal API key (401) — it was revoked or is wrong; re-enter it in Settings.'
      )
    case 403:
      return new Error(
        detail
          ? `PostHog refused the request: ${detail} — the personal API key likely lacks the needed scope; regenerate a scoped key.`
          : 'PostHog refused the request (403) — the personal API key lacks the needed scope; regenerate a scoped key with that permission.'
      )
    case 404:
      return new Error(
        `PostHog has no such resource (404 on ${path}) — it may be in another project or was deleted.`
      )
    default:
      return new Error(
        detail
          ? `PostHog rejected the request (${res.status}): ${detail}`
          : `PostHog rejected the request (${res.status}) on ${path}.`
      )
  }
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockPostHogData {
  events?: unknown[]
  insight?: unknown
  flag?: unknown
  cohort?: unknown
  queryError?: string
  insightError?: string
  flagError?: string
  cohortError?: string
  updateError?: string
}

/**
 * The offline seam tests inject in place of `PostHogHttpApi` (spec §12). It
 * returns seeded raw payloads, records every call for assertions, and rejects
 * seeded failures verbatim — exercising the connector, poller, and engine with
 * no credentials and no network. A settable `events`/`insight`/`cohort` lets a
 * poll test advance state tick-by-tick.
 */
export class MockPostHogApi implements PostHogApi {
  readonly calls = {
    queryEvents: [] as QueryEventsParams[],
    getInsight: [] as string[],
    getFeatureFlag: [] as string[],
    getCohort: [] as string[],
    updateFeatureFlag: [] as { id: string; patch: UpdateFeatureFlagPatch }[]
  }

  constructor(public data: MockPostHogData = {}) {}

  queryEvents(params: QueryEventsParams): Promise<unknown[]> {
    this.calls.queryEvents.push(params)
    if (this.data.queryError) return Promise.reject(new Error(this.data.queryError))
    const all = this.data.events ?? []
    // Inclusive lower bound (matches the real HogQL `>=`): the poller dedups the
    // boundary tick by uuid (spec §7.2a), so the mock must not drop it here.
    const rows = params.after
      ? all.filter((e) => isObject(e) && String(e.timestamp) >= params.after!)
      : all
    return Promise.resolve(rows)
  }

  getInsight(id: string): Promise<unknown> {
    this.calls.getInsight.push(id)
    if (this.data.insightError) return Promise.reject(new Error(this.data.insightError))
    return Promise.resolve(this.data.insight ?? {})
  }

  getFeatureFlag(id: string): Promise<unknown> {
    this.calls.getFeatureFlag.push(id)
    if (this.data.flagError) return Promise.reject(new Error(this.data.flagError))
    return Promise.resolve(this.data.flag ?? {})
  }

  getCohort(id: string): Promise<unknown> {
    this.calls.getCohort.push(id)
    if (this.data.cohortError) return Promise.reject(new Error(this.data.cohortError))
    return Promise.resolve(this.data.cohort ?? {})
  }

  updateFeatureFlag(id: string, patch: UpdateFeatureFlagPatch): Promise<unknown> {
    this.calls.updateFeatureFlag.push({ id, patch })
    if (this.data.updateError) return Promise.reject(new Error(this.data.updateError))
    return Promise.resolve(this.data.flag ?? { id, ...patch })
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The DEFERRED live transport (spec §4.3). Registered at startup so the
 * descriptor, normalizer, poller, and mock-tested dispatch land first; a real
 * call fails LOUDLY rather than silently no-opping until HTTP is wired.
 */
export function deferredLiveTransport(): PostHogTransport {
  return {
    send: () =>
      Promise.reject(
        new Error(
          "The live PostHog HTTP transport isn't wired yet — real REST/Query calls land in a " +
            'later phase. The connector, normalizer, poller, and cursor store are in place and mock-tested.'
        )
      )
  }
}

/** Re-export the post-DNS hook so the live transport can pin the dialed IP. */
export { blockedIpRange }
