import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import { SHOPIFY_TRIGGER_IDS, type ShopifyTriggerId } from '../../shared/shopify'
import type { ShopifyApi } from './shopify-admin'
import {
  normalizeCustomer,
  normalizeOrder,
  triggersForTopic,
  webhookToPayload
} from './shopify-normalize'
import type { ShopifyWebhookDelivery, ShopifyWebhookServer } from './shopify-webhook-server'

/**
 * The Shopify `LiveConnector` (spec §4.2, §4.3) — the first live dispatch behind
 * the registry's pinned `invokeAction`/`subscribe`. It maps a pinned action id →
 * a `shopify-admin` call (isolating every Shopify shape there) and a pinned
 * trigger id → a webhook subscription. It holds NO Shopify shape and NO secret:
 * reads normalize through `shopify-normalize.ts`, mutations resolve the admin
 * client's small result, and every failure REJECTS with the real cause (the
 * pinned convention) — never a token, never a sentinel-success (spec §6.2, §11).
 *
 * Authority stays in the graph: a mutation only runs because an `action` node
 * invoked it, behind whatever `gate`/edge the author drew (§9). The connector
 * never auto-mutates.
 */

const isTriggerId = (v: string): v is ShopifyTriggerId =>
  (SHOPIFY_TRIGGER_IDS as readonly string[]).includes(v)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export class ShopifyConnector implements LiveConnector {
  private readonly api: ShopifyApi
  private readonly webhook?: ShopifyWebhookServer
  private readonly log: (message: string) => void
  private readonly handlers = new Map<ShopifyTriggerId, Set<(event: unknown) => void>>()
  private webhookWired = false

  constructor(deps: {
    api: ShopifyApi
    webhook?: ShopifyWebhookServer
    log?: (message: string) => void
  }) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  // ── Action dispatch ─────────────────────────────────────────────────────────

  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getOrder':
        return { ...normalizeOrder(await this.api.order(this.requireId(actionId, params))) }
      case 'getCustomer':
        return { ...normalizeCustomer(await this.api.customer(this.requireId(actionId, params))) }
      case 'searchOrders':
        return this.searchOrders(params)
      case 'refundOrder':
        return this.api.refundCreate({
          orderId: this.requireId(actionId, params),
          amount: optionalNumber(params.amount),
          restock: params.restock === true || params.restock === 'true'
        })
      case 'cancelOrder':
        return this.api.orderCancel({
          orderId: this.requireId(actionId, params),
          reason: optionalString(params.reason),
          refund: params.refund === true || params.refund === 'true',
          restock: params.restock === true || params.restock === 'true'
        })
      case 'updateShippingAddress':
        return this.updateShippingAddress(actionId, params)
      case 'addOrderNote':
        return this.api.orderUpdate({
          orderId: this.requireId(actionId, params),
          note: this.requireNote(params)
        })
      default:
        throw new Error(
          `Shopify has no action '${actionId}'. Valid actions: getOrder, getCustomer, searchOrders, refundOrder, cancelOrder, updateShippingAddress, addOrderNote.`
        )
    }
  }

  private async searchOrders(params: Record<string, unknown>): Promise<unknown> {
    const query = optionalString(params.query) ?? emailQuery(params.email)
    if (!query) {
      throw new Error(
        "Shopify action 'searchOrders' needs a 'query' (e.g. \"email:a@b.com\") or an 'email' param."
      )
    }
    const { nodes, count } = await this.api.orders({ query })
    return { orders: nodes.map((n) => normalizeOrder(n)), count }
  }

  private async updateShippingAddress(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const orderId = this.requireId(actionId, params)
    if (!isObject(params.address)) {
      throw new Error(
        "Shopify action 'updateShippingAddress' needs an 'address' object (address1, city, province, country, zip)."
      )
    }
    // Pre-fulfillment only (§6.2): once any item has shipped (or been restocked)
    // the address can't be safely edited — only a fully 'unfulfilled' order may
    // be changed. Reject 'partial'/'fulfilled'/'restocked' legibly BEFORE the
    // mutation rather than let Shopify fail obscurely.
    const current = normalizeOrder(await this.api.order(orderId))
    if (current.order.fulfillmentStatus !== 'unfulfilled') {
      throw new Error(
        `Shopify order '${orderId}' is '${current.order.fulfillmentStatus}', not unfulfilled — its shipping address can only be changed before fulfillment begins. Contact the carrier instead.`
      )
    }
    return this.api.orderUpdate({ orderId, shippingAddress: params.address })
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const id = params.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Shopify action '${actionId}' needs an order id — pass 'id' (e.g. "{{trigger.orderId}}").`
      )
    }
    return id
  }

  private requireNote(params: Record<string, unknown>): string {
    const note = params.note
    if (typeof note !== 'string' || note.length === 0) {
      throw new Error("Shopify action 'addOrderNote' needs a non-empty 'note'.")
    }
    return note
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`shopify connector: ignoring unknown trigger '${triggerId}'`)
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

  /** Verified, deduped delivery → normalized trigger payload → matching handlers. */
  private onDelivery(delivery: ShopifyWebhookDelivery): void {
    const payload = webhookToPayload(delivery.topic, delivery.payload)
    if (!payload) return
    const seed = { eventId: delivery.webhookId || randomUUID(), payload }
    for (const triggerId of triggersForTopic(delivery.topic, payload)) {
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

function emailQuery(email: unknown): string | undefined {
  return typeof email === 'string' && email.length > 0 ? `email:${email}` : undefined
}
