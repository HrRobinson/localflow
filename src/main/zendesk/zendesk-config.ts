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
  /** saiife environment (1-9). */
  environment: number
  /** The tunnel/relay ingress URL (§4.5); optional in MVP (manual webhooks). */
  webhookUrl?: string
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * A valid Zendesk subdomain is a SINGLE DNS label: 1–63 chars, lowercase
 * alphanumerics with optional internal hyphens. The subdomain is interpolated
 * into `https://{subdomain}.zendesk.com/…`, so anything else (a dotted host, a
 * path, a `#` fragment, whitespace, embedded credentials) is host confusion —
 * `attacker.example.com#` would make `new URL(...).host` the attacker and leak
 * the Basic-auth API token. Such a value is REJECTED, never interpolated.
 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** True when `s` is a single DNS label safe to interpolate as a host component. */
export function isValidSubdomain(s: string): boolean {
  return DNS_LABEL.test(s)
}

/**
 * Normalize a subdomain: accept a bare `your-co`, a full `your-co.zendesk.com`, or
 * a pasted `https://your-co.zendesk.com/agent/…` and reduce it to `your-co`. Every
 * API call and the webhook origin key off this, so a pasted URL must not leak in.
 *
 * The result is NOT trusted as-is — `parseZendeskConfig` runs it through
 * `isValidSubdomain`. We deliberately do not split on `/` unconditionally: a bare
 * `foo/bar` (no `.zendesk.com`) stays `foo/bar` so the DNS-label check rejects it
 * rather than silently keeping `foo`.
 */
export function normalizeSubdomain(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '') // strip a pasted scheme
  // Strip the `.zendesk.com` host suffix AND everything after it (path / query /
  // fragment). `\b` prevents `foo.zendesk.company` from collapsing to `foo`.
  s = s.replace(/\.zendesk\.com\b.*$/, '')
  return s
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
  // Host-confusion guard (SSRF, §4.2): the subdomain is interpolated into
  // `https://{subdomain}.zendesk.com/…`, so a non-DNS-label result disables the
  // connector (null) rather than sending the Basic-auth token to an attacker host.
  if (!isValidSubdomain(subdomain)) return null
  const cfg: ZendeskConfig = {
    subdomain,
    agentEmail: values.agentEmail,
    environment: values.environment
  }
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  return cfg
}
