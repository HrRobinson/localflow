import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import type { IntegrationId } from '../../src/shared/integrations'
import { HostedIngressClient } from '../../src/main/hosted/hosted-ingress'
import {
  WebhookBindingRegistry,
  type HostedWebhookBinding
} from '../../src/main/hosted/webhook-bindings'
import { MockIngressSource, type Delivery } from '../../src/main/hosted/ingress-source'
import {
  shopifyWebhookBinding,
  type ShopifyWebhookDelivery
} from '../../src/main/shopify/shopify-webhook-server'
import { hubspotWebhookBinding } from '../../src/main/hubspot/hubspot-verifier'
import { HubspotConnector } from '../../src/main/hubspot/hubspot-connector'
import { githubWebhookBinding } from '../../src/main/github/github-webhook-server'
import { sentryWebhookBinding } from '../../src/main/sentry/sentry-webhook-server'
import { stripeWebhookBinding } from '../../src/main/stripe/stripe-webhook-server'
import { gitlabWebhookBinding } from '../../src/main/gitlab/gitlab-webhook-server'
import { linearWebhookBinding } from '../../src/main/linear/linear-webhook-server'
import { woocommerceWebhookBinding } from '../../src/main/woocommerce/wc-webhook-server'

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

  it('a binding whose parseHeader throws on attacker input → ack-drop, loop survives', async () => {
    // A verifier that throws while inspecting attacker-controlled headers (before
    // the secret compare). Without the guard this rejects out of handle() and
    // wedges the drain loop; with it, the throw is a permanent drop → ack.
    const throwingBinding: HostedWebhookBinding = {
      integration: 'github',
      verifier: {
        scheme: 'hmac',
        header: 'x-sig',
        parseHeader: () => {
          throw new Error('boom parsing attacker header')
        }
      },
      parse: () => null,
      deliver: () => {},
      secretRef: 'webhookSecret'
    }
    const poison: Delivery = {
      integration: 'github' as IntegrationId,
      ingressUrlId: 'url_poison',
      rawBody: '{"evil":true}',
      headers: { 'x-sig': 'anything' }
    }
    const delivered: ShopifyWebhookDelivery[] = []
    const acks = await run([poison, shopifyDelivery()], (r) => {
      r.register(throwingBinding)
      r.register(shopifyWebhookBinding((d) => void delivered.push(d)))
    })
    // Poison ack-dropped, then the good delivery still processed (loop not wedged).
    expect(acks).toEqual(['ack', 'ack'])
    expect(delivered).toHaveLength(1)
  })

  it('a binding whose preVerify throws → ack-drop, does not reject', async () => {
    const throwingBinding: HostedWebhookBinding = {
      integration: 'github',
      verifier: { scheme: 'hmac', header: 'x-sig' },
      parse: () => null,
      deliver: () => {},
      secretRef: 'webhookSecret',
      preVerify: () => {
        throw new Error('boom in preVerify')
      }
    }
    const poison: Delivery = {
      integration: 'github' as IntegrationId,
      ingressUrlId: 'url_poison2',
      rawBody: '{}',
      headers: { 'x-sig': 'anything' }
    }
    const acks = await run([poison], (r) => r.register(throwingBinding))
    expect(acks).toEqual(['ack'])
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

/**
 * Each remaining webhook connector's binding must route a relayed delivery to its
 * own verifier+parse+deliver (valid → ack + delivered once) and ack-drop a forged
 * one (verify-fail → ack, nothing delivered). Same ack-table pattern as above,
 * one integration per test. All six connectors key their signing secret under the
 * 'webhookSecret' keychain field, so each test injects `reveal` for that field.
 */
describe('HostedIngressClient — remaining connector bindings route + verify', () => {
  const hex = (secret: string, body: string): string =>
    createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  const b64 = (secret: string, body: string): string =>
    createHmac('sha256', secret).update(body, 'utf8').digest('base64')

  it('github: valid → ack + delivered; forged → ack-drop', async () => {
    const SECRET = 'gh_wh_secret'
    const body = '{"action":"opened"}'
    const base: Delivery = {
      integration: 'github',
      ingressUrlId: 'url_gh',
      rawBody: body,
      headers: {
        'x-hub-signature-256': `sha256=${hex(SECRET, body)}`,
        'x-github-event': 'issues',
        'x-github-delivery': 'gh-1'
      }
    }
    const delivered: unknown[] = []
    const ok = await run(
      [base],
      (r) => r.register(githubWebhookBinding((d) => void delivered.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(ok).toEqual(['ack'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ event: 'issues', deliveryId: 'gh-1' })

    const dropped: unknown[] = []
    const forged: Delivery = {
      ...base,
      headers: {
        ...base.headers,
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-delivery': 'gh-2'
      }
    }
    const bad = await run(
      [forged],
      (r) => r.register(githubWebhookBinding((d) => void dropped.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(bad).toEqual(['ack'])
    expect(dropped).toHaveLength(0)
  })

  it('sentry: valid → ack + delivered; forged → ack-drop', async () => {
    const SECRET = 'sentry_wh_secret'
    const body = '{"action":"created"}'
    const base: Delivery = {
      integration: 'sentry',
      ingressUrlId: 'url_sy',
      rawBody: body,
      headers: {
        'sentry-hook-signature': hex(SECRET, body),
        'sentry-hook-resource': 'issue',
        'request-id': 'sy-1'
      }
    }
    const delivered: unknown[] = []
    const ok = await run(
      [base],
      (r) => r.register(sentryWebhookBinding((d) => void delivered.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(ok).toEqual(['ack'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ resource: 'issue', action: 'created' })

    const dropped: unknown[] = []
    const forged: Delivery = {
      ...base,
      headers: { ...base.headers, 'sentry-hook-signature': 'deadbeef', 'request-id': 'sy-2' }
    }
    const bad = await run(
      [forged],
      (r) => r.register(sentryWebhookBinding((d) => void dropped.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(bad).toEqual(['ack'])
    expect(dropped).toHaveLength(0)
  })

  it('stripe: valid → ack + delivered; forged → ack-drop', async () => {
    const SECRET = 'stripe_wh_secret'
    const body = '{"id":"evt_1","type":"charge.refunded","data":{"object":{"id":"ch_1"}}}'
    const t = Math.floor(Date.now() / 1000)
    const base: Delivery = {
      integration: 'stripe',
      ingressUrlId: 'url_st',
      rawBody: body,
      headers: { 'stripe-signature': `t=${t},v1=${hex(SECRET, `${t}.${body}`)}` }
    }
    const delivered: unknown[] = []
    const ok = await run(
      [base],
      (r) => r.register(stripeWebhookBinding((d) => void delivered.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(ok).toEqual(['ack'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ eventId: 'evt_1', type: 'charge.refunded' })

    const dropped: unknown[] = []
    const forged: Delivery = { ...base, headers: { 'stripe-signature': `t=${t},v1=deadbeef` } }
    const bad = await run(
      [forged],
      (r) => r.register(stripeWebhookBinding((d) => void dropped.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(bad).toEqual(['ack'])
    expect(dropped).toHaveLength(0)
  })

  it('gitlab: valid token → ack + delivered; wrong token → ack-drop', async () => {
    const SECRET = 'gitlab_wh_token'
    const body = JSON.stringify({
      object_kind: 'pipeline',
      object_attributes: { id: 555, status: 'failed', ref: 'main', sha: 'abc' },
      project: { id: 7 }
    })
    const base: Delivery = {
      integration: 'gitlab',
      ingressUrlId: 'url_gl',
      rawBody: body,
      headers: {
        'x-gitlab-token': SECRET,
        'x-gitlab-event': 'Pipeline Hook',
        'x-gitlab-event-uuid': 'gl-1'
      }
    }
    const delivered: unknown[] = []
    const ok = await run(
      [base],
      (r) => r.register(gitlabWebhookBinding((d) => void delivered.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(ok).toEqual(['ack'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ triggerId: 'pipeline.failed', deliveryId: 'gl-1' })

    const dropped: unknown[] = []
    const forged: Delivery = {
      ...base,
      headers: { ...base.headers, 'x-gitlab-token': 'wrong', 'x-gitlab-event-uuid': 'gl-2' }
    }
    const bad = await run(
      [forged],
      (r) => r.register(gitlabWebhookBinding((d) => void dropped.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(bad).toEqual(['ack'])
    expect(dropped).toHaveLength(0)
  })

  it('linear: valid → ack + delivered; forged → ack-drop', async () => {
    const SECRET = 'linear_wh_secret'
    const body = JSON.stringify({ action: 'created', agentSession: { id: 'sess-1' } })
    const base: Delivery = {
      integration: 'linear',
      ingressUrlId: 'url_ln',
      rawBody: body,
      headers: { 'linear-signature': hex(SECRET, body) }
    }
    const delivered: unknown[] = []
    const ok = await run(
      [base],
      (r) => r.register(linearWebhookBinding((d) => void delivered.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(ok).toEqual(['ack'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ action: 'created', agentSession: { id: 'sess-1' } })

    const dropped: unknown[] = []
    const forged: Delivery = { ...base, headers: { 'linear-signature': 'deadbeef' } }
    const bad = await run(
      [forged],
      (r) => r.register(linearWebhookBinding((d) => void dropped.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(bad).toEqual(['ack'])
    expect(dropped).toHaveLength(0)
  })

  it('woocommerce: valid → ack + delivered; forged → ack-drop', async () => {
    const SECRET = 'woo_wh_secret'
    const body = JSON.stringify({
      id: 4242,
      total: '129.95',
      currency: 'USD',
      status: 'processing'
    })
    const base: Delivery = {
      integration: 'woocommerce',
      ingressUrlId: 'url_wc',
      rawBody: body,
      headers: {
        'x-wc-webhook-signature': b64(SECRET, body),
        'x-wc-webhook-topic': 'order.created',
        'x-wc-webhook-delivery-id': 'wc-1'
      }
    }
    const delivered: unknown[] = []
    const ok = await run(
      [base],
      (r) => r.register(woocommerceWebhookBinding((d) => void delivered.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(ok).toEqual(['ack'])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ topic: 'order.created', deliveryId: 'wc-1' })

    const dropped: unknown[] = []
    const forged: Delivery = {
      ...base,
      headers: {
        ...base.headers,
        'x-wc-webhook-signature': 'AAAA',
        'x-wc-webhook-delivery-id': 'wc-2'
      }
    }
    const bad = await run(
      [forged],
      (r) => r.register(woocommerceWebhookBinding((d) => void dropped.push(d))),
      {
        reveal: () => SECRET
      }
    )
    expect(bad).toEqual(['ack'])
    expect(dropped).toHaveLength(0)
  })
})

/**
 * Per-delivery `publicUrl` reconciliation: the relay stamps each delivery with the
 * PUBLIC URL it arrived on, so a URL-signed scheme (HubSpot v3) must verify each
 * delivery against ITS OWN url — not one static binding URL. A tenant with two
 * HubSpot URLs (A registered on the binding, B carried per-delivery) proves it:
 * a delivery signed for B with `delivery.publicUrl = B` verifies and delivers,
 * while the same body WITHOUT the per-delivery url falls back to the binding's A
 * and fails to verify (ack-drop).
 */
describe('HostedIngressClient — per-delivery publicUrl reconciliation', () => {
  it('a HubSpot delivery signed for URL-B verifies against delivery.publicUrl=URL-B, not the binding URL-A', async () => {
    const URL_A = 'https://relay.example.com/t/aaa/hubspot'
    const URL_B = 'https://relay.example.com/t/bbb/hubspot'
    const seeds: unknown[] = []
    const ts = Date.now()

    const sigFor = (url: string, body: string): string =>
      createHmac('sha256', HUBSPOT_SECRET).update(`POST${url}${body}${ts}`, 'utf8').digest('base64')

    const bodyB = JSON.stringify([
      { subscriptionType: 'contact.creation', objectId: 7, eventId: 'evt-B', occurredAt: ts }
    ])
    const withB: Delivery = {
      integration: 'hubspot',
      ingressUrlId: 'url_b',
      rawBody: bodyB,
      publicUrl: URL_B, // per-delivery — must win over the binding's URL_A
      headers: {
        'x-hubspot-signature-v3': sigFor(URL_B, bodyB),
        'x-hubspot-request-timestamp': String(ts)
      }
    }
    // Same signing URL (B) but NO per-delivery publicUrl → falls back to the
    // binding's URL_A → verification fails → ack-drop, never delivered.
    const bodyFallback = JSON.stringify([
      { subscriptionType: 'contact.creation', objectId: 8, eventId: 'evt-fallback', occurredAt: ts }
    ])
    const withoutUrl: Delivery = {
      integration: 'hubspot',
      ingressUrlId: 'url_a',
      rawBody: bodyFallback,
      headers: {
        'x-hubspot-signature-v3': sigFor(URL_B, bodyFallback),
        'x-hubspot-request-timestamp': String(ts)
      }
    }

    const connector = new HubspotConnector({ api: {} as never, log: () => {} })
    connector.subscribe('contact.created', (e) => seeds.push(e))
    const acks = await run([withB, withoutUrl], (r) =>
      r.register(hubspotWebhookBinding((events) => connector.deliver(events), { publicUrl: URL_A }))
    )

    expect(acks).toEqual(['ack', 'ack']) // first delivered, second verify-fail ack-drop
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({ eventId: 'evt-B' })
  })
})
