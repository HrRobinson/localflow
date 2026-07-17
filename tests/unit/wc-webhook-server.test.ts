import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  verifyWcSignature,
  startWcWebhookServer,
  WC_MAX_BODY_BYTES,
  WC_SIGNATURE_HEADER,
  WC_TOPIC_HEADER,
  type WcWebhookServer,
  type WcWebhookEvent
} from '../../src/main/woocommerce/wc-webhook-server'

const SECRET = 'whsec_woo_test_secret'

/** WC signs the RAW body with base64 HMAC-SHA256 (spec §2.3) — NOT hex. */
function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

const orderBody = (): string =>
  JSON.stringify({
    id: 4242,
    total: '129.95',
    currency: 'USD',
    status: 'processing',
    customer_id: 7,
    billing: { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' }
  })

describe('verifyWcSignature', () => {
  it('accepts a correct base64 HMAC-SHA256 over the raw body', () => {
    const body = orderBody()
    expect(verifyWcSignature(Buffer.from(body), sign(body), SECRET)).toBe(true)
  })
  it('rejects a wrong signature, an empty signature, and an empty secret', () => {
    const body = orderBody()
    expect(verifyWcSignature(Buffer.from(body), sign(body, 'nope'), SECRET)).toBe(false)
    expect(verifyWcSignature(Buffer.from(body), '', SECRET)).toBe(false)
    expect(verifyWcSignature(Buffer.from(body), sign(body), '')).toBe(false)
  })
})

describe('startWcWebhookServer', () => {
  let server: WcWebhookServer
  afterEach(() => server?.close())

  async function post(body: string, headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/woocommerce/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body
    })
  }

  it('delivers a valid, signed order.created event with a normalized payload', async () => {
    const received: WcWebhookEvent[] = []
    server = await startWcWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))

    const body = orderBody()
    const res = await post(body, {
      [WC_SIGNATURE_HEADER]: sign(body),
      [WC_TOPIC_HEADER]: 'order.created',
      'x-wc-webhook-delivery-id': 'del-1'
    })
    await flush()

    expect(res.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0].topic).toBe('order.created')
    expect(received[0].deliveryId).toBe('del-1')
    expect(received[0].payload.order.total).toBe(129.95)
    expect(received[0].payload.customer.email).toBe('ada@example.com')
  })

  it('rejects an invalid HMAC (401) and never calls the handler', async () => {
    const received: WcWebhookEvent[] = []
    server = await startWcWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))
    const body = orderBody()
    const res = await post(body, { [WC_SIGNATURE_HEADER]: sign(body, 'wrong'), [WC_TOPIC_HEADER]: 'order.created' })
    await flush()
    expect(res.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('rejects a missing signature (401)', async () => {
    const received: WcWebhookEvent[] = []
    server = await startWcWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))
    const res = await post(orderBody(), { [WC_TOPIC_HEADER]: 'order.created' })
    await flush()
    expect(res.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('200s a ping (no topic header) WITHOUT spawning a run', async () => {
    const received: WcWebhookEvent[] = []
    server = await startWcWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))
    const res = await post('webhook_id=12', {})
    await flush()
    expect(res.status).toBe(200)
    expect(received).toHaveLength(0)
  })

  it('rejects oversized bodies (413) before verifying or parsing', async () => {
    const received: WcWebhookEvent[] = []
    server = await startWcWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))
    const huge = 'x'.repeat(WC_MAX_BODY_BYTES + 1)
    const body = JSON.stringify({ id: 1, pad: huge })
    const res = await post(body, { [WC_SIGNATURE_HEADER]: sign(body), [WC_TOPIC_HEADER]: 'order.created' })
    await flush()
    expect(res.status).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('rejects a well-signed but malformed order payload (400)', async () => {
    const received: WcWebhookEvent[] = []
    server = await startWcWebhookServer({ secret: SECRET })
    server.onEvent((e) => received.push(e))
    const body = 'definitely not json'
    const res = await post(body, { [WC_SIGNATURE_HEADER]: sign(body), [WC_TOPIC_HEADER]: 'order.created' })
    await flush()
    expect(res.status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('rejects a wrong path/method (404)', async () => {
    server = await startWcWebhookServer({ secret: SECRET })
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('never writes the signing secret or the raw body into any log line', async () => {
    const logs: string[] = []
    server = await startWcWebhookServer({ secret: SECRET, log: (m) => logs.push(m) })
    server.onEvent(() => {
      throw new Error('handler blew up')
    })
    const body = JSON.stringify({ id: 'order-body-marker', billing: { email: 'x@y.z' } })
    await post(body, { [WC_SIGNATURE_HEADER]: sign(body, 'wrong'), [WC_TOPIC_HEADER]: 'order.created' })
    await post(body, { [WC_SIGNATURE_HEADER]: sign(body), [WC_TOPIC_HEADER]: 'order.created' })
    await flush()
    const joined = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(joined).not.toContain(SECRET)
    expect(joined).not.toContain('order-body-marker')
  })
})
