/**
 * Thin REST client for the HubSpot **CRM v3 API** — the SOLE place any HubSpot
 * request/response shape lives (paths, the `properties` selectors, search filter
 * groups, association typeIds, the error envelope): the API blast radius (§7.1).
 * HTTP transport is INJECTED as a seam (`HubSpotTransport`), exactly as
 * `wc-api.ts` injects `WcTransport`, so tests drive it with a `MockHubSpotApi`
 * and NO live HTTP happens in CI (§10).
 *
 * Security posture:
 *  - The private-app token is fetched at CALL TIME via the injected `reveal`
 *    seam (bound at live wiring to the main-only CredentialStore plaintext exit),
 *    used ONLY to build the `Authorization: Bearer` header, and is NEVER logged
 *    or returned (§4).
 *  - Errors are human, actionable, and carry the real HubSpot cause (§6); the
 *    client backs off on 429/5xx (honoring `Retry-After` on a 429 when present).
 *  - `searchContacts` is capped client-side by a 4/sec token bucket (§2.2, §6),
 *    so a fan-out can never 429 the Search endpoint under normal use.
 */

export type HubSpotMethod = 'GET' | 'POST' | 'PATCH'

export interface HubSpotRequest {
  method: HubSpotMethod
  url: string
  headers: Record<string, string>
  body?: string
}

export interface HubSpotResponse {
  status: number
  body: string
  /** Lower-cased response headers (for `Retry-After` on a 429). Optional. */
  headers?: Record<string, string>
}

/** The injected HTTP seam — the only thing that would touch the network. */
export interface HubSpotTransport {
  send(req: HubSpotRequest): Promise<HubSpotResponse>
}

/** A raw HubSpot v3 object — `properties` is the stringly-typed bag the
 *  normalizer flattens. Returned by reads AND writes; the connector normalizes. */
export interface HubSpotObject {
  id: string
  properties: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  archived?: boolean
}

export interface SearchContactsInput {
  /** Exact-match on the `email` property (the common enrichment key). */
  email?: string
  /** Free-text query across HubSpot's default searchable properties. */
  query?: string
  /** Page size (HubSpot caps at 100). */
  limit?: number
}

export interface CreateContactFields {
  email: string
  firstName?: string
  lastName?: string
  company?: string
  jobTitle?: string
  /** Extra raw HubSpot property names → values, merged last. */
  extra?: Record<string, string | number | boolean>
}

export interface UpdateDealFields {
  stage?: string
  amount?: number
  ownerId?: string
  extra?: Record<string, string | number | boolean>
}

export interface CreateNoteFields {
  note: string
  contactId?: string
  dealId?: string
}

export interface CreateTaskFields {
  subject: string
  body?: string
  ownerId?: string
  /** ISO 8601 or epoch-ms due date. */
  dueDate?: string
  contactId?: string
  dealId?: string
}

/** The seam the connector + tests depend on. `MockHubSpotApi` implements it. */
export interface HubSpotApi {
  getContact(id: string): Promise<HubSpotObject>
  getDeal(id: string): Promise<HubSpotObject>
  getCompany(id: string): Promise<HubSpotObject>
  searchContacts(input: SearchContactsInput): Promise<{ results: HubSpotObject[]; total: number }>
  createContact(fields: CreateContactFields): Promise<HubSpotObject>
  updateDeal(id: string, fields: UpdateDealFields): Promise<HubSpotObject>
  createNote(fields: CreateNoteFields): Promise<HubSpotObject>
  createTask(fields: CreateTaskFields): Promise<HubSpotObject>
}

// ── Pinned property selectors + association type ids (all HubSpot-specific) ──

const CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'company',
  'jobtitle',
  'lifecyclestage',
  'hs_lead_status',
  'createdate',
  'hs_last_activity_date'
]

const DEAL_PROPERTIES = [
  'dealname',
  'dealstage',
  'pipeline',
  'amount',
  'deal_currency_code',
  'hubspot_owner_id',
  'closedate',
  'hs_is_closed',
  'hs_is_closed_won',
  'createdate'
]

const COMPANY_PROPERTIES = [
  'name',
  'domain',
  'industry',
  'numberofemployees',
  'annualrevenue',
  'country'
]

/** HubSpot-defined association type ids (engagement → object). */
const ASSOC = {
  noteToContact: 202,
  noteToDeal: 214,
  taskToContact: 204,
  taskToDeal: 216
}

const DEFAULT_API_BASE = 'https://api.hubapi.com'
const V3 = '/crm/v3/objects'
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A token bucket rate limiter (exported for direct unit testing). `now`/`sleep`
 * are injected so a test drives it against a fake clock with no real waits.
 * Capacity `burst`, refilling `perSec` tokens/second (HubSpot Search: 4/sec).
 */
