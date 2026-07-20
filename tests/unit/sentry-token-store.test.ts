import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { SentryTokenStore } from '../../src/main/sentry/sentry-token-store'
import { SentryConnector } from '../../src/main/sentry/sentry-connector'
import { SentryHttpApi, type SentryTransport } from '../../src/main/sentry/sentry-api'

const TOKEN = 'sntrys_super_secret_bearer_token_value'
const SECRET = 'whsec_sentry_client_secret_value'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): SentryTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-sentry-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('sentry', 'authToken', TOKEN)
  creds.set('sentry', 'webhookSecret', SECRET)
  return new SentryTokenStore(creds)
}

describe('SentryTokenStore', () => {
  it('round-trips the bearer token + Client Secret via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.authToken()).toBe(TOKEN)
    expect(store.webhookSecret()).toBe(SECRET)
    expect(store.hasAuthToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-sentry-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new SentryTokenStore(creds)
    expect(() => store.authToken()).toThrow(/No "sentry" credential "authToken"/)
  })
})

describe('the bearer token never leaks into any connector output or error', () => {
  // Wire a transport that carries the real token in its Authorization header (as
  // production would) and assert the token appears in NEITHER a resolved context
  // NOR any rejected error message — the never-render-secrets rule (§5, §11).
  it('keeps the token out of results and errors across success and failure paths', async () => {
    const store = tokenStore()
    const captured: string[] = []

    const transport: SentryTransport = {
      send: async (req) => {
        // The header the live transport WOULD send — proves the token flows in.
        expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`)
        if (req.method === 'GET') {
          return { status: 200, body: JSON.stringify({ id: '42', shortId: 'FE-1' }) }
        }
        // A failure path: a mutation Sentry refuses.
        return { status: 403, body: JSON.stringify({ detail: 'insufficient scope' }) }
      }
    }

    const api = new SentryHttpApi({
      transport,
      orgSlug: 'org',
      projectSlug: 'proj',
      reveal: () => store.authToken()
    })
    const connector = new SentryConnector({ api })

    const okOut = await connector.invokeAction('getIssue', { id: '42' })
    captured.push(JSON.stringify(okOut))

    await connector.invokeAction('resolveIssue', { id: '42' }).catch((e: Error) => {
      captured.push(e.message)
      captured.push(e.stack ?? '')
    })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of captured) expect(s).not.toContain(TOKEN)
  })
})
