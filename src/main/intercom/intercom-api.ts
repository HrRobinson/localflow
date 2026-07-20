/**
 * The Intercom **REST client** — the SOLE place any Intercom request/response shape
 * lives (the API-version blast radius, spec §4.1, §4.2). The `IntercomApi` interface
 * is the seam: `IntercomApiClient` wraps an `IntercomTransport` (the live HTTP call,
 * DEFERRED — see `deferredLiveTransport`), and tests inject a `MockIntercomApi`, so
 * NO live Intercom call is ever performed in CI (spec §12).
 *
 * Read methods return the RAW Intercom object (HTML bodies, unix timestamps,
 * nested `contacts`/`tags`/`conversation_parts`); `intercom-normalize.ts` maps it to
 * the pinned context shape (§6.3). Mutation methods return a small localflow-shaped
 * result that becomes the action node's context output. Every request sends
 * `Authorization: Bearer <accessToken>` and targets the REGION base URL (US/EU/AU);
 * a `429` backs off honoring `Retry-After`. Failure follows the pinned convention:
 * every error path REJECTS with a legible, actionable message carrying the real
 * Intercom cause — and NEVER the access token (spec §8, §11).
 */

import type { IntercomRegion } from '../../shared/intercom'

// ── Raw Intercom object shapes (isolated here — HTML bodies, unix ts) ─────────

export interface RawAuthor {
  type?: string | null
  id?: string | null
  email?: string | null
}

export interface RawContactRef {
  type?: string | null
  id?: string | null
  email?: string | null
}

export interface RawConversationPart {
  /** HTML body of the part. */
  body?: string | null
  author?: RawAuthor | null
}

export interface RawConversation {
  id?: string | null
  state?: string | null
  read?: boolean | null
  priority?: string | null
  title?: string | null
  /** The message that opened the conversation. */
  source?: { body?: string | null; author?: RawAuthor | null } | null
  contacts?: { contacts?: RawContactRef[] | null } | null
  conversation_parts?: { conversation_parts?: RawConversationPart[] | null } | null
  tags?: { tags?: { name?: string | null }[] | null } | null
  /** Unix seconds. */
  created_at?: number | null
  updated_at?: number | null
}

export interface RawContact {
  id?: string | null
  email?: string | null
  name?: string | null
  role?: string | null
  created_at?: number | null
  last_seen_at?: number | null
}

// ── Mutation inputs / results (localflow-shaped) ──────────────────────────────

export interface ReplyInput {
  conversationId: string
  body: string
  adminId?: string
}
export interface ReplyResult {
  conversationId: string
  /** The id of the created reply part (may be ""). */
  partId: string
}

export interface CloseInput {
  conversationId: string
  adminId?: string
  body?: string
}
export interface CloseResult {
  conversationId: string
  state: string
}

export interface TagInput {
  conversationId: string
  tagId: string
  adminId?: string
}
export interface TagResult {
  conversationId: string
  tagId: string
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface IntercomApi {
  getConversation(id: string): Promise<RawConversation>
  getContact(id: string): Promise<RawContact>
  replyToConversation(input: ReplyInput): Promise<ReplyResult>
  closeConversation(input: CloseInput): Promise<CloseResult>
  tagConversation(input: TagInput): Promise<TagResult>
}

// ── HTTP transport (the live seam) ───────────────────────────────────────────

/** Intercom's error envelope (isolated here). */
export interface IntercomErrorEnvelope {
  errors?: { code?: string; message?: string }[]
  type?: string
  message?: string
}

export interface IntercomResponse {
  /** HTTP status — 401/403/404/429 are distinguished from a 2xx body. */
  status: number
  body: Record<string, unknown> & IntercomErrorEnvelope
  /** `Retry-After` seconds on a 429, when present. */
  retryAfter?: number
}

export interface IntercomRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path under the API root, e.g. "/conversations/123". */
  path: string
  /** JSON body for a POST/PUT (Intercom uses JSON). */
  json?: Record<string, unknown>
}

export type IntercomTransport = (req: IntercomRequest) => Promise<IntercomResponse>

/** Region → API base URL (§8). A token used against the wrong region fails with a
 *  legible error (§11), never a silent 404. */
