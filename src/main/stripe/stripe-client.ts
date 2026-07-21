/**
 * The Stripe **REST client** — the SOLE place any Stripe request/response shape
 * lives (the API-version blast radius, spec §4.1, §4.2). The `StripeApi` interface
 * is the seam: `StripeApiClient` wraps a `StripeTransport` (the live HTTP call,
 * DEFERRED — see `deferredLiveTransport`), and tests inject a `MockStripeApi`, so
 * NO live Stripe call is ever performed in CI (spec §12).
 *
 * Read methods return the RAW Stripe object (minor-unit integers, lowercase
 * currency, unix timestamps); `stripe-normalize.ts` maps it to the pinned context
 * shape (§6.3). Mutation methods return a small saiife-shaped result that
 * becomes the action node's context output. Every request sends
 * `Authorization: Bearer <restrictedKey>` and a `Stripe-Version`; mutations add an
 * `Idempotency-Key`; a `429` backs off honoring `Retry-After`. Failure follows the
 * pinned convention: every error path REJECTS with a legible, actionable message
 * carrying the real Stripe cause (`error.type`/`error.code`/`error.message`) — and
 * NEVER the restricted key (spec §8, §11).
 */

import { minorToMajor } from '../../shared/money'

// ── Raw Stripe object shapes (isolated here — minor units, unix ts) ──────────

export interface RawCharge {
  id?: string | null
  /** MINOR-unit integer (cents / whole yen). */
  amount?: number | null
  /** Lowercase on the wire, e.g. "usd". */
  currency?: string | null
  amount_refunded?: number | null
  status?: string | null
  paid?: boolean | null
  refunded?: boolean | null
  disputed?: boolean | null
  customer?: string | null
  /** Receipt email; billing email is a fallback. */
  receipt_email?: string | null
  billing_details?: { email?: string | null } | null
  payment_intent?: string | null
  /** Unix seconds. */
  created?: number | null
}

export interface RawDispute {
  id?: string | null
  charge?: string | null
  amount?: number | null
  currency?: string | null
  reason?: string | null
  status?: string | null
  evidence_details?: { due_by?: number | null } | null
}

export interface RawCustomer {
  id?: string | null
  email?: string | null
  name?: string | null
  currency?: string | null
  delinquent?: boolean | null
}

export interface RawSubscription {
  id?: string | null
  customer?: string | null
  status?: string | null
  currency?: string | null
  current_period_end?: number | null
  cancel_at_period_end?: boolean | null
  items?: { data?: { price?: { unit_amount?: number | null } | null }[] | null } | null
}

// ── Mutation inputs / results (saiife-shaped; amounts here are MINOR) ──────

export interface CreateRefundInput {
  chargeId: string
  /** MINOR-unit integer; omitted → full refund. */
  amount?: number
  reason?: string
  /** Stable key so a run-retry never double-refunds (spec §11). */
  idempotencyKey: string
}
export interface RefundResult {
  refundId: string
  /** MAJOR units (already converted from the refund's minor `amount`). */
  amount: number
  currency: string
}

export interface RespondToDisputeInput {
  disputeId: string
  evidence?: Record<string, unknown>
  /** `true` accepts the chargeback. */
  close?: boolean
  idempotencyKey: string
}
export interface DisputeResult {
  disputeId: string
  status: string
}

export interface CancelSubscriptionInput {
  subscriptionId: string
  invoiceNow?: boolean
  prorate?: boolean
  idempotencyKey: string
}
export interface SubscriptionResult {
  subscriptionId: string
  status: string
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface StripeApi {
  getCharge(id: string): Promise<RawCharge>
  getCustomer(id: string): Promise<RawCustomer>
  getDispute(id: string): Promise<RawDispute>
  getSubscription(id: string): Promise<RawSubscription>
  createRefund(input: CreateRefundInput): Promise<RefundResult>
  respondToDispute(input: RespondToDisputeInput): Promise<DisputeResult>
  cancelSubscription(input: CancelSubscriptionInput): Promise<SubscriptionResult>
}

// ── HTTP transport (the live seam) ───────────────────────────────────────────

/** Stripe's error envelope (isolated here). */
export interface StripeErrorEnvelope {
  error?: {
    type?: string
    code?: string
    message?: string
    param?: string
  }
}

export interface StripeResponse {
  /** HTTP status — 401/403/404/429 are distinguished from a 200 body. */
  status: number
  body: Record<string, unknown> & StripeErrorEnvelope
  /** `Retry-After` seconds on a 429, when present. */
  retryAfter?: number
}

export interface StripeRequest {
  method: 'GET' | 'POST' | 'DELETE'
  /** Path under the API root, e.g. "/v1/charges/ch_123". */
  path: string
  /** Form-encoded body params for a POST (Stripe uses form encoding). */
  form?: Record<string, unknown>
  /** Sent as the `Idempotency-Key` header on mutations. */
  idempotencyKey?: string
}

export type StripeTransport = (req: StripeRequest) => Promise<StripeResponse>

/** Pinned Stripe API version — bumping is a ONE-FILE change (spec §4.1, §11). */
export const DEFAULT_API_VERSION = '2025-06-30'

const MAX_RATE_LIMIT_RETRIES = 3

/**
 * The live client. Written against `StripeTransport` so the HTTP wiring (the
 * `Authorization: Bearer` header, `fetch`) is a deferred, injected concern and
 * every response-shape decision is unit-tested with a fake transport.
 */
export class StripeApiClient implements StripeApi {
  private readonly transport: StripeTransport
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRateLimitRetries: number

