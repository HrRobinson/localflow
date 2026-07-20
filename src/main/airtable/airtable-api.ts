/**
 * Thin Web API client for Airtable (spec §2.2, §3.2, §4). ALL Airtable endpoint/
 * HTTP knowledge lives here — the blast radius for any API change, exactly as Woo
 * isolated its REST in `wc-api.ts` and PostHog in `posthog-api.ts`. HTTP transport
 * is INJECTED as a seam (`AirtableTransport`) so tests drive it with a
 * `MockAirtableApi` and NO live HTTP happens (spec §10). Real HTTP is DEFERRED
 * (spec §7.1) — this module ships the client shape + the offline seam.
 *
 * Security posture:
 *  - Airtable's host is the FIXED cloud host `api.airtable.com`; there is no
 *    user-supplied base URL, so the shared SSRF guard is deliberately NOT used
 *    (spec §7.2). The one host is a constant here.
 *  - The personal access token is fetched at call time via the injected `reveal`
 *    seam (bound, at live wiring, to the main-only CredentialStore plaintext
 *    exit), used ONLY to build the `Authorization: Bearer` header, and NEVER
 *    logged or returned (spec §5, §8).
 *  - The **5 requests/second per base** cap is honored by a per-base token bucket;
 *    a 429 carries a **30-second lockout** the client waits out before retrying
 *    (spec §2.2, §9). Errors are human, actionable, and carry the real Airtable
 *    cause (spec §9).
 */

const AIRTABLE_HOST = 'https://api.airtable.com'
const AIRTABLE_API_VERSION = 'v0'

/** Airtable's per-base rate cap (spec §2.2). */
const REQUESTS_PER_SECOND = 5
/** The 429 lockout window Airtable imposes on a base (spec §2.2, §9). */
const LOCKOUT_MS = 30_000

export type AirtableMethod = 'GET' | 'POST' | 'PATCH'

