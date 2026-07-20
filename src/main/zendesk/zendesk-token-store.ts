import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Zendesk secrets — a THIN wrapper over the hub's
 * `CredentialStore` (spec §4.2, §8): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext API
 * token / webhook secret is read at CALL TIME and NEVER stored on `this`, logged,
 * echoed, or placed in any IPC/context/error payload (the never-render-secrets
 * rule, §8). The `agentEmail` is NOT secret (it is half of a Basic-auth pair whose
 * secret half is the token) — it lives in config, not here.
 */
export class ZendeskTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The API token — the secret half of HTTP Basic `{agentEmail}/token:{apiToken}`
   *  (§8). Main-process-only. */
  apiToken(): string {
    return this.creds.revealForConnector('zendesk', 'apiToken')
  }

  /** The webhook signing secret used to verify `X-Zendesk-Webhook-Signature` (§7). */
  webhookSecret(): string {
    return this.creds.revealForConnector('zendesk', 'webhookSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasApiToken(): boolean {
    return this.creds.has('zendesk', 'apiToken')
  }
}