  constructor(deps: {
    transport: StripeTransport
    sleep?: (ms: number) => Promise<void>
    maxRateLimitRetries?: number
  }) {
    this.transport = deps.transport
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxRateLimitRetries = deps.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES
  }

  async getCharge(id: string): Promise<RawCharge> {
    return (await this.request(
      { method: 'GET', path: `/v1/charges/${id}` },
      'charge',
      id
    )) as RawCharge
  }

  async getCustomer(id: string): Promise<RawCustomer> {
    return (await this.request(
      { method: 'GET', path: `/v1/customers/${id}` },
      'customer',
      id
    )) as RawCustomer
  }

  async getDispute(id: string): Promise<RawDispute> {
    return (await this.request(
      { method: 'GET', path: `/v1/disputes/${id}` },
      'dispute',
      id
    )) as RawDispute
  }

  async getSubscription(id: string): Promise<RawSubscription> {
    return (await this.request(
      { method: 'GET', path: `/v1/subscriptions/${id}` },
      'subscription',
      id
    )) as RawSubscription
  }

  async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    const form: Record<string, unknown> = { charge: input.chargeId }
    if (input.amount !== undefined) form.amount = input.amount
    if (input.reason !== undefined) form.reason = input.reason
    const body = (await this.request(
      { method: 'POST', path: '/v1/refunds', form, idempotencyKey: input.idempotencyKey },
      'refund',
      input.chargeId
    )) as { id?: string; amount?: number; currency?: string }
    const currency = (body.currency ?? '').toUpperCase()
    return {
      refundId: typeof body.id === 'string' ? body.id : '',
      amount: minorToMajor(Number(body.amount ?? input.amount ?? 0), currency),
      currency
    }
  }

