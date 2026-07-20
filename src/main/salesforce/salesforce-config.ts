import { checkBaseUrl } from '../net/ssrf-guard'
import type { SalesforceConfig } from '../../shared/salesforce'

/**
 * The `salesforce` block of config.json (spec §5, §8), parsed config-as-code and
 * validated at the boundary exactly like `parsePostHogConfig`: config.json is
 * user-edited, so only well-typed values are honored and any garbage DISABLES the
 * feature (returns `null`) rather than throwing. An absent/disabled block means
 * the connector never subscribes a poll — the opt-in posture localflow's "works
 * with no integration" guarantee relies on (spec §4.1).
 *
 * Secrets are NOT here: the JWT private key / consumer secret live in the keychain
 * (spec §8). This block holds only non-secret refs — the client id, the login /
 * instance URL, the integration username, the api version, the default sObject,
 * the poll cadence, and the environment. The login AND instance URLs are run
 * through the SHARED SSRF guard here so a private/loopback host disables the
 * feature at the config boundary (spec §4.4), not only at call time — the org's
 * My Domain is a user-supplied base URL, exactly the self-host case the guard
 * exists for.
 */

export function parseSalesforceConfig(raw: unknown): SalesforceConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const block = (raw as { salesforce?: unknown }).salesforce
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null

  const b = block as Record<string, unknown>
  if (b.enabled !== true) return null
  if (typeof b.clientId !== 'string' || b.clientId.length === 0) return null
  if (typeof b.loginUrl !== 'string' || b.loginUrl.length === 0) return null
  if (typeof b.environment !== 'number' || !Number.isInteger(b.environment)) return null
  if (b.environment < 1 || b.environment > 9) return null

  // The login URL is a user-supplied base URL → SSRF-guarded at the boundary.
  if (!checkBaseUrl(b.loginUrl, 'Salesforce login URL').ok) return null
  // If an instance URL is supplied, it too must pass (else it is taken from the
  // token response at auth time). A PRESENT-but-bad instance URL disables.
  if (typeof b.instanceUrl === 'string' && b.instanceUrl.length > 0) {
    if (!checkBaseUrl(b.instanceUrl, 'Salesforce instance URL').ok) return null
  }

  const config: SalesforceConfig = {
    enabled: true,
    clientId: b.clientId,
    loginUrl: b.loginUrl,
    environment: b.environment
  }
  if (typeof b.instanceUrl === 'string' && b.instanceUrl.length > 0) {
    config.instanceUrl = b.instanceUrl
  }
  if (typeof b.username === 'string' && b.username.length > 0) config.username = b.username
  if (typeof b.apiVersion === 'string' && b.apiVersion.length > 0) config.apiVersion = b.apiVersion
  if (typeof b.defaultObject === 'string' && b.defaultObject.length > 0) {
    config.defaultObject = b.defaultObject
  }
  if (typeof b.pollSeconds === 'number' && Number.isFinite(b.pollSeconds) && b.pollSeconds > 0) {
    config.pollSeconds = Math.min(Math.trunc(b.pollSeconds), 3600)
  }
  return config
}
