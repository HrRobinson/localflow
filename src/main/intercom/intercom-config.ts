import type { IntegrationConfigEntry } from '../../shared/integrations'
import { type IntercomRegion } from '../../shared/intercom'
import { baseUrlForRegion } from './intercom-api'

/**
 * The non-secret `intercom` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary); this
 * module holds only Intercom-specific coercion — the `region` → base-URL derivation
 * and the region default. Secrets (`accessToken`, `clientSecret`) never appear here
 * — they live in the keychain (`intercom-token-store.ts`). Mirrors `stripe-config.ts`.
 */

export interface IntercomConfig {
  /** Intercom hosting region; selects the API base URL. Defaults 'us'. */
  region: IntercomRegion
  /** saiife environment (1-9). */
  environment: number
  /** The tunnel/relay ingress URL (§4.4); optional in MVP (manual webhooks). */
  webhookUrl?: string
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function coerceRegion(v: unknown): IntercomRegion {
  return v === 'eu' || v === 'au' ? v : 'us'
}

/**
 * Build a typed `IntercomConfig` from the hub's parsed config entry, or `null` when
 * the required non-secret refs are absent (the connector then stays dormant — the
 * opt-in posture). The hub has already type-checked each field; this only applies
 * Intercom coercion and the region default.
 */
export function parseIntercomConfig(
  entry: IntegrationConfigEntry | undefined
): IntercomConfig | null {
  if (!entry) return null
  const values = entry.values
  if (typeof values.environment !== 'number') return null
  const cfg: IntercomConfig = {
    region: coerceRegion(values.region),
    environment: values.environment
  }
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  return cfg
}

/** The API base URL for a parsed config (region → host, §8). */
export function baseUrlForConfig(cfg: IntercomConfig): string {
  return baseUrlForRegion(cfg.region)
}
