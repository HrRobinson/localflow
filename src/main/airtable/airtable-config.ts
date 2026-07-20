import type { AirtableConfig } from '../../shared/airtable'

/**
 * The `airtable` block of config.json (spec §5, §8), parsed config-as-code and
 * validated AT THE BOUNDARY exactly like `parsePostHogConfig`: config.json is
 * user-edited, so only well-typed values are honored and any garbage DISABLES the
 * feature (returns `null`) rather than throwing. An absent/disabled block means
 * the connector never subscribes a poll — the opt-in posture localflow's "works
 * with no integration" guarantee relies on (spec §7).
 *
 * Secrets are NOT here: the personal access token (and the phase-2 webhook MAC
 * secret) live in the keychain (spec §5). This block holds only non-secret refs —
 * the base id, table, view, webhook id, poll cadence, and environment. Airtable's
 * host is the FIXED cloud host, so there is no SSRF surface to guard here
 * (spec §7.2), unlike the PostHog/Woo self-host case.
 */
export function parseAirtableConfig(raw: unknown): AirtableConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const block = (raw as { airtable?: unknown }).airtable
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null

  const b = block as Record<string, unknown>
  if (b.enabled !== true) return null
  const baseId = coerceStr(b.baseId)
  const tableId = coerceStr(b.tableId)
  if (baseId === undefined || tableId === undefined) return null
  if (typeof b.environment !== 'number' || !Number.isInteger(b.environment)) return null
  if (b.environment < 1 || b.environment > 9) return null

  const config: AirtableConfig = {
    enabled: true,
    baseId,
    tableId,
    environment: b.environment
  }
  const viewId = coerceStr(b.viewId)
  if (viewId !== undefined) config.viewId = viewId
  const webhookId = coerceStr(b.webhookId)
  if (webhookId !== undefined) config.webhookId = webhookId
  if (typeof b.pollSeconds === 'number' && Number.isFinite(b.pollSeconds) && b.pollSeconds > 0) {
    config.pollSeconds = Math.min(Math.trunc(b.pollSeconds), 3600)
  }
  return config
}

/** A non-empty, trimmed string, or undefined (spec §11.7: table accepts id or name). */
function coerceStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed.length === 0 ? undefined : trimmed
}
