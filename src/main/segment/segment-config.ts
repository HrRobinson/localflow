import { checkBaseUrl } from '../net/ssrf-guard'
import type { IntegrationConfigEntry } from '../../shared/integrations'

/**
 * The non-secret `segment` refs (spec §4.2, §5). Most validation is FREE via the
 * hub's descriptor-driven `integration-config.ts` (validate-at-the-boundary);
 * this module holds only Segment-specific coercion — the default webhook path and
 * the region data-plane URL normalization. Secrets (`sharedSecret`, `writeKey`)
 * never appear here — they live in the keychain (`segment-token-store.ts`).
 */

/** Default Tracking API base (US). EU workspaces override with `dataPlaneUrl`. */
export const DEFAULT_DATA_PLANE_URL = 'https://api.segment.io'
export const DEFAULT_WEBHOOK_PATH = '/segment/webhook'

export interface SegmentConfig {
  /** saiife environment (1-9). */
  environment: number
  /** The ingress path the tunnel/relay forwards to; defaults to `/segment/webhook`. */
  webhookPath: string
  /** The tunnel/relay ingress URL (§4.4); optional in MVP (manual destination URL). */
  webhookUrl?: string
  /** Tracking API region base; defaults to the US `DEFAULT_DATA_PLANE_URL`. */
  dataPlaneUrl: string
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Strip a trailing slash so `${dataPlaneUrl}/v1/track` never doubles up. */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Resolve the data-plane base URL under the SHARED SSRF guard (§4.4). The
 * `writeKey` is sent to `${dataPlaneUrl}/v1/…` once the live transport lands, so a
 * user-supplied base is exactly the self-host case the guard exists for: a
 * private/loopback/link-local/cloud-metadata host, or a plain-`http://` (auth in
 * the clear) URL, must never reach the write path. A failing or absent value is
 * coerced to the trusted US default — matching how this file drops other invalid
 * values — so the write can only ever target Segment.
 *
 * NOTE (live-cut): the live transport in `segment-client.ts` MUST re-run
 * `checkBaseUrl` on the resolved host at request time (post-DNS `blockedIpRange`),
 * exactly as Salesforce does, to close a DNS-rebind between parse and dial.
 */
function safeDataPlaneUrl(raw: unknown): string {
  if (!isNonEmptyString(raw)) return DEFAULT_DATA_PLANE_URL
  const trimmed = normalizeBase(raw)
  if (!checkBaseUrl(trimmed, 'Segment data-plane URL').ok) return DEFAULT_DATA_PLANE_URL
  return trimmed
}

/**
 * Build a typed `SegmentConfig` from the hub's parsed config entry, or `null`
 * when the required non-secret ref (`environment`) is absent (the connector then
 * stays dormant — the opt-in posture). The hub has already type-checked each
 * field; this only applies Segment coercion and defaults.
 */
export function parseSegmentConfig(
  entry: IntegrationConfigEntry | undefined
): SegmentConfig | null {
  if (!entry) return null
  const values = entry.values
  if (typeof values.environment !== 'number') return null
  const cfg: SegmentConfig = {
    environment: values.environment,
    webhookPath: isNonEmptyString(values.webhookPath) ? values.webhookPath : DEFAULT_WEBHOOK_PATH,
    dataPlaneUrl: safeDataPlaneUrl(values.dataPlaneUrl)
  }
  if (isNonEmptyString(values.webhookUrl)) cfg.webhookUrl = values.webhookUrl
  return cfg
}
