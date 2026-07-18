/**
 * The Shopify **GraphQL Admin API** client — the SOLE place any Shopify
 * request/response shape lives (the API-version blast radius, spec §4.1). The
 * `ShopifyApi` interface is the seam: `ShopifyAdminApi` wraps a `GraphqlTransport`
 * (the live HTTP call, DEFERRED — see `deferredLiveTransport`), and tests inject
 * a `MockShopifyApi`, so NO live GraphQL is ever performed in CI (spec §12).
 *
 * Read methods return the RAW GraphQL node; `shopify-normalize.ts` maps it to the
 * pinned context shape. Mutation methods return a small localflow-shaped result
 * that becomes the action node's context output. Failure follows the pinned
 * convention: every error path REJECTS with a legible, actionable message that
 * carries the real Shopify cause — and NEVER the admin token (spec §8, §11).
 */

// ── Raw GraphQL node shapes (isolated here) ──────────────────────────────────

export interface RawMoney {
  amount?: string | null
  currencyCode?: string | null
}

export interface RawCustomerNode {
  id?: string | null
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  displayName?: string | null
  /** Shopify `numberOfOrders` is an UnsignedInt64 — serialized as a string. */
  numberOfOrders?: string | number | null
  amountSpent?: RawMoney | null
}

export interface RawOrderNode {
  id?: string | null
  name?: string | null
  email?: string | null
  createdAt?: string | null
  closed?: boolean | null
  cancelledAt?: string | null
  displayFinancialStatus?: string | null
  displayFulfillmentStatus?: string | null
  totalPriceSet?: { shopMoney?: RawMoney | null } | null
  lineItems?: { nodes?: unknown[] | null } | null
  /** Fraud/risk assessments — drives the derived `flagged` field (§6.1). */
  risk?: { assessments?: { riskLevel?: string | null }[] | null } | null
  customer?: RawCustomerNode | null
}

// ── Mutation inputs / results (localflow-shaped) ─────────────────────────────

export interface RefundCreateInput {
  orderId: string
  amount?: number
  currency?: string
  restock?: boolean
}
export interface RefundCreateResult {
  refundId: string
  amount: number
}

export interface OrderCancelInput {
  orderId: string
  reason?: string
  refund?: boolean
  restock?: boolean
}
export interface OrderCancelResult {
  orderId: string
}

export interface OrderUpdateInput {
  orderId: string
  note?: string
  shippingAddress?: Record<string, unknown>
}
export interface OrderUpdateResult {
  orderId: string
}

// ── The seam ─────────────────────────────────────────────────────────────────

export interface ShopifyApi {
  order(id: string): Promise<RawOrderNode>
  customer(id: string): Promise<RawCustomerNode>
  orders(params: { query: string }): Promise<{ nodes: RawOrderNode[]; count: number }>
  refundCreate(input: RefundCreateInput): Promise<RefundCreateResult>
  orderCancel(input: OrderCancelInput): Promise<OrderCancelResult>
  orderUpdate(input: OrderUpdateInput): Promise<OrderUpdateResult>
}

// ── GraphQL transport (the live HTTP seam) ───────────────────────────────────

export interface GraphqlThrottleStatus {
  currentlyAvailable?: number
  restoreRate?: number
  maximumAvailable?: number
}

export interface GraphqlEnvelope {
  data?: Record<string, unknown> | null
  errors?: { message: string; extensions?: { code?: string } }[]
  extensions?: {
    cost?: { requestedQueryCost?: number; throttleStatus?: GraphqlThrottleStatus }
  }
}

export interface GraphqlResult {
  /** HTTP status — 401 (bad token) / 402 / 423 are distinguished from a 200 body. */
  status: number
  body: GraphqlEnvelope
}

export type GraphqlTransport = (req: {
  query: string
  variables: Record<string, unknown>
}) => Promise<GraphqlResult>

/** Pinned Admin API version — bumping is a ONE-FILE change (spec §4.1, §11). */
export const DEFAULT_API_VERSION = '2025-07'

