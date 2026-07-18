import type { CredentialStore } from '../integrations/credential-store'

/**
 * Keychain-backed access to the generic HTTP connector's PER-NODE secrets — a
 * THIN wrapper over the hub's `CredentialStore` (spec §7). Unlike a fixed-vendor
 * store, `http` has no single per-id secret: every node stores its own under a
 * COMPOSITE key built from `nodeId` and `secretRef`, which reuses
 * `CredentialStore` verbatim by making the `key` argument composite (NO
 * signature change — §7.2). `revealForConnector` is the sole plaintext exit and
 * is MAIN-PROCESS-ONLY; this store is named distinctly (`*-token-store.ts`) so
 * the grep test can assert no IPC/renderer caller. The plaintext secret is read
 * at CALL TIME and NEVER stored on `this`, logged, echoed, or placed in any
 * IPC/context/error payload.
 */

/**
 * Build the composite keychain key for one node's secret. LENGTH-PREFIXES the
 * `nodeId` segment so the boundary between `nodeId` and `secretRef` is
 * unambiguous even when either segment itself contains `:` — a naive
 * `${nodeId}:${secretRef}` join lets two different pairs collide on the same
 * entry (e.g. `nodeId:"orders"` + `secretRef:"shopify:webhookSecret"` and
 * `nodeId:"orders:shopify"` + `secretRef:"webhookSecret"` both join to
 * `"orders:shopify:webhookSecret"`). Prefixing `nodeId.length` fixes the
 * boundary: the two examples above become `"6:orders:shopify:webhookSecret"`
 * and `"14:orders:shopify:webhookSecret"` — distinct, because a `nodeId` of a
 * different length can never produce the same length prefix.
 */
export function httpSecretKey(nodeId: string, secretRef: string): string {
  return `${nodeId.length}:${nodeId}:${secretRef}`
}

export class HttpTokenStore {
  constructor(private readonly creds: CredentialStore) {}

  /** Reveal a node's secret under the collision-safe composite key
   *  (`httpSecretKey`) — main-process-only. The value is never retained. */
  revealNodeSecret(nodeId: string, secretRef: string): string {
    return this.creds.revealForConnector('http', httpSecretKey(nodeId, secretRef))
  }

  /** Presence probe for a node's secret — never decrypts. */
  hasNodeSecret(nodeId: string, secretRef: string): boolean {
    return this.creds.has('http', httpSecretKey(nodeId, secretRef))
  }
}
