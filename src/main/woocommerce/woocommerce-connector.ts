import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import type { WcApi } from './wc-api'
import type { WcWebhookEvent } from './wc-webhook-server'
import { normalizeCustomer, normalizeOrder } from './wc-normalize'

/**
 * The WooCommerce `LiveConnector` (spec §4.2) — the orchestrator the registry
 * delegates to for id `'woocommerce'`. It owns:
 *  - the **action-dispatch table** (`invokeAction(actionId, params)` → the right
 *    `wc-api` call), and
 *  - **trigger fan-out** (`subscribe(triggerId, handler)` + `deliver(event)`):
 *    a verified webhook event is routed to every handler subscribed to its
 *    topic as a `{ eventId, payload }` SeedEvent (`trigger-subscriber.coerceEvent`
 *    shape, spec §4.5).
 *
 * Safety posture (spec §4.6): the connector exposes the four gated mutations but
 * NEVER fires one on its own — a mutation runs ONLY because an action node
 * invoked `invokeAction`. Delivering a trigger makes ZERO store writes. Every
 * failure REJECTS with the real `wc-api` error (spec §3, §8); the key/secret are
 * confined to `wc-api`'s Basic-auth header and never logged or returned.
 *
 * Live wiring (binding the `wc-api` `reveal` seam to the CredentialStore
 * plaintext exit + a real HTTP transport + the webhook server's `onEvent`) is
 * DEFERRED (spec §11); this is the offline, mock-seam-tested core.
 */

export interface WoocommerceConnectorDeps {
  api: WcApi
  /** Route+reason logger for delivery failures. NEVER receives a secret. */
  log?: (message: string) => void
  /** Injectable id minter for a SeedEvent lacking a delivery id (tests). */
  newId?: () => string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Read a required id param (`orderId`/`customerId`, falling back to `id`). */
function requireId(params: Record<string, unknown>, key: string, label: string): string {
  const raw = params[key] ?? params.id
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  throw new Error(
    `WooCommerce ${label} needs a non-empty ${key} — none was supplied to the action.`
  )
}

export class WoocommerceConnector implements LiveConnector {
  private readonly api: WcApi
  private readonly log: (message: string) => void
  private readonly newId: () => string
  /** Per-topic trigger handlers (spec §4.5 fan-out). */
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>()

  constructor(deps: WoocommerceConnectorDeps) {
    this.api = deps.api
    this.log = deps.log ?? ((m: string) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch (spec §6.2 reads, §6.3 gated mutations) ─────────────────

  // `async` so a synchronous validation throw (e.g. a missing id) surfaces as a
  // REJECTED promise — the pinned failure convention (spec §3) — never a sync
  // throw the action-runner would see out of band.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getOrder':
        return normalizeOrder(await this.api.getOrder(requireId(params, 'orderId', 'getOrder')))
      case 'getCustomer':
        return normalizeCustomer(
          await this.api.getCustomer(requireId(params, 'customerId', 'getCustomer'))
        )
      case 'searchOrders': {
        const raw = await this.api.searchOrders({
          search: optionalStr(params.search),
          status: optionalStr(params.status),
          customer: optionalStr(params.customer),
          after: optionalStr(params.after)
        })
        return Array.isArray(raw) ? raw.map((o) => normalizeOrder(o)) : []
      }
      case 'refundOrder':
        return this.api.createRefund(requireId(params, 'orderId', 'refundOrder'), {
          amount: optionalStr(params.amount),
          lineItems: Array.isArray(params.lineItems) ? params.lineItems : undefined,
          // Conservative default: RECORD-ONLY unless the flow explicitly opts
          // into a gateway refund (spec §6.3).
          apiRefund: params.viaGateway === true
        })
      case 'cancelOrder':
        return this.api.updateOrder(requireId(params, 'orderId', 'cancelOrder'), {
          status: 'cancelled'
        })
      case 'updateShippingAddress':
        return this.api.updateOrder(requireId(params, 'orderId', 'updateShippingAddress'), {
          shipping: isObject(params.shipping) ? params.shipping : {}
        })
      case 'addOrderNote':
        return this.api.createOrderNote(requireId(params, 'orderId', 'addOrderNote'), {
          note: optionalStr(params.note) ?? '',
          customerNote: params.customerNote === true
        })
      default:
        throw new Error(
          `Unknown WooCommerce action "${actionId}" — the connector services getOrder, ` +
            `getCustomer, searchOrders, refundOrder, cancelOrder, updateShippingAddress, addOrderNote.`
        )
    }
  }

  // ── Trigger fan-out (spec §4.5) ─────────────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    let set = this.handlers.get(triggerId)
    if (!set) {
      set = new Set()
      this.handlers.set(triggerId, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  /**
   * Route a verified webhook event (from `wc-webhook-server`) to every handler
   * subscribed to its topic, as a `{ eventId, payload }` SeedEvent. This is the
   * ONLY path a trigger takes — it makes NO store calls (authority: spec §4.6).
   */
  deliver(event: WcWebhookEvent): void {
    const set = this.handlers.get(event.topic)
    if (!set || set.size === 0) return
    const seed = { eventId: event.deliveryId ?? this.newId(), payload: event.payload }
    for (const handler of set) {
      try {
        handler(seed)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        this.log(`woocommerce connector: handler for ${event.topic} failed — ${reason}`)
      }
    }
  }
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
