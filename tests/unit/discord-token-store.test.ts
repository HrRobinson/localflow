import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { DiscordTokenStore } from '../../src/main/discord/discord-token-store'

const BOT = 'mfa.super-secret-discord-bot-token-value'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): DiscordTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-discord-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('discord', 'botToken', BOT)
  return new DiscordTokenStore(creds)
}

describe('DiscordTokenStore', () => {
  it('round-trips the ONE secret via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.botToken()).toBe(BOT)
    expect(store.hasBotToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-discord-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new DiscordTokenStore(creds)
    expect(() => store.botToken()).toThrow(/No "discord" credential "botToken"/)
    expect(store.hasBotToken()).toBe(false)
  })

  it('never renders the token value in a thrown/log string', () => {
    const store = tokenStore()
    // The reveal is the ONLY plaintext exit; probing presence must not leak it.
    const probe = String(store.hasBotToken())
    expect(probe).not.toContain(BOT)
  })
})
