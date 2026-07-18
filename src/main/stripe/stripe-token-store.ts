import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Stripe secrets — a THIN wrapper over the hub's
 * `CredentialStore` (spec §4.2, §8): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext
 * restricted key / webhook secret is read at CALL TIME and NEVER stored on `this`,
 * logged, echoed, or placed in any IPC/context/error payload (the
 * never-render-secrets rule, §8). The stored key is a RESTRICTED key (`rk_…`),
 * least-privilege — never a full `sk_…`.
 */
export class StripeTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The `Authorization: Bearer <restrictedKey>` value — main-process-only. */
  restrictedKey(): string {
    return this.creds.revealForConnector('stripe', 'restrictedKey')
  }

  /** The webhook signing secret used to verify `Stripe-Signature` (§7). */
  webhookSecret(): string {
    return this.creds.revealForConnector('stripe', 'webhookSecret')
  }

  /** Presence probe for gating — never decrypts. */
  hasRestrictedKey(): boolean {
    return this.creds.has('stripe', 'restrictedKey')
  }
}
