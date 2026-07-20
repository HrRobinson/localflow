import { baseUrlForRegion, type PagerDutyRegion } from './pagerduty-config'

/**
 * The PagerDuty **REST v2 client** — the SOLE place any PagerDuty request/response
 * shape lives (the API blast radius, spec §4.2). The `PagerDutyApi` interface is
 * the seam: `PagerDutyHttpApi` wraps an injected `PagerDutyTransport` (the live
 * HTTP call — the real `fetch` is DEFERRED via `deferredPagerDutyTransport`), and
 * tests inject a `MockPagerDutyApi`, so NO live PagerDuty call is ever performed
 * in CI (spec §12).
 *
 * Auth is a single `Authorization: Token token=<key>` header. Every WRITE also
 * carries the `From: <fromEmail>` acting-user header (§8) — PagerDuty attributes
 * REST mutations to a named user. The api key is read at call time via the
 * injected `reveal` seam (bound, at live wiring, to the main-only CredentialStore
 * plaintext exit) and used ONLY for the header — never logged or returned.
 *
 * There is NO SSRF guard: PagerDuty is SaaS-only and the base URL is a fixed
 * region choice (§4.5), never a user-supplied host. Failure follows the pinned
 * convention: every error path REJECTS with a legible, actionable message
 * carrying the real PagerDuty cause — and NEVER a secret (§11).
 */

// ── Raw PagerDuty REST shapes (isolated here) ────────────────────────────────

export interface RawPagerDutyRef {
  id?: string | null
  summary?: string | null
  html_url?: string | null
  self?: string | null
  type?: string | null
}

export interface RawPagerDutyAssignment {
  assignee?: RawPagerDutyRef | null
}

export interface RawPagerDutyIncident {
  id?: string | null
  incident_number?: number | null
  title?: string | null
  status?: string | null
  urgency?: string | null
  priority?: RawPagerDutyRef | null
  service?: RawPagerDutyRef | null
  escalation_policy?: RawPagerDutyRef | null
  assignments?: RawPagerDutyAssignment[] | null
  html_url?: string | null
  created_at?: string | null
  /** The incident body — a linked Sentry issue may hide in `details` (§7). */
  body?: { details?: string | null } | null
}

export interface RawPagerDutyService {
  id?: string | null
  name?: string | null
  status?: string | null
  escalation_policy?: RawPagerDutyRef | null
  html_url?: string | null
}

// ── Mutation inputs / results (localflow-shaped) ─────────────────────────────

export interface StatusChangeInput {
  id: string
}
export interface EscalateInput {
  id: string
  /** A specific level; omitted → the next level up. */
  escalationLevel?: number
}
export interface AddNoteInput {
  id: string
  note: string
}

