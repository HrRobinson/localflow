import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'

/** In-memory stand-in for Electron `safeStorage` — the seam tests replace. */
class FakeBackend implements SecretBackend {
  available = true
  /** When set, decryptString throws — simulates a rotated keychain. */
  corruptDecrypt = false

  isEncryptionAvailable(): boolean {
    return this.available
  }
  encryptString(plaintext: string): Buffer {
    return Buffer.from('cipher::' + plaintext, 'utf8')
  }
  decryptString(ciphertext: Buffer): string {
    if (this.corruptDecrypt) throw new Error('key mismatch')
    const s = ciphertext.toString('utf8')
    if (!s.startsWith('cipher::')) throw new Error('malformed ciphertext')
    return s.slice('cipher::'.length)
  }
}

const SECRET = 'lin_live_topsecret_ABC123'

describe('CredentialStore', () => {
  let dir: string
  let file: string
  let backend: FakeBackend

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lf-creds-'))
    file = join(dir, 'integration-secrets.enc')
    backend = new FakeBackend()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips set / has / presence / clear', () => {
    const store = new CredentialStore({ backend, file })
    expect(store.has('linear', 'oauthToken')).toBe(false)

    store.set('linear', 'oauthToken', SECRET)
    expect(store.has('linear', 'oauthToken')).toBe(true)
    expect(store.presence('linear')).toEqual({ oauthToken: true })

    store.clear('linear', 'oauthToken')
    expect(store.has('linear', 'oauthToken')).toBe(false)
    expect(store.presence('linear')).toEqual({})
  })

  it('clears every field for an id when no key is given', () => {
    const store = new CredentialStore({ backend, file })
    store.set('linear', 'oauthToken', SECRET)
    store.set('linear', 'webhookSecret', 'wh_secret')
    store.set('email', 'refreshToken', 'rt_secret')

    store.clear('linear')
    expect(store.has('linear', 'oauthToken')).toBe(false)
    expect(store.has('linear', 'webhookSecret')).toBe(false)
    expect(store.has('email', 'refreshToken')).toBe(true)
  })

  it('persists across instances and never writes plaintext to disk', () => {
    const a = new CredentialStore({ backend, file })
    a.set('linear', 'oauthToken', SECRET)

    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain(SECRET)

    const b = new CredentialStore({ backend, file })
    expect(b.has('linear', 'oauthToken')).toBe(true)
    expect(b.revealForConnector('linear', 'oauthToken')).toBe(SECRET)
  })

  it('presence returns booleans only — no values', () => {
    const store = new CredentialStore({ backend, file })
    store.set('linear', 'oauthToken', SECRET)
    const p = store.presence('linear')
    for (const v of Object.values(p)) expect(typeof v).toBe('boolean')
    expect(JSON.stringify(p)).not.toContain(SECRET)
  })

  it('throws a legible error and stores nothing when the backend is unavailable', () => {
    backend.available = false
    const store = new CredentialStore({ backend, file })
    expect(store.available()).toBe(false)
    expect(() => store.set('linear', 'oauthToken', SECRET)).toThrowError(
      /secure storage isn't available/i
    )
    expect(store.has('linear', 'oauthToken')).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('surfaces a legible re-enter error on decrypt failure, never the value', () => {
    const store = new CredentialStore({ backend, file })
    store.set('linear', 'oauthToken', SECRET)
    backend.corruptDecrypt = true

    const detail = store.decryptionError('linear')
    expect(detail).toMatch(/can't be decrypted/i)
    expect(detail).toMatch(/re-enter/i)
    expect(detail).not.toContain(SECRET)
    expect(() => store.revealForConnector('linear', 'oauthToken')).toThrowError(/re-enter/i)
  })

  it('has no decryptionError when every stored secret decrypts', () => {
    const store = new CredentialStore({ backend, file })
    store.set('linear', 'oauthToken', SECRET)
    expect(store.decryptionError('linear')).toBeUndefined()
  })
})
