import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { ShopifyTokenStore } from '../../src/main/shopify/shopify-token-store'
import { ShopifyConnector } from '../../src/main/shopify/shopify-connector'
import { ShopifyAdminApi, type GraphqlTransport } from '../../src/main/shopify/shopify-admin'

const TOKEN = 'shpat_super_secret_admin_token_value'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function tokenStore(): ShopifyTokenStore {
  const dir = mkdtempSync(join(tmpdir(), 'lf-shopify-tok-'))
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('shopify', 'adminToken', TOKEN)
  creds.set('shopify', 'webhookSecret', 'whsec_value')
  return new ShopifyTokenStore(creds)
}

describe('ShopifyTokenStore', () => {
  it('round-trips the admin token via the main-only reveal exit', () => {
    const store = tokenStore()
    expect(store.adminToken()).toBe(TOKEN)
    expect(store.webhookSecret()).toBe('whsec_value')
    expect(store.hasAdminToken()).toBe(true)
  })

  it('surfaces a legible error (never the ciphertext) when nothing is stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-shopify-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    const store = new ShopifyTokenStore(creds)
    expect(() => store.adminToken()).toThrow(/No "shopify" credential "adminToken"/)
  })
})

describe('the admin token never leaks into any connector output or error', () => {
  // Wire a transport that carries the real token in its header (as production
  // would) and assert the token appears in NEITHER a resolved context NOR any
  // rejected error message — the never-render-secrets rule (spec §8, §11).
  it('keeps the token out of results and errors across success and failure paths', async () => {
    const store = tokenStore()
    const captured: string[] = []

    const transport: GraphqlTransport = async ({ query }) => {
      // The header the live transport WOULD send — proves the token flows in.
      const header = `X-Shopify-Access-Token: ${store.adminToken()}`
      expect(header).toContain(TOKEN)
      if (query.includes('order(')) {
        return {
          status: 200,
          body: { data: { order: { id: 'gid://shopify/Order/42', name: '#1001' } } }
        }
      }
      // A failure path: a mutation the store refuses.
      return {
        status: 200,
        body: {
          data: {
            refundCreate: { refund: null, userErrors: [{ field: ['orderId'], message: 'nope' }] }
          }
        }
      }
    }

    const connector = new ShopifyConnector({ api: new ShopifyAdminApi({ transport }) })

    const okOut = await connector.invokeAction('getOrder', { id: '42' })
    captured.push(JSON.stringify(okOut))

    await connector.invokeAction('refundOrder', { id: '42' }).catch((e: Error) => {
      captured.push(e.message)
      captured.push(e.stack ?? '')
    })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of captured) expect(s).not.toContain(TOKEN)
  })
})