export class RateLimiter {
  private tokens: number
  private last: number
  private readonly burst: number
  private readonly perSec: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(deps: {
    perSec: number
    burst?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }) {
    this.perSec = deps.perSec
    this.burst = deps.burst ?? deps.perSec
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.tokens = this.burst
    this.last = this.now()
  }

  /** Acquire one token, sleeping just long enough if the bucket is empty. */
  async acquire(): Promise<void> {
    this.refill()
    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.perSec) * 1000
      await this.sleep(waitMs)
      this.refill()
    }
    this.tokens -= 1
  }

  private refill(): void {
    const t = this.now()
    const elapsedSec = Math.max(0, t - this.last) / 1000
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.perSec)
    this.last = t
  }
}

export interface HubSpotApiDeps {
  transport: HubSpotTransport
  /** Main-only plaintext exit for the private-app token (never stored here). */
  reveal: () => string
  /** CRM API base (non-secret ref from config.json). Defaults to api.hubapi.com. */
  apiBase?: string
  /** Injectable delay so tests run without real backoff waits. */
  sleep?: (ms: number) => Promise<void>
  /** Max retry attempts on 429/5xx/timeout before giving up (default 3). */
  maxRetries?: number
  /** Injected clock for the search rate limiter (tests). */
  now?: () => number
}

export class HubSpotApiClient implements HubSpotApi {
  private readonly transport: HubSpotTransport
  private readonly reveal: () => string
  private readonly apiBase: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number
  /** The 4/sec Search cap (§6) — applied ONLY to `searchContacts`. */
  private readonly searchLimiter: RateLimiter

  constructor(deps: HubSpotApiDeps) {
    this.transport = deps.transport
    this.reveal = deps.reveal
    this.apiBase = trimTrailingSlash(deps.apiBase ?? DEFAULT_API_BASE)
    this.sleep = deps.sleep ?? defaultSleep
    this.maxRetries = deps.maxRetries ?? 3
    this.searchLimiter = new RateLimiter({
      perSec: 4,
      now: deps.now,
      sleep: this.sleep
    })
  }

  // ── Reads (§3.2) ─────────────────────────────────────────────────────────────

  getContact(id: string): Promise<HubSpotObject> {
    return this.readObject('contacts', id, CONTACT_PROPERTIES)
  }

  getDeal(id: string): Promise<HubSpotObject> {
    return this.readObject('deals', id, DEAL_PROPERTIES)
  }

  getCompany(id: string): Promise<HubSpotObject> {
    return this.readObject('companies', id, COMPANY_PROPERTIES)
  }

  async searchContacts(
    input: SearchContactsInput
  ): Promise<{ results: HubSpotObject[]; total: number }> {
    // The one hard, low ceiling: Search is 4 req/s per token. Gate every call
    // through the bucket so a fan-out never 429s (§2.2, §6).
    await this.searchLimiter.acquire()
    const body: Record<string, unknown> = {
      properties: CONTACT_PROPERTIES,
      limit: clampLimit(input.limit)
    }
    if (input.query) body.query = input.query
    if (input.email) {
      body.filterGroups = [
        { filters: [{ propertyName: 'email', operator: 'EQ', value: input.email }] }
      ]
    }
    const data = await this.request('POST', `${V3}/contacts/search`, body)
    const obj = isObject(data) ? data : {}
    const results = Array.isArray(obj.results) ? (obj.results as HubSpotObject[]) : []
    const total = typeof obj.total === 'number' ? obj.total : results.length
    return { results, total }
  }

  // ── Gated writes (§3.2) ──────────────────────────────────────────────────────

  createContact(fields: CreateContactFields): Promise<HubSpotObject> {
    const properties: Record<string, unknown> = { email: fields.email }
    if (fields.firstName !== undefined) properties.firstname = fields.firstName
    if (fields.lastName !== undefined) properties.lastname = fields.lastName
    if (fields.company !== undefined) properties.company = fields.company
    if (fields.jobTitle !== undefined) properties.jobtitle = fields.jobTitle
    Object.assign(properties, fields.extra ?? {})
    return this.writeObject('POST', `${V3}/contacts`, { properties })
  }

  updateDeal(id: string, fields: UpdateDealFields): Promise<HubSpotObject> {
    const properties: Record<string, unknown> = {}
    if (fields.stage !== undefined) properties.dealstage = fields.stage
    if (fields.amount !== undefined) properties.amount = String(fields.amount)
    if (fields.ownerId !== undefined) properties.hubspot_owner_id = fields.ownerId
    Object.assign(properties, fields.extra ?? {})
    return this.writeObject('PATCH', `${V3}/deals/${encodeURIComponent(id)}`, { properties })
  }

