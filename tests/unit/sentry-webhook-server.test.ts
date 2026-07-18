import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startSentryWebhookServer,
  verifySentrySignature,
  type SentryWebhookServer,
  type SentryWebhookDelivery
} from '../../src/main/sentry/sentry-webhook-server'

const SECRET = 'whsec_sentry_client_secret'

/** Sentry signs the RAW body with HEX HMAC-SHA256 (§4.4) — NOT base64. */
function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')
}

let server: SentryWebhookServer | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function post(
  s: SentryWebhookServer,
  body: string,
  headers: Record<string, string>
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${s.port}/sentry/webhook`, {
    method: 'POST',
    headers,
    body
  })
  return res.status
}

const hdrs = (
  body: string,
  {
    resource = 'issue',
    id = 'req-1',
    sig = sign(body)
  }: Partial<{ resource: string; id: string; sig: string }> = {}
): Record<string, string> => ({
  'content-type': 'application/json',
  'sentry-hook-signature': sig,
  'sentry-hook-resource': resource,
  'request-id': id
})

describe('verifySentrySignature', () => {
  it('accepts a correct hex HMAC-SHA256 over the raw body', () => {
    const body = '{"action":"created"}'
    expect(verifySentrySignature(Buffer.from(body), sign(body), SECRET)).toBe(true)
  })
  it('rejects a wrong signature, a non-string, and an empty secret', () => {
    const body = '{"action":"created"}'
    expect(verifySentrySignature(Buffer.from(body), sign(body, 'other'), SECRET)).toBe(false)
    expect(verifySentrySignature(Buffer.from(body), undefined, SECRET)).toBe(false)
    expect(verifySentrySignature(Buffer.from(body), sign(body), '')).toBe(false)
  })
})

describe('sentry webhook server', () => {
  it('accepts a valid, signed, novel delivery and routes the resource header', async () => {
    const seen: SentryWebhookDelivery[] = []
    server = await startSentryWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"action":"created","data":{"issue":{"id":"4509"}}}'
    expect(await post(server, body, hdrs(body))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ requestId: 'req-1', resource: 'issue', action: 'created' })
    expect(seen[0].payload).toMatchObject({ data: { issue: { id: '4509' } } })
  })

  it('rejects a forged signature with 401 and never emits', async () => {
    const seen: SentryWebhookDelivery[] = []
    server = await startSentryWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"action":"created"}'
    expect(await post(server, body, hdrs(body, { sig: 'deadbeef' }))).toBe(401)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('dedups a repeated Request-ID with 200 and no second emit', async () => {
    const seen: SentryWebhookDelivery[] = []
    server = await startSentryWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = '{"action":"created","data":{"issue":{"id":"4509"}}}'
    expect(await post(server, body, hdrs(body, { id: 'dupe' }))).toBe(200)
    expect(await post(server, body, hdrs(body, { id: 'dupe' }))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
  })

  it('rejects malformed JSON with 400 and no emit', async () => {
    const seen: SentryWebhookDelivery[] = []
    server = await startSentryWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = 'not json'
    expect(await post(server, body, hdrs(body, { id: 'bad' }))).toBe(400)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('never logs the secret or the raw body', async () => {
    const logs: string[] = []
    server = await startSentryWebhookServer({ secret: SECRET, log: (m) => logs.push(m) })
    const body = '{"action":"created","token":"4111111111111111"}'
    await post(server, body, hdrs(body, { sig: 'deadbeef', id: 'leak-check' }))
    await new Promise((r) => setTimeout(r, 20))
    for (const line of logs) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain('4111111111111111')
    }
  })
})
