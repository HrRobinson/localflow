import { checkStoreUrl } from './wc-ssrf'

/**
 * The `woocommerce` block of config.json (spec §4.2, §7), parsed config-as-code
 * and validated at the boundary exactly like `parseLinearConfig`: config.json is
 * user-edited, so only well-typed values are honored and any garbage DISABLES
 * the feature (returns `null`) rather than throwing. An absent/disabled block
 * means the connector never starts a webhook server and never subscribes — the
 * opt-in posture saiife's "works with no integration" guarantee relies on
 * (spec §4.1).
 *
 * Secrets are NOT here: the consumer key/secret and the webhook signing secret
 * live in the keychain (spec §5). This block holds only the non-secret store URL
 * ref and the environment. The store URL is additionally run through the SSRF
 * guard here so a private/loopback/non-https URL disables the feature at the
 * config boundary (spec §5.1), not only at call time.
 */

export interface WoocommerceConfig {
  enabled: true
  /** The self-hosted store base URL — https + SSRF-safe (spec §5.1). */
  storeUrl: string
  /** Which saiife environment (1-9) hosts WooCommerce work. */
  environment: number
}

export function parseWoocommerceConfig(raw: unknown): WoocommerceConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const block = (raw as { woocommerce?: unknown }).woocommerce
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null

  const b = block as Record<string, unknown>
  if (b.enabled !== true) return null
  if (typeof b.storeUrl !== 'string' || b.storeUrl.length === 0) return null
  // Reject a non-https / private / loopback store URL at the config boundary.
  if (!checkStoreUrl(b.storeUrl).ok) return null
  if (typeof b.environment !== 'number' || !Number.isInteger(b.environment)) return null
  if (b.environment < 1 || b.environment > 9) return null

  return { enabled: true, storeUrl: b.storeUrl, environment: b.environment }
}
