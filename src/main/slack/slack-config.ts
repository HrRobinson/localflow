import type { IntegrationConfigEntry } from '../../shared/integrations'

/**
 * The non-secret `slack` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary);
 * this module holds only Slack-specific coercion — the ingress `mode` default
 * and channel normalization. Secrets (`botToken`, `appToken`, `signingSecret`)
 * never appear here — they live in the keychain (`slack-token-store.ts`).
 */

export type SlackMode = 'socket' | 'events'

export interface SlackConfig {
  /** The channel approvals + notifications post to by default (id or #name). */
  defaultChannel: string
  /** Ingress mode; defaults to 'socket' (the zero-ingress path, §2.1). */
  mode: SlackMode
  /** saiife environment (1-9). */
  environment: number
  /** The public ingress URL for `mode: 'events'` only (§4.4). */
  eventsUrl?: string
}

export const DEFAULT_MODE: SlackMode = 'socket'

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Coerce a raw `mode` value to a known `SlackMode`, defaulting to socket. */
export function normalizeMode(raw: unknown): SlackMode {
  return raw === 'events' ? 'events' : DEFAULT_MODE
}

/**
 * Build a typed `SlackConfig` from the hub's parsed config entry, or `null` when
 * the required non-secret refs are absent (the connector then stays dormant —
 * the opt-in posture). The hub has already type-checked each field; this only
 * applies Slack coercion and the mode default.
 */
export function parseSlackConfig(entry: IntegrationConfigEntry | undefined): SlackConfig | null {
  if (!entry) return null
  const values = entry.values
  if (!isNonEmptyString(values.defaultChannel)) return null
  if (typeof values.environment !== 'number') return null
  const cfg: SlackConfig = {
    defaultChannel: values.defaultChannel.trim(),
    mode: normalizeMode(values.mode),
    environment: values.environment
  }
  if (isNonEmptyString(values.eventsUrl)) cfg.eventsUrl = values.eventsUrl
  return cfg
}
