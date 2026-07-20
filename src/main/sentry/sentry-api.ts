import { checkBaseUrl } from '../net/ssrf-guard'
import type { SentryStatusDetails } from '../../shared/sentry'

/**
 * The Sentry **REST client** — the SOLE place any Sentry request/response shape
 * lives (the API blast radius, spec §4.2). The `SentryApi` interface is the seam:
 * `SentryHttpApi` wraps an injected `SentryTransport` (the live HTTP call — the
 * real `fetch` is DEFERRED via `deferredSentryTransport`), and tests inject a
 * `MockSentryApi`, so NO live Sentry call is ever performed in CI (spec §12).
 *
 * Read methods return the RAW Sentry node; `sentry-normalize.ts` maps it to the
 * pinned context shape. Mutations resolve a small localflow-shaped result.
 * Failure follows the pinned convention: every error path REJECTS with a legible,
 * actionable message that carries the real Sentry cause — and NEVER the bearer
 * token or Client Secret (spec §5, §11).
 *
 * Two security controls run on every request (spec §5.2): the self-host `baseUrl`
 * is validated through the shared SSRF guard BEFORE a request is built, and the
 * bearer token is fetched at call time via the injected `reveal` seam (bound, at
 * live wiring, to the main-only CredentialStore plaintext exit) — used ONLY for
 * the `Authorization` header, never logged or returned.
 */

// ── Raw Sentry REST shapes (isolated here) ───────────────────────────────────

export interface RawSentryProject {
  id?: string | null
  slug?: string | null
  name?: string | null
}

export interface RawSentryIssue {
  id?: string | null
  shortId?: string | null
  title?: string | null
  culprit?: string | null
  level?: string | null
  status?: string | null
  substatus?: string | null
  permalink?: string | null
  platform?: string | null
  project?: RawSentryProject | null
  count?: string | number | null
  userCount?: string | number | null
  firstSeen?: string | null
  lastSeen?: string | null
}

/** A raw event frame, buried at `entries[exception].data.values[].stacktrace.frames[]`. */
export interface RawSentryFrame {
  filename?: string | null
  absPath?: string | null
  function?: string | null
  lineNo?: number | null
  colNo?: number | null
  module?: string | null
  inApp?: boolean | null
  contextLine?: string | null
  /** Sentry's source context: `[[lineNo, "code"], …]`. */
  context?: [number, string][] | null
}

export interface RawSentryExceptionValue {
  type?: string | null
  value?: string | null
  stacktrace?: { frames?: RawSentryFrame[] | null } | null
}

export interface RawSentryEntry {
  type?: string | null
  data?: { values?: RawSentryExceptionValue[] | null } | null
}

export interface RawSentryEvent {
  id?: string | null
  eventID?: string | null
  groupID?: string | null
  issueId?: string | null
  message?: string | null
  title?: string | null
  culprit?: string | null
  platform?: string | null
  permalink?: string | null
  entries?: RawSentryEntry[] | null
}

// ── Mutation inputs / results (localflow-shaped) ─────────────────────────────

export interface ResolveIssueInput {
  id: string
  statusDetails?: SentryStatusDetails
}
export interface AssignIssueInput {
  id: string
  assignedTo: string
}
export interface IgnoreIssueInput {
  id: string
  statusDetails?: SentryStatusDetails
}
export interface CommentIssueInput {
  id: string
  text: string
}

