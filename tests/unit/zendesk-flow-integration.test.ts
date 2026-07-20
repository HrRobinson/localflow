import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { ZendeskConnector } from '../../src/main/zendesk/zendesk-connector'
import { MockZendeskApi, type RawTicket } from '../../src/main/zendesk/zendesk-api'
import { ShopifyConnector } from '../../src/main/shopify/shopify-connector'
import { MockShopifyApi, type RawOrderNode } from '../../src/main/shopify/shopify-admin'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7.3, §12): the REAL IntegrationRegistry +
 * the REAL action-runner + the REAL selectEdges routing, driven over BOTH a
 * MockZendeskApi AND a MockShopifyApi — no credentials, no network. Proves the §7.3
 * loop: a ticket.commentAdded seed → getTicket writes the requesterEmail → Shopify
 * searchOrders JOINS on that SAME email → a cross-connector edge routes to the
 * reply branch → NO write happens during read+route (never-auto-run, §9) → only the
 * GATED replyToTicket node posts the public reply, exactly once.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const ticket: RawTicket = {
  id: 35436,
  subject: 'Where is my order?',
  status: 'open',
  priority: 'high',
  requester_email: 'buyer@x.com',
  requester_id: 771,
  tags: ['shipping']
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

function buildRegistry(
  zendeskApi: MockZendeskApi,
  shopifyApi: MockShopifyApi
): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-zendesk-flow-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        zendesk: {
          enabled: true,
          subdomain: 'your-co',
          agentEmail: 'agent@your-co.com',
          environment: 1
        },
        shopify: { enabled: true, shopDomain: 's.myshopify.com', environment: 1 }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('zendesk', 'apiToken', 'zdtok_x')
  creds.set('zendesk', 'webhookSecret', 'whsec_x')
  creds.set('shopify', 'adminToken', 'shpat_x')
  creds.set('shopify', 'webhookSecret', 'whsec_y')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('zendesk', new ZendeskConnector({ api: zendeskApi }))
  registry.registerConnector('shopify', new ShopifyConnector({ api: shopifyApi }))
  return registry
}

const getTicketNode: FlowNode = {
  id: 'ticket',
  type: 'action',
  integration: 'zendesk',
  ref: 'getTicket',
  config: { params: { id: '{{t.ticketId}}' } },
  position: { x: 0, y: 0 }
}

const searchOrdersNode: FlowNode = {
  id: 'order',
  type: 'action',
  integration: 'shopify',
  ref: 'searchOrders',
  config: { params: { email: '{{ticket.ticket.requesterEmail}}' } },
  position: { x: 0, y: 0 }
}

// Cross-connector router (§7.3): reads BOTH {{ticket.ticket.*}} and {{order.orders.0.order.*}}.
const routerGraph: FlowGraph = {
  id: 'support-worker',
  name: 'ticket reply → order context → gated public reply',
  nodes: [getTicketNode, searchOrdersNode],
  edges: [
    {
      id: 'reply',
      from: 'route',
      to: 'replyGate',
      condition: { field: 'order.orders.0.order.fulfillmentStatus', op: 'eq', value: 'fulfilled' }
    },
    {
      id: 'escalate',
      from: 'route',
      to: 'escalateGate',
      condition: { field: 'order.orders.0.order.fulfillmentStatus', op: 'ne', value: 'fulfilled' }
    }
  ]
}

describe('offline Zendesk × Shopify support→reply composition (§7.3, §9)', () => {
  it('joins on requesterEmail, routes, and posts the public reply ONLY at the gated node', async () => {
    const zendeskApi = new MockZendeskApi({ tickets: { '35436': ticket } })
    const shopifyApi = new MockShopifyApi({ searchResults: [order] })
    const registry = buildRegistry(zendeskApi, shopifyApi)

    // 1. The verified webhook seeds context['t'] (as the subscribe would).
    const context: RunContext = {
      t: { ticketId: '35436', requesterEmail: 'buyer@x.com', type: 'ticket.commentAdded' }
    }

    // 2. getTicket through the REAL registry → normalized ticket context.
    const read = await runAction({ registry }, getTicketNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    const ticketCtx = (context.ticket as { ticket: { requesterEmail: string; status: string } })
      .ticket
    expect(ticketCtx).toMatchObject({ requesterEmail: 'buyer@x.com', status: 'open' })

    // 3. Shopify searchOrders (email templated from the ticket) → order context.
    const orderRead = await runAction({ registry }, searchOrdersNode, context)
    expect(orderRead.status).toBe('done')
    Object.assign(context, orderRead.context)
    const orderCtx = (context.order as { orders: { order: { email: string } }[] }).orders[0].order

    // ── THE CROSS-CONNECTOR JOIN PROOF: the ticket requesterEmail and the Shopify
    //    order email are the SAME normalized string through the real engine (§6.3). ──
    expect(ticketCtx.requesterEmail).toBe(orderCtx.email)
    expect(ticketCtx.requesterEmail).toBe('buyer@x.com')

    // 4. The cross-connector router selects the reply branch.
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['reply'])

    // 5. NEVER-AUTO-RUN: reading + routing made ZERO Zendesk writes (§9).
    expect(zendeskApi.calls.updateTicket).toHaveLength(0)

    // 6. Only the GATED replyToTicket node (downstream of the author's gate, run
    //    here to simulate post-approval) posts the public reply — exactly once.
    const replyNode: FlowNode = {
      id: 'doReply',
      type: 'action',
      integration: 'zendesk',
      ref: 'replyToTicket',
      config: {
        params: { id: '{{t.ticketId}}', body: 'Your order #900 shipped — tracking attached.' }
      },
      position: { x: 0, y: 0 }
    }
    const reply = await runAction({ registry }, replyNode, context)
    expect(reply.status).toBe('done')
    expect(zendeskApi.calls.updateTicket).toHaveLength(1)
    expect(zendeskApi.calls.updateTicket[0]).toEqual({
      ticketId: '35436',
      comment: { body: 'Your order #900 shipped — tracking attached.', public: true }
    })

    // 7. The follow-up setStatus(solved) carries NO comment.
    const solveNode: FlowNode = {
      id: 'doSolve',
      type: 'action',
      integration: 'zendesk',
      ref: 'setStatus',
      config: { params: { id: '{{t.ticketId}}', status: 'solved' } },
      position: { x: 0, y: 0 }
    }
    await runAction({ registry }, solveNode, context)
    expect(zendeskApi.calls.updateTicket[1]).toEqual({ ticketId: '35436', status: 'solved' })
    expect(zendeskApi.calls.updateTicket[1].comment).toBeUndefined()
  })

  it('fails the node with the real Zendesk cause when the mutation rejects (§11)', async () => {
    const zendeskApi = new MockZendeskApi({
      updateError: 'cannot reply to a closed ticket (`details: status`)'
    })
    const registry = buildRegistry(zendeskApi, new MockShopifyApi({}))
    const replyNode: FlowNode = {
      id: 'doReply',
      type: 'action',
      integration: 'zendesk',
      ref: 'replyToTicket',
      config: { params: { id: '35436', body: 'hi' } },
      position: { x: 0, y: 0 }
    }
    const outcome = await runAction({ registry }, replyNode, {})
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/cannot reply to a closed ticket/)
  })
})
