/**
 * The Zendesk **REST client** — the SOLE place any Zendesk request/response shape
 * lives (the API blast radius, spec §4.1, §4.2). The `ZendeskApi` interface is the
 * seam: `ZendeskRestApi` wraps a `ZendeskTransport` (the live HTTP call, DEFERRED
 * — see `deferredLiveTransport`), and tests inject a `MockZendeskApi`, so NO live
 * Zendesk call is ever performed in CI (spec §12).
 *
 * Read methods return the RAW Zendesk object; `zendesk-normalize.ts` maps it to
 * the pinned context shape (§6.3). Mutation methods return a small localflow-shaped
 * result that becomes the action node's context output. Every request sends HTTP
 * Basic `{agentEmail}/token:{apiToken}` (or `Authorization: Bearer` in the OAuth
 * fork) against `https://{subdomain}.zendesk.com/api/v2/`; a `429` backs off
 * honoring `Retry-After`. Failure follows the pinned convention: every error path
 * REJECTS with a legible, actionable message carrying the real Zendesk cause
 * (`error`/`description`/`details`) — and NEVER the token (spec §8, §11).
 */

// ── Raw Zendesk object shapes (isolated here) ────────────────────────────────

export interface RawTicket {
  id?: number | string | null
  subject?: string | null
  status?: string | null
  priority?: string | null
  /** Some payloads (webhook/side-load) carry the requester email inline. */
  requester_email?: string | null
  requester_id?: number | string | null
  assignee_id?: number | string | null
  group_id?: number | string | null
  tags?: string[] | null
  satisfaction_rating?: { score?: string | null } | null
  created_at?: string | null
  updated_at?: string | null
}

export interface RawComment {
  id?: number | string | null
  body?: string | null
  plain_body?: string | null
  public?: boolean | null
  author_id?: number | string | null
  /** 'end-user' | 'agent' | 'system' when the payload carries it. */
  author_role?: string | null
  created_at?: string | null
}

export interface RawUser {
  id?: number | string | null
  email?: string | null
  name?: string | null
  role?: string | null
  organization_id?: number | string | null
  created_at?: string | null
}

// ── Mutation inputs / results (localflow-shaped) ─────────────────────────────

/**
 * Zendesk folds reply + status + assignment into ONE `PUT /tickets/{id}.json`.
 * The connector composes only the fields the invoked action id owns, so a
 * `setStatus` write can NEVER carry a public comment as a side effect (§6.2, §9).
 */
export interface UpdateTicketInput {
  ticketId: string
  /** Present only for `replyToTicket` (public:true) / `addInternalNote` (public:false). */
  comment?: { body: string; public: boolean }
  /** Present only for `setStatus`. */
  status?: string
  /** Present only for `assignTicket`. */
  assigneeId?: string
  groupId?: string
}
export interface UpdateTicketResult {
  ticketId: string
  status: string
}

export interface SetTagsInput {
  ticketId: string
  tags: string[]
}
export interface SetTagsResult {
  ticketId: string
  tags: string[]
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface ZendeskApi {
  getTicket(id: string): Promise<RawTicket>
  getComments(id: string): Promise<RawComment[]>
  searchTickets(query: string): Promise<RawTicket[]>
  getUser(id: string): Promise<RawUser>
  updateTicket(input: UpdateTicketInput): Promise<UpdateTicketResult>
  setTags(input: SetTagsInput): Promise<SetTagsResult>
}

// ── HTTP transport (the live seam) ───────────────────────────────────────────

/** Zendesk's error envelope (isolated here, §11). */
export interface ZendeskErrorEnvelope {
  error?: string
  description?: string
  /** Per-field validation messages, e.g. `{ status: [{ description }] }`. */
  details?: Record<string, unknown>
}

export interface ZendeskResponse {
  /** HTTP status — 401/403/404/422/429 are distinguished from a 2xx body. */
  status: number
  body: Record<string, unknown> & ZendeskErrorEnvelope
  /** `Retry-After` seconds on a 429, when present. */
  retryAfter?: number
}

export interface ZendeskRequest {
  method: 'GET' | 'PUT' | 'POST'
  /** Path under the API v2 root, e.g. "/tickets/35436.json". */
  path: string
  /** JSON body for a PUT/POST. */
  json?: Record<string, unknown>
}

export type ZendeskTransport = (req: ZendeskRequest) => Promise<ZendeskResponse>

const MAX_RATE_LIMIT_RETRIES = 3

/**
 * The live client. Written against `ZendeskTransport` so the HTTP wiring (the
 * Basic-auth header, `fetch`, the `{subdomain}.zendesk.com` host) is a deferred,
 * injected concern and every response-shape decision is unit-tested with a fake
 * transport.
 */
export class ZendeskRestApi implements ZendeskApi {
  private readonly transport: ZendeskTransport
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRateLimitRetries: number

