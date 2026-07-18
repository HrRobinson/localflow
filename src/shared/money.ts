/**
 * localflow's cross-connector money vocabulary. Amounts are always in MAJOR
 * units (dollars, euros, yen) as a `number`, so conditions compare numerically
 * and consistently regardless of which connector produced them.
 *
 * Shopify/Woo already emit major-unit numbers (this formalizes that). Stripe,
 * GitHub Sponsors, and most billing APIs emit MINOR units (integer cents, or
 * whole yen for zero-decimal currencies) — `minorToMajor` converts those so
 * `stripe.refund.amount` and `shopify.order.total` live on the same scale.
 *
 * Currency-mismatch caveat (no FX): comparing two `Money.amount`s is only
 * meaningful when their `currency` matches. `minorToMajor` fixes the *scale*
 * mismatch (cents vs. dollars); it does NOT convert between currencies. A
 * condition comparing amounts across different `currency` values is comparing
 * unlike quantities — the condition authoring surface should compare `.currency`
 * first. This module makes same-currency comparisons correct; it deliberately
 * does not invent an FX rate.
 */

export interface Money {
  /** Amount in MAJOR units, e.g. 42.5 for $42.50. */
  amount: number
  /** ISO-4217 code, upper-case, e.g. 'USD', 'JPY', 'BHD'. */
  currency: string
}

/**
 * ISO-4217 currencies with ZERO minor-unit digits (no cents). Includes the
 * billing-sense zero-decimal set most payment APIs (Stripe) use.
 */
const ZERO_DECIMAL: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'HUF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF'
])

/** ISO-4217 currencies with THREE minor-unit digits. */
const THREE_DECIMAL: ReadonlySet<string> = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND'
])

/**
 * Number of decimal places for a currency (ISO-4217 minor-unit exponent).
 * Unlisted currencies default to 2. Covers the exceptions that matter:
 *  - 0 decimals: JPY, KRW, VND, CLP, ISK, HUF (billing sense), XOF, XAF, …
 *  - 3 decimals: BHD, KWD, OMR, JOD, TND, IQD, LYD, …
 */
export function currencyDecimals(currency: string): number {
  const c = currency.toUpperCase()
  if (ZERO_DECIMAL.has(c)) return 0
  if (THREE_DECIMAL.has(c)) return 3
  return 2
}

/**
 * Convert a MINOR-unit integer (Stripe cents / whole yen) to MAJOR units using
 * the currency's decimal count. `minorToMajor(4200, 'USD') === 42`,
 * `minorToMajor(4200, 'JPY') === 4200`, `minorToMajor(4200, 'BHD') === 4.2`.
 * Non-finite input → 0 (mirrors the never-throw normalization discipline).
 */
export function minorToMajor(minor: number, currency: string): number {
  if (!Number.isFinite(minor)) return 0
  return minor / 10 ** currencyDecimals(currency)
}

/** Build a normalized `Money` from a minor-unit integer (Stripe path). */
export function moneyFromMinor(minor: number, currency: string): Money {
  return { amount: minorToMajor(minor, currency), currency: currency.toUpperCase() }
}
