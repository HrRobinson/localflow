import { checkBaseUrl } from '../net/ssrf-guard'
import type { PostHogConfig } from '../../shared/posthog'

/**
 * The `posthog` block of config.json (spec §5, §8), parsed config-as-code and
 * validated at the boundary exactly like `parseWoocommerceConfig`: config.json
 * is user-edited, so only well-typed values are honored and any garbage DISABLES
 * the feature (returns `null`) rather than throwing. An absent/disabled block
 * means the connector never subscribes a poll — the opt-in posture localflow's
 * "works with no integration" guarantee relies on (spec §4.1).
 *
 * Secrets are NOT here: the personal API key lives in the keychain (spec §8).
 * This block holds only non-secret refs — the PUBLIC project key (`phc_…`), the
 * host, the poll cadence, and the environment. The host is additionally run
 * through the SHARED SSRF guard here so a private/loopback host disables the
 * feature at the config boundary (spec §4.4), not only at call time — UNLESS
 * `allowInsecureLocalHost` opts a self-host-on-LAN in (the reviewed escape hatch).
 */

export function parsePostHogConfig(raw: unknown): PostHogConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const block = (raw as { posthog?: unknown }).posthog
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null

  const b = block as Record<string, unknown>
  if (b.enabled !== true) return null
  if (typeof b.projectApiKey !== 'string' || b.projectApiKey.length === 0) return null
  if (typeof b.host !== 'string' || b.host.length === 0) return null
  if (typeof b.environment !== 'number' || !Number.isInteger(b.environment)) return null
  if (b.environment < 1 || b.environment > 9) return null

  const allowInsecureLocalHost = b.allowInsecureLocalHost === true
  // Reject a non-https / private / loopback host at the config boundary, unless
  // a self-host-on-LAN was explicitly opted in.
  const check = checkBaseUrl(b.host, 'PostHog host')
  if (!check.ok && !(allowInsecureLocalHost && isLocalHostReason(check.reason))) return null

  const config: PostHogConfig = {
    enabled: true,
    projectApiKey: b.projectApiKey,
    host: b.host,
    environment: b.environment
  }
  if (typeof b.pollSeconds === 'number' && Number.isFinite(b.pollSeconds) && b.pollSeconds > 0) {
    config.pollSeconds = Math.min(Math.trunc(b.pollSeconds), 3600)
  }
  if (allowInsecureLocalHost) config.allowInsecureLocalHost = true
  return config
}

function isLocalHostReason(reason: string): boolean {
  return /loopback|127\.0\.0\.1|localhost|::1/i.test(reason)
}
