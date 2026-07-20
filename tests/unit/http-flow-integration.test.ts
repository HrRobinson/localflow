import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { HttpConnector } from '../../src/main/http/http-connector'
import {
  HttpClient,
  MockHttpTransport,
  type HttpRawResponse
} from '../../src/main/http/http-client'
import type { FlowNode } from '../../src/shared/flows'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const ok = (over: Partial<HttpRawResponse> = {}): HttpRawResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"status":"failed"}',
  ...over
})

function wire(responder: () => HttpRawResponse) {
  const dir = mkdtempSync(join(tmpdir(), 'lf-http-flow-'))
  const configFile = join(dir, 'config.json')
  // `http` must be enabled with its one required descriptor field (environment)
  // for status('http') === 'connected' so the action-runner lets the node run.
  writeFileSync(
    configFile,
    JSON.stringify({ integrations: { http: { enabled: true, environment: 1 } } })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  const registry = new IntegrationRegistry({ creds, configFile, notify: () => {} })
  const transport = new MockHttpTransport(responder)
  registry.registerConnector(
    'http',
    new HttpConnector({
      client: new HttpClient({ transport }),
      reveal: (nodeId, ref) => creds.revealForConnector('http', `${nodeId}:${ref}`)
    })
  )
  return { registry, creds, transport }
}

const getNode = (): FlowNode => ({
  id: 'fetch',
  type: 'action',
  integration: 'http',
  ref: 'http.get',
  config: {
    url: 'https://api.internal/orders/{{trigger.orderId}}',
    auth: { scheme: 'bearer', secretRef: 'apiToken' }
  },
  position: { x: 0, y: 0 }
})

describe('http connector through the real registry + action-runner seam (§8.1)', () => {
  it('templates the URL, reveals the per-node secret, writes HttpResponseContext', async () => {
    const { registry, creds, transport } = wire(() => ok())
    creds.set('http', 'fetch:apiToken', 'tok-XYZ')

    const out = await runAction({ registry }, getNode(), { trigger: { orderId: '5123' } })

    expect(out.status).toBe('done')
    // URL templated from context, then dialed by the mock transport.
    expect(transport.requests[0].url).toBe('https://api.internal/orders/5123')
    // Secret revealed under the COMPOSITE key http:fetch:apiToken and applied.
    expect(transport.requests[0].headers['authorization']).toBe('Bearer tok-XYZ')
    expect(out.context).toEqual({
      fetch: { http: expect.objectContaining({ status: 200, ok: true }) }
    })
  })

  it('a non-2xx REJECTS → the node fails with the real cause forwarded (§9)', async () => {
    const { registry, creds } = wire(() => ok({ status: 422, body: 'name required' }))
    creds.set('http', 'fetch:apiToken', 'tok')
    const out = await runAction({ registry }, getNode(), { trigger: { orderId: '1' } })
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/returned 422/)
    expect(out.message).toMatch(/name required/)
  })

  it('a missing per-node secret fails legibly at run time (per-node readiness, §5)', async () => {
    const { registry } = wire(() => ok()) // secret never set
    const out = await runAction({ registry }, getNode(), { trigger: { orderId: '1' } })
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/credential|secret|stored/i)
  })

  it('an SSRF-blocked URL fails the node before any socket (§4.5)', async () => {
    const { registry, creds, transport } = wire(() => ok())
    creds.set('http', 'fetch:apiToken', 'tok')
    const node = getNode()
    node.config.url = 'https://169.254.169.254/latest/meta-data'
    // Canonical (gitlab) SSRF guard labels the metadata IP as 'cloud-metadata'.
    const out = await runAction({ registry }, node, {})
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/cloud-metadata|link-local|private/i)
    expect(transport.requests).toHaveLength(0)
  })
})