  createNote(fields: CreateNoteFields): Promise<HubSpotObject> {
    const body = {
      properties: { hs_note_body: fields.note, hs_timestamp: nowIso() },
      associations: associations(
        fields.contactId,
        fields.dealId,
        ASSOC.noteToContact,
        ASSOC.noteToDeal
      )
    }
    return this.writeObject('POST', `${V3}/notes`, body)
  }

  createTask(fields: CreateTaskFields): Promise<HubSpotObject> {
    const properties: Record<string, unknown> = {
      hs_task_subject: fields.subject,
      hs_timestamp: fields.dueDate ?? nowIso(),
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: 'NONE'
    }
    if (fields.body !== undefined) properties.hs_task_body = fields.body
    if (fields.ownerId !== undefined) properties.hubspot_owner_id = fields.ownerId
    const body = {
      properties,
      associations: associations(
        fields.contactId,
        fields.dealId,
        ASSOC.taskToContact,
        ASSOC.taskToDeal
      )
    }
    return this.writeObject('POST', `${V3}/tasks`, body)
  }

  // ── Transport + error mapping ────────────────────────────────────────────────

  private readObject(object: string, id: string, properties: string[]): Promise<HubSpotObject> {
    const query = new URLSearchParams({ properties: properties.join(','), archived: 'false' })
    return this.request(
      'GET',
      `${V3}/${object}/${encodeURIComponent(id)}?${query.toString()}`
    ) as Promise<HubSpotObject>
  }

  private writeObject(method: HubSpotMethod, path: string, body: unknown): Promise<HubSpotObject> {
    return this.request(method, path, body) as Promise<HubSpotObject>
  }

  private async request(method: HubSpotMethod, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.apiBase}${path}`
    const req: HubSpotRequest = { method, url, headers: this.authHeaders(body !== undefined) }
    if (body !== undefined) req.body = JSON.stringify(body)

    let lastErr: Error | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(backoffMs(attempt))
      let res: HubSpotResponse
      try {
        res = await this.transport.send(req)
      } catch (err) {
        lastErr = new Error(
          `HubSpot is unreachable (${(err as Error).message}) — check your connection and the CRM API base in Settings.`,
          { cause: err }
        )
        continue
      }
      if (res.status >= 200 && res.status < 300) return parseJson(res.body)
      if (res.status === 429) {
        // Search/burst throttle — honor Retry-After when HubSpot sends it.
        const retryAfter = Number(res.headers?.['retry-after'])
        if (Number.isFinite(retryAfter) && retryAfter > 0 && attempt < this.maxRetries) {
          await this.sleep(retryAfter * 1000)
        }
        lastErr = new Error(`HubSpot rate-limited the request (429) — backing off and retrying.`)
        continue
      }
      if (res.status >= 500) {
        lastErr = new Error(`HubSpot returned ${res.status} — backing off and retrying.`)
        continue
      }
      throw mapClientError(res, path)
    }
    throw (
      lastErr ?? new Error(`HubSpot request to ${path} failed after ${this.maxRetries} retries.`)
    )
  }

  /** Build the Bearer header from the keychain token. The token is read here and
   *  used ONLY for this header — never logged or returned (§4). */
  private authHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.reveal()}`,
      Accept: 'application/json'
    }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function trimTrailingSlash(href: string): string {
  return href.endsWith('/') ? href.slice(0, -1) : href
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 10
  return Math.min(Math.max(Math.trunc(limit), 1), 100)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Build the v3 association array for an engagement → contact/deal. */
function associations(
  contactId: string | undefined,
  dealId: string | undefined,
  toContactType: number,
  toDealType: number
): unknown[] {
  const out: unknown[] = []
  if (contactId) {
    out.push({
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: toContactType }]
    })
  }
  if (dealId) {
    out.push({
      to: { id: dealId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: toDealType }]
    })
  }
  return out
}

/** Capped exponential backoff: 200ms, 400ms, 800ms, … (matches wc-api). */
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

/** Extract HubSpot's `{ message, category }` from an error body, if present. */
function hubspotMessage(body: string): string | undefined {
  try {
    const data: unknown = JSON.parse(body)
    if (isObject(data) && typeof data.message === 'string' && data.message.length > 0) {
      return data.message
    }
  } catch {
    /* not JSON — fall through */
  }
  return undefined
}