export interface MutateIssueResult {
  id: string
  status?: string
  assignedTo?: string
}
export interface CommentResult {
  id: string
  text: string
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface SentryApi {
  getIssue(id: string): Promise<RawSentryIssue>
  getEvent(params: { id: string; eventId?: string }): Promise<RawSentryEvent>
  searchIssues(params: { query?: string }): Promise<RawSentryIssue[]>
  resolveIssue(input: ResolveIssueInput): Promise<MutateIssueResult>
  assignIssue(input: AssignIssueInput): Promise<MutateIssueResult>
  ignoreIssue(input: IgnoreIssueInput): Promise<MutateIssueResult>
  commentIssue(input: CommentIssueInput): Promise<CommentResult>
}

// ── HTTP transport (the live seam) ───────────────────────────────────────────

export type SentryMethod = 'GET' | 'PUT' | 'POST'

export interface SentryRequest {
  method: SentryMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface SentryResponse {
  status: number
  /** Raw response body text — parsed by the client. */
  body: string
  /** `Retry-After` seconds on a 429, when present. */
  retryAfterSec?: number
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface SentryTransport {
  send(req: SentryRequest): Promise<SentryResponse>
}

export interface SentryHttpApiDeps {
  transport: SentryTransport
  /** Self-host base URL (non-secret ref); default `https://sentry.io`. */
  baseUrl?: string
  /** Organization slug (non-secret ref). */
  orgSlug: string
  /** Project slug — required for the project-scoped resolve endpoint (§2.2). */
  projectSlug?: string
  /** Main-only plaintext exit for the bearer token (never stored here). */
  reveal: () => string
  /** Injectable delay so tests run without real backoff waits. */
  sleep?: (ms: number) => Promise<void>
  /** Max retry attempts on 429 before giving up (default 3). */
  maxRetries?: number
}

const DEFAULT_BASE_URL = 'https://sentry.io'
const DEFAULT_MAX_RETRIES = 3
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The live client, written against `SentryTransport` so the `fetch` wiring (the
 * `Authorization: Bearer` header) is a deferred, injected concern and every
 * URL/response decision is unit-tested with a fake transport.
 */
export class SentryHttpApi implements SentryApi {
  private readonly transport: SentryTransport
  private readonly baseUrl: string
  private readonly orgSlug: string
  private readonly projectSlug?: string
  private readonly reveal: () => string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(deps: SentryHttpApiDeps) {
    this.transport = deps.transport
    this.baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL
    this.orgSlug = deps.orgSlug
    this.projectSlug = deps.projectSlug
    this.reveal = deps.reveal
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  getIssue(id: string): Promise<RawSentryIssue> {
    return this.request(
      'GET',
      `/api/0/organizations/${this.org()}/issues/${enc(id)}/`
    ) as Promise<RawSentryIssue>
  }

  getEvent(params: { id: string; eventId?: string }): Promise<RawSentryEvent> {
    const suffix = params.eventId ? enc(params.eventId) : 'latest'
    return this.request(
      'GET',
      `/api/0/issues/${enc(params.id)}/events/${suffix}/`
    ) as Promise<RawSentryEvent>
  }

  async searchIssues(params: { query?: string }): Promise<RawSentryIssue[]> {
    const qs = new URLSearchParams()
    if (params.query) qs.set('query', params.query)
    const suffix = qs.toString()
    const data = await this.request(
      'GET',
      `/api/0/organizations/${this.org()}/issues/${suffix ? `?${suffix}` : ''}`
    )
    return Array.isArray(data) ? (data as RawSentryIssue[]) : []
  }

  /**
   * Resolve an issue. **The project-scoped endpoint detail (§2.2):** when
   * `statusDetails` (e.g. `inCommit`) is present, the org-level PUT silently
   * ignores it, so the client PUTs the PROJECT-scoped collection endpoint
   * (`/api/0/projects/{org}/{project}/issues/?id={id}`) where `inCommit`/`inRelease`
   * actually apply. With no `statusDetails`, the plain org-level issue endpoint
   * is used.
   */
  async resolveIssue(input: ResolveIssueInput): Promise<MutateIssueResult> {
    const body: Record<string, unknown> = { status: 'resolved' }
    if (input.statusDetails) body.statusDetails = input.statusDetails
    await this.request(
      'PUT',
      this.mutateIssuePath(input.id, input.statusDetails !== undefined, 'resolve'),
      body
    )
    return { id: input.id, status: 'resolved' }
  }

  async ignoreIssue(input: IgnoreIssueInput): Promise<MutateIssueResult> {
    const body: Record<string, unknown> = { status: 'ignored' }
    if (input.statusDetails) body.statusDetails = input.statusDetails
    await this.request(
      'PUT',
      this.mutateIssuePath(input.id, input.statusDetails !== undefined, 'ignore'),
      body
    )
    return { id: input.id, status: 'ignored' }
  }

  async assignIssue(input: AssignIssueInput): Promise<MutateIssueResult> {
    await this.request('PUT', this.mutateIssuePath(input.id, false, 'assign'), {
      assignedTo: input.assignedTo
    })
    return { id: input.id, assignedTo: input.assignedTo }
  }

  async commentIssue(input: CommentIssueInput): Promise<CommentResult> {
    await this.request('POST', `/api/0/issues/${enc(input.id)}/comments/`, { text: input.text })
    return { id: input.id, text: input.text }
  }

  /** Org-level issue endpoint, or the project-scoped collection endpoint when the
   *  mutation carries `statusDetails` (the §2.2 quirk isolated here). `operation`
   *  names the actual mutation (resolve / ignore) so a missing-slug error is
   *  action-accurate rather than always blaming a resolve. */
  private mutateIssuePath(id: string, useProjectScope: boolean, operation: string): string {
    if (useProjectScope) {
      if (!this.projectSlug) {
        throw new Error(
          `Sentry ${operation} with commit/release details needs a project slug — set the ` +
            'Project slug in Settings so the project-scoped endpoint (which honors ' +
            'inCommit/inRelease) can be used.'
        )
      }
      return `/api/0/projects/${this.org()}/${enc(this.projectSlug)}/issues/?id=${enc(id)}`
    }
    return `/api/0/issues/${enc(id)}/`
  }

  private org(): string {
    if (!this.orgSlug) {
      throw new Error('Sentry needs an organization slug — set the Organization slug in Settings.')
    }
    return enc(this.orgSlug)
  }

  /** Send one request through the SSRF guard + transport, with 429 backoff, then
   *  parse the JSON body or map the error to an actionable §11 message. */
  private async request(method: SentryMethod, path: string, body?: unknown): Promise<unknown> {
    // SSRF guard on the self-host baseUrl BEFORE building the request (§5.2).
    const check = checkBaseUrl(this.baseUrl, 'Sentry base URL')
    if (!check.ok) throw new Error(check.reason)

    const url = `${trimTrailingSlash(check.url.href)}${path}`
    const host = check.url.host
    const req: SentryRequest = { method, url, headers: this.authHeaders(body !== undefined) }
    if (body !== undefined) req.body = JSON.stringify(body)

    for (let attempt = 0; ; attempt++) {
      let res: SentryResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        throw new Error(
          `Couldn't reach Sentry at ${host} (${(err as Error).message}) — check the base URL and your connection.`,
          { cause: err }
        )
      }
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt, res.retryAfterSec))
        continue
      }
      throw mapError(res, path)
    }
  }

