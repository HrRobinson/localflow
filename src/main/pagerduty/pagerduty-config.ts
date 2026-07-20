import type { IntegrationConfigEntry } from '../../shared/integrations'

/**
 * The non-secret `pagerduty` refs (spec §4.5, §5, §8). Most validation is FREE
 * via the hub's descriptor-driven `integration-config.ts`; this module holds only
 * PagerDuty-specific coercion — the `region` enum → the FIXED base URL (§4.5).
 * Because the base URL is chosen from a CLOSED set of PagerDuty-owned hosts, it is
 * never user-supplied and there is NO SSRF surface (a deliberate contrast with
 * GitHub/Woo). Secrets (`apiKey`, `webhookSecret`, `routingKey`) never appear
 * here — they live in the keychain.
 */

export type PagerDutyRegion = 'us' | 'eu'

/** region → fixed REST base URL (§4.5). A closed set; never user-supplied. */
export const PAGERDUTY_REST_BASE_URLS: Record<PagerDutyRegion, string> = {
  us: 'https://api.pagerduty.com',
  eu: 'https://api.eu.pagerduty.com'
}

/** The Events API v2 host is likewise fixed (deferred write path, §13.1). */
export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue'

export const DEFAULT_PAGERDUTY_REGION: PagerDutyRegion = 'us'

export interface PagerDutyConfig {
  /** Region enum → the fixed REST base URL (§4.5). Default `us`. */
  region: PagerDutyRegion
  /** The PagerDuty user REST mutations are attributed to (`From:` header, §8). */
  fromEmail: string
  /** localflow environment (1-9). */
  environment: number
  /** Default service id, e.g. "PXXXXXX". Optional; nodes may filter per-node. */
  serviceId?: string
  /** Default escalation policy id — used by `escalateIncident` when reassigning. */
  escalationPolicyId?: string
  /** The tunnel/relay ingress URL (§4.4); optional in MVP (manual webhooks). */
  webhookUrl?: string
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export function isPagerDutyRegion(v: unknown): v is PagerDutyRegion {
  return v === 'us' || v === 'eu'
}

/** The fixed REST base URL for a region (§4.5). */
export function baseUrlForRegion(region: PagerDutyRegion): string {
  return PAGERDUTY_REST_BASE_URLS[region]
}

/**
 * Build a typed `PagerDutyConfig` from the hub's parsed config entry, or `null`
 * when the required non-secret refs are absent (the connector then stays dormant
 * — the opt-in posture). The hub has already type-checked each field; this only
 * applies the region default and validates the region enum (an unknown region
 * falls back to the default rather than minting an SSRF-able URL).
 */
export function parsePagerDutyConfig(
  entry: IntegrationConfigEntry | undefined
): PagerDutyConfig | null {
  if (!entry) return null
  const values = entry.values
  if (!isNonEmptyString(values.fromEmail)) return null
  if (typeof values.environment !== 'number') return null

  const region = isPagerDutyRegion(values.region) ? values.region : DEFAULT_PAGERDUTY_REGION
  const cfg: PagerDutyConfig = {
    region,
    fromEmail: values.fromEmail.trim(),
    environment: values.environment
  }
  if (isNonEmptyString(values.serviceId)) cfg.serviceId = values.serviceId.trim()
  if (isNonEmptyString(values.escalationPolicyId)) {
    cfg.escalationPolicyId = values.escalationPolicyId.trim()
  }
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  return cfg
}
