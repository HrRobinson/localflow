import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretBackend } from '../../src/main/integrations/credential-store'
import { HostedTokenStore } from '../../src/main/hosted/hosted-token-store'

const TOKEN = 'hosted-account-token-super-secret-value'

// A reversible fake backend so a test can inspect the on-disk sidecar. Encrypts
// as base64 so the plaintext token is NOT recoverable from the raw file bytes.
const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

function store(): { store: HostedTokenStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lf-hosted-tok-'))
  const file = join(dir, 'hosted-token.enc')
  return { store: new HostedTokenStore({ backend, file }), file }
}

describe('HostedTokenStore', () => {
  it('round-trips the account token via the main-only reveal exit', () => {
    const { store: s } = store()
    expect(s.hasToken()).toBe(false)
    s.setToken(TOKEN)
    expect(s.hasToken()).toBe(true)
    expect(s.revealToken()).toBe(TOKEN)
  })

  it('surfaces a legible error (never ciphertext) when nothing is stored', () => {
    const { store: s } = store()
    expect(() => s.revealToken()).toThrow(/no hosted account token/i)
    expect(() => s.revealToken()).toThrow(/Settings/i)
  })

  it('clears the token', () => {
    const { store: s } = store()
    s.setToken(TOKEN)
    s.clearToken()
    expect(s.hasToken()).toBe(false)
    expect(() => s.revealToken()).toThrow()
  })

  it('never writes the plaintext token to disk (keychain-encrypted only)', () => {
    const { store: s, file } = store()
    s.setToken(TOKEN)
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain(TOKEN)
  })

  it('refuses to store when the backend is unavailable, with a legible error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-hosted-tok-'))
    const s = new HostedTokenStore({
      backend: { ...backend, isEncryptionAvailable: () => false },
      file: join(dir, 'hosted-token.enc')
    })
    expect(() => s.setToken(TOKEN)).toThrow(/Secure storage isn't available/i)
    expect(s.hasToken()).toBe(false)
  })
})
