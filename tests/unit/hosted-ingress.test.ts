import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import type { IntegrationId } from '../../src/shared/integrations'
import { HostedIngressClient } from '../../src/main/hosted/hosted-ingress'
import { WebhookBindingRegistry } from '../../src/main/hosted/webhook-bindings'
import { MockIngressSource, type Delivery } from '../../src/main/hosted/ingress-source'
import {
  shopifyWebhookBinding,
  type ShopifyWebhookDelivery
} from '../../src/main/shopify/shopify-webhook-server'
import { hubspotWebhookBinding } from '../../src/main/hubspot/hubspot-verifier'
import { HubspotConnector } from '../../src/main/hubspot/hubspot-connector'

const SHOPIFY_SECRET = 'shpss_webhook_secret'
const HUBSPOT_SECRET = 'hubspot_client_secret'
const BODY = '{"id":123,"total_price":"42.00"}'

function shopifySig(body: string, secret = SHOPIFY_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64')
}

function shopifyDelivery(over: Partial<Delivery> = {}, body = BODY): Delivery {
  return {
    integration: 'shopify',
    ingressUrlId: 'url_shop',
    rawBody: body,
    headers: {
      'x-shopify-hmac-sha256': shopifySig(body),
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': 'wh-1'
    },
    ...over
  }
}

function reveal(_integration: IntegrationId, ref: string): string {
  if (ref === 'webhookSecret') return SHOPIFY_SECRET
  if (ref === 'webhookClientSecret') return HUBSPOT_SECRET
  throw new Error(`unexpected secretRef ${ref}`)
}

async function run(deliveries: Delivery[], setup: (r: WebhookBindingRegistry) => void, deps = {}) {
  const registry = new WebhookBindingRegistry()
  setup(registry)
  const client = new HostedIngressClient({ registry, reveal, ...deps })
  const source = new MockIngressSource(deliveries)
  client.start(source)
  await source.settled
  return source.acks.map((a) => a.ack)
}

describe('HostedIngressClient — ack decision table', () => {
  it('verified + parsed + deliver resolves → ack, deliver gets the delivery', async () => {
    const delivered: ShopifyWebhookDelivery[] = []
    const acks = await run([shopifyDelivery()], (r) =>
      r.register(
        shopifyWebhookBinding((d) => {
          delivered.push(d)
        })
      )
    )
    expect(acks).toEqual(['ack'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ topic: 'orders/create', webhookId: 'wh-1' })
  })

  it('forged signature → ack-drop, and the secret + body never reach a log', async () => {
    const logs: string[] = []
    const delivered: unknown[] = []
    const forged = shopifyDelivery({
      headers: {
        'x-shopify-hmac-sha256': 'AAAA',
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'wh-forged'
      }
    })
    const acks = await run(
      [forged],
      (r) =>
        r.register(
          shopifyWebhookBinding((d) => {
            delivered.push(d)
          })
        ),
      { log: (m: string) => logs.push(m) }
    )
    expect(acks).toEqual(['ack']) // permanent failure → ack-drop
    expect(delivered).toHaveLength(0)
    const joined = logs.join('\n')
    expect(joined).not.toContain(SHOPIFY_SECRET)
    expect(joined).not.toContain(BODY)
    expect(joined).not.toContain('42.00')
  })

  it('redelivered Shopify webhook id → dedup drop → ack (delivered once)', async () => {
    const delivered: ShopifyWebhookDelivery[] = []
    // Same binding instance across both deliveries so the dedup seen-set persists.
    const binding = shopifyWebhookBinding((d) => {
      delivered.push(d)
    })
    const acks = await run([shopifyDelivery(), shopifyDelivery()], (r) => r.register(binding))
    expect(acks).toEqual(['ack', 'ack'])
    expect(delivered).toHaveLength(1) // second was a dedup drop
  })

  it('unparseable body → ack-drop', async () => {
    const acks = await run([shopifyDelivery({}, 'not-json')], (r) =>
      r.register(shopifyWebhookBinding(() => {}))
    )
    expect(acks).toEqual(['ack'])
  })

  it('no binding for the integration → nack (transient, wire it and redeliver)', async () => {
    const logs: string[] = []
    const acks = await run(
      [{ ...shopifyDelivery(), integration: 'github' as IntegrationId }],
      () => {},
      { log: (m: string) => logs.push(m) }
    )
    expect(acks).toEqual(['nack'])
    expect(logs.join('\n')).toMatch(/no connector is wired for 'github'/)
  })

  it('reveal throws (locked keychain) → nack, and surfaces the reveal error', async () => {
    const logs: string[] = []
    const acks = await run(
      [shopifyDelivery()],
      (r) => r.register(shopifyWebhookBinding(() => {})),
      {
        reveal: () => {
          throw new Error("safeStorage: can't decrypt — re-enter it in the Integrations tab.")
        },
        log: (m: string) => logs.push(m)
      }
    )
    expect(acks).toEqual(['nack'])
    expect(logs.join('\n')).toMatch(/safeStorage/)
  })

  it('deliver throws → nack, the loop survives and the next delivery still processes', async () => {
    let calls = 0
    const binding = shopifyWebhookBinding(() => {
      calls += 1
      if (calls === 1) throw new Error('flow engine down')
    })
    const first = shopifyDelivery({ ingressUrlId: 'a' })
    const second = shopifyDelivery({
      ingressUrlId: 'b',
      headers: {
        'x-shopify-hmac-sha256': shopifySig(BODY),
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'wh-2'
      }
    })
    const acks = await run([first, second], (r) => r.register(binding))
    expect(acks).toEqual(['nack', 'ack'])
    expect(calls).toBe(2) // second was still processed after the first threw
  })

  it('HubSpot delivery verifies via the binding publicUrl and delivers a SeedEvent', async () => {
    const seeds: unknown[] = []
    const PUBLIC_URL = 'https://relay.example.com/t/abc/hubspot'
    const ts = Date.now()
    const hubBody = JSON.stringify([
      {
        subscriptionType: 'contact.creation',
        objectId: 42,
        eventId: 'evt-9',
        occurredAt: ts
      }
    ])
    const base = `POST${PUBLIC_URL}${hubBody}${ts}`
    const sig = createHmac('sha256', HUBSPOT_SECRET).update(base, 'utf8').digest('base64')
    const delivery: Delivery = {
      integration: 'hubspot',
      ingressUrlId: 'url_hub',
      rawBody: hubBody,
      headers: {
        'x-hubspot-signature-v3': sig,
        'x-hubspot-request-timestamp': String(ts)
      }
    }
    // A real connector so the delivered value is the same SeedEvent the loopback
    // path produces. Subscribe a handler to the contact-created trigger.
    const connector = new HubspotConnector({
      api: {} as never,
      log: () => {}
    })
    connector.subscribe('contact.created', (e) => seeds.push(e))
    const acks = await run([delivery], (r) =>
      r.register(
        hubspotWebhookBinding((events) => connector.deliver(events), { publicUrl: PUBLIC_URL })
      )
    )
    expect(acks).toEqual(['ack'])
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({ eventId: 'evt-9' })
  })
})