export interface AirtableRequest {
  method: AirtableMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface AirtableResponse {
  status: number
  body: string
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface AirtableTransport {
  send(req: AirtableRequest): Promise<AirtableResponse>
}

// ── Record shapes (the Web API's `{ id, createdTime, fields }`) ───────────────

/** A raw Airtable record as the Web API returns it (spec §2.2). `fields` is keyed
 *  by FIELD NAME; `airtable-normalize` maps it to the pinned envelope. */
export interface RawAirtableRecord {
  id: string
  createdTime: string
  fields: Record<string, unknown>
}

export interface ListRecordsParams {
  /** `filterByFormula` predicate, forwarded verbatim. */
  filterByFormula?: string
  /** Restrict to a view (id or name). */
  view?: string
  /** Page size, capped at 100 by Airtable. */
  pageSize?: number
  /** Subset of field names to return. */
  fields?: string[]
  /** Pagination offset from a prior page. */
  offset?: string
}

/** A create/update writes a `{ fields }` bag; `typecast` lets Airtable coerce
 *  string inputs into typed cells (spec §3.2). */
export interface WriteRecordInput {
  fields: Record<string, unknown>
  typecast?: boolean
}

// ── `/payloads` CDC stream shapes (Strategy A — spec §4) ──────────────────────

/** A created/changed record inside a `/payloads` batch. `cellValuesByFieldName`
 *  is the name-keyed cell bag (the webhook spec is created with field-name keys
 *  so the poll needs no schema round-trip); `changedFieldNames` narrows updates. */
export interface RawChangedRecord {
  createdTime?: string
  cellValuesByFieldName?: Record<string, unknown>
  changedFieldNames?: string[]
}

/** The per-table change groups inside one payload (spec §4). */
export interface RawTableChanges {
  createdRecordsById?: Record<string, RawChangedRecord>
  changedRecordsById?: Record<string, RawChangedRecord>
  destroyedRecordIds?: string[]
}

/** One CDC payload — a single base transaction (spec §4). The monotonic
 *  `baseTransactionNumber` disambiguates a record touched in different txns. */
export interface RawWebhookPayload {
  timestamp?: string
  baseTransactionNumber?: number
  changedTablesById?: Record<string, RawTableChanges>
}

/** A page of the `/payloads` cursor read (spec §4). `cursor` is the monotonic
 *  integer to pass NEXT; `mightHaveMore` drives pagination within a poll. */
export interface WebhookPayloadsPage {
  payloads: RawWebhookPayload[]
  cursor: number
  mightHaveMore?: boolean
}

/** The one-time secret + id returned at webhook creation (spec §4.4). The
 *  `macSecretBase64` is the phase-2 ping secret → keychain (never MVP-used). */
export interface CreatedWebhook {
  id: string
  macSecretBase64?: string
  expirationTime?: string
}

/**
 * The seam `airtable-connector` and `airtable-poller` are written against
 * (spec §10). The real impl (`AirtableHttpApi`) wraps the transport + the token
 * bucket; tests inject a `MockAirtableApi` returning canned records, canned
 * `/payloads` batches (settable tick-by-tick so a poll test advances state), and
 * canned error envelopes. Reads return already-typed record shapes — the
 * connector/poller run them through `airtable-normalize` (the correctness
 * boundary that pins the envelope + never-coerce).
 */
export interface AirtableApi {
  listRecords(params: ListRecordsParams): Promise<{ records: RawAirtableRecord[]; offset?: string }>
  getRecord(recordId: string): Promise<RawAirtableRecord>
  createRecord(input: WriteRecordInput): Promise<RawAirtableRecord>
  updateRecord(recordId: string, input: WriteRecordInput): Promise<RawAirtableRecord>
  /** The CDC cursor read (spec §4) — `cursor` is the monotonic integer. */
  listWebhookPayloads(webhookId: string, cursor?: number): Promise<WebhookPayloadsPage>
  createWebhook(spec: unknown): Promise<CreatedWebhook>
  refreshWebhook(webhookId: string): Promise<void>
}

export interface AirtableHttpApiDeps {
  transport: AirtableTransport
  /** Base id, `appXXXXXXXXXXXXXX` (non-secret ref from config.json). */
  baseId: string
  /** The watched/default table (id or name). */
  tableId: string
  /** Main-only plaintext exit for the personal access token (never stored here). */
  reveal: () => string
  /** Injected clock (ms) for the token bucket + lockout (the `flow-engine.now()`
   *  seam) so tests drive the throttle deterministically. */
  now?: () => number
  /** Injectable delay so tests run without real backoff/throttle waits. */
  sleep?: (ms: number) => Promise<void>
  /** Max retry attempts on a 429 lockout before giving up (default 2). */
  maxRetries?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The real Web API client. Owns the per-base token bucket + the 30-second
 * 429-lockout backoff (spec §2.2, §9). The base/table are path refs; the token is
 * the only secret and is read at call time, used ONLY for the Bearer header.
 */
export class AirtableHttpApi implements AirtableApi {
  private readonly transport: AirtableTransport
  private readonly baseId: string
  private readonly tableId: string
  private readonly reveal: () => string
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  /** Timestamps (ms) of the last requests, for the 5 req/sec sliding window. */
  private recent: number[] = []
  /** When the current 429 lockout ends (ms); 0 when not locked out. */
  private lockedUntil = 0

  constructor(deps: AirtableHttpApiDeps) {
    this.transport = deps.transport
    this.baseId = deps.baseId
    this.tableId = deps.tableId
    this.reveal = deps.reveal
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? 2
  }

  listRecords(
    params: ListRecordsParams
  ): Promise<{ records: RawAirtableRecord[]; offset?: string }> {
    const q = new URLSearchParams()
    if (params.filterByFormula) q.set('filterByFormula', params.filterByFormula)
    if (params.view) q.set('view', params.view)
    if (params.pageSize) q.set('pageSize', String(Math.min(params.pageSize, 100)))
    if (params.offset) q.set('offset', params.offset)
    if (params.fields) for (const f of params.fields) q.append('fields[]', f)
    const qs = q.toString()
    const path = `/${this.baseId}/${encodeURIComponent(this.tableId)}${qs ? `?${qs}` : ''}`
    return this.request('GET', path).then((raw) => {
      const obj = isObject(raw) ? raw : {}
      const records = Array.isArray(obj.records) ? (obj.records as RawAirtableRecord[]) : []
      return { records, offset: typeof obj.offset === 'string' ? obj.offset : undefined }
    })
  }

  getRecord(recordId: string): Promise<RawAirtableRecord> {
    const path = `/${this.baseId}/${encodeURIComponent(this.tableId)}/${encodeURIComponent(recordId)}`
    return this.request('GET', path).then((raw) => raw as RawAirtableRecord)
  }

  createRecord(input: WriteRecordInput): Promise<RawAirtableRecord> {
    const path = `/${this.baseId}/${encodeURIComponent(this.tableId)}`
    return this.request('POST', path, {
      fields: input.fields,
      ...(input.typecast ? { typecast: true } : {})
    }).then((raw) => raw as RawAirtableRecord)
  }

  updateRecord(recordId: string, input: WriteRecordInput): Promise<RawAirtableRecord> {
    const path = `/${this.baseId}/${encodeURIComponent(this.tableId)}/${encodeURIComponent(recordId)}`
    return this.request('PATCH', path, {
      fields: input.fields,
      ...(input.typecast ? { typecast: true } : {})
    }).then((raw) => raw as RawAirtableRecord)
  }

  listWebhookPayloads(webhookId: string, cursor?: number): Promise<WebhookPayloadsPage> {
    const q = cursor !== undefined ? `?cursor=${encodeURIComponent(String(cursor))}` : ''
    const path = `/bases/${this.baseId}/webhooks/${encodeURIComponent(webhookId)}/payloads${q}`
    return this.request('GET', path).then((raw) => {
      const obj = isObject(raw) ? raw : {}
      return {
        payloads: Array.isArray(obj.payloads) ? (obj.payloads as RawWebhookPayload[]) : [],
        cursor: typeof obj.cursor === 'number' ? obj.cursor : (cursor ?? 1),
        mightHaveMore: obj.mightHaveMore === true
      }
    })
  }

  createWebhook(spec: unknown): Promise<CreatedWebhook> {
    const path = `/bases/${this.baseId}/webhooks`
    return this.request('POST', path, { specification: spec }).then((raw) => raw as CreatedWebhook)
  }

  refreshWebhook(webhookId: string): Promise<void> {
    const path = `/bases/${this.baseId}/webhooks/${encodeURIComponent(webhookId)}/refresh`
    return this.request('POST', path, {}).then(() => undefined)
  }

  // ── Transport + throttle + error mapping ────────────────────────────────────

  private async request(method: AirtableMethod, path: string, body?: unknown): Promise<unknown> {
    const url = `${AIRTABLE_HOST}/${AIRTABLE_API_VERSION}${path}`
    const req: AirtableRequest = { method, url, headers: this.authHeaders(body !== undefined) }
    if (body !== undefined) req.body = JSON.stringify(body)

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle()
      const res = await this.transport.send(req)
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      if (res.status === 429) {
        // Airtable locks the WHOLE base out for ~30s. Wait it out, then retry —
        // only after exhausting retries do we reject (spec §9), never swallow.
        this.lockedUntil = this.now() + LOCKOUT_MS
        if (attempt < this.maxRetries) {
          await this.sleep(LOCKOUT_MS)
          continue
        }
        throw new Error(
          `Airtable throttled base '${this.baseId}' (5 req/sec; 30-second lockout) — ` +
            `the request was retried and gave up.`
        )
      }
      throw mapClientError(res, this.baseId, this.tableId)
    }
    // Unreachable: the loop either returns, continues, or throws.
    throw new Error(
      `Airtable request to base '${this.baseId}' failed after ${this.maxRetries} retries.`
    )
  }

  /** Enforce the per-base 5 req/sec token bucket + honor an active 429 lockout
   *  (spec §2.2, §9). Deterministic under the injected clock + sleep. */
  private async throttle(): Promise<void> {
    const now = this.now()
    if (this.lockedUntil > now) {
      await this.sleep(this.lockedUntil - now)
    }
    // Slide the 1-second window forward.
    const cutoff = this.now() - 1000
    this.recent = this.recent.filter((t) => t > cutoff)
    if (this.recent.length >= REQUESTS_PER_SECOND) {
      // Wait until the oldest in-window request ages out.
      const wait = this.recent[0] + 1000 - this.now()
      if (wait > 0) await this.sleep(wait)
      const cut2 = this.now() - 1000
      this.recent = this.recent.filter((t) => t > cut2)
    }
    this.recent.push(this.now())
  }

  /** Build the Bearer header from the keychain secret. Read here and used ONLY
   *  for this header — never logged or returned (spec §5, §8). */
  private authHeaders(hasBody: boolean): Record<string, string> {
    const token = this.reveal()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseJson(raw: string): unknown {
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Extract Airtable's `{ error: { type, message } }` (or a bare string) from a
 *  body, if present (spec §9 — forward Airtable's own message). */
function airtableError(body: string): { type?: string; message?: string } {
  try {
    const data: unknown = JSON.parse(body)
    if (isObject(data)) {
      const err = data.error
      if (typeof err === 'string') return { message: err }
      if (isObject(err)) {
        return {
          type: typeof err.type === 'string' ? err.type : undefined,
          message: typeof err.message === 'string' ? err.message : undefined
        }
      }
    }
  } catch {
    /* not JSON — fall through */
  }
  return {}
}

/** Map a non-retryable status to the actionable, real-cause message (spec §9). */
function mapClientError(res: AirtableResponse, baseId: string, tableId: string): Error {
  const { type, message } = airtableError(res.body)
  switch (res.status) {
    case 401:
      return new Error(
        'Airtable rejected the personal access token (401) — it was revoked or is wrong; ' +
          're-enter it in Settings.'
      )
    case 403:
      return new Error(
        message
          ? `Airtable refused the request (403): ${message} — the PAT likely lacks a needed ` +
              `scope (e.g. data.records:write); add it to the token.`
          : 'Airtable refused the request (403) — the PAT lacks a needed scope ' +
              '(e.g. data.records:write); add that scope to the token.'
      )
    case 404:
      return new Error(
        `Airtable has no such record in table '${tableId}' (404) — it may be in another base ` +
          `('${baseId}') or was deleted.`
      )
    case 422:
      return new Error(
        message
          ? `Airtable refused the write: ${message}${type ? ` (${type})` : ''} — ` +
              `check the field name/type.`
          : `Airtable refused the write (422) — check the field names/types.`
      )
    default:
      return new Error(
        message
          ? `Airtable rejected the request (${res.status}): ${message}`
          : `Airtable rejected the request (${res.status}) on base '${baseId}'.`
      )
  }
}

// ── The test seam ─────────────────────────────────────────────────────────────

export interface MockAirtableData {
  records?: Record<string, RawAirtableRecord>
  listResult?: RawAirtableRecord[]
  /** A queue of `/payloads` pages, shifted one per `listWebhookPayloads` call so a
   *  poll test advances state tick-by-tick. When empty, an empty page is returned. */
  payloadPages?: WebhookPayloadsPage[]
  createResult?: RawAirtableRecord
  updateResult?: RawAirtableRecord
  createdWebhook?: CreatedWebhook
  listError?: string
  getError?: string
  createError?: string
  updateError?: string
  payloadsError?: string
}

/**
 * The offline seam tests inject in place of `AirtableHttpApi` (spec §10). It
 * returns seeded records/payloads, records every call for assertions, and rejects
 * seeded failures verbatim — exercising the connector, poller, and engine with no
 * credentials and no network (same posture as `MockPostHogApi`).
 */
export class MockAirtableApi implements AirtableApi {
  readonly calls = {
    listRecords: [] as ListRecordsParams[],
    getRecord: [] as string[],
    createRecord: [] as WriteRecordInput[],
    updateRecord: [] as { recordId: string; input: WriteRecordInput }[],
    listWebhookPayloads: [] as { webhookId: string; cursor?: number }[],
    createWebhook: [] as unknown[],
    refreshWebhook: [] as string[]
  }

  constructor(public data: MockAirtableData = {}) {}

  listRecords(
    params: ListRecordsParams
  ): Promise<{ records: RawAirtableRecord[]; offset?: string }> {
    this.calls.listRecords.push(params)
    if (this.data.listError) return Promise.reject(new Error(this.data.listError))
    const records = this.data.listResult ?? Object.values(this.data.records ?? {})
    return Promise.resolve({ records })
  }

  getRecord(recordId: string): Promise<RawAirtableRecord> {
    this.calls.getRecord.push(recordId)
    if (this.data.getError) return Promise.reject(new Error(this.data.getError))
    const rec = this.data.records?.[recordId]
    if (!rec) return Promise.reject(new Error(`Airtable has no record '${recordId}' (404).`))
    return Promise.resolve(rec)
  }

  createRecord(input: WriteRecordInput): Promise<RawAirtableRecord> {
    this.calls.createRecord.push(input)
    if (this.data.createError) return Promise.reject(new Error(this.data.createError))
    return Promise.resolve(
      this.data.createResult ?? {
        id: 'recNEW',
        createdTime: '2026-07-20T00:00:00.000Z',
        fields: input.fields
      }
    )
  }

  updateRecord(recordId: string, input: WriteRecordInput): Promise<RawAirtableRecord> {
    this.calls.updateRecord.push({ recordId, input })
    if (this.data.updateError) return Promise.reject(new Error(this.data.updateError))
    const existing = this.data.records?.[recordId]
    return Promise.resolve(
      this.data.updateResult ?? {
        id: recordId,
        createdTime: existing?.createdTime ?? '2026-07-20T00:00:00.000Z',
        fields: { ...(existing?.fields ?? {}), ...input.fields }
      }
    )
  }

  listWebhookPayloads(webhookId: string, cursor?: number): Promise<WebhookPayloadsPage> {
    this.calls.listWebhookPayloads.push({ webhookId, cursor })
    if (this.data.payloadsError) return Promise.reject(new Error(this.data.payloadsError))
    const queue = this.data.payloadPages ?? []
    const next = queue.shift()
    if (next) return Promise.resolve(next)
    // No more seeded pages: an empty batch that holds the cursor steady.
    return Promise.resolve({ payloads: [], cursor: cursor ?? 1, mightHaveMore: false })
  }

  createWebhook(spec: unknown): Promise<CreatedWebhook> {
    this.calls.createWebhook.push(spec)
    return Promise.resolve(this.data.createdWebhook ?? { id: 'achMOCK' })
  }

  refreshWebhook(webhookId: string): Promise<void> {
    this.calls.refreshWebhook.push(webhookId)
    return Promise.resolve()
  }
}

/**
 * The DEFERRED live transport (spec §7.1). Registered at startup so the
 * descriptor, normalizer, poller, and mock-tested dispatch land first; a real
 * call fails LOUDLY rather than silently no-opping until HTTP is wired.
 */
export function deferredLiveTransport(): AirtableTransport {
  return {
    send: () =>
      Promise.reject(
        new Error(
          "The live Airtable HTTP transport isn't wired yet — real Web API calls land in a " +
            'later phase. The connector, normalizer, poller, and cursor store are in place and ' +
            'mock-tested.'
        )
      )
  }
}
