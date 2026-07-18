import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { HubSpotTokenStore } from '../../src/main/hubspot/hubspot-token-store'

const TOKEN = 'pat-na1-super-secret-private-app-token'
const CLIENT_SECRET = 'whsec-app-client-secret-value'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): HubSpotTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-hubspot-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('hubspot', 'privateAppToken', TOKEN)
  creds.set('hubspot', 'webhookClientSecret', CLIENT_SECRET)
  return new HubSpotTokenStore(creds)
}

describe('HubSpotTokenStore', () => {
  it('round-trips the two secrets via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.privateAppToken()).toBe(TOKEN)
    expect(store.webhookClientSecret()).toBe(CLIENT_SECRET)
    expect(store.hasPrivateAppToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-hubspot-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new HubSpotTokenStore(creds)
    expect(() => store.privateAppToken()).toThrow(/No "hubspot" credential "privateAppToken"/)
  })
})
