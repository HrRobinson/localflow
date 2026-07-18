import type { IntegrationConfigEntry } from '../../shared/integrations'

/**
 * The non-secret `sentry` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary);
 * this module holds only Sentry-specific coercion — slug normalization and the
 * `baseUrl` default (`https://sentry.io`). Secrets (`authToken`, `webhookSecret`)
 * never appear here — they live in the keychain (`sentry-token-store.ts`).
 */

export const DEFAULT_SENTRY_BASE_URL = 'https://sentry.io'

export interface SentryConfig {
  orgSlug: string
  /** Optional; scopes reads/searches and the project-scoped resolve (§2.2). */
  projectSlug?: string
  /** Self-host origin; defaults to `https://sentry.io`. SSRF-guarded at call time. */
  baseUrl: string
  /** localflow environment (1-9). */
  environment: number
  /** The tunnel/relay ingress URL (§4.4); optional in MVP (manual webhooks). */
  webhookUrl?: string
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Trim + lowercase a slug (Sentry slugs are lowercase, hyphenated). */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Strip a trailing slash from a base URL so path joins are clean. */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

/**
 * Build a typed `SentryConfig` from the hub's parsed config entry, or `null` when
 * the required non-secret refs are absent (the connector then stays dormant — the
 * opt-in posture). The hub has already type-checked each field; this only applies
 * Sentry coercion and the baseUrl default.
 */
export function parseSentryConfig(entry: IntegrationConfigEntry | undefined): SentryConfig | null {
  if (!entry) return null
  const values = entry.values
  if (!isNonEmptyString(values.orgSlug)) return null
  if (typeof values.environment !== 'number') return null
  const cfg: SentryConfig = {
    orgSlug: normalizeSlug(values.orgSlug),
    baseUrl: isNonEmptyString(values.baseUrl)
      ? normalizeBaseUrl(values.baseUrl)
      : DEFAULT_SENTRY_BASE_URL,
    environment: values.environment
  }
  if (isNonEmptyString(values.projectSlug)) cfg.projectSlug = normalizeSlug(values.projectSlug)
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  return cfg
}
