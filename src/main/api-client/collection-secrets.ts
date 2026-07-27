import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { SecretBackend } from '../integrations/credential-store'

/**
 * DEDICATED keychain store for API-client collection credentials (design §7).
 * It is its OWN tiny store (not `CredentialStore`) for the same reason
 * `HostedTokenStore` is: a collection is not an integration and must not leak
 * into descriptor/registry enumeration, and a separate sidecar file makes
 * collision with the `http` per-node keyspace structurally impossible rather
 * than carefully avoided.
 *
 * Mirrors `CredentialStore`'s discipline: the `SecretBackend` seam keeps it
 * unit-testable, writes are atomic (temp + rename), and `revealSecret` is the
 * sole plaintext exit and MUST stay MAIN-PROCESS-ONLY — no `preload`/renderer
 * code may call it. A decrypt failure surfaces the legible "re-enter it"
 * error, never the ciphertext.
 */

/**
 * Build the composite sidecar key for one collection's secret. LENGTH-PREFIXES
 * the `collectionId` segment so the boundary is unambiguous even when either
 * segment contains `:` — the same reasoning as `httpSecretKey`.
 */
export function collectionSecretKey(collectionId: string, secretRef: string): string {
  return `${collectionId.length}:${collectionId}:${secretRef}`
}

type SecretMap = Record<string, string>

export class CollectionSecretStore {
  private readonly backend: SecretBackend
  private readonly file: string
  private map: SecretMap

  constructor(deps: { backend: SecretBackend; file: string }) {
    this.backend = deps.backend
    this.file = deps.file
    this.map = load(deps.file)
  }

  available(): boolean {
    return this.backend.isEncryptionAvailable()
  }

  /** Presence only — never decrypts. */
  has(collectionId: string, secretRef: string): boolean {
    return collectionSecretKey(collectionId, secretRef) in this.map
  }

  set(collectionId: string, secretRef: string, value: string): void {
    if (!this.available()) {
      throw new Error(
        "Secure storage isn't available on this machine (safeStorage: encryption " +
          `unavailable). The "${secretRef}" credential can't be saved, so this ` +
          'collection stays unusable.'
      )
    }
    let ciphertext: Buffer
    try {
      ciphertext = this.backend.encryptString(value)
    } catch (err) {
      throw new Error(
        `Couldn't encrypt the "${secretRef}" credential — ${(err as Error).message}. ` +
          'Nothing was stored; try again.',
        { cause: err }
      )
    }
    this.persist({
      ...this.map,
      [collectionSecretKey(collectionId, secretRef)]: ciphertext.toString('base64')
    })
  }

  /** Clear one ref, or every ref for a collection when `secretRef` is omitted. */
  clear(collectionId: string, secretRef?: string): void {
    const next: SecretMap = {}
    const prefix = `${collectionId.length}:${collectionId}:`
    for (const [k, v] of Object.entries(this.map)) {
      const exact = secretRef !== undefined ? collectionSecretKey(collectionId, secretRef) : null
      if (exact !== null ? k === exact : k.startsWith(prefix)) continue
      next[k] = v
    }
    this.persist(next)
  }

  /**
   * MAIN-PROCESS-ONLY plaintext exit. MUST NEVER be called from `preload` or
   * renderer code, or be routed to IPC, a log, or a peek. Named to grep
   * distinctly.
   */
  revealSecret(collectionId: string, secretRef: string): string {
    const b64 = this.map[collectionSecretKey(collectionId, secretRef)]
    if (b64 === undefined) {
      throw new Error(
        `No credential "${secretRef}" is stored for this collection — set it in the API client.`
      )
    }
    try {
      return this.backend.decryptString(Buffer.from(b64, 'base64'))
    } catch (err) {
      throw new Error(
        `The stored "${secretRef}" credential can't be decrypted (safeStorage: ` +
          `${(err as Error).message}) — re-enter it in the API client.`,
        { cause: err }
      )
    }
  }

  /** Atomic write (temp + rename) so a failed write leaves no half-written blob. */
  private persist(next: SecretMap): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't save the credential — ${(err as Error).message}. Nothing was stored; try again.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage sidecar is the normal first-run case — start empty. */
function load(file: string): SecretMap {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: SecretMap = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}
