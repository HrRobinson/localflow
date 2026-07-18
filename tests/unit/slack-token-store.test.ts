import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { SlackTokenStore } from '../../src/main/slack/slack-token-store'

const BOT = 'xoxb-super-secret-bot-token-value'
const APP = 'xapp-super-secret-app-token-value'
const SIGN = 'signing-secret-super-secret-value'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): SlackTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-slack-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('slack', 'botToken', BOT)
  creds.set('slack', 'appToken', APP)
  creds.set('slack', 'signingSecret', SIGN)
  return new SlackTokenStore(creds)
}

describe('SlackTokenStore', () => {
  it('round-trips the three secrets via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.botToken()).toBe(BOT)
    expect(store.appToken()).toBe(APP)
    expect(store.signingSecret()).toBe(SIGN)
    expect(store.hasBotToken()).toBe(true)
    expect(store.hasAppToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-slack-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new SlackTokenStore(creds)
    expect(() => store.botToken()).toThrow(/No "slack" credential "botToken"/)
    expect(store.hasBotToken()).toBe(false)
  })
})
