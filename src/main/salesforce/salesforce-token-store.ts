import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Salesforce auth credential — a THIN wrapper over
 * the hub's `CredentialStore` (spec §4.2, §8): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext
 * secret is read at CALL TIME and NEVER stored on `this`, logged, echoed, or
 * placed in any IPC/context/error payload (the never-render-secrets rule, spec
 * §8). Which secret the live auth fork reads is decided in `salesforce-auth`:
 * `clientSecret` for client-credentials (MVP), `privateKey` for JWT-bearer.
 */
export class SalesforceTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The connected-app consumer secret — main-process-only (client-creds fork). */
  clientSecret(): string {
    return this.creds.revealForConnector('salesforce', 'clientSecret')
  }

  /** The connected-app JWT private key (PEM) — main-process-only (JWT fork). */
  privateKey(): string {
    return this.creds.revealForConnector('salesforce', 'privateKey')
  }

  /** Presence probe for gating — never decrypts. */
  hasClientSecret(): boolean {
    return this.creds.has('salesforce', 'clientSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasPrivateKey(): boolean {
    return this.creds.has('salesforce', 'privateKey')
  }
}
