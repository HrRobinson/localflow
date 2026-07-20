import type { WcCustomerView, WcOrderView, WcTriggerPayload } from '../../shared/woocommerce'

/**
 * PURE map from raw WooCommerce `wc/v3` JSON to the pinned `order.*` /
 * `customer.*` context fields (spec §4, §7). Side-effect-free and defensive —
 * it never trusts the store's shape by type, mirroring `status-map.ts`'s purity
 * so every mapping is exhaustively unit-testable with no live store (spec §9).
 *
 * Two WooCommerce data-shape realities are handled here, not by the caller:
 *  - `total` arrives as a STRING (`"129.95"`) → coerced to a NUMBER so a
 *    condition layer compares it numerically (spec §7).
 *  - GUEST orders carry `customer_id: 0` and no customer record — `customer.id`
 *    is OMITTED and `billing.email` is the stable identity key (spec §2.5).
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** Coerce WC's stringly-typed money to a finite number; garbage/absent → 0. WC
 *  reports MAJOR units, so the result conforms to `Money.amount` semantics
 *  (`src/shared/money.ts`) — no minor-unit conversion needed. */
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** WC uses `customer_id: 0` for guests — treat only a non-zero id as present. */
function customerId(raw: unknown): string | undefined {
  if (typeof raw === 'number') return raw > 0 ? String(raw) : undefined
  if (typeof raw === 'string' && raw.length > 0 && raw !== '0') return raw
  return undefined
}

function fullName(first: unknown, last: unknown): string {
  return [str(first), str(last)].filter((s) => s.length > 0).join(' ')
}

/** Normalize a raw WC order into the `order.*` + `customer.*` context payload. */
export function normalizeOrder(raw: unknown): WcTriggerPayload {
  const o = isObject(raw) ? raw : {}
  const billing = isObject(o.billing) ? o.billing : {}
  const email = str(billing.email)

  const order: WcOrderView = {
    id: str(o.id),
    total: num(o.total),
    currency: str(o.currency),
    status: str(o.status),
    email
  }

  const customer: WcCustomerView = {
    email,
    name: fullName(billing.first_name, billing.last_name)
  }
  const id = customerId(o.customer_id)
  if (id !== undefined) customer.id = id

  return { order, customer }
}

/** Normalize a raw WC customer record into the `customer.*` context view. */
export function normalizeCustomer(raw: unknown): WcCustomerView {
  const c = isObject(raw) ? raw : {}
  const view: WcCustomerView = {
    email: str(c.email),
    name: fullName(c.first_name, c.last_name)
  }
  const id = customerId(c.id)
  if (id !== undefined) view.id = id
  return view
}