  constructor(deps: {
    transport: ZendeskTransport
    sleep?: (ms: number) => Promise<void>
    maxRateLimitRetries?: number
  }) {
    this.transport = deps.transport
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxRateLimitRetries = deps.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES
  }

  async getTicket(id: string): Promise<RawTicket> {
    const body = await this.request({ method: 'GET', path: `/tickets/${id}.json` }, 'ticket', id)
    return (body.ticket ?? {}) as RawTicket
  }

  async getComments(id: string): Promise<RawComment[]> {
    const body = await this.request(
      { method: 'GET', path: `/tickets/${id}/comments.json` },
      'ticket',
      id
    )
    return Array.isArray(body.comments) ? (body.comments as RawComment[]) : []
  }

  async searchTickets(query: string): Promise<RawTicket[]> {
    const body = await this.request(
      { method: 'GET', path: `/search.json?query=${encodeURIComponent(query)}` },
      'search',
      query
    )
    return Array.isArray(body.results) ? (body.results as RawTicket[]) : []
  }

  async getUser(id: string): Promise<RawUser> {
    const body = await this.request({ method: 'GET', path: `/users/${id}.json` }, 'user', id)
    return (body.user ?? {}) as RawUser
  }

  async updateTicket(input: UpdateTicketInput): Promise<UpdateTicketResult> {
    const ticket: Record<string, unknown> = {}
    if (input.comment) ticket.comment = { body: input.comment.body, public: input.comment.public }
    if (input.status !== undefined) ticket.status = input.status
    if (input.assigneeId !== undefined && input.assigneeId.length > 0)
      ticket.assignee_id = input.assigneeId
    if (input.groupId !== undefined && input.groupId.length > 0) ticket.group_id = input.groupId
    const body = (await this.request(
      { method: 'PUT', path: `/tickets/${input.ticketId}.json`, json: { ticket } },
      'ticket',
      input.ticketId
    )) as { ticket?: { id?: number | string; status?: string } }
    return {
      ticketId: String(body.ticket?.id ?? input.ticketId),
      status: typeof body.ticket?.status === 'string' ? body.ticket.status : ''
    }
  }

  async setTags(input: SetTagsInput): Promise<SetTagsResult> {
    const body = (await this.request(
      { method: 'PUT', path: `/tickets/${input.ticketId}/tags.json`, json: { tags: input.tags } },
      'ticket',
      input.ticketId
    )) as { tags?: string[] }
    return {
      ticketId: input.ticketId,
      tags: Array.isArray(body.tags) ? body.tags : input.tags
    }
  }

  /** Send one request with rate-limit backoff, then unwrap the body or REJECT. */
  private async request(
    req: ZendeskRequest,
    kind: string,
    id: string
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      let res: ZendeskResponse
      try {
        res = await this.transport(req)
      } catch (err) {
        throw new Error(
          `Couldn't reach the Zendesk API — ${(err as Error).message}. Check your connection ` +
            'and the `subdomain` field.',
          { cause: err }
        )
      }
      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        await this.sleep(backoffMs(res.retryAfter, attempt))
        continue
      }
      return this.unwrap(res, kind, id)
    }
  }

  /** Classify the response into a body or a legible, actionable rejection (§11).
   *  The token/secret is NEVER included in any message. */
  private unwrap(res: ZendeskResponse, kind: string, id: string): Record<string, unknown> {
    const { status, body } = res
    if (status === 401) {
      throw new Error(
        'Zendesk rejected the credentials (401) — check the agent email, API token, and that ' +
          'token access is enabled in Admin Center; re-enter them in Settings.'
      )
    }
    if (status === 403) {
      throw new Error(
        `Zendesk refused the ${kind} — the token's user lacks agent permission for this ` +
          `${kind}/group (403). ${body.error ?? ''}`.trim()
      )
    }
    if (status === 404) {
      throw new Error(`Zendesk has no ${kind} '${id}' (wrong id, or it's on another subdomain).`)
    }
    if (status === 429) {
      const wait = res.retryAfter ?? 1
      throw new Error(`Zendesk throttled the request (retry in ~${wait}s).`)
    }
    if (status === 422 || (typeof body.error === 'string' && status >= 400)) {
      const detail = describeDetails(body.details) || body.description || body.error || 'error'
      throw new Error(`Zendesk refused the update: ${detail}.`)
    }
    if (status >= 400) {
      throw new Error(`Zendesk returned HTTP ${status} for the ${kind} '${id}'.`)
    }
    return body
  }
}

