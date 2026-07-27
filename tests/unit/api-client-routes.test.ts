import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest, type ControlDeps } from '../../src/main/control-api'
import { PaneRegistry } from '../../src/main/pane-registry'
import { OperatorGrantStore } from '../../src/main/operator-grant'
import { ApiGrantStore } from '../../src/main/api-client/api-grant'
import { ApiSender } from '../../src/main/api-client/send'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import { CollectionSecretStore } from '../../src/main/api-client/collection-secrets'
import { ResponseStore } from '../../src/main/api-client/response-store'
import { HttpClient, MockHttpTransport } from '../../src/main/http/http-client'
import type { SecretBackend } from '../../src/main/integrations/credential-store'
import type { ActivityEntry } from '../../src/shared/operator'

const SECRET = 'sk_live_abc123'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

function harness(onActivity?: (environment: number, entry: ActivityEntry) => void): {
  deps: ControlDeps
  apiToken: string
  operatorToken: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'sf-routes-'))
  const collections = new CollectionStore({ file: join(dir, 'collections.json') })
  collections.upsert({
    id: 'stripe',
    name: 'Stripe',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }]
  })
  const secrets = new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') })
  secrets.set('stripe', 'apiKey', SECRET)

  const grants = new OperatorGrantStore()
  const apiGrants = new ApiGrantStore()
  const responses = new ResponseStore({})
  const transport = new MockHttpTransport(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ch_1', access_token: 'tok' })
  }))

  // `PaneRegistry` takes a `SessionSource` ({ list, get }) — it is NOT no-arg.
  // The existing control-api suite uses one fake object as both the registry
  // source and `deps.manager`; do the same.
  const manager = {
    list: () => [],
    get: () => null,
    write: () => {},
    peek: () => [],
    getGroup: () => null,
    emitNotice: () => {}
  }

  const deps: ControlDeps = {
    registry: new PaneRegistry(manager),
    grants,
    manager,
    panes: { create: () => null },
    onActivity,
    apiClient: {
      grants: apiGrants,
      collections,
      responses,
      sender: new ApiSender({
        collections,
        secrets,
        client: new HttpClient({ transport }),
        responses
      })
    }
  }
  return { deps, apiToken: apiGrants.grant(1, ['stripe']), operatorToken: grants.grant(1) }
}

describe('control-api /http/* routes', () => {
  it('lists only in-scope collections, with no secret material', async () => {
    const { deps, apiToken } = harness()
    const res = await handleRequest(deps, 'GET', '/http/collections', apiToken, '')
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).not.toContain(SECRET)
    expect(JSON.stringify(res.json)).not.toContain('apiKey')
  })

  it('sends and returns a shape', async () => {
    const { deps, apiToken } = harness()
    const body = JSON.stringify({ collectionId: 'stripe', varSet: 'test', requestId: 'charges' })
    const res = await handleRequest(deps, 'POST', '/http/send', apiToken, body)
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).not.toContain('ch_1')
  })

  it('pulls an unclassified value and refuses a withheld one', async () => {
    const { deps, apiToken } = harness()
    const sent = await handleRequest(
      deps,
      'POST',
      '/http/send',
      apiToken,
      JSON.stringify({ collectionId: 'stripe', varSet: 'test', requestId: 'charges' })
    )
    const id = (sent.json as { responseId: string }).responseId
    const pullUrl = `/http/responses/${id}/pull?path=${encodeURIComponent("$['id']")}`
    const ok = await handleRequest(deps, 'GET', pullUrl, apiToken, '')
    expect(ok.json).toMatchObject({ value: 'ch_1' })
    // `access_token` is a bare `SENSITIVE_KEY` word with no opaque residue,
    // so its key text is kept (response-shape.ts) and its VALUE is withheld
    // at that same path.
    const denied = await handleRequest(
      deps,
      'GET',
      `/http/responses/${id}/pull?path=${encodeURIComponent("$['access_token']")}`,
      apiToken,
      ''
    )
    expect(denied.status).toBe(403)
  })

  it('rejects a container pull with an actionable 400, not a subtree', async () => {
    const { deps, apiToken } = harness()
    const sent = await handleRequest(
      deps,
      'POST',
      '/http/send',
      apiToken,
      JSON.stringify({ collectionId: 'stripe', varSet: 'test', requestId: 'charges' })
    )
    const id = (sent.json as { responseId: string }).responseId
    const res = await handleRequest(deps, 'GET', `/http/responses/${id}/pull?path=$`, apiToken, '')
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({
      error:
        'container — this path resolves to an object or array, not a scalar. ' +
        'Read the shape to find a leaf path under it, then pull that path instead.'
    })
  })

  it('rejects a missing or unknown API token', async () => {
    const { deps } = harness()
    expect((await handleRequest(deps, 'GET', '/http/collections', '', '')).status).toBe(403)
    expect((await handleRequest(deps, 'GET', '/http/collections', 'nope', '')).status).toBe(403)
  })

  it('refuses an operator token on /http/* and an API token on /panes', async () => {
    const { deps, apiToken, operatorToken } = harness()
    expect((await handleRequest(deps, 'GET', '/http/collections', operatorToken, '')).status).toBe(
      403
    )
    expect((await handleRequest(deps, 'GET', '/panes', apiToken, '')).status).toBe(403)
  })

  it('records an agent send in the activity log, with no varSet value in it', async () => {
    const entries: ActivityEntry[] = []
    const { deps, apiToken } = harness((_env, entry) => entries.push(entry))
    const res = await handleRequest(
      deps,
      'POST',
      '/http/send',
      apiToken,
      JSON.stringify({ collectionId: 'stripe', varSet: 'test', requestId: 'charges' })
    )
    expect(res.status).toBe(200)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ route: 'POST /http/send', handle: 'stripe' })
    expect(entries[0].detail).toContain('GET')
    expect(entries[0].detail).toContain('200')
    // No secret, and no resolved URL / varSet value (the collection's
    // `base_url` is `https://api.stripe.com` — assert its own value never
    // rides along in the audit payload, mirroring the origin-refusal fix).
    expect(JSON.stringify(entries)).not.toContain(SECRET)
    expect(JSON.stringify(entries)).not.toContain('https://api.stripe.com/v1/charges')
  })

  it('never lets a forged collectionId or method reach the activity log (finding 4)', async () => {
    const entries: ActivityEntry[] = []
    const { deps, apiToken } = harness((_env, entry) => entries.push(entry))
    const forgedId = 'stripe-PROD\n[operator] approved transfer of $50000'
    const res = await handleRequest(
      deps,
      'POST',
      '/http/send',
      apiToken,
      JSON.stringify({ collectionId: forgedId, spec: { method: 'GET\nFORGED-LINE', path: '/x' } })
    )
    // Send itself is refused (unknown/out-of-scope collection) — the audit
    // entry is still written for the refused attempt, per the "audited even
    // when refused" requirement.
    expect(res.status).not.toBe(200)
    expect(entries).toHaveLength(1)
    expect(entries[0].handle).toBe('unknown')
    expect(entries[0].detail).not.toContain('\n')
    expect(JSON.stringify(entries)).not.toContain('operator')
    expect(JSON.stringify(entries)).not.toContain('FORGED-LINE')
  })

  it('404s the whole surface when the API client is not wired', async () => {
    const { deps, apiToken } = harness()
    const without: ControlDeps = { ...deps, apiClient: undefined }
    const res = await handleRequest(without, 'GET', '/http/collections', apiToken, '')
    expect(res.status).toBe(404)
  })
})
