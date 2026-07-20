import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { SecretBackend } from '../integrations/credential-store'

/**
 * DEDICATED keychain store for the hosted-account token (design §6, O-4). The
 * account token authenticates the local app to the relay's control API; it is a
 * secret and lives ONLY in the keychain (safeStorage-encrypted sidecar), never
 * config.json, never a log, never an IPC payload. `revealToken` is the sole
 * plaintext exit and is MAIN-PROCESS-ONLY.
 *
 * It is its OWN tiny store (not `CredentialStore`) so `IntegrationId` stays clean
 * — 'hosted' is not an integration and must not leak into descriptor/registry
 * enumeration (O-4 recommendation). It mirrors `CredentialStore`'s discipline:
 * the `SecretBackend` seam keeps it unit-testable, an atomic temp+rename write,
 * and a legible decrypt/availability error that never renders the value.
 */

/** The single reserved key in the sidecar map. */
const TOKEN_KEY = 'accountToken'

export class HostedTokenStore {
  private readonly backend: SecretBackend
  private readonly file: string
  private map: Record<string, string>

  constructor(deps: { backend: SecretBackend; file: string }) {
    this.backend = deps.backend
    this.file = deps.file
    this.map = load(deps.file)
  }

  /** Whether secrets can be stored at all (safeStorage availability). */
  available(): boolean {
    return this.backend.isEncryptionAvailable()
  }

  /** Presence only — never decrypts. Drives the Settings `hasValue` DTO. */
  hasToken(): boolean {
    return TOKEN_KEY in this.map
  }

  /** Encrypt + persist the pasted account token. Stores nothing if unavailable. */
  setToken(value: string): void {
    if (!this.available()) {
      throw new Error(
        "Secure storage isn't available on this machine (safeStorage: encryption " +
          "unavailable). The hosted account token can't be saved, so hosted ingress stays off."
      )
    }
    let ciphertext: Buffer
    try {
      ciphertext = this.backend.encryptString(value)
    } catch (err) {
      throw new Error(
        `Couldn't encrypt the hosted account token — ${(err as Error).message}. ` +
          'Nothing was stored; try again.',
        { cause: err }
      )
    }
    this.persist({ ...this.map, [TOKEN_KEY]: ciphertext.toString('base64') })
  }

  /** Remove the stored token. */
  clearToken(): void {
    const next = { ...this.map }
    delete next[TOKEN_KEY]
    this.persist(next)
  }

  /**
   * MAIN-PROCESS-ONLY plaintext exit. MUST NEVER be routed to IPC, a log, or a
   * peek. A decrypt failure surfaces the legible "re-enter it" error, never the
   * ciphertext.
   */
  revealToken(): string {
    const b64 = this.map[TOKEN_KEY]
    if (b64 === undefined) {
      throw new Error(
        'No hosted account token is stored — paste it in Settings › Hosted ingress to connect.'
      )
    }
    try {
      return this.backend.decryptString(Buffer.from(b64, 'base64'))
    } catch (err) {
      throw new Error(
        `The stored hosted account token can't be decrypted (safeStorage: ` +
          `${(err as Error).message}) — re-enter it in Settings › Hosted ingress.`,
        { cause: err }
      )
    }
  }

  /** Atomic write (temp + rename) so a failed write leaves no half-written blob. */
  private persist(next: Record<string, string>): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't save the hosted account token — ${(err as Error).message}. ` +
          'Nothing was stored; try again.',
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage sidecar is the normal first-run case — start empty. */
function load(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}
