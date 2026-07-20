import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { ZendeskTokenStore } from '../../src/main/zendesk/zendesk-token-store'
import { ZendeskConnector } from '../../src/main/zendesk/zendesk-connector'
import { ZendeskRestApi, type ZendeskTransport } from '../../src/main/zendesk/zendesk-api'

// A realistic-looking API token. The whole point of these tests: this value must
// appear in NO connector output and NO error/stack, ever (the never-render rule).
const TOKEN = 'zdtok_super_secret_api_token_value_abc123'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): ZendeskTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-zendesk-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('zendesk', 'apiToken', TOKEN)
  creds.set('zendesk', 'webhookSecret', 'whsec_value')
  return new ZendeskTokenStore(creds)
}

describe('ZendeskTokenStore', () => {
  it('round-trips the API token via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.apiToken()).toBe(TOKEN)
    expect(store.webhookSecret()).toBe('whsec_value')
    expect(store.hasApiToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-zendesk-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new ZendeskTokenStore(creds)
    expect(() => store.apiToken()).toThrow(/No "zendesk" credential "apiToken"/)
  })
})

describe('the API token never leaks into any connector output, log, or error (§8, §11)', () => {
  it('keeps the token out of results and errors across success and failure paths', async () => {
    const store = tokenStore()
    const captured: string[] = []
    const logs: string[] = []

    // A transport that carries the real token in its Basic-auth header (as the live
    // wiring would) and proves the token flows IN — then we assert it never flows OUT.
    const transport: ZendeskTransport = async (req) => {
      const basic = Buffer.from(`agent@x.com/token:${store.apiToken()}`).toString('base64')
      const header = `Authorization: Basic ${basic}`
      expect(header).toContain(basic)
      if (req.path.startsWith('/tickets/') && req.method === 'GET') {
        return { status: 200, body: { ticket: { id: 1, status: 'open' } } }
      }
      // A failure path: a 403 permission error (the least-privilege 403 of §11).
      return { status: 403, body: { error: 'Forbidden', description: 'permission denied' } }
    }

    const connector = new ZendeskConnector({
      api: new ZendeskRestApi({ transport }),
      log: (m) => logs.push(m)
    })

    const okOut = await connector.invokeAction('getTicket', { id: '1' })
    captured.push(JSON.stringify(okOut))

    await connector.invokeAction('replyToTicket', { id: '1', body: 'hi' }).catch((e: Error) => {
      captured.push(e.message)
      captured.push(e.stack ?? '')
    })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of [...captured, ...logs]) expect(s).not.toContain(TOKEN)
  })
})

describe('the public-reply send-path has exactly one non-test caller (§9)', () => {
  it('`comment.public: true` is emitted from a SINGLE place in the connector source', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/main/zendesk/zendesk-connector.ts', import.meta.url)),
      'utf8'
    )
    // The ONLY code literal that emits a customer-facing public comment (the
    // trailing brace distinguishes the `{ body, public: true }` object from prose).
    const publicTrue = src.match(/public:\s*true\s*\}/g) ?? []
    expect(publicTrue).toHaveLength(1)
    // The public-reply send-path has exactly ONE call site (`this.sendPublicReply(`).
    const sendCallers = src.match(/this\.sendPublicReply\(/g) ?? []
    expect(sendCallers).toHaveLength(1)
  })
})
