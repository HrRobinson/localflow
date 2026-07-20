import type { IntegrationConfigEntry } from '../../shared/integrations'
import { DEFAULT_API_VERSION } from './stripe-client'

/**
 * The non-secret `stripe` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary);
 * this module holds only Stripe-specific coercion — the pinned default API
 * version and the `mode` derivation. Secrets (`restrictedKey`, `webhookSecret`)
 * never appear here — they live in the keychain (`stripe-token-store.ts`).
 */

export type StripeMode = 'test' | 'live'

export interface StripeConfig {
  /** `acct_…` — non-secret display / future-Connect ref (may be ""). */
  accountId: string
  /** Stripe API version; defaults to the pinned `DEFAULT_API_VERSION`. */
  apiVersion: string
  /** localflow environment (1-9). */
  environment: number
  /** The tunnel/relay ingress URL (§4.5); optional in MVP (manual webhooks). */
  webhookUrl?: string
  /** test | live; defaults from the key prefix at reveal time when omitted (§5). */
  mode?: StripeMode
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Build a typed `StripeConfig` from the hub's parsed config entry, or `null` when
 * the required non-secret refs are absent (the connector then stays dormant — the
 * opt-in posture). The hub has already type-checked each field; this only applies
 * Stripe coercion and the version default.
 */
export function parseStripeConfig(entry: IntegrationConfigEntry | undefined): StripeConfig | null {
  if (!entry) return null
  const values = entry.values
  if (typeof values.environment !== 'number') return null
  const cfg: StripeConfig = {
    accountId: isNonEmptyString(values.accountId) ? values.accountId : '',
    apiVersion: isNonEmptyString(values.apiVersion) ? values.apiVersion : DEFAULT_API_VERSION,
    environment: values.environment
  }
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  if (values.mode === 'test' || values.mode === 'live') cfg.mode = values.mode
  return cfg
}

/** Derive the mode from a restricted-key prefix when `mode` config is absent (§5). */
export function modeFromKeyPrefix(restrictedKey: string): StripeMode | undefined {
  if (restrictedKey.startsWith('rk_test_') || restrictedKey.startsWith('sk_test_')) return 'test'
  if (restrictedKey.startsWith('rk_live_') || restrictedKey.startsWith('sk_live_')) return 'live'
  return undefined
}
