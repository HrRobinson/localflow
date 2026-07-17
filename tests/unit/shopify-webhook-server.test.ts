import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startShopifyWebhookServer,
  verifyShopifySignature,
  type ShopifyWebhookServer,
  type ShopifyWebhookDelivery
} from '../../src/main/shopify/shopify-webhook-server'

const SECRET = 'whsec_test_secret'

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64')
}

let server: ShopifyWebhookServer | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function post(
  s: ShopifyWebhookServer,
  body: string,
  headers: Record<string, string>
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${s.port}/shopify/webhook`, {
    method: 'POST',
    headers,
    body
  })
  return res.status
}

const hdrs = (
  body: string,
  {
    topic = 'orders/create',
    id = 'wh-1',
    sig = sign(body)
  }: Partial<{ topic: string; id: string; sig: string }> = {}
): Record<string, string> => ({
  'content-type': 'application/json',
  'x-shopify-hmac-sha256': sig,
  'x-shopify-topic': topic,
  'x-shopify-webhook-id': id
})

describe('verifyShopifySignature', () => {
  it('accepts a correct base64 HMAC-SHA256 over the raw body', () => {
    const body = '{"id":1}'
    expect(verifyShopifySignature(Buffer.from(body), sign(body), SECRET)).toBe(true)
  })
  it('rejects a wrong signature, a non-string, and an empty secret', () => {
    const body = '{"id":1}'
    expect(verifyShopifySignature(Buffer.from(body), sign(body, 'other'), SECRET)).toBe(false)
    expect(verifyShopifySignature(Buffer.from(body), undefined, SECRET)).toBe(false)
    expect(verifyShopifySignature(Buffer.from(body), sign(body), '')).toBe(false)
  })
})

describe('shopify webhook server', () => {
  it('accepts a valid, signed, novel delivery and emits it once', async () => {
    const seen: ShopifyWebhookDelivery[] = []
    server = await startShopifyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"id":5123456789,"email":"b@x.com"}'
    expect(await post(server, body, hdrs(body))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ webhookId: 'wh-1', topic: 'orders/create' })
    expect(seen[0].payload).toEqual({ id: 5123456789, email: 'b@x.com' })
  })

  it('rejects a forged signature with 401 and never emits', async () => {
    const seen: ShopifyWebhookDelivery[] = []
    server = await startShopifyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"id":1}'
    expect(await post(server, body, hdrs(body, { sig: 'AAAA' }))).toBe(401)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('dedups a repeated X-Shopify-Webhook-Id with 200 and no second emit', async () => {
    const seen: ShopifyWebhookDelivery[] = []
    server = await startShopifyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"id":1}'
    expect(await post(server, body, hdrs(body, { id: 'dupe' }))).toBe(200)
    expect(await post(server, body, hdrs(body, { id: 'dupe' }))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
  })

  it('rejects malformed JSON with 400 and no emit', async () => {
    const seen: ShopifyWebhookDelivery[] = []
    server = await startShopifyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = 'not json'
    expect(await post(server, body, hdrs(body, { id: 'bad-json' }))).toBe(400)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('404s a wrong path', async () => {
    server = await startShopifyWebhookServer({ secret: SECRET, log: () => {} })
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  it('never logs the secret or the raw body', async () => {
    const logs: string[] = []
    server = await startShopifyWebhookServer({ secret: SECRET, log: (m) => logs.push(m) })
    const body = '{"id":1,"card":"4111111111111111"}'
    await post(server, body, hdrs(body, { sig: 'AAAA', id: 'leak-check' }))
    await new Promise((r) => setTimeout(r, 20))
    for (const line of logs) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain('4111111111111111')
    }
  })
})