const MAX_THROTTLE_RETRIES = 3

/** Reduce a Shopify GID (`gid://shopify/Order/42`) to its bare id (`42`). */
function bareId(gid: string): string {
  const slash = gid.lastIndexOf('/')
  return slash === -1 ? gid : gid.slice(slash + 1)
}

class ThrottledError extends Error {
  constructor(readonly throttle?: GraphqlThrottleStatus) {
    super('throttled')
  }
}

/**
 * The live client. Written against `GraphqlTransport` so the HTTP wiring (the
 * `X-Shopify-Access-Token` header, `fetch`) is a deferred, injected concern and
 * every response-shape decision is unit-tested with a fake transport.
 */
export class ShopifyAdminApi implements ShopifyApi {
  private readonly transport: GraphqlTransport
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxThrottleRetries: number

  constructor(deps: {
    transport: GraphqlTransport
    sleep?: (ms: number) => Promise<void>
    maxThrottleRetries?: number
  }) {
    this.transport = deps.transport
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxThrottleRetries = deps.maxThrottleRetries ?? MAX_THROTTLE_RETRIES
  }

  async order(id: string): Promise<RawOrderNode> {
    const data = await this.execute(ORDER_QUERY, { id: orderGid(id) })
    const node = data.order
    if (!node) throw notFound('order', id)
    return node as RawOrderNode
  }

  async customer(id: string): Promise<RawCustomerNode> {
    const data = await this.execute(CUSTOMER_QUERY, { id: customerGid(id) })
    const node = data.customer
    if (!node) throw notFound('customer', id)
    return node as RawCustomerNode
  }

  async orders(params: { query: string }): Promise<{ nodes: RawOrderNode[]; count: number }> {
    const data = await this.execute(ORDERS_QUERY, { query: params.query })
    const conn = (data.orders ?? {}) as { nodes?: RawOrderNode[] }
    const nodes = Array.isArray(conn.nodes) ? conn.nodes : []
    return { nodes, count: nodes.length }
  }

  async refundCreate(input: RefundCreateInput): Promise<RefundCreateResult> {
    const refundInput: Record<string, unknown> = { orderId: orderGid(input.orderId) }
    if (input.amount !== undefined) {
      refundInput.transactions = [
        { amount: String(input.amount), kind: 'REFUND', orderId: orderGid(input.orderId) }
      ]
    }
    const data = await this.execute(REFUND_CREATE_MUTATION, { input: refundInput })
    const payload = requirePayload(data, 'refundCreate')
    const refund = (payload.refund ?? {}) as {
      id?: string
      totalRefundedSet?: { shopMoney?: RawMoney }
    }
    return {
      refundId: refund.id ? bareId(refund.id) : '',
      amount: Number(refund.totalRefundedSet?.shopMoney?.amount ?? input.amount ?? 0)
    }
  }

  async orderCancel(input: OrderCancelInput): Promise<OrderCancelResult> {
    const data = await this.execute(ORDER_CANCEL_MUTATION, {
      orderId: orderGid(input.orderId),
      reason: (input.reason ?? 'OTHER').toUpperCase(),
      refund: input.refund ?? false,
      restock: input.restock ?? false
    })
    requirePayload(data, 'orderCancel')
    return { orderId: input.orderId }
  }

  async orderUpdate(input: OrderUpdateInput): Promise<OrderUpdateResult> {
    const orderFields: Record<string, unknown> = { id: orderGid(input.orderId) }
    if (input.note !== undefined) orderFields.note = input.note
    if (input.shippingAddress !== undefined) orderFields.shippingAddress = input.shippingAddress
    const data = await this.execute(ORDER_UPDATE_MUTATION, { input: orderFields })
    requirePayload(data, 'orderUpdate')
    return { orderId: input.orderId }
  }

