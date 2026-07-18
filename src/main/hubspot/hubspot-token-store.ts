import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the HubSpot secrets — a THIN wrapper over the hub's
 * `CredentialStore` (§4): the connector reuses the existing `safeStorage`
 * sidecar, it does not open a second keychain. `revealForConnector` is the sole
 * plaintext exit and is MAIN-PROCESS-ONLY; this store is named distinctly so a
 * grep test can assert no IPC/renderer caller. The plaintext token/secret is
 * read at CALL TIME and NEVER stored on `this`, logged, echoed, or placed in any
 * IPC/context/error payload (the never-render-secrets rule).
 *
 * Two DISTINCT secrets (§5.5): the private-app Bearer token authorizes read/
 * write; the webhook app CLIENT SECRET signs `X-HubSpot-Signature-v3`.
 */
export class HubSpotTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `Authorization: Bearer` private-app token — main-process-only. */
  privateAppToken(): string {
    return this.creds.revealForConnector('hubspot', 'privateAppToken')
  }

  /** The webhook app client secret used to verify `X-HubSpot-Signature-v3`. */
  webhookClientSecret(): string {
    return this.creds.revealForConnector('hubspot', 'webhookClientSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasPrivateAppToken(): boolean {
    return this.creds.has('hubspot', 'privateAppToken')
  }
}