export interface MutateIncidentResult {
  id: string
  status?: string
}
export interface AddNoteResult {
  id: string
  note: string
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface PagerDutyApi {
  getIncident(id: string): Promise<RawPagerDutyIncident>
  getService(id: string): Promise<RawPagerDutyService>
  acknowledgeIncident(input: StatusChangeInput): Promise<MutateIncidentResult>
  resolveIncident(input: StatusChangeInput): Promise<MutateIncidentResult>
  escalateIncident(input: EscalateInput): Promise<MutateIncidentResult>
  addNote(input: AddNoteInput): Promise<AddNoteResult>
}

// ── HTTP transport (the live seam) ───────────────────────────────────────────

export type PagerDutyMethod = 'GET' | 'PUT' | 'POST'

export interface PagerDutyRequest {
  method: PagerDutyMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface PagerDutyResponse {
  status: number
  /** Raw response body text — parsed by the client. */
  body: string
  /** `Retry-After` seconds on a 429, when present. */
  retryAfterSec?: number
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface PagerDutyTransport {
  send(req: PagerDutyRequest): Promise<PagerDutyResponse>
}

export interface PagerDutyHttpApiDeps {
  transport: PagerDutyTransport
  /** Region enum → the fixed base URL (§4.5). Default `us`. */
  region?: PagerDutyRegion
  /** Main-only plaintext exit for the REST api key (never stored here). */
  reveal: () => string
  /** The acting-user email sent as `From:` on every write (§8). */
  fromEmail: string
  /** Injectable delay so tests run without real backoff waits. */
  sleep?: (ms: number) => Promise<void>
  /** Max retry attempts on 429 before giving up (default 3). */
  maxRetries?: number
}

const DEFAULT_MAX_RETRIES = 3
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The live client, written against `PagerDutyTransport` so the `fetch` wiring is a
 * deferred, injected concern and every URL/header/response decision is unit-tested
 * with a fake transport.
 */
export class PagerDutyHttpApi implements PagerDutyApi {
  private readonly transport: PagerDutyTransport
  private readonly baseUrl: string
  private readonly reveal: () => string
  private readonly fromEmail: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(deps: PagerDutyHttpApiDeps) {
    this.transport = deps.transport
    this.baseUrl = baseUrlForRegion(deps.region ?? 'us')
    this.reveal = deps.reveal
    this.fromEmail = deps.fromEmail
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES
  }

  async getIncident(id: string): Promise<RawPagerDutyIncident> {
    const data = await this.request('GET', `/incidents/${enc(id)}`)
    return incidentOf(data)
  }

  async getService(id: string): Promise<RawPagerDutyService> {
    const data = await this.request('GET', `/services/${enc(id)}`)
    return serviceOf(data)
  }

  async acknowledgeIncident(input: StatusChangeInput): Promise<MutateIncidentResult> {
    await this.request('PUT', `/incidents/${enc(input.id)}`, {
      incident: { type: 'incident_reference', status: 'acknowledged' }
    })
    return { id: input.id, status: 'acknowledged' }
  }

  async resolveIncident(input: StatusChangeInput): Promise<MutateIncidentResult> {
    await this.request('PUT', `/incidents/${enc(input.id)}`, {
      incident: { type: 'incident_reference', status: 'resolved' }
    })
    return { id: input.id, status: 'resolved' }
  }

  async escalateIncident(input: EscalateInput): Promise<MutateIncidentResult> {
    const incident: Record<string, unknown> = { type: 'incident_reference' }
    if (input.escalationLevel !== undefined) incident.escalation_level = input.escalationLevel
    await this.request('PUT', `/incidents/${enc(input.id)}`, { incident })
    return { id: input.id, status: 'escalated' }
  }

  async addNote(input: AddNoteInput): Promise<AddNoteResult> {
    await this.request('POST', `/incidents/${enc(input.id)}/notes`, {
      note: { content: input.note }
    })
    return { id: input.id, note: input.note }
  }

  /** Send one request through the transport, with 429 backoff, then parse the JSON
   *  body or map the error to an actionable §11 message. A write (`body`) always
   *  carries the `From:` acting-user header (§8). */
  private async request(method: PagerDutyMethod, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    const isWrite = body !== undefined
    const req: PagerDutyRequest = { method, url, headers: this.authHeaders(isWrite) }
    if (isWrite) req.body = JSON.stringify(body)

    for (let attempt = 0; ; attempt++) {
      let res: PagerDutyResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        throw new Error(
          `Couldn't reach PagerDuty (${(err as Error).message}) — check your connection.`,
          { cause: err }
        )
      }
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt, res.retryAfterSec))
        continue
      }
      throw mapError(res, method, path)
    }
  }

  /** Build the auth + acting-user headers. The api key is read here and used ONLY
   *  for the `Authorization` header; the `From:` header (a non-secret email)
   *  attributes writes to a named user (§8). */
  private authHeaders(isWrite: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Token token=${this.reveal()}`,
      Accept: 'application/json'
    }
    if (isWrite) {
      headers['Content-Type'] = 'application/json'
      headers.From = this.fromEmail
    }
    return headers
  }
}

function enc(v: string): string {
  return encodeURIComponent(v)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** GET /incidents/{id} wraps the node under `{ incident: … }`. */
function incidentOf(data: unknown): RawPagerDutyIncident {
  if (isObj(data) && isObj(data.incident)) return data.incident as RawPagerDutyIncident
  return isObj(data) ? (data as RawPagerDutyIncident) : {}
}

/** GET /services/{id} wraps the node under `{ service: … }`. */
function serviceOf(data: unknown): RawPagerDutyService {
  if (isObj(data) && isObj(data.service)) return data.service as RawPagerDutyService
  return isObj(data) ? (data as RawPagerDutyService) : {}
}

/** Capped backoff honoring `Retry-After` when PagerDuty sends it (§11). */
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

/** PagerDuty error bodies carry `{ error: { message, errors: [...] } }`. */
function pdDetail(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (isObj(data) && isObj(data.error)) {
      const err = data.error as { message?: unknown; errors?: unknown }
      const parts: string[] = []
      if (typeof err.message === 'string' && err.message.length > 0) parts.push(err.message)
      if (Array.isArray(err.errors)) {
        for (const e of err.errors) if (typeof e === 'string') parts.push(e)
      }
      if (parts.length > 0) return parts.join('; ')
    }
  } catch {
    /* not JSON */
  }
  return undefined
}

/** Map a non-2xx response to the actionable, real-cause §11 message. Escalation
 *  at the top level surfaces as a 400 whose detail we forward verbatim. */
function mapError(res: PagerDutyResponse, method: PagerDutyMethod, path: string): Error {
  const detail = pdDetail(res.body)
  switch (res.status) {
    case 400:
      return new Error(
        detail
          ? `PagerDuty rejected the ${method} ${path} (400): ${detail}.`
          : `PagerDuty rejected the ${method} ${path} (400) — check the acting user ('From') and the request.`
      )
    case 401:
      return new Error(
        'PagerDuty rejected the API key (401) — it was revoked or is wrong; re-enter it in Settings.'
      )
    case 403:
      return new Error(
        `PagerDuty refused the request (403) — the API key lacks the ability to modify this resource${
          detail ? `: ${detail}` : ''
        }. Grant it and re-enter.`
      )
    case 404:
      return new Error(
        `PagerDuty has no such resource (404 on ${path}) — it may be from another account or was deleted.`
      )
    case 429:
      return new Error(
        'PagerDuty rate limit hit (429) — retried and still limited; try again shortly.'
      )
    default:
      return new Error(
        detail
          ? `PagerDuty rejected the request (${res.status}): ${detail}.`
          : `PagerDuty rejected the request (${res.status}) on ${path}.`
      )
  }
}

/**
 * The live HTTP transport is DEFERRED (foundation slice: no live REST). Wiring it
 * means a `fetch` with the `Authorization: Token` header. Until then a registered
 * connector using this transport fails LOUDLY rather than silently.
 */
export function deferredPagerDutyTransport(): PagerDutyTransport {
  return {
    send: () =>
      Promise.reject(
        new Error(
          'The live PagerDuty REST transport isn’t wired yet — real HTTP calls land in a later ' +
            'phase. The connector, normalizer, and webhook receiver are in place and mock-tested.'
        )
      )
  }
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockPagerDutyData {
  incidents?: Record<string, RawPagerDutyIncident>
  services?: Record<string, RawPagerDutyService>
  getIncidentError?: string
  getServiceError?: string
  acknowledgeError?: string
  resolveError?: string
  escalateError?: string
  addNoteError?: string
}

/**
 * The mock seam tests inject in place of `PagerDutyHttpApi` (spec §12). It returns
 * seeded raw nodes, records every call (including the `From:` acting-user email a
 * live write would send), and rejects seeded error strings verbatim — exercising
 * the connector and the engine offline, with no credentials and no network. Same
 * posture as `MockSentryApi`.
 */
export class MockPagerDutyApi implements PagerDutyApi {
  readonly calls = {
    getIncident: [] as string[],
    getService: [] as string[],
    acknowledgeIncident: [] as StatusChangeInput[],
    resolveIncident: [] as StatusChangeInput[],
    escalateIncident: [] as EscalateInput[],
    addNote: [] as AddNoteInput[]
  }

  /** The `From:` acting-user email a live write attaches (§8). Exposed so a test
   *  can assert every mutation is attributed — the offline stand-in for the HTTP
   *  header the real client sends. */
  readonly fromEmail: string

  constructor(
    private readonly data: MockPagerDutyData = {},
    opts: { fromEmail?: string } = {}
  ) {
    this.fromEmail = opts.fromEmail ?? 'localflow-automation@example.com'
  }

  getIncident(id: string): Promise<RawPagerDutyIncident> {
    this.calls.getIncident.push(id)
    if (this.data.getIncidentError) return Promise.reject(new Error(this.data.getIncidentError))
    const node = this.data.incidents?.[id]
    if (!node) return Promise.reject(new Error(`PagerDuty has no incident '${id}'.`))
    return Promise.resolve(node)
  }

  getService(id: string): Promise<RawPagerDutyService> {
    this.calls.getService.push(id)
    if (this.data.getServiceError) return Promise.reject(new Error(this.data.getServiceError))
    const node = this.data.services?.[id]
    if (!node) return Promise.reject(new Error(`PagerDuty has no service '${id}'.`))
    return Promise.resolve(node)
  }

  acknowledgeIncident(input: StatusChangeInput): Promise<MutateIncidentResult> {
    this.calls.acknowledgeIncident.push(input)
    if (this.data.acknowledgeError) return Promise.reject(new Error(this.data.acknowledgeError))
    return Promise.resolve({ id: input.id, status: 'acknowledged' })
  }

  resolveIncident(input: StatusChangeInput): Promise<MutateIncidentResult> {
    this.calls.resolveIncident.push(input)
    if (this.data.resolveError) return Promise.reject(new Error(this.data.resolveError))
    return Promise.resolve({ id: input.id, status: 'resolved' })
  }

  escalateIncident(input: EscalateInput): Promise<MutateIncidentResult> {
    this.calls.escalateIncident.push(input)
    if (this.data.escalateError) return Promise.reject(new Error(this.data.escalateError))
    return Promise.resolve({ id: input.id, status: 'escalated' })
  }

  addNote(input: AddNoteInput): Promise<AddNoteResult> {
    this.calls.addNote.push(input)
    if (this.data.addNoteError) return Promise.reject(new Error(this.data.addNoteError))
    return Promise.resolve({ id: input.id, note: input.note })
  }
}
