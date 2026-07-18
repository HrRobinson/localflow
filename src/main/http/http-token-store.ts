import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the generic HTTP connector's PER-NODE secrets — a
 * THIN wrapper over the hub's `CredentialStore` (spec §7). Unlike a fixed-vendor
 * store, `http` has no single per-id secret: every node stores its own under the
 * COMPOSITE key `http:<nodeId>:<secretRef>`, which reuses `CredentialStore`
 * verbatim by making the `key` argument composite (NO signature change — §7.2).
 * `revealForConnector` is the sole plaintext exit and is MAIN-PROCESS-ONLY; this
 * store is named distinctly (`*-token-store.ts`) so the grep test can assert no
 * IPC/renderer caller. The plaintext secret is read at CALL TIME and NEVER stored
 * on `this`, logged, echoed, or placed in any IPC/context/error payload.
 */
export class HttpTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** Reveal a node's secret under the composite key `http:<nodeId>:<secretRef>`
   *  — main-process-only. The value is never retained. */
  revealNodeSecret(nodeId: string, secretRef: string): string {
    return this.creds.revealForConnector('http', `${nodeId}:${secretRef}`)
  }

  /** Presence probe for a node's secret — never decrypts. */
  hasNodeSecret(nodeId: string, secretRef: string): boolean {
    return this.creds.has('http', `${nodeId}:${secretRef}`)
  }
}
