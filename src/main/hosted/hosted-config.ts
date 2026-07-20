import { INTEGRATION_IDS, type IntegrationId } from '../../shared/integrations'
import type { IngressUrl } from './hosted-control-client'

/**
 * Validate-at-the-boundary config for hosted ingress (design §4.5), mirroring the
 * connectors' config shape: NON-SECRET refs live in config.json under a `hosted`
 * key; the ACCOUNT TOKEN is a secret and lives ONLY in the keychain (never
 * config.json, never logged). A hand-edited token in config.json is dropped with
 * a legible notice, exactly like the integrations config-boundary notice.
 *
 * config.json is user-edited, so a malformed shape / non-https base URL returns a
 * legible rejection rather than throwing — the caller keeps hosted ingress off.
 */
export interface HostedConfig {
  /** Master switch. When false, the client never drains (opt-in default). */
  enabled: boolean
  /** The relay control-API base URL (https-only; validated here). */
  controlApiBaseUrl: string
  /** Cached non-secret refs so the UI can render provisioned URLs without a
   *  round-trip; the control API is the source of truth. */
  ingressUrls?: IngressUrl[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isIntegrationId = (v: unknown): v is IntegrationId =>
  typeof v === 'string' && (INTEGRATION_IDS as readonly string[]).includes(v)

/**
 * Parse + validate the `hosted` config entry. Returns a legible rejection for a
 * non-object block, a missing/malformed base URL, or a non-https base URL. A
 * hand-edited secret token in the block is dropped and reported via `notify`.
 */
export function parseHostedConfig(
  raw: unknown,
  notify?: (message: string) => void
): HostedConfig | { error: string } {
  if (!isObject(raw)) {
    return { error: 'The "hosted" config block is missing or is not an object.' }
  }

  // A secret must never live in config.json — drop a hand-edited token loudly.
  if ('accountToken' in raw || 'token' in raw) {
    notify?.(
      'a hosted account token was found in config.json and ignored — it belongs in the ' +
        'keychain (paste it in Settings › Hosted ingress), never in config.json. Remove it there.'
    )
  }

  const base = raw.controlApiBaseUrl
  if (typeof base !== 'string' || base.length === 0) {
    return {
      error:
        'Hosted ingress needs a "controlApiBaseUrl" — set the relay control-API URL ' +
        '(https://…) in the "hosted" config block.'
    }
  }
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return { error: `Hosted ingress "controlApiBaseUrl" is not a valid URL: "${base}".` }
  }
  if (url.protocol !== 'https:') {
    return {
      error:
        `Hosted ingress "controlApiBaseUrl" must be https (got "${base}") — ` +
        'a plaintext relay URL is refused so the account token is never sent in the clear.'
    }
  }

  const config: HostedConfig = {
    enabled: raw.enabled === true,
    controlApiBaseUrl: base
  }
  const ingressUrls = parseIngressUrls(raw.ingressUrls)
  if (ingressUrls.length > 0) config.ingressUrls = ingressUrls
  return config
}

/** Keep only well-formed cached ingress URLs; silently drop garbage entries (the
 *  control API is the source of truth, so a stale/garbage cache is non-fatal). */
function parseIngressUrls(raw: unknown): IngressUrl[] {
  if (!Array.isArray(raw)) return []
  const out: IngressUrl[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const { id, integration, url, createdAt } = item
    if (
      typeof id === 'string' &&
      id.length > 0 &&
      isIntegrationId(integration) &&
      typeof url === 'string' &&
      url.length > 0 &&
      typeof createdAt === 'string' &&
      createdAt.length > 0
    ) {
      out.push({ id, integration, url, createdAt })
    }
  }
  return out
}
