import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { StripeConnector } from '../../src/main/stripe/stripe-connector'
import { MockStripeApi, type RawCharge } from '../../src/main/stripe/stripe-client'
import { ShopifyConnector } from '../../src/main/shopify/shopify-connector'
import { MockShopifyApi, type RawOrderNode } from '../../src/main/shopify/shopify-admin'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7.3, §12): the REAL IntegrationRegistry +
 * the REAL action-runner + the REAL selectEdges routing, driven over BOTH a
 * MockStripeApi AND a MockShopifyApi — no credentials, no network. Proves the §7.3
 * loop: a Stripe dispute seed → getCharge writes a MAJOR-unit charge.amount →
 * Shopify searchOrders writes an order.total in the SAME unit → a cross-connector
 * edge (`currency ==`, `total lte 50`) selects the accept-&-refund branch → the
 * gated createRefund reaches the Stripe mock. This is the test that proves the
 * money convention makes the composition correct.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const charge: RawCharge = {
  id: 'ch_42',
  amount: 5000, // MINOR — 50.00 USD
  currency: 'usd',
  status: 'succeeded',
  paid: true,
  disputed: true,
  customer: 'cus_1',
  receipt_email: 'buyer@x.com'
}

const order: RawOrderNode = {
  id: 'gid://shopify/Order/900',
  name: '#900',
  email: 'buyer@x.com',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  totalPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } },
  lineItems: { nodes: [{ id: 'li' }] }
}

function buildRegistry(stripeApi: MockStripeApi, shopifyApi: MockShopifyApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-stripe-flow-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        stripe: { enabled: true, environment: 1 },
        shopify: { enabled: true, shopDomain: 's.myshopify.com', environment: 1 }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('stripe', 'restrictedKey', 'rk_test_x')
  creds.set('stripe', 'webhookSecret', 'whsec_x')
  creds.set('shopify', 'adminToken', 'shpat_x')
  creds.set('shopify', 'webhookSecret', 'whsec_y')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('stripe', new StripeConnector({ api: stripeApi }))
  registry.registerConnector('shopify', new ShopifyConnector({ api: shopifyApi }))
  return registry
}

const getChargeNode: FlowNode = {
  id: 'charge',
  type: 'action',
  integration: 'stripe',
  ref: 'getCharge',
  config: { params: { id: '{{t.chargeId}}' } },
  position: { x: 0, y: 0 }
}

const searchOrdersNode: FlowNode = {
  id: 'order',
  type: 'action',
  integration: 'shopify',
  ref: 'searchOrders',
  config: { params: { email: '{{charge.charge.email}}' } },
  position: { x: 0, y: 0 }
}

// Cross-connector router (§7.3): reads BOTH {{stripe.charge.*}} and {{shopify.order.*}}.
const routerGraph: FlowGraph = {
  id: 'dispute-worker',
  name: 'dispute → order context → gated refund',
  nodes: [getChargeNode, searchOrdersNode],
  edges: [
    // Accept-&-refund: the Shopify order total is ≤ $50 (numeric, MAJOR units).
    {
      id: 'refund',
      from: 'route',
      to: 'acceptGate',
      condition: { field: 'order.orders.0.order.total', op: 'lte', value: 50 }
    },
    // Contest: larger orders route to the contest gate instead.
    {
      id: 'contest',
      from: 'route',
      to: 'contestGate',
      condition: { field: 'order.orders.0.order.total', op: 'gt', value: 50 }
    }
  ]
}

describe('offline Stripe × Shopify dispute→refund composition (§7.3)', () => {
  it('reads both connectors on the SAME money scale and routes + refunds correctly', async () => {
    const stripeApi = new MockStripeApi({ charges: { ch_42: charge } })
    const shopifyApi = new MockShopifyApi({ searchResults: [order] })
    const registry = buildRegistry(stripeApi, shopifyApi)

    // 1. The verified dispute event seeds context['t'] (as the webhook subscribe would).
    const context: RunContext = {
      t: { chargeId: 'ch_42', disputeId: 'dp_1', amount: 50, currency: 'USD' }
    }

    // 2. getCharge through the REAL registry → normalized MAJOR-unit charge context.
    const read = await runAction({ registry }, getChargeNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    const chargeCtx = (
      context.charge as { charge: { amount: number; currency: string; email: string } }
    ).charge
    expect(chargeCtx).toMatchObject({ amount: 50, currency: 'USD' })

    // 3. Shopify searchOrders (email templated from the charge) → order context.
    const orderRead = await runAction({ registry }, searchOrdersNode, context)
    expect(orderRead.status).toBe('done')
    Object.assign(context, orderRead.context)
    const orderCtx = (context.order as { orders: { order: { total: number; currency: string } }[] })
      .orders[0].order

    // ── THE EQUAL-SCALE PROOF: Stripe charge.amount and Shopify order.total are
    //    the SAME number + SAME currency casing through the real engine (§6.3). ──
    expect(chargeCtx.amount).toBe(orderCtx.total)
    expect(chargeCtx.amount).toBe(50)
    expect(chargeCtx.currency).toBe(orderCtx.currency)
    expect(chargeCtx.currency).toBe('USD')

    // 4. The cross-connector router selects the accept-&-refund branch (≤ $50).
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['refund'])

    // 5. The gated mutation reaches the Stripe client (MAJOR 50 → MINOR 5000).
    const refundNode: FlowNode = {
      id: 'doRefund',
      type: 'action',
      integration: 'stripe',
      ref: 'createRefund',
      config: { params: { id: '{{t.chargeId}}', amount: '{{t.amount}}', reason: 'fraudulent' } },
      position: { x: 0, y: 0 }
    }
    const refund = await runAction({ registry }, refundNode, context)
    expect(refund.status).toBe('done')
    expect(stripeApi.calls.createRefund).toHaveLength(1)
    expect(stripeApi.calls.createRefund[0]).toMatchObject({
      chargeId: 'ch_42',
      amount: 5000,
      reason: 'fraudulent'
    })
  })

  it('routes a larger order to the contest branch (no auto-refund edge)', async () => {
    const stripeApi = new MockStripeApi({ charges: { ch_42: charge } })
    const shopifyApi = new MockShopifyApi({
      searchResults: [
        { ...order, totalPriceSet: { shopMoney: { amount: '250.00', currencyCode: 'USD' } } }
      ]
    })
    const registry = buildRegistry(stripeApi, shopifyApi)
    const context: RunContext = { t: { chargeId: 'ch_42' } }
    Object.assign(context, (await runAction({ registry }, getChargeNode, context)).context)
    Object.assign(context, (await runAction({ registry }, searchOrdersNode, context)).context)
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['contest'])
    // No refund happened by merely reading + routing (never-auto-run, §9).
    expect(stripeApi.calls.createRefund).toHaveLength(0)
  })

  it('fails the node with the real Stripe cause when the mutation rejects', async () => {
    const stripeApi = new MockStripeApi({
      refundError: 'charge already fully refunded (`charge_already_refunded`)'
    })
    const registry = buildRegistry(stripeApi, new MockShopifyApi({}))
    const refundNode: FlowNode = {
      id: 'doRefund',
      type: 'action',
      integration: 'stripe',
      ref: 'createRefund',
      config: { params: { id: 'ch_42' } },
      position: { x: 0, y: 0 }
    }
    const outcome = await runAction({ registry }, refundNode, {})
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/already fully refunded/)
  })
})
