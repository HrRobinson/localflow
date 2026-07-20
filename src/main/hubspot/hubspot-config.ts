/**
 * The `hubspot` block of config.json (§4, §8), parsed config-as-code and
 * validated at the boundary exactly like `parseWoocommerceConfig`: config.json
 * is user-edited, so only well-typed values are honored and any garbage DISABLES
 * the feature (returns `null`) rather than throwing. An absent/disabled block
 * means the connector never subscribes and the descriptor's `status()` reports
 * `needs-config` — the opt-in posture localflow's "works with no integration"
 * guarantee relies on.
 *
 * Secrets are NOT here: the private-app token and the webhook app client secret
 * live in the keychain (§4). This block holds only NON-SECRET refs — portal id,
 * CRM api base, environment, and the public ingress webhook URL the v3 verifier
 * composes the signed URI from (§5.3).
 */

const DEFAULT_API_BASE = 'https://api.hubapi.com'

export interface HubspotConfig {
  enabled: true
  /** CRM API base (defaults to api.hubapi.com when unset/garbage). */
  apiBase: string
  /** Which localflow environment (1-9) hosts HubSpot work. */
  environment: number
  /** Non-secret portal (hub) id ref, when supplied. */
  portalId?: string
  /** The public tunnel/relay URL HubSpot delivers to — the v3 signed URI base
   *  (§5.3). Required for the trigger path; reads/writes don't need it. */
  webhookUrl?: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function parseHubspotConfig(raw: unknown): HubspotConfig | null {
  if (!isObject(raw)) return null
  const block = raw.hubspot
  if (!isObject(block)) return null

  if (block.enabled !== true) return null
  if (typeof block.environment !== 'number' || !Number.isInteger(block.environment)) return null
  if (block.environment < 1 || block.environment > 9) return null

  const config: HubspotConfig = {
    enabled: true,
    apiBase: optionalStr(block.apiBase) ?? DEFAULT_API_BASE,
    environment: block.environment
  }
  const portalId = optionalStr(block.portalId)
  if (portalId) config.portalId = portalId
  const webhookUrl = optionalStr(block.webhookUrl)
  if (webhookUrl) config.webhookUrl = webhookUrl
  return config
}