  async respondToDispute(input: RespondToDisputeInput): Promise<DisputeResult> {
    // Two DISTINCT Stripe endpoints, not one form-flag switch: accepting a
    // chargeback is `POST /v1/disputes/{id}/close`; submitting evidence to
    // contest is `POST /v1/disputes/{id}` with `submit=true`. The old code
    // posted the update endpoint with `submit=false` for `close:true`, which
    // only STAGES a draft and never actually closes the dispute.
    const req: StripeRequest = input.close
      ? {
          method: 'POST',
          path: `/v1/disputes/${input.disputeId}/close`,
          idempotencyKey: input.idempotencyKey
        }
      : {
          method: 'POST',
          path: `/v1/disputes/${input.disputeId}`,
          form: { ...(input.evidence ? { evidence: input.evidence } : {}), submit: true },
          idempotencyKey: input.idempotencyKey
        }
    const body = (await this.request(req, 'dispute', input.disputeId)) as {
      id?: string
      status?: string
    }
    return {
      disputeId: typeof body.id === 'string' ? body.id : input.disputeId,
      status: body.status ?? ''
    }
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<SubscriptionResult> {
    const form: Record<string, unknown> = {}
    if (input.invoiceNow !== undefined) form.invoice_now = input.invoiceNow
    if (input.prorate !== undefined) form.prorate = input.prorate
    const body = (await this.request(
      {
        method: 'DELETE',
        path: `/v1/subscriptions/${input.subscriptionId}`,
        form,
        idempotencyKey: input.idempotencyKey
      },
      'subscription',
      input.subscriptionId
    )) as { id?: string; status?: string }
    return {
      subscriptionId: typeof body.id === 'string' ? body.id : input.subscriptionId,
      status: body.status ?? ''
    }
  }

  /** Send one request with rate-limit backoff, then unwrap the body or REJECT. */
  private async request(
    req: StripeRequest,
    kind: string,
    id: string
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      let res: StripeResponse
      try {
        res = await this.transport(req)
      } catch (err) {
        throw new Error(
          `Couldn't reach the Stripe API — ${(err as Error).message}. Check your connection.`,
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
  private unwrap(res: StripeResponse, kind: string, id: string): Record<string, unknown> {
    const { status, body } = res
    const error = body.error
    if (status === 401) {
      throw new Error(
        'Stripe rejected the API key (401) — the restricted key was revoked or is wrong; ' +
          're-enter it in Settings.'
      )
    }
    if (status === 403) {
      throw new Error(
        `Your Stripe restricted key lacks a required permission — ${error?.message ?? 'permission denied'}. ` +
          `Grant the missing scope to this key in the Stripe dashboard.`
      )
    }
    if (status === 404) {
      throw new Error(
        `Stripe has no ${kind} '${id}' (wrong id, or it belongs to another account/mode).`
      )
    }
    if (status === 429) {
      const wait = res.retryAfter ?? 1
      throw new Error(`Stripe throttled the request (retry in ~${wait}s).`)
    }
    if (error) {
      const code = error.code ? ` (\`${error.code}\`)` : ''
      throw new Error(
        `Stripe refused the ${kind}: ${error.message ?? error.type ?? 'error'}${code}.`
      )
    }
    if (status >= 400) {
      throw new Error(`Stripe returned HTTP ${status} for the ${kind} '${id}'.`)
    }
    return body
  }
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
 * with a deferred transport). Wiring it means a `fetch` to `https://api.stripe.com`
 * with the keychain `Authorization: Bearer rk_…` header. Until then a registered
 * connector using this transport fails LOUDLY rather than silently.
 */
export function deferredLiveTransport(): StripeTransport {
  return () =>
    Promise.reject(
      new Error(
        "The live Stripe API transport isn't wired yet — real Stripe calls land in a " +
          'later phase. The connector, normalizer, and webhook receiver are in place and mock-tested.'
      )
    )
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockStripeData {
  charges?: Record<string, RawCharge>
  customers?: Record<string, RawCustomer>
  disputes?: Record<string, RawDispute>
  subscriptions?: Record<string, RawSubscription>
  refund?: RefundResult
  refundError?: string
  disputeError?: string
  cancelError?: string
}

/**
 * The mock seam tests inject in place of `StripeApiClient` (spec §12). It returns
 * seeded raw Stripe objects, records every mutation call (with its idempotency
 * key) for assertions, and rejects seeded error failures verbatim — exercising the
 * connector and the engine offline, with no credentials and no network.
 */
export class MockStripeApi implements StripeApi {
  readonly calls = {
    createRefund: [] as CreateRefundInput[],
    respondToDispute: [] as RespondToDisputeInput[],
    cancelSubscription: [] as CancelSubscriptionInput[]
  }

  constructor(private readonly data: MockStripeData) {}

  getCharge(id: string): Promise<RawCharge> {
    const node = this.data.charges?.[id]
    if (!node) return Promise.reject(notFound('charge', id))
    return Promise.resolve(node)
  }

  getCustomer(id: string): Promise<RawCustomer> {
    const node = this.data.customers?.[id]
    if (!node) return Promise.reject(notFound('customer', id))
    return Promise.resolve(node)
  }

  getDispute(id: string): Promise<RawDispute> {
    const node = this.data.disputes?.[id]
    if (!node) return Promise.reject(notFound('dispute', id))
    return Promise.resolve(node)
  }

  getSubscription(id: string): Promise<RawSubscription> {
    const node = this.data.subscriptions?.[id]
    if (!node) return Promise.reject(notFound('subscription', id))
    return Promise.resolve(node)
  }

  createRefund(input: CreateRefundInput): Promise<RefundResult> {
    this.calls.createRefund.push(input)
    if (this.data.refundError) {
      return Promise.reject(new Error(`Stripe refused the refund: ${this.data.refundError}.`))
    }
    return Promise.resolve(this.data.refund ?? { refundId: 're_1', amount: 0, currency: 'USD' })
  }

  respondToDispute(input: RespondToDisputeInput): Promise<DisputeResult> {
    this.calls.respondToDispute.push(input)
    if (this.data.disputeError) {
      return Promise.reject(new Error(`Stripe refused the dispute: ${this.data.disputeError}.`))
    }
    return Promise.resolve({
      disputeId: input.disputeId,
      status: input.close ? 'lost' : 'under_review'
    })
  }

  cancelSubscription(input: CancelSubscriptionInput): Promise<SubscriptionResult> {
    this.calls.cancelSubscription.push(input)
    if (this.data.cancelError) {
      return Promise.reject(new Error(`Stripe refused the subscription: ${this.data.cancelError}.`))
    }
    return Promise.resolve({ subscriptionId: input.subscriptionId, status: 'canceled' })
  }
}

function notFound(kind: string, id: string): Error {
  return new Error(
    `Stripe has no ${kind} '${id}' (wrong id, or it belongs to another account/mode).`
  )
}
