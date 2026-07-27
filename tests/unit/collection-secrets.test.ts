import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretBackend } from '../../src/main/integrations/credential-store'
import {
  CollectionSecretStore,
  collectionSecretKey
} from '../../src/main/api-client/collection-secrets'

const SECRET = 'sk_live_collection_secret_value'

// Reversible fake so a test can inspect the sidecar. Encrypts as base64 so the
// plaintext is NOT recoverable from the raw file bytes.
const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

function store(): { store: CollectionSecretStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-col-sec-'))
  const file = join(dir, 'collection-secrets.enc')
  return { store: new CollectionSecretStore({ backend, file }), file }
}

describe('collectionSecretKey', () => {
  it('length-prefixes so two pairs can never collide', () => {
    // Without the length prefix both of these join to the same string.
    expect(collectionSecretKey('orders', 'stripe:key')).not.toBe(
      collectionSecretKey('orders:stripe', 'key')
    )
  })
})

describe('CollectionSecretStore', () => {
  it('round-trips a secret via the main-only reveal exit', () => {
    const { store: s } = store()
    expect(s.has('col1', 'token')).toBe(false)
    s.set('col1', 'token', SECRET)
    expect(s.has('col1', 'token')).toBe(true)
    expect(s.revealSecret('col1', 'token')).toBe(SECRET)
  })

  it('scopes secrets per collection', () => {
    const { store: s } = store()
    s.set('col1', 'token', SECRET)
    expect(s.has('col2', 'token')).toBe(false)
  })

  it('clears one ref, or every ref for a collection', () => {
    const { store: s } = store()
    s.set('col1', 'token', SECRET)
    s.set('col1', 'other', SECRET)
    s.clear('col1', 'token')
    expect(s.has('col1', 'token')).toBe(false)
    expect(s.has('col1', 'other')).toBe(true)
    s.clear('col1')
    expect(s.has('col1', 'other')).toBe(false)
  })

  it('never writes plaintext to disk', () => {
    const { store: s, file } = store()
    s.set('col1', 'token', SECRET)
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
  })

  it('surfaces a legible error (never ciphertext) when absent', () => {
    const { store: s } = store()
    expect(() => s.revealSecret('col1', 'token')).toThrow(/no credential/i)
    expect(() => s.revealSecret('col1', 'token')).toThrow(/token/)
  })

  it('surfaces a legible re-enter error on decrypt failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-sec-'))
    const file = join(dir, 'collection-secrets.enc')
    const broken: SecretBackend = {
      ...backend,
      decryptString: () => {
        throw new Error('bad key')
      }
    }
    const s = new CollectionSecretStore({ backend: broken, file })
    s.set('col1', 'token', SECRET)
    expect(() => s.revealSecret('col1', 'token')).toThrow(/re-enter/i)
  })

  it('refuses to store when encryption is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-sec-'))
    const file = join(dir, 'collection-secrets.enc')
    const off: SecretBackend = { ...backend, isEncryptionAvailable: () => false }
    const s = new CollectionSecretStore({ backend: off, file })
    expect(() => s.set('col1', 'token', SECRET)).toThrow(/secure storage/i)
  })
})