/** Flatten Zendesk's per-field `details` into a legible "field: message" string. */
function describeDetails(details: unknown): string {
  if (typeof details !== 'object' || details === null) return ''
  const parts: string[] = []
  for (const [field, val] of Object.entries(details as Record<string, unknown>)) {
    const first = Array.isArray(val) ? val[0] : val
    const msg =
      typeof first === 'object' && first !== null
        ? (first as { description?: string }).description
        : typeof first === 'string'
          ? first
          : undefined
    if (msg) parts.push(`${msg} (\`details: ${field}\`)`)
  }
  return parts.join('; ')
}

/** Backoff honoring `Retry-After` (seconds); falls back to exponential. */
function backoffMs(retryAfter: number | undefined, attempt: number): number {
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000)
  }
  return Math.min(200 * 2 ** attempt, 5000)
}

/**
 * The live HTTP transport is DEFERRED (spec §4.4: the foundation slice registers
 * with a deferred transport). Wiring it means a `fetch` to
 * `https://{subdomain}.zendesk.com/api/v2` with the keychain Basic-auth header.
 * Until then a registered connector using this transport fails LOUDLY rather than
 * silently.
 */
export function deferredLiveTransport(): ZendeskTransport {
  return () =>
    Promise.reject(
      new Error(
        "The live Zendesk API transport isn't wired yet — real Zendesk calls land in a later " +
          'phase. The connector, normalizer, and webhook receiver are in place and mock-tested.'
      )
    )
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockZendeskData {
  tickets?: Record<string, RawTicket>
  comments?: Record<string, RawComment[]>
  users?: Record<string, RawUser>
  searchResults?: RawTicket[]
  /** Seeded verbatim Zendesk failure messages (§11 / §12). */
  updateError?: string
  tagsError?: string
}

/**
 * The mock seam tests inject in place of `ZendeskRestApi` (spec §12). It returns
 * seeded raw Zendesk objects, records every mutation call for assertions, and
 * rejects seeded failures verbatim — exercising the connector and the engine
 * offline, with no credentials and no network.
 */
export class MockZendeskApi implements ZendeskApi {
  readonly calls = {
    updateTicket: [] as UpdateTicketInput[],
    setTags: [] as SetTagsInput[]
  }

  constructor(private readonly data: MockZendeskData) {}

  getTicket(id: string): Promise<RawTicket> {
    const node = this.data.tickets?.[id]
    if (!node) return Promise.reject(notFound('ticket', id))
    return Promise.resolve(node)
  }

  getComments(id: string): Promise<RawComment[]> {
    return Promise.resolve(this.data.comments?.[id] ?? [])
  }

  searchTickets(query: string): Promise<RawTicket[]> {
    void query
    return Promise.resolve(this.data.searchResults ?? [])
  }

  getUser(id: string): Promise<RawUser> {
    const node = this.data.users?.[id]
    if (!node) return Promise.reject(notFound('user', id))
    return Promise.resolve(node)
  }

  updateTicket(input: UpdateTicketInput): Promise<UpdateTicketResult> {
    this.calls.updateTicket.push(input)
    if (this.data.updateError) {
      return Promise.reject(new Error(`Zendesk refused the update: ${this.data.updateError}.`))
    }
    return Promise.resolve({ ticketId: input.ticketId, status: input.status ?? 'open' })
  }

  setTags(input: SetTagsInput): Promise<SetTagsResult> {
    this.calls.setTags.push(input)
    if (this.data.tagsError) {
      return Promise.reject(new Error(`Zendesk refused the update: ${this.data.tagsError}.`))
    }
    return Promise.resolve({ ticketId: input.ticketId, tags: input.tags })
  }
}

function notFound(kind: string, id: string): Error {
  return new Error(`Zendesk has no ${kind} '${id}' (wrong id, or it's on another subdomain).`)
}
