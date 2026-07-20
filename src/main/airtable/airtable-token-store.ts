import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Airtable secrets — a THIN wrapper over the hub's
 * `CredentialStore` (spec §5, §7.1): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext
 * token/secret is read at CALL TIME and NEVER stored on `this`, logged, echoed,
 * or placed in any IPC/context/error payload (the never-render-secrets rule).
 */
export class AirtableTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `Authorization: Bearer` personal access token — main-process-only. */
  personalAccessToken(): string {
    return this.creds.revealForConnector('airtable', 'personalAccessToken')
  }

  /** The one-time webhook MAC secret used to verify the phase-2 signed ping. */
  webhookMacSecret(): string {
    return this.creds.revealForConnector('airtable', 'webhookMacSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasPersonalAccessToken(): boolean {
    return this.creds.has('airtable', 'personalAccessToken')
  }
}
