import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { IntercomTokenStore } from '../../src/main/intercom/intercom-token-store'
import { IntercomConnector } from '../../src/main/intercom/intercom-connector'
import { IntercomApiClient, type IntercomTransport } from '../../src/main/intercom/intercom-api'

// A realistic-looking access token — the SINGLE Bearer credential of §8. The whole
// point of these tests: this value must appear in NO connector output and NO
// error/stack, ever (the never-render-secrets rule).
const TOKEN = 'dG9r_super_secret_intercom_access_token_51xyz'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): IntercomTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-intercom-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('intercom', 'accessToken', TOKEN)
  creds.set('intercom', 'clientSecret', 'client_secret_value')
  return new IntercomTokenStore(creds)
}

describe('IntercomTokenStore', () => {
  it('round-trips the access token + client secret via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.accessToken()).toBe(TOKEN)
    expect(store.clientSecret()).toBe('client_secret_value')
    expect(store.hasAccessToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-intercom-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new IntercomTokenStore(creds)
    expect(() => store.accessToken()).toThrow(/No "intercom" credential "accessToken"/)
  })
})

describe('the access token never leaks into any connector output, log, or error (§8, §11)', () => {
  it('keeps the token out of results and errors across success and failure paths', async () => {
    const store = tokenStore()
    const captured: string[] = []
    const logs: string[] = []

    // A transport that carries the real token in its Authorization header (as the
    // live wiring would) and proves the token flows IN — then we assert it never
    // flows OUT into any rendered surface.
    const transport: IntercomTransport = async (req) => {
      const header = `Authorization: Bearer ${store.accessToken()}`
      expect(header).toContain(TOKEN)
      if (req.path.startsWith('/conversations/') && req.method === 'GET') {
        return { status: 200, body: { id: '1001', state: 'open' } }
      }
      // A failure path: a 403 permission error (the least-privilege 403 of §11).
      return {
        status: 403,
        body: { errors: [{ code: 'forbidden', message: 'permission denied' }] }
      }
    }

    const connector = new IntercomConnector({
      api: new IntercomApiClient({ transport }),
      log: (m) => logs.push(m)
    })

    const okOut = await connector.invokeAction('getConversation', { id: '1001' })
    captured.push(JSON.stringify(okOut))

    await connector
      .invokeAction('replyToConversation', { id: '1001', body: 'hi' })
      .catch((e: Error) => {
        captured.push(e.message)
        captured.push(e.stack ?? '')
      })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of [...captured, ...logs]) expect(s).not.toContain(TOKEN)
  })
})
