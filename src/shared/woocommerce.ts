/**
 * Shared WooCommerce-integration types (spec §4.2 shared row, §7). Kept in
 * `shared` because both the main-process connector and any future renderer
 * surface need the same vocabulary. No secrets ever live in these shapes — the
 * consumer key/secret and the webhook signing secret stay in the keychain
 * (spec §5); config.json and these types carry only references and non-secret ids.
 *
 * The field PATHS (`order.*` / `customer.*`) are deliberately ALIGNED with the
 * Shopify sibling so a single flow template targets either platform (spec §7).
 * The value SETS diverge (WC `status` enum; guest orders with no `customer.id`).
 */

/** The two triggers (ids aligned with Shopify; `order.refundRequested` ingress
 *  diverges — derived in-flow, spec §6.1). */
export type WcTriggerId = 'order.created' | 'order.refundRequested'

/** The seven actions (three reads + four gated mutations), ids aligned with
 *  Shopify (spec §7). */
export type WcActionId =
  | 'getOrder'
  | 'getCustomer'
  | 'searchOrders'
  | 'refundOrder'
  | 'cancelOrder'
  | 'updateShippingAddress'
  | 'addOrderNote'

/**
 * The normalized order view written to `order.*` context fields (spec §7).
 * `total` is a NUMBER and `status` an enum string so a condition layer compares
 * them correctly (spec's "normalize so numeric total/enum status compare").
 */
export interface WcOrderView {
  id: string
  total: number
  currency: string
  status: string
  email: string
}

/**
 * The normalized customer view written to `customer.*` context fields (spec §7).
 * `id` may be ABSENT for guest orders (`customer_id: 0`, spec §2.5) — `email` is
 * the stable identity key in that case.
 */
export interface WcCustomerView {
  id?: string
  email: string
  name: string
}

/** The payload seeded into `context['order.created']` when a trigger fires
 *  (spec §4.5): the `order.*` / `customer.*` fields `wc-normalize` produced. */
export interface WcTriggerPayload {
  order: WcOrderView
  customer: WcCustomerView
}
