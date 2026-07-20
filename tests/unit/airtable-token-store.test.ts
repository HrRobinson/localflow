import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { AirtableTokenStore } from '../../src/main/airtable/airtable-token-store'
import { AirtableHttpApi, type AirtableTransport } from '../../src/main/airtable/airtable-api'

const PAT = 'patLIVE_super_secret_personal_access_token'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): AirtableTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-at-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('airtable', 'personalAccessToken', PAT)
  creds.set('airtable', 'webhookMacSecret', 'macsecret_value')
  return new AirtableTokenStore(creds)
}

describe('AirtableTokenStore', () => {
  it('round-trips the PAT via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.personalAccessToken()).toBe(PAT)
    expect(store.webhookMacSecret()).toBe('macsecret_value')
    expect(store.hasPersonalAccessToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-at-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new AirtableTokenStore(creds)
    expect(() => store.personalAccessToken()).toThrow(
      /No "airtable" credential "personalAccessToken"/
    )
  })
})

describe('the PAT never leaks into any connector output or error (spec §5, §8, §9)', () => {
  it('keeps the token out of results and errors across success and failure paths', async () => {
    const store = tokenStore()
    const captured: string[] = []

    // A transport that carries the real PAT in its header (as production would)
    // and asserts the token flows in — then we prove it flows out of NOTHING.
    const transport: AirtableTransport = {
      send: async (req) => {
        expect(req.headers.Authorization).toBe(`Bearer ${PAT}`)
        if (req.method === 'GET') {
          return {
            status: 200,
            body: JSON.stringify({
              id: 'rec1',
              createdTime: '2026-07-20T00:00:00.000Z',
              fields: {}
            })
          }
        }
        // A failure path: a 422 the API maps to a legible error (never echoing auth).
        return { status: 422, body: JSON.stringify({ error: { type: 'X', message: 'bad field' } }) }
      }
    }

    const api = new AirtableHttpApi({
      transport,
      baseId: 'app1',
      tableId: 'tblIntake',
      reveal: () => store.personalAccessToken(),
      sleep: async () => {}
    })

    captured.push(JSON.stringify(await api.getRecord('rec1')))
    await api.updateRecord('rec1', { fields: { Bad: 'x' } }).catch((e: Error) => {
      captured.push(e.message)
      captured.push(e.stack ?? '')
    })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of captured) expect(s).not.toContain(PAT)
  })
})
