import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Shopify secrets — a THIN wrapper over the hub's
 * `CredentialStore` (spec §4.2, §8): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext
 * token/secret is read at CALL TIME and NEVER stored on `this`, logged, echoed,
 * or placed in any IPC/context/error payload (the never-render-secrets rule).
 */
export class ShopifyTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `X-Shopify-Access-Token` value — main-process-only. */
  adminToken(): string {
    return this.creds.revealForConnector('shopify', 'adminToken')
  }

  /** The webhook signing secret used to verify `X-Shopify-Hmac-Sha256`. */
  webhookSecret(): string {
    return this.creds.revealForConnector('shopify', 'webhookSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasAdminToken(): boolean {
    return this.creds.has('shopify', 'adminToken')
  }
}