export const REGION_BASE_URLS: Record<IntercomRegion, string> = {
  us: 'https://api.intercom.io',
  eu: 'https://api.eu.intercom.io',
  au: 'https://api.au.intercom.io'
}

export function baseUrlForRegion(region: IntercomRegion): string {
  return REGION_BASE_URLS[region]
}

const MAX_RATE_LIMIT_RETRIES = 3

/**
 * The live client. Written against `IntercomTransport` so the HTTP wiring (the
 * `Authorization: Bearer` header, region base URL, `fetch`) is a deferred, injected
 * concern and every response-shape decision is unit-tested with a fake transport.
 */
export class IntercomApiClient implements IntercomApi {
  private readonly transport: IntercomTransport
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRateLimitRetries: number

  constructor(deps: {
    transport: IntercomTransport
    sleep?: (ms: number) => Promise<void>
    maxRateLimitRetries?: number
  }) {
    this.transport = deps.transport
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxRateLimitRetries = deps.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES
  }

  async getConversation(id: string): Promise<RawConversation> {
    return (await this.request(
      { method: 'GET', path: `/conversations/${id}` },
      'conversation',
      id
    )) as RawConversation
  }

  async getContact(id: string): Promise<RawContact> {
    return (await this.request(
      { method: 'GET', path: `/contacts/${id}` },
      'contact',
      id
    )) as RawContact
  }

  async replyToConversation(input: ReplyInput): Promise<ReplyResult> {
    // A CUSTOMER-FACING reply: message_type "comment" posts a public reply. Only
    // an approved gate reaches this call (§9); the client itself never gates.
    const json: Record<string, unknown> = {
      message_type: 'comment',
      type: 'admin',
      body: input.body
    }
    if (input.adminId !== undefined) json.admin_id = input.adminId
    const body = (await this.request(
      { method: 'POST', path: `/conversations/${input.conversationId}/reply`, json },
      'conversation',
      input.conversationId
    )) as { conversation_parts?: { conversation_parts?: { id?: string }[] } }
    const parts = body.conversation_parts?.conversation_parts ?? []
    const partId =
      parts.length > 0 && typeof parts[parts.length - 1].id === 'string'
        ? (parts[parts.length - 1].id as string)
        : ''
    return { conversationId: input.conversationId, partId }
  }

  async closeConversation(input: CloseInput): Promise<CloseResult> {
    const json: Record<string, unknown> = { message_type: 'close', type: 'admin' }
    if (input.adminId !== undefined) json.admin_id = input.adminId
    if (input.body !== undefined) json.body = input.body
    const body = (await this.request(
      { method: 'POST', path: `/conversations/${input.conversationId}/parts`, json },
      'conversation',
      input.conversationId
    )) as { state?: string }
    return { conversationId: input.conversationId, state: body.state ?? 'closed' }
  }

  async tagConversation(input: TagInput): Promise<TagResult> {
    const json: Record<string, unknown> = { id: input.tagId }
    if (input.adminId !== undefined) json.admin_id = input.adminId
    await this.request(
      { method: 'POST', path: `/conversations/${input.conversationId}/tags`, json },
      'conversation',
      input.conversationId
    )
    return { conversationId: input.conversationId, tagId: input.tagId }
  }

