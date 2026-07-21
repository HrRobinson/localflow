import type { IntegrationConfigEntry } from '../../shared/integrations'

/**
 * The non-secret `discord` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary);
 * this module holds only Discord-specific coercion — the ingress `mode` default
 * and snowflake normalization. The ONE secret (the bot token) never appears here
 * — it lives in the keychain (`discord-token-store.ts`). NOTE the asymmetry vs
 * Slack: the interaction `publicKey` is a PUBLIC Ed25519 key (for `mode: 'http'`
 * verification), NOT a secret, so it lives in config (§5, §8).
 */

export type DiscordMode = 'gateway' | 'http'

export interface DiscordConfig {
  /** The single server (guild) the connector operates in (snowflake). */
  guildId: string
  /** The channel approvals + notifications post to by default (snowflake). */
  defaultChannel: string
  /** Application id — needed to register `/saiife` + address callbacks. */
  applicationId?: string
  /** Application PUBLIC key — Ed25519 verify key for `mode: 'http'` only. */
  publicKey?: string
  /** Ingress mode; defaults to 'gateway' (the zero-ingress path, §2.1). */
  mode: DiscordMode
  /** saiife environment (1-9). */
  environment: number
  /** The public ingress URL for `mode: 'http'` only (§4.4). */
  interactionsUrl?: string
}

export const DEFAULT_MODE: DiscordMode = 'gateway'

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Coerce a raw `mode` value to a known `DiscordMode`, defaulting to gateway. */
export function normalizeMode(raw: unknown): DiscordMode {
  return raw === 'http' ? 'http' : DEFAULT_MODE
}

/**
 * Build a typed `DiscordConfig` from the hub's parsed config entry, or `null`
 * when the required non-secret refs are absent (the connector then stays dormant
 * — the opt-in posture). The hub has already type-checked each field; this only
 * applies Discord coercion and the mode default.
 */
export function parseDiscordConfig(
  entry: IntegrationConfigEntry | undefined
): DiscordConfig | null {
  if (!entry) return null
  const values = entry.values
  if (!isNonEmptyString(values.guildId)) return null
  if (!isNonEmptyString(values.defaultChannel)) return null
  if (typeof values.environment !== 'number') return null
  const cfg: DiscordConfig = {
    guildId: values.guildId.trim(),
    defaultChannel: values.defaultChannel.trim(),
    mode: normalizeMode(values.mode),
    environment: values.environment
  }
  if (isNonEmptyString(values.applicationId)) cfg.applicationId = values.applicationId.trim()
  if (isNonEmptyString(values.publicKey)) cfg.publicKey = values.publicKey.trim()
  if (isNonEmptyString(values.interactionsUrl)) cfg.interactionsUrl = values.interactionsUrl
  return cfg
}
