import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { ShopifyConnector } from '../../src/main/shopify/shopify-connector'
import { MockShopifyApi, type RawOrderNode } from '../../src/main/shopify/shopify-admin'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7, §12): the REAL IntegrationRegistry +
 * the REAL action-runner + the REAL selectEdges routing, driven over a
 * MockShopifyApi — no credentials, no network. Proves the §7 loop composes:
 * a refundRequested seed → getOrder writes normalized context → the router
 * selects the "paid" edge → refundOrder reaches the mock; and that a >$50 order
 * takes the human-gate branch instead.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const orderNode = (id: string, total: string, financial = 'PAID'): RawOrderNode => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  email: 'buyer@x.com',
  displayFinancialStatus: financial,
  displayFulfillmentStatus: 'UNFULFILLED',
  totalPriceSet: { shopMoney: { amount: total, currencyCode: 'USD' } },
  lineItems: { nodes: [{ id: 'li' }] }
})

function buildRegistry(api: MockShopifyApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-shopify-flow-'))
  const configFile = join(dir, 'config.json')
  // Enabled + all required non-secret refs present, secrets in the keychain →
  // status('shopify') === 'connected' so the action-runner lets the node run.
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        shopify: { enabled: true, shopDomain: 's.myshopify.com', environment: 1 }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('shopify', 'adminToken', 'shpat_x')
  creds.set('shopify', 'webhookSecret', 'whsec_x')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('shopify', new ShopifyConnector({ api }))
  return registry
}

const readNode: FlowNode = {
  id: 'read',
  type: 'action',
  integration: 'shopify',
  ref: 'getOrder',
  config: { params: { id: '{{t.orderId}}' } },
  position: { x: 0, y: 0 }
}

const routerGraph: FlowGraph = {
  id: 'refund-worker',
  name: 'refund on request',
  nodes: [readNode],
  edges: [
    {
      id: 'auto',
      from: 'route',
      to: 'refundOrder',
      condition: { field: 'read.order.financialStatus', equals: 'paid' }
    },
    {
      id: 'gate',
      from: 'route',
      to: 'approveRefund',
      condition: { field: 'read.order.financialStatus', equals: 'pending' }
    }
  ]
}

describe('offline Shopify ecom loop', () => {
  it('reads the order, routes on the normalized field, then refunds via the mock', async () => {
    const api = new MockShopifyApi({ orders: { '42': orderNode('42', '42.50') } })
    const registry = buildRegistry(api)

    // 1. Trigger seed lands in context['t'] (as the webhook subscribe would).
    const context: RunContext = { t: { orderId: '42', email: 'buyer@x.com' } }

    // 2. getOrder reads through the REAL registry delegation + action-runner.
    const read = await runAction({ registry }, readNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    expect((context.read as { order: { total: number } }).order).toMatchObject({
      total: 42.5,
      financialStatus: 'paid'
    })

    // 3. The router selects the paid (auto-refund) edge, not the gate edge.
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['auto'])

    // 4. The gated mutation reaches the admin client.
    const refundNode: FlowNode = {
      id: 'refundOrder',
      type: 'action',
      integration: 'shopify',
      ref: 'refundOrder',
      config: { params: { id: '{{t.orderId}}', restock: true } },
      position: { x: 0, y: 0 }
    }
    const refund = await runAction({ registry }, refundNode, context)
    expect(refund.status).toBe('done')
    expect(api.calls.refundCreate).toEqual([{ orderId: '42', amount: undefined, restock: true }])
  })

  it('routes a not-yet-paid order to the human-gate branch (no auto-refund edge)', async () => {
    const api = new MockShopifyApi({ orders: { '7': orderNode('7', '250.00', 'PENDING') } })
    const registry = buildRegistry(api)
    const context: RunContext = { t: { orderId: '7' } }
    const read = await runAction({ registry }, readNode, context)
    Object.assign(context, read.context)
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['gate'])
  })

  it('fails the node with the real Shopify cause when the mutation rejects', async () => {
    const api = new MockShopifyApi({ refundError: 'Order has already been fully refunded' })
    const registry = buildRegistry(api)
    const refundNode: FlowNode = {
      id: 'refundOrder',
      type: 'action',
      integration: 'shopify',
      ref: 'refundOrder',
      config: { params: { id: '42' } },
      position: { x: 0, y: 0 }
    }
    const outcome = await runAction({ registry }, refundNode, {})
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/already been fully refunded/)
  })
})
