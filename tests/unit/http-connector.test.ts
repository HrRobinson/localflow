import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpConnector, type RevealNodeSecret } from '../../src/main/http/http-connector'
import {
  HttpClient,
  MockHttpTransport,
  type HttpRawResponse
} from '../../src/main/http/http-client'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { NODE_ID_PARAM } from '../../src/shared/http'

const ok = (over: Partial<HttpRawResponse> = {}): HttpRawResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
  ...over
})

function build(
  reveal: RevealNodeSecret,
  responder: () => HttpRawResponse,
  log?: (m: string) => void
) {
  const transport = new MockHttpTransport(responder)
  const connector = new HttpConnector({
    client: new HttpClient({ transport }),
    reveal,
    log
  })
  return { connector, transport }
}

describe('HttpConnector — outgoing dispatch', () => {
  it('http.get → GET + normalized HttpResponseContext written back', async () => {
    const { connector, transport } = build(
      () => 'tok',
      () => ok({ body: '{"status":"failed"}' })
    )
    const out = await connector.invokeAction('http.get', {
      url: 'https://api.internal/orders/42',
      auth: { scheme: 'bearer', secretRef: 'apiToken' },
      [NODE_ID_PARAM]: 'fetch'
    })
    expect(transport.requests[0].method).toBe('GET')
    expect(out).toEqual({
      http: {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/json' },
        body: { status: 'failed' }
      }
    })
  })

  it('http.send → POST with the serialized body', async () => {
    const { connector, transport } = build(
      () => 'tok',
      () => ok({ status: 200 })
    )
    await connector.invokeAction('http.send', {
      url: 'https://ops.example.com/hooks/abc',
      method: 'POST',
      body: { text: 'Order failed' },
      auth: { scheme: 'header', header: 'X-API-Key', secretRef: 'opsKey' },
      [NODE_ID_PARAM]: 'alert'
    })
    const r = transport.requests[0]
    expect(r.method).toBe('POST')
    expect(r.body).toBe('{"text":"Order failed"}')
  })

  it('rejects an unknown action id legibly, before any request', async () => {
    const { connector, transport } = build(
      () => 'tok',
      () => ok()
    )
    await expect(connector.invokeAction('http.delete', {})).rejects.toThrow(
      /no action 'http\.delete'/
    )
    expect(transport.requests).toHaveLength(0)
  })

  it('★ SSRF: a send to a metadata address rejects, transport never called', async () => {
    const { connector, transport } = build(
      () => 'tok',
      () => ok()
    )
    await expect(
      connector.invokeAction('http.send', {
        url: 'https://169.254.169.254/latest/meta-data',
        auth: { scheme: 'none' },
        [NODE_ID_PARAM]: 'x'
      })
    ).rejects.toThrow(/link-local|private/i)
    expect(transport.requests).toHaveLength(0)
  })
})

describe('HttpConnector — per-node composite keychain key (§7)', () => {
  it('reveals under `<nodeId>:<secretRef>` and applies the bearer header', async () => {
    const seen: [string, string][] = []
    const reveal: RevealNodeSecret = (nodeId, ref) => {
      seen.push([nodeId, ref])
      return 'SECRET-tok'
    }
    const { connector, transport } = build(reveal, () => ok())
    await connector.invokeAction('http.get', {
      url: 'https://api.example.com/x',
      auth: { scheme: 'bearer', secretRef: 'apiToken' },
      [NODE_ID_PARAM]: 'fetch'
    })
    expect(seen).toEqual([['fetch', 'apiToken']])
    expect(transport.requests[0].headers['authorization']).toBe('Bearer SECRET-tok')
  })

  it('the header scheme places the secret in the configured header', async () => {
    const { connector, transport } = build(
      () => 'KEY-123',
      () => ok()
    )
    await connector.invokeAction('http.get', {
      url: 'https://api.example.com/x',
      auth: { scheme: 'header', header: 'X-API-Key', secretRef: 'k' },
      [NODE_ID_PARAM]: 'n'
    })
    expect(transport.requests[0].headers['X-API-Key']).toBe('KEY-123')
  })

  it('scheme none makes no reveal and sends no auth header', async () => {
    let revealed = false
    const { connector, transport } = build(
      () => {
        revealed = true
        return 'x'
      },
      () => ok()
    )
    await connector.invokeAction('http.get', {
      url: 'https://api.example.com/x',
      auth: { scheme: 'none' },
      [NODE_ID_PARAM]: 'n'
    })
    expect(revealed).toBe(false)
    expect(transport.requests[0].headers['authorization']).toBeUndefined()
  })

  it('two nodes resolve isolated secrets via a real CredentialStore (http:A vs http:B)', async () => {
    const backend: SecretBackend = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => b.toString('utf8')
    }
    const dir = mkdtempSync(join(tmpdir(), 'lf-http-creds-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    creds.set('http', 'A:token', 'tok-A')
    creds.set('http', 'B:token', 'tok-B')
    const reveal: RevealNodeSecret = (nodeId, ref) =>
      creds.revealForConnector('http', `${nodeId}:${ref}`)
    const { connector, transport } = build(reveal, () => ok())

    await connector.invokeAction('http.get', {
      url: 'https://api.example.com/a',
      auth: { scheme: 'bearer', secretRef: 'token' },
      [NODE_ID_PARAM]: 'A'
    })
    await connector.invokeAction('http.get', {
      url: 'https://api.example.com/b',
      auth: { scheme: 'bearer', secretRef: 'token' },
      [NODE_ID_PARAM]: 'B'
    })
    expect(transport.requests[0].headers['authorization']).toBe('Bearer tok-A')
    expect(transport.requests[1].headers['authorization']).toBe('Bearer tok-B')
  })
})

/** ★ The load-bearing secret invariant (§9): the per-node secret VALUE never
 *  appears in a returned value, a log line, or an error surfaced onward. */
describe('HttpConnector — no secret leak', () => {
  it('never surfaces the token through outputs, logs, or errors', async () => {
    const TOKEN = 'super-secret-bearer-DO-NOT-LEAK'
    const logs: string[] = []
    const { connector } = build(
      () => TOKEN,
      () => ok({ status: 500, body: 'upstream boom' }),
      (m) => logs.push(m)
    )
    let errMsg = ''
    try {
      await connector.invokeAction('http.send', {
        url: 'https://api.example.com/x',
        method: 'POST',
        body: { a: 1 },
        auth: { scheme: 'bearer', secretRef: 'apiToken' },
        [NODE_ID_PARAM]: 'n'
      })
    } catch (e) {
      errMsg = (e as Error).message
    }
    // Trigger the deferred-subscribe log too.
    connector.subscribe('webhook.received', () => {})

    const surfaced = [errMsg, logs.join('\n')].join('\n')
    expect(errMsg).toMatch(/returned 500/)
    expect(surfaced).not.toContain(TOKEN)
    expect(surfaced).not.toMatch(/Authorization|Bearer /)
  })
})

describe('HttpConnector — incoming trigger is a legible deferred no-op (Half 2)', () => {
  it('logs the deferral and returns a no-op unsubscribe (no dead silent stream)', () => {
    const logs: string[] = []
    const { connector } = build(
      () => 'x',
      () => ok(),
      (m) => logs.push(m)
    )
    const off = connector.subscribe('webhook.received', () => {})
    expect(logs.join('\n')).toMatch(/Half 2|not wired/i)
    expect(() => off()).not.toThrow()
  })
})
