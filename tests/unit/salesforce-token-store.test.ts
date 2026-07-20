import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { SalesforceTokenStore } from '../../src/main/salesforce/salesforce-token-store'

const CLIENT_SECRET = 'sfdc_consumer_SECRET_do_not_leak_9f3a'
const PRIVATE_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nMII_SECRET_do_not_leak\n-----END RSA PRIVATE KEY-----'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): SalesforceTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-sf-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('salesforce', 'clientSecret', CLIENT_SECRET)
  creds.set('salesforce', 'privateKey', PRIVATE_KEY)
  return new SalesforceTokenStore(creds)
}

describe('SalesforceTokenStore', () => {
  it('round-trips both auth-fork secrets via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.clientSecret()).toBe(CLIENT_SECRET)
    expect(store.privateKey()).toBe(PRIVATE_KEY)
    expect(store.hasClientSecret()).toBe(true)
    expect(store.hasPrivateKey()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-sf-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new SalesforceTokenStore(creds)
    expect(() => store.clientSecret()).toThrow(/No "salesforce" credential "clientSecret"/)
    expect(store.hasClientSecret()).toBe(false)
  })
})
