import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Sentry secrets — a THIN wrapper over the hub's
 * `CredentialStore` (spec §4.2, §5): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext
 * token/secret is read at CALL TIME and NEVER stored on `this`, logged, echoed,
 * or placed in any IPC/context/error payload (the never-render-secrets rule).
 */
export class SentryTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `Authorization: Bearer` value — main-process-only. */
  authToken(): string {
    return this.creds.revealForConnector('sentry', 'authToken')
  }

  /** The webhook Client Secret used to verify `Sentry-Hook-Signature`. */
  webhookSecret(): string {
    return this.creds.revealForConnector('sentry', 'webhookSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasAuthToken(): boolean {
    return this.creds.has('sentry', 'authToken')
  }
}
