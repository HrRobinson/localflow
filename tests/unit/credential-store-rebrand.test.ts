import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'

/**
 * Models macOS after the rename: encryption is still available (so the store
 * does NOT look "unavailable"), but ciphertext written under the previous
 * application identity no longer decrypts.
 */
const rebrandBrokenBackend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
  decryptString: () => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
  }
}

describe('credential store after a migrated sidecar fails to decrypt', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credstore-rebrand-'))
    file = join(dir, 'integration-secrets.enc')
    writeFileSync(
      file,
      JSON.stringify({ 'shopify:accessToken': 'Y2lwaGVy', 'shopify:shop': 'c2hvcA==' })
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('still reports the credential as PRESENT — never as unconfigured', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    expect(store.has('shopify', 'accessToken')).toBe(true)
    expect(store.presence('shopify')).toEqual({ accessToken: true, shop: true })
  })

  it('surfaces a legible re-enter instruction instead of crashing', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    const error = store.decryptionError('shopify')
    expect(error).toBeDefined()
    expect(error).toContain("can't be decrypted")
    expect(error).toContain('safeStorage:')
    expect(error).toContain('Stored "shopify" credential "accessToken"')
    expect(error).toContain('re-enter it in the Integrations tab')
  })

  it('throws the same legible error from the plaintext exit, never the ciphertext', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    expect(() => store.revealForConnector('shopify', 'accessToken')).toThrow(
      /re-enter it in the Integrations tab/
    )
    try {
      store.revealForConnector('shopify', 'accessToken')
    } catch (err) {
      expect((err as Error).message).not.toContain('Y2lwaGVy')
    }
  })

  it('lets the user overwrite the undecryptable value in place', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    store.set('shopify', 'accessToken', 'freshly-typed')
    expect(store.has('shopify', 'accessToken')).toBe(true)
    expect(store.decryptionError('shopify')).toBeDefined()
  })

  it('reports no decryption error for an integration with nothing stored', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    expect(store.decryptionError('slack')).toBeUndefined()
  })
})