  /** Send one request with rate-limit backoff, then unwrap the body or REJECT. */
  private async request(
    req: IntercomRequest,
    kind: string,
    id: string
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      let res: IntercomResponse
      try {
        res = await this.transport(req)
      } catch (err) {
        throw new Error(
          `Couldn't reach the Intercom API — ${(err as Error).message}. Check your connection.`,
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

  /** Classify the response into a body or a legible, actionable rejection (§11). */
  private unwrap(res: IntercomResponse, kind: string, id: string): Record<string, unknown> {
    const { status, body } = res
    const detail = errorDetail(body)
    if (status === 401) {
      throw new Error(
        'Intercom rejected the access token (401) — it was revoked or is wrong; ' +
          're-enter it in Settings.'
      )
    }
    if (status === 403) {
      throw new Error(
        `Intercom refused the ${kind}: the app is missing the required permission — ` +
          `grant it in the Developer Hub${detail ? ` (${detail})` : ''}.`
      )
    }
    if (status === 404) {
      throw new Error(
        `Intercom has no ${kind} '${id}' — it may be closed, merged, or from another ` +
          `workspace; also check the configured region (us/eu/au).`
      )
    }
    if (status === 429) {
      const wait = res.retryAfter ?? 1
      throw new Error(`Intercom rate-limited the request — retry in ~${wait}s.`)
    }
    if (detail) {
      throw new Error(`Intercom refused the ${kind}: ${detail}.`)
    }
    if (status >= 400) {
      throw new Error(`Intercom returned HTTP ${status} for the ${kind} '${id}'.`)
    }
    return body
  }
}

/** Pull a human message out of Intercom's error envelope (never the token). */
function errorDetail(body: IntercomErrorEnvelope): string | undefined {
  const first = body.errors?.[0]
  if (first && (first.message || first.code)) {
    return first.code ? `${first.message ?? 'error'} (\`${first.code}\`)` : first.message
  }
  if (typeof body.message === 'string' && body.message.length > 0) return body.message
  return undefined
}

/** Backoff honoring `Retry-After` (seconds); falls back to exponential. */
function backoffMs(retryAfter: number | undefined, attempt: number): number {
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000)
  }
  return Math.min(200 * 2 ** attempt, 5000)
}

/**
 * The live HTTP transport is DEFERRED (spec §14: the foundation slice registers
 * with a deferred transport). Wiring it means a `fetch` to the region base URL with
 * the keychain `Authorization: Bearer <token>` header. Until then a registered
 * connector using this transport fails LOUDLY rather than silently.
 */
export function deferredLiveTransport(): IntercomTransport {
  return () =>
    Promise.reject(
      new Error(
        "The live Intercom API transport isn't wired yet — real Intercom calls land in a " +
          'later phase. The connector, normalizer, and webhook receiver are in place and mock-tested.'
      )
    )
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockIntercomData {
  conversations?: Record<string, RawConversation>
  contacts?: Record<string, RawContact>
  replyError?: string
  closeError?: string
  tagError?: string
}

/**
 * The mock seam tests inject in place of `IntercomApiClient` (spec §12). It returns
 * seeded raw Intercom objects, records every mutation call for assertions, and
 * rejects seeded error failures verbatim — exercising the connector and the engine
 * offline, with no credentials and no network.
 */
export class MockIntercomApi implements IntercomApi {
  readonly calls = {
    reply: [] as ReplyInput[],
    close: [] as CloseInput[],
    tag: [] as TagInput[]
  }

  constructor(private readonly data: MockIntercomData) {}

  getConversation(id: string): Promise<RawConversation> {
    const node = this.data.conversations?.[id]
    if (!node) return Promise.reject(notFound('conversation', id))
    return Promise.resolve(node)
  }

  getContact(id: string): Promise<RawContact> {
    const node = this.data.contacts?.[id]
    if (!node) return Promise.reject(notFound('contact', id))
    return Promise.resolve(node)
  }

  replyToConversation(input: ReplyInput): Promise<ReplyResult> {
    this.calls.reply.push(input)
    if (this.data.replyError) {
      return Promise.reject(new Error(`Intercom refused the reply: ${this.data.replyError}.`))
    }
    return Promise.resolve({ conversationId: input.conversationId, partId: 'part_1' })
  }

  closeConversation(input: CloseInput): Promise<CloseResult> {
    this.calls.close.push(input)
    if (this.data.closeError) {
      return Promise.reject(new Error(`Intercom refused the close: ${this.data.closeError}.`))
    }
    return Promise.resolve({ conversationId: input.conversationId, state: 'closed' })
  }

  tagConversation(input: TagInput): Promise<TagResult> {
    this.calls.tag.push(input)
    if (this.data.tagError) {
      return Promise.reject(new Error(`Intercom refused the tag: ${this.data.tagError}.`))
    }
    return Promise.resolve({ conversationId: input.conversationId, tagId: input.tagId })
  }
}

function notFound(kind: string, id: string): Error {
  return new Error(
    `Intercom has no ${kind} '${id}' — it may be closed, merged, or from another workspace.`
  )
}
