import type { RawCustomerNode, RawMoney, RawOrderNode } from './shopify-admin'
import type {
  ShopifyCustomerContext,
  ShopifyFinancialStatus,
  ShopifyFulfillmentStatus,
  ShopifyOrderContext,
  ShopifyOrderStatus,
  ShopifyTriggerId,
  ShopifyTriggerPayload
} from '../../shared/shopify'

/**
 * PURE normalization (spec §6.3, §10) — the correctness boundary the conditions
 * track depends on. A raw Shopify GraphQL node (or a raw webhook body) becomes
 * the PINNED context/trigger shape: GIDs reduced to bare ids, money coerced to a
 * `number` (so `order.total gt 100` compares numerically, not lexically), status
 * enums lowercased to exact `eq`/`ne` values, absent-customer → empty strings.
 * Never throws — a sparse/garbage node normalizes to safe defaults so a
 * malformed read never crashes a run (mirrors `status-map.ts` / `state-machine.ts`).
 */

/** Reduce a Shopify GID (`gid://shopify/Order/42`) to its bare id (`42`). */
function bareId(gid: string | null | undefined): string {
  if (typeof gid !== 'string' || gid.length === 0) return ''
  const slash = gid.lastIndexOf('/')
  return slash === -1 ? gid : gid.slice(slash + 1)
}

/** Coerce a Shopify money string/number to a Number; garbage → 0. */
function moneyToNumber(money: RawMoney | null | undefined): number {
  const n = Number(money?.amount ?? 0)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const FINANCIAL: Record<string, ShopifyFinancialStatus> = {
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  PAID: 'paid',
  PARTIALLY_PAID: 'partially_paid',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  VOIDED: 'voided'
}

const FULFILLMENT: Record<string, ShopifyFulfillmentStatus> = {
  UNFULFILLED: 'unfulfilled',
  PARTIALLY_FULFILLED: 'partial',
  PARTIAL: 'partial',
  FULFILLED: 'fulfilled',
  RESTOCKED: 'restocked'
}

function orderStatus(node: RawOrderNode): ShopifyOrderStatus {
  if (node.cancelledAt) return 'cancelled'
  if (node.closed) return 'closed'
  return 'open'
}

/** High-risk / manual-review derivation (§6.1): any HIGH assessment flags it. */
function isFlagged(node: RawOrderNode): boolean {
  const assessments = node.risk?.assessments
  if (!Array.isArray(assessments)) return false
  return assessments.some((a) => (a.riskLevel ?? '').toUpperCase() === 'HIGH')
}

function customerName(node: RawCustomerNode): string {
  const display = str(node.displayName).trim()
  if (display.length > 0) return display
  return `${str(node.firstName)} ${str(node.lastName)}`.trim()
}

export function normalizeOrder(node: RawOrderNode): ShopifyOrderContext {
  const customer = node.customer ?? null
  return {
    order: {
      id: bareId(node.id),
      name: str(node.name),
      total: moneyToNumber(node.totalPriceSet?.shopMoney),
      currency: str(node.totalPriceSet?.shopMoney?.currencyCode),
      status: orderStatus(node),
      financialStatus: FINANCIAL[str(node.displayFinancialStatus).toUpperCase()] ?? 'pending',
      fulfillmentStatus:
        FULFILLMENT[str(node.displayFulfillmentStatus).toUpperCase()] ?? 'unfulfilled',
      email: str(node.email),
      createdAt: str(node.createdAt),
      flagged: isFlagged(node),
      lineItemCount: Array.isArray(node.lineItems?.nodes) ? node.lineItems!.nodes!.length : 0
    },
    customer: {
      id: bareId(customer?.id),
      email: str(customer?.email),
      name: customer ? customerName(customer) : ''
    }
  }
}

export function normalizeCustomer(node: RawCustomerNode): ShopifyCustomerContext {
  const ordersCount = Number(node.numberOfOrders ?? 0)
  return {
    customer: {
      id: bareId(node.id),
      email: str(node.email),
      name: customerName(node),
      ordersCount: Number.isFinite(ordersCount) ? ordersCount : 0,
      totalSpent: moneyToNumber(node.amountSpent),
      currency: str(node.amountSpent?.currencyCode)
    }
  }
}

// ── Webhook body → trigger payload (§6.1) ────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The order id a webhook body carries: `id` (orders/*) or `order_id` (returns/*). */
function webhookOrderId(raw: Record<string, unknown>): string {
  const id = raw.id ?? raw.order_id
  if (typeof id === 'number') return String(id)
  if (typeof id === 'string' && id.length > 0) return bareId(id)
  return ''
}

/**
 * Normalize a raw (untrusted) webhook body into a `ShopifyTriggerPayload`, or
 * `null` when the topic is unsupported or the body has no usable order id (so no
 * run is ever seeded on garbage — spec §4.4). Risk derivation is a skeleton: the
 * body's own `flagged`/risk hint, pending the real fraud-field mapping (§6.1).
 */
export function webhookToPayload(topic: string, raw: unknown): ShopifyTriggerPayload | null {
  if (!isObj(raw)) return null
  if (topic !== 'orders/create' && topic !== 'returns/request') return null
  const orderId = webhookOrderId(raw)
  if (orderId.length === 0) return null
  const email = raw.email ?? (isObj(raw.customer) ? raw.customer.email : undefined)
  const payload: ShopifyTriggerPayload = {
    orderId,
    flagged: raw.flagged === true,
    topic
  }
  if (typeof email === 'string' && email.length > 0) payload.email = email
  return payload
}

/**
 * Which pinned trigger ids a verified topic + payload fires. `orders/create`
 * additionally fires `order.flagged` when the payload is high-risk; an
 * unsupported topic fires nothing (§6.1).
 */
export function triggersForTopic(topic: string, payload: ShopifyTriggerPayload): ShopifyTriggerId[] {
  if (topic === 'orders/create') {
    return payload.flagged ? ['order.created', 'order.flagged'] : ['order.created']
  }
  if (topic === 'returns/request') return ['order.refundRequested']
  return []
}