  /** Send one request with cost-aware throttle backoff, then unwrap `data`. */
  private async execute(
    query: string,
    variables: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      let result: GraphqlResult
      try {
        result = await this.transport({ query, variables })
      } catch (err) {
        throw new Error(
          `Couldn't reach the Shopify Admin API — ${(err as Error).message}. Check the store domain and your connection.`,
          { cause: err }
        )
      }
      try {
        return this.unwrap(result)
      } catch (err) {
        if (err instanceof ThrottledError && attempt < this.maxThrottleRetries) {
          await this.sleep(backoffMs(err.throttle))
          continue
        }
        if (err instanceof ThrottledError) {
          const avail = err.throttle?.currentlyAvailable ?? 0
          const rate = err.throttle?.restoreRate ?? 50
          throw new Error(
            `Shopify throttled the request (cost bucket empty: ${avail} available, ${rate}/s restore) — retry in a moment.`,
            { cause: err }
          )
        }
        throw err
      }
    }
  }

  /** Classify the envelope into `data`, a legible rejection, or a throttle retry. */
  private unwrap(result: GraphqlResult): Record<string, unknown> {
    const { status, body } = result
    if (status === 401) {
      throw new Error(
        'Shopify rejected the admin token (401 Unauthorized) — the token was revoked or is wrong; re-enter it in Settings.'
      )
    }
    const errors = body.errors ?? []
    const throttled = errors.find((e) => e.extensions?.code === 'THROTTLED')
    if (throttled) throw new ThrottledError(body.extensions?.cost?.throttleStatus)
    const denied = errors.find(
      (e) => e.extensions?.code === 'ACCESS_DENIED' || /access denied/i.test(e.message)
    )
    if (denied || status === 402 || status === 403) {
      const detail = (denied ?? errors[0])?.message ?? `HTTP ${status}`
      throw new Error(
        `Shopify refused the request — the custom app is missing a required scope: ${detail}. Add it in the app's config.`
      )
    }
    if (errors.length > 0) {
      throw new Error(`Shopify Admin API error: ${errors.map((e) => e.message).join('; ')}.`)
    }
    if (!body.data) {
      throw new Error(`Shopify Admin API returned no data (HTTP ${status}).`)
    }
    return body.data
  }
}

/** A mutation payload with a non-empty `userErrors[]` REJECTS verbatim (§6.2). */
function requirePayload(data: Record<string, unknown>, field: string): Record<string, unknown> {
  const payload = data[field]
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`Shopify returned no '${field}' result — the mutation may have been rejected.`)
  }
  const userErrors = (payload as { userErrors?: { field?: string[]; message?: string }[] })
    .userErrors
  if (Array.isArray(userErrors) && userErrors.length > 0) {
    const detail = userErrors
      .map((e) => (e.field?.length ? `${e.field.join('.')}: ${e.message}` : e.message))
      .join('; ')
    throw new Error(`Shopify refused '${field}': ${detail}.`)
  }
  return payload as Record<string, unknown>
}

function notFound(kind: 'order' | 'customer', id: string): Error {
  return new Error(`Shopify has no ${kind} '${id}' (it may be from another store or was deleted).`)
}

function orderGid(id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/Order/${id}`
}
function customerGid(id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/Customer/${id}`
}

/** Cost-aware backoff: wait long enough to restore the requested cost. */
function backoffMs(throttle?: GraphqlThrottleStatus): number {
  const rate = throttle?.restoreRate ?? 50
  return Math.min(Math.max(1000 / Math.max(rate, 1), 200), 5000)
}

/**
 * The live HTTP transport is DEFERRED (spec: no live GraphQL in the foundation
 * slice). Wiring it means a `fetch` to `https://<shop>/admin/api/<version>/
 * graphql.json` with the keychain `X-Shopify-Access-Token` header. Until then a
 * registered connector using this transport fails LOUDLY rather than silently.
 */
export function deferredLiveTransport(shopDomain: string): GraphqlTransport {
  return () =>
    Promise.reject(
      new Error(
        `The live Shopify Admin API transport for '${shopDomain}' isn't wired yet — ` +
          `real GraphQL calls land in a later phase. The connector, normalizer, and ` +
          `webhook receiver are in place and mock-tested.`
      )
    )
}

