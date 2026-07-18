/**
 * WooCommerce store-URL SSRF guard — now a thin delegate over the shared guard
 * in `../net/ssrf-guard`. The behavior (and every reason string) is identical:
 * `checkStoreUrl(raw)` is `checkBaseUrl(raw, 'Store URL')`, and `blockedIpRange`
 * is re-exported unchanged. Kept as a stable import surface so existing Woo
 * consumers and tests (`wc-ssrf.test.ts`) are unaffected.
 */

import { checkBaseUrl, blockedIpRange } from '../net/ssrf-guard'
import type { UrlCheck } from '../net/ssrf-guard'

export type StoreUrlCheck = UrlCheck

export { blockedIpRange }

/** Validate the literal WooCommerce store URL — `checkBaseUrl` with the
 *  'Store URL' label so the reasons stay byte-identical to the originals. */
export function checkStoreUrl(raw: string): StoreUrlCheck {
  return checkBaseUrl(raw, 'Store URL')
}