  /** Build the bearer header from the keychain token. The token is read here and
   *  used ONLY for this header — never logged or returned. */
  private authHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.reveal()}`,
      Accept: 'application/json'
    }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }
}

function enc(v: string): string {
  return encodeURIComponent(v)
}

function trimTrailingSlash(href: string): string {
  return href.endsWith('/') ? href.slice(0, -1) : href
}

/** Capped backoff honoring `Retry-After` when Sentry sends it (§11). */
function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec)) {
    return Math.min(Math.max(retryAfterSec * 1000, 0), 30_000)
  }
  return Math.min(200 * 2 ** attempt, 5_000)
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Sentry's error body often carries a `{ detail }` string. */
function sentryDetail(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (typeof data === 'object' && data !== null && 'detail' in data) {
      const d = (data as { detail: unknown }).detail
      if (typeof d === 'string' && d.length > 0) return d
    }
  } catch {
    /* not JSON */
  }
  return undefined
}

/** Map a non-2xx response to the actionable, real-cause §11 message. */
function mapError(res: SentryResponse, path: string): Error {
  const detail = sentryDetail(res.body)
  switch (res.status) {
    case 401:
      return new Error(
        'Sentry rejected the auth token (401) — it was revoked or is wrong; re-enter it in Settings.'
      )
    case 403:
      return new Error(
        `Sentry refused the request (403) — the token is missing a required scope (event:read / event:write)${
          detail ? `: ${detail}` : ''
        }. Add it to the internal integration.`
      )
    case 404:
      return new Error(
        `Sentry has no such resource (404 on ${path}) — wrong id/project, or it was deleted or merged.`
      )
    case 429:
      return new Error(
        'Sentry throttled the request (429) — retried and still limited; try again shortly.'
      )
    default:
      return new Error(
        detail
          ? `Sentry rejected the request (${res.status}): ${detail}.`
          : `Sentry rejected the request (${res.status}) on ${path}.`
      )
  }
}

/**
 * The live HTTP transport is DEFERRED (foundation slice: no live REST). Wiring it
 * means a `fetch` with the keychain bearer token. Until then a registered
 * connector using this transport fails LOUDLY rather than silently.
 */
export function deferredSentryTransport(): SentryTransport {
  return {
    send: () =>
      Promise.reject(
        new Error(
          'The live Sentry REST transport isn’t wired yet — real HTTP calls land in a later ' +
            'phase. The connector, normalizer, and webhook receiver are in place and mock-tested.'
        )
      )
  }
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockSentryData {
  issues?: Record<string, RawSentryIssue>
  events?: Record<string, RawSentryEvent>
  /** Keyed by eventId for `getEvent({ eventId })`. */
  eventsById?: Record<string, RawSentryEvent>
  searchResults?: RawSentryIssue[]
  getIssueError?: string
  getEventError?: string
  resolveError?: string
  assignError?: string
  ignoreError?: string
  commentError?: string
}

/**
 * The mock seam tests inject in place of `SentryHttpApi` (spec §12). It returns
 * seeded raw nodes (including events with real nested `entries[exception]…frames`
 * fixtures), records every mutation call for assertions, and rejects seeded
 * error strings verbatim — exercising the connector and the engine offline, with
 * no credentials and no network.
 */
export class MockSentryApi implements SentryApi {
  readonly calls = {
    getIssue: [] as string[],
    getEvent: [] as { id: string; eventId?: string }[],
    searchIssues: [] as { query?: string }[],
    resolveIssue: [] as ResolveIssueInput[],
    assignIssue: [] as AssignIssueInput[],
    ignoreIssue: [] as IgnoreIssueInput[],
    commentIssue: [] as CommentIssueInput[]
  }

  constructor(private readonly data: MockSentryData = {}) {}

  getIssue(id: string): Promise<RawSentryIssue> {
    this.calls.getIssue.push(id)
    if (this.data.getIssueError) return Promise.reject(new Error(this.data.getIssueError))
    const node = this.data.issues?.[id]
    if (!node) return Promise.reject(new Error(`Sentry has no issue '${id}'.`))
    return Promise.resolve(node)
  }

  getEvent(params: { id: string; eventId?: string }): Promise<RawSentryEvent> {
    this.calls.getEvent.push(params)
    if (this.data.getEventError) return Promise.reject(new Error(this.data.getEventError))
    const node = params.eventId
      ? this.data.eventsById?.[params.eventId]
      : this.data.events?.[params.id]
    if (!node) return Promise.reject(new Error(`Sentry has no event for issue '${params.id}'.`))
    return Promise.resolve(node)
  }

  searchIssues(params: { query?: string }): Promise<RawSentryIssue[]> {
    this.calls.searchIssues.push(params)
    return Promise.resolve(this.data.searchResults ?? [])
  }

  resolveIssue(input: ResolveIssueInput): Promise<MutateIssueResult> {
    this.calls.resolveIssue.push(input)
    if (this.data.resolveError) return Promise.reject(new Error(this.data.resolveError))
    return Promise.resolve({ id: input.id, status: 'resolved' })
  }

  ignoreIssue(input: IgnoreIssueInput): Promise<MutateIssueResult> {
    this.calls.ignoreIssue.push(input)
    if (this.data.ignoreError) return Promise.reject(new Error(this.data.ignoreError))
    return Promise.resolve({ id: input.id, status: 'ignored' })
  }

  assignIssue(input: AssignIssueInput): Promise<MutateIssueResult> {
    this.calls.assignIssue.push(input)
    if (this.data.assignError) return Promise.reject(new Error(this.data.assignError))
    return Promise.resolve({ id: input.id, assignedTo: input.assignedTo })
  }

  commentIssue(input: CommentIssueInput): Promise<CommentResult> {
    this.calls.commentIssue.push(input)
    if (this.data.commentError) return Promise.reject(new Error(this.data.commentError))
    return Promise.resolve({ id: input.id, text: input.text })
  }
}
