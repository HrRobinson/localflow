import type { IntegrationConfigEntry } from '../../shared/integrations'
import { DEFAULT_API_VERSION } from './shopify-admin'

/**
 * The non-secret `shopify` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary);
 * this module holds only Shopify-specific coercion — shop-domain normalization
 * and the pinned default API version. Secrets (`adminToken`, `webhookSecret`)
 * never appear here — they live in the keychain (`shopify-token-store.ts`).
 */

export interface ShopifyConfig {
  /** `your-store.myshopify.com` — normalized (no scheme/path, lowercased). */
  shopDomain: string
  /** Admin API version; defaults to the pinned `DEFAULT_API_VERSION`. */
  apiVersion: string
  /** localflow environment (1-9). */
  environment: number
  /** The tunnel/relay ingress URL (§4.4); optional in MVP (manual webhooks). */
  webhookUrl?: string
}

/** Strip scheme/path and lowercase a store domain to its bare host. */
export function normalizeShopDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Build a typed `ShopifyConfig` from the hub's parsed config entry, or `null`
 * when the required non-secret refs are absent (the connector then stays
 * dormant — the opt-in posture). The hub has already type-checked each field;
 * this only applies Shopify coercion and the version default.
 */
export function parseShopifyConfig(entry: IntegrationConfigEntry | undefined): ShopifyConfig | null {
  if (!entry) return null
  const values = entry.values
  if (!isNonEmptyString(values.shopDomain)) return null
  if (typeof values.environment !== 'number') return null
  const cfg: ShopifyConfig = {
    shopDomain: normalizeShopDomain(values.shopDomain),
    apiVersion: isNonEmptyString(values.apiVersion) ? values.apiVersion : DEFAULT_API_VERSION,
    environment: values.environment
  }
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  return cfg
}
