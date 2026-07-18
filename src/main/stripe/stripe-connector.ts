import { createHash, randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import { STRIPE_TRIGGER_IDS, type StripeTriggerId } from '../../shared/stripe'
import type { StripeApi } from './stripe-client'
import {
  eventToPayload,
  majorToMinor,
  normalizeCharge,
  normalizeCustomer,
  normalizeDispute,
  normalizeSubscription,
  triggersForType
} from './stripe-normalize'
import type { StripeWebhookDelivery, StripeWebhookServer } from './stripe-webhook-server'

/**
 * The Stripe `LiveConnector` (spec §4.2) — the live dispatch behind the registry's
 * pinned `invokeAction`/`subscribe`. It maps a pinned action id → a `stripe-client`
 * call (isolating every Stripe shape there) and a pinned trigger id → a shared
 * webhook subscription. It holds NO Stripe shape and NO secret: reads normalize
 * through `stripe-normalize.ts`, mutations resolve the client's small result, and
 * every failure REJECTS with the real cause (the pinned convention) — never a key,
 * never a sentinel-success (§6.2, §11).
 *
 * Authority is the graph the author drew (§9): all three mutations — `createRefund`,
 * `respondToDispute`, `cancelSubscription` — move or contest MONEY, so they are
 * treated UNIFORMLY as gated money actions. NONE ever auto-runs: a mutation runs
 * ONLY because an `action` node invoked it, behind whatever gate/edge the author
 * placed. Delivering a trigger makes ZERO Stripe writes. An OPTIONAL deterministic
 * backstop (`limits.refundMaxAmount`, §9) rejects an over-limit refund BEFORE any
 * call — defense in depth under the author's gate, no model in the loop.
 */

export interface StripeLimits {
  /** Hard per-refund ceiling in MAJOR units; an over-limit refund rejects (§9). */
  refundMaxAmount?: number
  /** The currency the ceiling is denominated in (informational for the message). */
  refundMaxCurrency?: string
}

export interface StripeConnectorDeps {
  api: StripeApi
  webhook?: StripeWebhookServer
  /** Optional deterministic money backstop (§9); off by default (§13.2). */
  limits?: StripeLimits
  log?: (message: string) => void
  /** Injectable id minter for a SeedEvent lacking an event id (tests). */
  newId?: () => string
}

const isTriggerId = (v: string): v is StripeTriggerId =>
  (STRIPE_TRIGGER_IDS as readonly string[]).includes(v)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export class StripeConnector implements LiveConnector {
  private readonly api: StripeApi
  private readonly webhook?: StripeWebhookServer
  private readonly limits?: StripeLimits
  private readonly log: (message: string) => void
  private readonly newId: () => string
  private readonly handlers = new Map<StripeTriggerId, Set<(event: unknown) => void>>()
  private readonly seenEvents = new Set<string>()
  private webhookWired = false

  constructor(deps: StripeConnectorDeps) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.limits = deps.limits
    this.log = deps.log ?? ((m) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch ─────────────────────────────────────────────────────────

  // `async` so a synchronous validation throw (a missing id, an over-limit
  // refund) surfaces as a REJECTED promise — the pinned failure convention.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getCharge':
        return normalizeCharge(await this.api.getCharge(this.requireId(actionId, params)))
      case 'getCustomer':
        return normalizeCustomer(await this.api.getCustomer(this.requireId(actionId, params)))
      case 'getDispute':
        return normalizeDispute(await this.api.getDispute(this.requireId(actionId, params)))
      case 'getSubscription':
        return normalizeSubscription(
          await this.api.getSubscription(this.requireId(actionId, params))
        )
      case 'createRefund':
        return this.createRefund(actionId, params)
      case 'respondToDispute':
        return this.respondToDispute(actionId, params)
      case 'cancelSubscription':
        return this.cancelSubscription(actionId, params)
      default:
        throw new Error(
          `Stripe has no action '${actionId}'. Valid actions: getCharge, getCustomer, getDispute, ` +
            `getSubscription, createRefund, respondToDispute, cancelSubscription.`
        )
    }
  }

  /** Refund a charge (§6.2) — GATED money action. Amount is MAJOR-unit (the value
   *  the author sees); converted to minor for Stripe. The deterministic backstop
   *  (§9) is enforced HERE, before any network call. */
  private async createRefund(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    const chargeId = this.requireId(actionId, params)
    const amountMajor = optionalNumber(params.amount)
    const currency = optionalString(params.currency)
    // A partial refund's `amount` is MAJOR-unit and needs the charge's own currency
    // to convert to minor units — guessing USD silently over/under-refunds any
    // non-2-decimal currency (JPY/BHD, §9). A full refund (no amount) needs none.
    if (amountMajor !== undefined && currency === undefined) {
      throw new Error(
        `Stripe action 'createRefund' needs the charge's currency to convert ${amountMajor} to ` +
          `minor units — pass currency (e.g. from the charge context, {{stripe.charge.currency}}).`
      )
    }
    this.enforceRefundLimit(amountMajor, currency ?? 'USD')
    const input = {
      chargeId,
      amount: amountMajor === undefined ? undefined : majorToMinor(amountMajor, currency as string),
      reason: optionalString(params.reason)
    }
    return this.api.createRefund({
      ...input,
      idempotencyKey: idempotencyKey('createRefund', input)
    })
  }

  /** Respond to a dispute (§6.2): submit `evidence` to contest, or `{close:true}`
   *  to accept the chargeback. GATED money action. */
  private async respondToDispute(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const disputeId = this.requireId(actionId, params)
    const close = params.close === true || params.close === 'true'
    const evidence = isObject(params.evidence) ? params.evidence : undefined
    if (!close && !evidence) {
      throw new Error(
        "Stripe action 'respondToDispute' needs an 'evidence' object to contest, or 'close: true' to accept the chargeback."
      )
    }
    const input = { disputeId, evidence, close }
    return this.api.respondToDispute({
      ...input,
      idempotencyKey: idempotencyKey('respondToDispute', input)
    })
  }

  /** Cancel a subscription (§6.2) — GATED money action (stops billing). */
  private async cancelSubscription(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const subscriptionId = this.requireId(actionId, params)
    const input = {
      subscriptionId,
      invoiceNow: params.invoiceNow === true || params.invoiceNow === 'true',
      prorate: params.prorate === true || params.prorate === 'true'
    }
    return this.api.cancelSubscription({
      ...input,
      idempotencyKey: idempotencyKey('cancelSubscription', input)
    })
  }

  /** The §9 backstop: reject an over-limit refund BEFORE the client is called. */
  private enforceRefundLimit(amountMajor: number | undefined, currency: string): void {
    const max = this.limits?.refundMaxAmount
    if (max === undefined || amountMajor === undefined) return
    if (amountMajor > max) {
      const cur = this.limits?.refundMaxCurrency ?? currency
      throw new Error(
        `refund ${amountMajor} ${currency} exceeds the configured ${max} ${cur} Stripe limit — ` +
          `raise \`stripe.limits.refundMaxAmount\` or route it through a human gate.`
      )
    }
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const id = params.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Stripe action '${actionId}' needs an id — pass 'id' (e.g. "{{t.chargeId}}").`
      )
    }
    return id
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`stripe connector: ignoring unknown trigger '${triggerId}'`)
      return () => {}
    }
    let set = this.handlers.get(triggerId)
    if (!set) {
      set = new Set()
      this.handlers.set(triggerId, set)
    }
    set.add(handler)
    this.wireWebhook()
    return () => {
      set!.delete(handler)
    }
  }

  /** Attach the single webhook `onEvent` sink once, lazily on first subscribe. */
  private wireWebhook(): void {
    if (this.webhookWired || !this.webhook) return
    this.webhookWired = true
    this.webhook.onEvent((delivery) => this.onDelivery(delivery))
  }

  /**
   * Verified delivery → normalized trigger payload → matching handlers. Dedup on
   * the Stripe event id (`evt_…`) so an at-least-once redelivery never seeds a
   * second run (§7.1). This path makes ZERO Stripe writes — delivering a trigger
   * NEVER mutates money (the never-auto-run guarantee, §9).
   */
  private onDelivery(delivery: StripeWebhookDelivery): void {
    const eventId = delivery.eventId || this.newId()
    if (this.seenEvents.has(eventId)) return
    this.seenEvents.add(eventId)
    const payload = eventToPayload(delivery.type, delivery.data, eventId)
    if (!payload) return
    const seed = { eventId, payload }
    for (const triggerId of triggersForType(delivery.type)) {
      for (const handler of this.handlers.get(triggerId) ?? []) handler(seed)
    }
  }
}

function optionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * A STABLE idempotency key derived from the action + its resolved input, so a
 * run-RETRY with identical params reuses the key (Stripe returns the original
 * result — never a double-refund) while a CONFLICTING reuse is Stripe's to report
 * (§11). Deterministic hash — no secret, no randomness.
 */
function idempotencyKey(action: string, input: Record<string, unknown>): string {
  const canonical = `${action}:${stableStringify(input)}`
  return `lf_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

/** JSON with sorted keys and `undefined` fields dropped — stable across calls. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}
