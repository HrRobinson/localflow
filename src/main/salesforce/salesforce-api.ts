import { checkBaseUrl, blockedIpRange } from '../net/ssrf-guard'
import type { SalesforceAuth } from './salesforce-auth'

/**
 * Thin REST client for the Salesforce API (spec §4.2, §6). ALL Salesforce
 * endpoint/HTTP/SOQL knowledge lives here — the blast radius for any API-version
 * bump — exactly as PostHog isolated its REST in `posthog-api.ts`. The HTTP
 * transport is INJECTED as a seam (`SalesforceTransport`) so tests drive the
 * connector/poller with a `MockSalesforceApi` and NO live HTTP happens (spec
 * §12). Real HTTP + JWT/client-credentials auth are DEFERRED behind the seam
 * (spec §4.3, §8) — this module ships the client shape + the offline seam.
 *
 * Security posture:
 *  - The user-supplied instance URL passes the SHARED SSRF guard
 *    (`net/ssrf-guard`) BEFORE a request is built (spec §4.4).
 *  - The access token is fetched at call time from `salesforce-auth` (which reads
 *    the keychain credential), used ONLY to build the `Authorization: Bearer`
 *    header, and NEVER logged or returned (spec §8).
 *  - Errors forward Salesforce's own `[{ message, errorCode, fields }]` array
 *    verbatim — already human-readable (spec §11).
 */

export type SalesforceMethod = 'GET' | 'POST' | 'PATCH'

