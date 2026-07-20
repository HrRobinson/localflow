import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Intercom secrets — a THIN wrapper over the hub's
 * `CredentialStore` (spec §4.2, §8): the connector reuses the existing `safeStorage`
 * sidecar, it does not open a second keychain. `revealForConnector` is the sole
 * plaintext exit and is MAIN-PROCESS-ONLY; this store is named distinctly so a grep
 * test can assert no IPC/renderer caller. The plaintext access token / client secret
 * is read at CALL TIME and NEVER stored on `this`, logged, echoed, or placed in any
 * IPC/context/error payload (the never-render-secrets rule, §8).
 */
export class IntercomTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `Authorization: Bearer <accessToken>` value — main-process-only. */
  accessToken(): string {
    return this.creds.revealForConnector('intercom', 'accessToken')
  }

  /** The app client secret used to verify `X-Hub-Signature` (HMAC-SHA1, §7). */
  clientSecret(): string {
    return this.creds.revealForConnector('intercom', 'clientSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasAccessToken(): boolean {
    return this.creds.has('intercom', 'accessToken')
  }
}