/** Map a non-retryable 4xx to an actionable, real-cause message (§6). */
function mapClientError(res: HubSpotResponse, path: string): Error {
  const detail = hubspotMessage(res.body)
  switch (res.status) {
    case 401:
      return new Error(
        'HubSpot rejected the private-app token (401) — it was revoked or is wrong. ' +
          'Regenerate it in the portal (Settings ▸ Integrations ▸ Private Apps) and re-enter it.'
      )
    case 403:
      return new Error(
        detail
          ? `HubSpot refused the request — the private app is missing a required scope: ${detail}. Add it to the app.`
          : 'HubSpot refused the request (403) — the private app is missing a required scope. Add it to the app.'
      )
    case 404:
      return new Error(
        `That object isn't in this portal (404 on ${path}) — it may be deleted or from another portal.`
      )
    case 409:
      return new Error(
        detail
          ? `HubSpot reported a conflict (409): ${detail}` // e.g. a duplicate contact.
          : `HubSpot reported a conflict (409) on ${path} — the object may already exist.`
      )
    default:
      return new Error(
        detail
          ? `HubSpot rejected the request (${res.status}): ${detail}`
          : `HubSpot rejected the request (${res.status}) on ${path}.`
      )
  }
}

/**
 * The live HTTP transport is DEFERRED (foundation slice: no live REST in CI).
 * Wiring it means a `fetch` to `<apiBase>/crm/v3/…` with the keychain Bearer
 * header. Until then a registered connector using this transport fails LOUDLY
 * rather than silently no-opping.
 */
export function deferredLiveTransport(): HubSpotTransport {
  return {
    send: () =>
      Promise.reject(
        new Error(
          "The live HubSpot CRM v3 transport isn't wired yet — real REST calls land in a " +
            'later phase. The connector, normalizer, and webhook verifier are in place and mock-tested.'
        )
      )
  }
}

// ── The test seam ──────────────────────────────────────────────────────────────

export interface MockHubSpotData {
  contacts?: Record<string, HubSpotObject>
  deals?: Record<string, HubSpotObject>
  companies?: Record<string, HubSpotObject>
  searchResults?: HubSpotObject[]
  searchTotal?: number
  createContactError?: string
  updateDealError?: string
  createNoteError?: string
  createTaskError?: string
}

/**
 * The mock seam tests inject in place of `HubSpotApiClient` (§10). It returns
 * seeded raw objects, records every write call for assertions, and rejects
 * seeded error strings verbatim — exercising the connector and the engine
 * offline, with no credentials and no network.
 */
export class MockHubSpotApi implements HubSpotApi {
  readonly calls = {
    getContact: [] as string[],
    getDeal: [] as string[],
    getCompany: [] as string[],
    searchContacts: [] as SearchContactsInput[],
    createContact: [] as CreateContactFields[],
    updateDeal: [] as { id: string; fields: UpdateDealFields }[],
    createNote: [] as CreateNoteFields[],
    createTask: [] as CreateTaskFields[]
  }

  constructor(private readonly data: MockHubSpotData = {}) {}

  getContact(id: string): Promise<HubSpotObject> {
    this.calls.getContact.push(id)
    const node = this.data.contacts?.[id]
    if (!node) return Promise.reject(notFound('contact', id))
    return Promise.resolve(node)
  }

  getDeal(id: string): Promise<HubSpotObject> {
    this.calls.getDeal.push(id)
    const node = this.data.deals?.[id]
    if (!node) return Promise.reject(notFound('deal', id))
    return Promise.resolve(node)
  }

  getCompany(id: string): Promise<HubSpotObject> {
    this.calls.getCompany.push(id)
    const node = this.data.companies?.[id]
    if (!node) return Promise.reject(notFound('company', id))
    return Promise.resolve(node)
  }

  searchContacts(input: SearchContactsInput): Promise<{ results: HubSpotObject[]; total: number }> {
    this.calls.searchContacts.push(input)
    const results = this.data.searchResults ?? []
    return Promise.resolve({ results, total: this.data.searchTotal ?? results.length })
  }

  createContact(fields: CreateContactFields): Promise<HubSpotObject> {
    this.calls.createContact.push(fields)
    if (this.data.createContactError) {
      return Promise.reject(new Error(this.data.createContactError))
    }
    return Promise.resolve({ id: 'new-contact', properties: { email: fields.email } })
  }

  updateDeal(id: string, fields: UpdateDealFields): Promise<HubSpotObject> {
    this.calls.updateDeal.push({ id, fields })
    if (this.data.updateDealError) return Promise.reject(new Error(this.data.updateDealError))
    return Promise.resolve({ id, properties: {} })
  }

  createNote(fields: CreateNoteFields): Promise<HubSpotObject> {
    this.calls.createNote.push(fields)
    if (this.data.createNoteError) return Promise.reject(new Error(this.data.createNoteError))
    return Promise.resolve({ id: 'new-note', properties: {} })
  }

  createTask(fields: CreateTaskFields): Promise<HubSpotObject> {
    this.calls.createTask.push(fields)
    if (this.data.createTaskError) return Promise.reject(new Error(this.data.createTaskError))
    return Promise.resolve({ id: 'new-task', properties: {} })
  }
}

function notFound(kind: 'contact' | 'deal' | 'company', id: string): Error {
  return new Error(`HubSpot has no ${kind} '${id}' (it may be from another portal or was deleted).`)
}
