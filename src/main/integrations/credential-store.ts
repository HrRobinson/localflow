import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { IntegrationId } from '../../shared/integrations'

/**
 * The ONLY module in localflow that touches raw integration secret material.
 * Get/set/clear behind Electron `safeStorage` (injected as `SecretBackend` so
 * tests never touch the real OS keychain). It never returns a secret across an
 * IPC boundary, into a log, or into config.json — the renderer-facing surface
 * is presence booleans; `revealForConnector` is the sole plaintext exit and is
 * MAIN-PROCESS-ONLY (a grep test asserts it has zero IPC/renderer callers).
 *
 * Secrets persist to a `safeStorage`-encrypted sidecar file in userData (a JSON
 * map of `"<id>:<key>" -> base64(ciphertext)`), never config.json. This is the
 * first `safeStorage` use in the codebase; it sets the pattern the connector
 * token-stores will adopt.
 */

/** Structural subset of Electron's `safeStorage` — the seam tests replace. */
export interface SecretBackend {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

type SecretMap = Record<string, string>

const keyOf = (id: IntegrationId, key: string): string => `${id}:${key}`

export class CredentialStore {
  private readonly backend: SecretBackend
  private readonly file: string
  private map: SecretMap

  constructor(deps: { backend: SecretBackend; file: string }) {
    this.backend = deps.backend
    this.file = deps.file
    this.map = load(deps.file)
  }

  /** `safeStorage.isEncryptionAvailable()` — whether secrets can be stored at all. */
  available(): boolean {
    return this.backend.isEncryptionAvailable()
  }

  /** Presence only — is a value stored for this field? Never decrypts. */
  has(id: IntegrationId, key: string): boolean {
    return keyOf(id, key) in this.map
  }

  /** The presence map for one integration (booleans only — no values, ever). */
  presence(id: IntegrationId): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    const prefix = `${id}:`
    for (const k of Object.keys(this.map)) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = true
    }
    return out
  }

  /** Encrypt + persist a secret. Stores nothing if the backend is unavailable. */
  set(id: IntegrationId, key: string, value: string): void {
    if (!this.available()) {
      throw new Error(
        `Secure storage isn't available on this machine (safeStorage: encryption unavailable). ` +
          `"${id}" credentials can't be saved, so it stays disabled.`
      )
    }
    let ciphertext: Buffer
    try {
      ciphertext = this.backend.encryptString(value)
    } catch (err) {
      throw new Error(
        `Couldn't encrypt the "${key}" credential for "${id}" — ${(err as Error).message}. ` +
          `Nothing was stored; try again.`,
        { cause: err }
      )
    }
    const next = { ...this.map, [keyOf(id, key)]: ciphertext.toString('base64') }
    this.persist(next, key, id)
  }

  /** Clear one field, or every field for an id when `key` is omitted. */
  clear(id: IntegrationId, key?: string): void {
    const next: SecretMap = {}
    const prefix = `${id}:`
    for (const [k, v] of Object.entries(this.map)) {
      if (key !== undefined ? k === keyOf(id, key) : k.startsWith(prefix)) continue
      next[k] = v
    }
    this.persist(next, key ?? '(all)', id)
  }

  /**
   * MAIN-PROCESS-ONLY plaintext exit for an in-process connector. MUST NEVER be
   * routed to IPC, a log, or a peek. Named to grep distinctly (§10 asserts no
   * IPC/renderer caller). A decrypt failure surfaces the legible "re-enter it"
   * error, never the ciphertext.
   */
  revealForConnector(id: IntegrationId, key: string): string {
    const b64 = this.map[keyOf(id, key)]
    if (b64 === undefined) {
      throw new Error(`No "${id}" credential "${key}" is stored — set it in the Integrations tab.`)
    }
    return this.decrypt(id, key, b64)
  }

  /**
   * Main-only health probe for `status()`: if any stored secret for this id
   * can't be decrypted, returns the legible error (state, not value); else
   * undefined. Decrypts in-process and discards the plaintext — no value leaks.
   */
  decryptionError(id: IntegrationId): string | undefined {
    const prefix = `${id}:`
    for (const [k, b64] of Object.entries(this.map)) {
      if (!k.startsWith(prefix)) continue
      try {
        this.decrypt(id, k.slice(prefix.length), b64)
      } catch (err) {
        return (err as Error).message
      }
    }
    return undefined
  }

  private decrypt(id: IntegrationId, key: string, b64: string): string {
    try {
      return this.backend.decryptString(Buffer.from(b64, 'base64'))
    } catch (err) {
      throw new Error(
        `Stored "${id}" credential "${key}" can't be decrypted (safeStorage: ` +
          `${(err as Error).message}) — re-enter it in the Integrations tab.`,
        { cause: err }
      )
    }
  }

  /** Atomic write (temp + rename) so a failed write leaves no half-written blob. */
  private persist(next: SecretMap, key: string, id: IntegrationId): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't save the "${key}" credential for "${id}" — ${(err as Error).message}. ` +
          `Nothing was stored; try again.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage sidecar is the normal first-run case — start empty, never throw. */
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
