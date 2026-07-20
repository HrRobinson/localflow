import type { IntegrationConfigEntry } from '../../shared/integrations'

/**
 * The non-secret `zendesk` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary); this
 * module holds only Zendesk-specific coercion — subdomain normalization (strip a
 * pasted `https://…zendesk.com`). Secrets (`apiToken`, `webhookSecret`) never
 * appear here — they live in the keychain (`zendesk-token-store.ts`).
 */

export interface ZendeskConfig {
  /** `your-co` in `your-co.zendesk.com` — the per-tenant identity (§5). */
  subdomain: string
  /** The email half of the Basic-auth pair; the identity replies are attributed
   *  to. Non-secret. */
  agentEmail: string
  /** localflow environment (1-9). */
  environment: number
  /** The tunnel/relay ingress URL (§4.5); optional in MVP (manual webhooks). */
  webhookUrl?: string
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Normalize a subdomain: accept a bare `your-co`, a full `your-co.zendesk.com`, or
 * a pasted `https://your-co.zendesk.com/agent/…` and reduce it to `your-co`. Every
 * API call and the webhook origin key off this, so a pasted URL must not leak in.
 */
export function normalizeSubdomain(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^https?:\/\//i, '')
  s = s.split('/')[0] // drop any path
  s = s.replace(/\.zendesk\.com$/i, '')
  return s.toLowerCase()
}

/**
 * Build a typed `ZendeskConfig` from the hub's parsed config entry, or `null` when
 * a required non-secret ref is absent (the connector then stays dormant — the
 * opt-in posture). The hub has already type-checked each field; this only applies
 * Zendesk coercion.
 */
export function parseZendeskConfig(
  entry: IntegrationConfigEntry | undefined
): ZendeskConfig | null {
  if (!entry) return null
  const values = entry.values
  if (typeof values.environment !== 'number') return null
  if (!isNonEmptyString(values.subdomain) || !isNonEmptyString(values.agentEmail)) return null
  const subdomain = normalizeSubdomain(values.subdomain)
  if (subdomain.length === 0) return null
  const cfg: ZendeskConfig = {
    subdomain,
    agentEmail: values.agentEmail,
    environment: values.environment
  }
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  return cfg
}