export interface SalesforceRequest {
  method: SalesforceMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface SalesforceResponse {
  status: number
  body: string
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface SalesforceTransport {
  send(req: SalesforceRequest): Promise<SalesforceResponse>
}

/** A SOQL result page. `records` are RAW Salesforce records (with `attributes`);
 *  the connector/poller run them through `salesforce-normalize` (spec §6.3). */
export interface SalesforceQueryResult {
  records: unknown[]
  totalSize: number
  done: boolean
}

/** The reconcile query the poller runs (spec §7.2). The api owns the SOQL shape;
 *  the poller supplies WHAT to poll + the cursor boundary. */
export interface SalesforceReconcileParams {
  object: string
  /** The timestamp field to cursor on (`CreatedDate` for `record.created`,
   *  `LastModifiedDate` for `record.updated` — spec §6.1). */
  timestampField: 'CreatedDate' | 'LastModifiedDate'
  /** Extra fields to SELECT beyond the reserved metadata. */
  fields?: string[]
  /** The author's optional SOQL `WHERE` fragment. */
  where?: string
  /** Inclusive lower bound on `timestampField` (the poll cursor). */
  afterTs?: string
}

/** A record create (spec §6.2). */
export interface CreateRecordResult {
  id: string
  success: boolean
}

/** A submit-for-approval request (spec §6.2, §9). */
export interface SubmitApprovalParams {
  recordId: string
  approverId?: string
  comments?: string
}

/**
 * The seam `salesforce-connector` and `salesforce-poller` are written against
 * (spec §12). The real impl (`SalesforceHttpApi`) wraps the transport + the SSRF
 * guard + `salesforce-auth`; tests inject a `MockSalesforceApi` returning canned
 * records and canned Salesforce error arrays. Reads return RAW Salesforce JSON —
 * the caller runs it through `salesforce-normalize` (the correctness boundary).
 */
export interface SalesforceApi {
  /** Run arbitrary SOQL (the `query` action, spec §6.2). */
  query(soql: string): Promise<SalesforceQueryResult>
  /** The reconcile poll query (spec §7.2) — the api builds the SOQL. */
  queryReconcile(params: SalesforceReconcileParams): Promise<SalesforceQueryResult>
  /** One record by id + selected fields (the `getRecord` action, spec §6.2). */
  getRecord(object: string, id: string, fields?: string[]): Promise<unknown>
  createRecord(object: string, fields: Record<string, unknown>): Promise<CreateRecordResult>
  updateRecord(object: string, id: string, fields: Record<string, unknown>): Promise<void>
  submitForApproval(params: SubmitApprovalParams): Promise<unknown>
}

/** The pinned default REST API version (spec §5) — one place to bump. */
export const DEFAULT_API_VERSION = 'v62.0'

/** The reserved metadata every reconcile SELECT includes so the normalizer has
 *  the Id + both timestamps (spec §6.3). */
const RESERVED_SELECT = ['Id', 'CreatedDate', 'LastModifiedDate']

/** Build a reconcile SOQL string (spec §7.2). Exported so a test can assert the
 *  `>= boundary ORDER BY <ts>, Id` shape without a transport. */
export function buildReconcileSoql(params: SalesforceReconcileParams): string {
  const select = [...RESERVED_SELECT, ...(params.fields ?? [])]
    .filter((f, i, a) => a.indexOf(f) === i)
    .join(', ')
  const conds: string[] = []
  if (params.afterTs !== undefined && params.afterTs.length > 0) {
    // Inclusive lower bound — the poller owns exact (ts, Id) tuple dedup at the
    // boundary (spec §7.2), so the query must NOT drop a boundary-tick record.
    conds.push(`${params.timestampField} >= ${soqlDate(params.afterTs)}`)
  }
  if (params.where !== undefined && params.where.trim().length > 0) {
    conds.push(`(${params.where.trim()})`)
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : ''
  // ORDER BY the cursor tuple so the poll advances monotonically (spec §7.2).
  return `SELECT ${select} FROM ${params.object}${where} ORDER BY ${params.timestampField}, Id`
}

export interface SalesforceHttpApiDeps {
  transport: SalesforceTransport
  auth: SalesforceAuth
  /** The org instance URL (non-secret ref from config.json), SSRF-guarded here. */
  instanceUrl: string
  apiVersion?: string
}

/**
 * The real REST client (spec §4.2). Every request runs `checkBaseUrl` on the
 * instance URL, attaches the Bearer token from `salesforce-auth` (re-minting once
 * on `INVALID_SESSION_ID`), and maps a Salesforce error array to a legible reject.
 */
export class SalesforceHttpApi implements SalesforceApi {
  private readonly transport: SalesforceTransport
  private readonly auth: SalesforceAuth
  private readonly instanceUrl: string
  private readonly apiVersion: string

  constructor(deps: SalesforceHttpApiDeps) {
    this.transport = deps.transport
    this.auth = deps.auth
    this.instanceUrl = deps.instanceUrl
    this.apiVersion = deps.apiVersion ?? DEFAULT_API_VERSION
  }

  query(soql: string): Promise<SalesforceQueryResult> {
    const path = `/query?q=${encodeURIComponent(soql)}`
    return this.request('GET', path).then(asQueryResult)
  }

  queryReconcile(params: SalesforceReconcileParams): Promise<SalesforceQueryResult> {
    return this.query(buildReconcileSoql(params))
  }

  getRecord(object: string, id: string, fields?: string[]): Promise<unknown> {
    const q = fields && fields.length > 0 ? `?fields=${encodeURIComponent(fields.join(','))}` : ''
    return this.request('GET', `/sobjects/${enc(object)}/${enc(id)}${q}`)
  }

  createRecord(object: string, fields: Record<string, unknown>): Promise<CreateRecordResult> {
    return this.request('POST', `/sobjects/${enc(object)}`, fields).then((raw) => {
      const r = isObject(raw) ? raw : {}
      return { id: typeof r.id === 'string' ? r.id : '', success: r.success === true }
    })
  }

  async updateRecord(object: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/sobjects/${enc(object)}/${enc(id)}`, fields)
  }

  submitForApproval(params: SubmitApprovalParams): Promise<unknown> {
    const request: Record<string, unknown> = {
      actionType: 'Submit',
      contextId: params.recordId
    }
    if (params.approverId !== undefined) request.nextApproverIds = [params.approverId]
    if (params.comments !== undefined) request.comments = params.comments
    return this.request('POST', '/process/approvals/', { requests: [request] })
  }

  // ── Transport + error mapping ───────────────────────────────────────────────

  private async request(method: SalesforceMethod, path: string, body?: unknown): Promise<unknown> {
    // SSRF guard BEFORE any request is built (spec §4.4). Salesforce's own hosts
    // are public; the guard just refuses a fat-fingered internal address.
    const check = checkBaseUrl(this.instanceUrl, 'Salesforce instance URL')
    if (!check.ok) throw new Error(check.reason)
    const base = trimTrailingSlash(check.url.href)
    const url = `${base}/services/data/${this.apiVersion}${path}`

    // `salesforce-auth.withAuth` mints/caches the token and re-mints ONCE on a
    // `401 INVALID_SESSION_ID` before rejecting (spec §8, §11).
    return this.auth.withAuth(async (token) => {
      const req: SalesforceRequest = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
      if (body !== undefined) {
        req.headers['Content-Type'] = 'application/json'
        req.body = JSON.stringify(body)
      }
      let res: SalesforceResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        throw new Error(
          `Salesforce instance ${check.url.host} is unreachable (${(err as Error).message}) — check the instance URL in Settings.`,
          { cause: err }
        )
      }
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      throw mapError(res, path)
    })
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function enc(s: string): string {
  return encodeURIComponent(s)
}

/** SOQL date literals are NOT quoted (`LastModifiedDate >= 2026-07-19T12:30:00Z`). */
function soqlDate(iso: string): string {
  return iso
}

function trimTrailingSlash(href: string): string {
  return href.endsWith('/') ? href.slice(0, -1) : href
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function asQueryResult(raw: unknown): SalesforceQueryResult {
  const r = isObject(raw) ? raw : {}
  return {
    records: Array.isArray(r.records) ? r.records : [],
    totalSize: typeof r.totalSize === 'number' ? r.totalSize : 0,
    done: r.done !== false
  }
}

/**
 * Map a Salesforce error response to a legible, real-cause reject (spec §11).
 * Salesforce returns an ARRAY `[{ message, errorCode, fields }]`; forward the
 * first `message` verbatim (already human-authored) and keep the `errorCode`. The
 * access token / credential is never part of this.
 */
export function mapError(res: SalesforceResponse, path: string): Error {
  const parsed = parseJson(res.body)
  const first = Array.isArray(parsed) && isObject(parsed[0]) ? parsed[0] : undefined
  // The OAuth token endpoint returns `{ error, error_description }` (not an array).
  const oauthError = isObject(parsed) ? parsed : undefined
  if (first && typeof first.message === 'string') {
    const code = typeof first.errorCode === 'string' ? ` (${first.errorCode})` : ''
    return new Error(`Salesforce rejected the request${code}: ${first.message}`)
  }
  if (oauthError && typeof oauthError.error === 'string') {
    const desc =
      typeof oauthError.error_description === 'string' ? `: ${oauthError.error_description}` : ''
    return new Error(`Salesforce rejected the request (${oauthError.error})${desc}`)
  }
  if (res.status === 404) {
    return new Error(
      `Salesforce has no such resource (404 on ${path}) — it may be in another org or was deleted.`
    )
  }
  return new Error(`Salesforce rejected the request (${res.status}) on ${path}.`)
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockSalesforceData {
  /** Raw records the reconcile poll + `query` return (with `attributes`). */
  records?: unknown[]
  /** A single record `getRecord` returns. */
  record?: unknown
  queryError?: string
  getRecordError?: string
  createError?: string
  updateError?: string
  approvalError?: string
  /** The id a create resolves (default `'NEW000000000001'`). */
  createdId?: string
}

/**
 * The offline seam tests inject in place of `SalesforceHttpApi` (spec §12). It
 * returns seeded raw payloads, records every call for assertions, and rejects
 * seeded failures verbatim — exercising the connector, poller, and engine with no
 * credentials and no network. A settable `records` lets a poll test advance state
 * tick-by-tick. `queryReconcile` applies the inclusive `afterTs` filter the real
 * SOQL `>=` would, so the poller's boundary dedup is exercised faithfully.
 */
export class MockSalesforceApi implements SalesforceApi {
  readonly calls = {
    query: [] as string[],
    queryReconcile: [] as SalesforceReconcileParams[],
    getRecord: [] as { object: string; id: string; fields?: string[] }[],
    createRecord: [] as { object: string; fields: Record<string, unknown> }[],
    updateRecord: [] as { object: string; id: string; fields: Record<string, unknown> }[],
    submitForApproval: [] as SubmitApprovalParams[]
  }

  constructor(public data: MockSalesforceData = {}) {}

  query(soql: string): Promise<SalesforceQueryResult> {
    this.calls.query.push(soql)
    if (this.data.queryError) return Promise.reject(new Error(this.data.queryError))
    const records = this.data.records ?? []
    return Promise.resolve({ records, totalSize: records.length, done: true })
  }

  queryReconcile(params: SalesforceReconcileParams): Promise<SalesforceQueryResult> {
    this.calls.queryReconcile.push(params)
    if (this.data.queryError) return Promise.reject(new Error(this.data.queryError))
    const all = this.data.records ?? []
    // Inclusive lower bound on the timestamp field (matches the real SOQL `>=`);
    // the poller dedups the boundary tuple by Id (spec §7.2).
    const rows = params.afterTs
      ? all.filter((r) => isObject(r) && String(r[params.timestampField] ?? '') >= params.afterTs!)
      : all
    return Promise.resolve({ records: rows, totalSize: rows.length, done: true })
  }

  getRecord(object: string, id: string, fields?: string[]): Promise<unknown> {
    this.calls.getRecord.push({ object, id, fields })
    if (this.data.getRecordError) return Promise.reject(new Error(this.data.getRecordError))
    return Promise.resolve(this.data.record ?? {})
  }

  createRecord(object: string, fields: Record<string, unknown>): Promise<CreateRecordResult> {
    this.calls.createRecord.push({ object, fields })
    if (this.data.createError) return Promise.reject(new Error(this.data.createError))
    return Promise.resolve({ id: this.data.createdId ?? 'NEW000000000001', success: true })
  }

  updateRecord(object: string, id: string, fields: Record<string, unknown>): Promise<void> {
    this.calls.updateRecord.push({ object, id, fields })
    if (this.data.updateError) return Promise.reject(new Error(this.data.updateError))
    return Promise.resolve()
  }

  submitForApproval(params: SubmitApprovalParams): Promise<unknown> {
    this.calls.submitForApproval.push(params)
    if (this.data.approvalError) return Promise.reject(new Error(this.data.approvalError))
    return Promise.resolve({
      success: true,
      instanceId: 'PI0000000000001',
      instanceStatus: 'Pending'
    })
  }
}

/**
 * The DEFERRED live transport (spec §4.3). Registered at startup so the
 * descriptor, normalizer, poller, and mock-tested dispatch land first; a real
 * call fails LOUDLY rather than silently no-opping until HTTP is wired.
 */
export function deferredLiveTransport(): SalesforceTransport {
  return {
    send: () =>
      Promise.reject(
        new Error(
          "The live Salesforce HTTP transport isn't wired yet — real REST/SOQL calls land in a " +
            'later phase. The connector, normalizer, poller, cursor store, and auth seam are in place and mock-tested.'
        )
      )
  }
}

/** Re-export the post-DNS hook so the live transport can pin the dialed IP. */
export { blockedIpRange }