// ── The test seam ────────────────────────────────────────────────────────────

export interface MockShopifyData {
  orders?: Record<string, RawOrderNode>
  customers?: Record<string, RawCustomerNode>
  searchResults?: RawOrderNode[]
  refund?: RefundCreateResult
  refundError?: string
  cancelError?: string
  updateError?: string
}

/**
 * The mock seam tests inject in place of `ShopifyAdminApi` (spec §12). It returns
 * seeded raw nodes, records every mutation call for assertions, and rejects
 * seeded `userErrors`-style failures verbatim — exercising the connector and the
 * engine offline, with no credentials and no network.
 */
export class MockShopifyApi implements ShopifyApi {
  readonly calls = {
    refundCreate: [] as RefundCreateInput[],
    orderCancel: [] as OrderCancelInput[],
    orderUpdate: [] as OrderUpdateInput[]
  }

  constructor(private readonly data: MockShopifyData) {}

  order(id: string): Promise<RawOrderNode> {
    const node = this.data.orders?.[id]
    if (!node) return Promise.reject(notFound('order', id))
    return Promise.resolve(node)
  }

  customer(id: string): Promise<RawCustomerNode> {
    const node = this.data.customers?.[id]
    if (!node) return Promise.reject(notFound('customer', id))
    return Promise.resolve(node)
  }

  orders(_params: { query: string }): Promise<{ nodes: RawOrderNode[]; count: number }> {
    void _params
    const nodes = this.data.searchResults ?? []
    return Promise.resolve({ nodes, count: nodes.length })
  }

  refundCreate(input: RefundCreateInput): Promise<RefundCreateResult> {
    this.calls.refundCreate.push(input)
    if (this.data.refundError) {
      return Promise.reject(new Error(`Shopify refused 'refundCreate': ${this.data.refundError}.`))
    }
    return Promise.resolve(this.data.refund ?? { refundId: 'r1', amount: input.amount ?? 0 })
  }

  orderCancel(input: OrderCancelInput): Promise<OrderCancelResult> {
    this.calls.orderCancel.push(input)
    if (this.data.cancelError) {
      return Promise.reject(new Error(`Shopify refused 'orderCancel': ${this.data.cancelError}.`))
    }
    return Promise.resolve({ orderId: input.orderId })
  }

  orderUpdate(input: OrderUpdateInput): Promise<OrderUpdateResult> {
    this.calls.orderUpdate.push(input)
    if (this.data.updateError) {
      return Promise.reject(new Error(`Shopify refused 'orderUpdate': ${this.data.updateError}.`))
    }
    return Promise.resolve({ orderId: input.orderId })
  }
}

// ── Queries / mutations (all Shopify shapes isolated in this file) ───────────

const ORDER_FIELDS = `
  id
  name
  email
  createdAt
  closed
  cancelledAt
  displayFinancialStatus
  displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) { nodes { id } }
  risk { assessments { riskLevel } }
  customer { id email firstName lastName displayName }
`

const ORDER_QUERY = `query localflowOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`

const ORDERS_QUERY = `query localflowOrders($query: String!) {
  orders(first: 25, query: $query) { nodes { ${ORDER_FIELDS} } }
}`

const CUSTOMER_QUERY = `query localflowCustomer($id: ID!) {
  customer(id: $id) {
    id email firstName lastName displayName numberOfOrders
    amountSpent { amount currencyCode }
  }
}`

const REFUND_CREATE_MUTATION = `mutation localflowRefund($input: RefundInput!) {
  refundCreate(input: $input) {
    refund { id totalRefundedSet { shopMoney { amount currencyCode } } }
    userErrors { field message }
  }
}`

const ORDER_CANCEL_MUTATION = `mutation localflowCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
  orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
    userErrors { field message }
  }
}`

const ORDER_UPDATE_MUTATION = `mutation localflowUpdate($input: OrderInput!) {
  orderUpdate(input: $input) {
    order { id }
    userErrors { field message }
  }
}`
