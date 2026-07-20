import { randomUUID } from 'node:crypto'

/**
 * The Segment **HTTP Tracking API** client — the SOLE place any Segment
 * request/response shape lives (the API blast radius, spec §4.2, §6.2). The
 * `SegmentApi` interface is the seam: `SegmentApiClient` wraps a
 * `SegmentTransport` (the live HTTPS call, DEFERRED — see `deferredLiveTransport`),
 * and tests inject a `MockSegment`, so NO live Segment call is ever performed in
 * CI (spec §12). Mirrors `stripe-client.ts`.
 *
 * A write into Segment fans out to EVERY downstream destination — an amplified
 * side effect — so both writes are gated by the author's graph (§9). Every error
 * path REJECTS with a legible, actionable message carrying the real Segment cause,
 * and NEVER the write key (§8, §11).
 */

// ── Write inputs / result (localflow-shaped) ─────────────────────────────────

export interface TrackInput {
  event: string
  userId?: string
  anonymousId?: string
  properties?: Record<string, unknown>
  /** Segment's dedup id, minted client-side and echoed back as the result. */
  messageId: string
}

export interface IdentifyInput {
  userId?: string
  anonymousId?: string
  traits?: Record<string, unknown>
  messageId: string
}

export interface SegmentWriteResult {
  messageId: string
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface SegmentApi {
  track(input: TrackInput): Promise<SegmentWriteResult>
  identify(input: IdentifyInput): Promise<SegmentWriteResult>
}

// ── HTTP transport (the live seam) ───────────────────────────────────────────

export interface SegmentResponse {
  /** HTTP status — 401 (bad write key) / 4xx / 5xx are distinguished from 200. */
  status: number
  /** Segment's small ack body (`{ success: true }`) or an error message. */
  body: Record<string, unknown>
}

export interface SegmentRequest {
  /** Path under the data-plane root, e.g. "/v1/track". */
  path: '/v1/track' | '/v1/identify'
  /** JSON body (the Segment event envelope). */
  body: Record<string, unknown>
}

export type SegmentTransport = (req: SegmentRequest) => Promise<SegmentResponse>

/** Mint a Segment messageId for a write (dedup id) — injectable for tests. */
export type IdMinter = () => string

/**
 * The live client. Written against `SegmentTransport` so the HTTP wiring (the
 * `Authorization: Basic base64(writeKey:)` header, the region `dataPlaneUrl`,
 * `fetch`) is a deferred, injected concern and every response-shape decision is
 * unit-tested with a fake transport.
 */
export class SegmentApiClient implements SegmentApi {
  private readonly transport: SegmentTransport
  private readonly newId: IdMinter

  constructor(deps: { transport: SegmentTransport; newId?: IdMinter }) {
    this.transport = deps.transport
    this.newId = deps.newId ?? randomUUID
  }

  async track(input: TrackInput): Promise<SegmentWriteResult> {
    const messageId = input.messageId || this.newId()
    const body: Record<string, unknown> = { type: 'track', event: input.event, messageId }
    if (input.userId !== undefined) body.userId = input.userId
    if (input.anonymousId !== undefined) body.anonymousId = input.anonymousId
    if (input.properties !== undefined) body.properties = input.properties
    await this.send({ path: '/v1/track', body }, 'track')
    return { messageId }
  }

  async identify(input: IdentifyInput): Promise<SegmentWriteResult> {
    const messageId = input.messageId || this.newId()
    const body: Record<string, unknown> = { type: 'identify', messageId }
    if (input.userId !== undefined) body.userId = input.userId
    if (input.anonymousId !== undefined) body.anonymousId = input.anonymousId
    if (input.traits !== undefined) body.traits = input.traits
    await this.send({ path: '/v1/identify', body }, 'identify')
    return { messageId }
  }

  /** Send one request and classify the response into success or a legible
   *  rejection (§11). The write key never appears in any thrown message. */
  private async send(req: SegmentRequest, kind: 'track' | 'identify'): Promise<void> {
    let res: SegmentResponse
    try {
      res = await this.transport(req)
    } catch (err) {
      throw new Error(
        `Couldn't reach the Segment Tracking API (${(err as Error).message}) — check ` +
          'connectivity and dataPlaneUrl.',
        { cause: err }
      )
    }
    const { status, body } = res
    if (status === 401) {
      throw new Error(
        'Segment rejected the write key (401) — it was revoked or is wrong; re-enter it in Settings.'
      )
    }
    if (status >= 400) {
      const reason = typeof body.message === 'string' ? body.message : `HTTP ${status}`
      throw new Error(
        `Segment refused the ${kind} call — ${reason} (check the event name / properties).`
      )
    }
  }
}

/**
 * The live HTTPS transport is DEFERRED (spec §4.4: the foundation slice registers
 * with a deferred transport). Wiring it means a `fetch` to `${dataPlaneUrl}/v1/…`
 * with the keychain `Authorization: Basic base64(writeKey:)` header. Until then a
 * registered connector using this transport fails LOUDLY rather than silently.
 */
export function deferredLiveTransport(): SegmentTransport {
  return () =>
    Promise.reject(
      new Error(
        "The live Segment Tracking API transport isn't wired yet — real Segment writes land in " +
          'a later phase. The connector, normalizer, and webhook receiver are in place and mock-tested.'
      )
    )
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockSegmentData {
  /** When set, a `track` call rejects with this Segment error text. */
  trackError?: string
  /** When set, an `identify` call rejects with this Segment error text. */
  identifyError?: string
  /** When set, a call rejects as a 401 (bad write key). */
  unauthorized?: boolean
}

/**
 * The mock seam tests inject in place of `SegmentApiClient` (spec §12). It records
 * every write call for assertions and rejects seeded error failures verbatim —
 * exercising the connector offline, with no credentials and no network.
 */
export class MockSegment implements SegmentApi {
  readonly calls = {
    track: [] as TrackInput[],
    identify: [] as IdentifyInput[]
  }

  constructor(private readonly data: MockSegmentData = {}) {}

  track(input: TrackInput): Promise<SegmentWriteResult> {
    this.calls.track.push(input)
    if (this.data.unauthorized) return Promise.reject(this.unauthorized())
    if (this.data.trackError) {
      return Promise.reject(new Error(`Segment refused the track call — ${this.data.trackError}.`))
    }
    return Promise.resolve({ messageId: input.messageId })
  }

  identify(input: IdentifyInput): Promise<SegmentWriteResult> {
    this.calls.identify.push(input)
    if (this.data.unauthorized) return Promise.reject(this.unauthorized())
    if (this.data.identifyError) {
      return Promise.reject(
        new Error(`Segment refused the identify call — ${this.data.identifyError}.`)
      )
    }
    return Promise.resolve({ messageId: input.messageId })
  }

  private unauthorized(): Error {
    return new Error(
      'Segment rejected the write key (401) — it was revoked or is wrong; re-enter it in Settings.'
    )
  }
}
