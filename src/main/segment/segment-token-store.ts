import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the Segment secrets — a THIN wrapper over the hub's
 * `CredentialStore` (spec §4.2, §8): the connector reuses the existing
 * `safeStorage` sidecar, it does not open a second keychain. `revealForConnector`
 * is the sole plaintext exit and is MAIN-PROCESS-ONLY; this store is named
 * distinctly so a grep test can assert no IPC/renderer caller. The plaintext
 * shared secret / write key is read at CALL TIME and NEVER stored on `this`,
 * logged, echoed, or placed in any IPC/context/error payload (§8).
 */
export class SegmentTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** The HMAC key that verifies the `X-Signature` header (§8) — main-only. */
  sharedSecret(): string {
    return this.creds.revealForConnector('segment', 'sharedSecret')
  }

  /** The HTTP Tracking API Basic-auth username (§8) — main-only. */
  writeKey(): string {
    return this.creds.revealForConnector('segment', 'writeKey')
  }

  /** Presence probe for per-capability gating (a write needs the key) — never decrypts. */
  hasWriteKey(): boolean {
    return this.creds.has('segment', 'writeKey')
  }
}
