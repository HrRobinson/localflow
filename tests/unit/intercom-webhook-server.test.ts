import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startIntercomWebhookServer,
  INTERCOM_VERIFIER,
  type IntercomWebhookDelivery,
  type IntercomWebhookServer
} from '../../src/main/intercom/intercom-webhook-server'
import { verifyWebhookSignature } from '../../src/main/webhooks/webhook-receiver'

const SECRET = 'app_client_secret_value'
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Build a valid X-Hub-Signature header (sha1= hex over the raw body). */
function hubSig(body: string, secret = SECRET): string {
  return `sha1=${createHmac('sha1', secret).update(body, 'utf8').digest('hex')}`
}

describe('INTERCOM_VERIFIER config (§7) — HMAC-SHA1, no timestamp', () => {
  it('pins the Intercom scheme: hmac-sha1 hex over the body, X-Hub-Signature, no timestamp', () => {
    expect(INTERCOM_VERIFIER).toMatchObject({
      scheme: 'hmac',
      algo: 'sha1',
      header: 'x-hub-signature',
      encoding: 'hex',
      signsTimestamp: false
    })
  })

  it("parseHeader strips the 'sha1=' prefix and rejects a missing prefix / empty value", () => {
    const parse = INTERCOM_VERIFIER.scheme === 'hmac' ? INTERCOM_VERIFIER.parseHeader : undefined
    expect(parse?.('sha1=abc123')).toEqual({ signature: 'abc123' })
    expect(parse?.('abc123')).toBeNull() // no prefix
    expect(parse?.('sha1=')).toBeNull() // empty
  })

  it('verifies a valid SHA1 signature and rejects a forged one', () => {
    const body = '{"topic":"conversation.user.replied"}'
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'x-hub-signature': hubSig(body) },
        INTERCOM_VERIFIER,
        SECRET
      )
    ).toBe(true)
    // A signature made with the WRONG secret must fail.
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'x-hub-signature': hubSig(body, 'wrong') },
        INTERCOM_VERIFIER,
        SECRET
      )
    ).toBe(false)
  })

  it('rejects an empty signing secret outright (no forgeable check)', () => {
    const body = '{"topic":"conversation.user.replied"}'
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'x-hub-signature': hubSig(body, '') },
        INTERCOM_VERIFIER,
        ''
      )
    ).toBe(false)
  })
})

describe('startIntercomWebhookServer — end-to-end pipeline', () => {
  let receiver: IntercomWebhookServer | undefined
  afterEach(() => {
    receiver?.close()
    receiver = undefined
  })

  async function post(r: IntercomWebhookServer, body: string, sig: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${r.port}/intercom/webhook`, {
      method: 'POST',
      headers: { 'x-hub-signature': sig },
      body
    })
    return res.status
  }

  it('verifies, parses a well-formed notification, and delivers a delivery once', async () => {
    const seen: IntercomWebhookDelivery[] = []
    receiver = await startIntercomWebhookServer({ secret: SECRET })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({
      type: 'notification_event',
      id: 'notif_1',
      topic: 'conversation.user.replied',
      data: { item: { id: '1001', state: 'open' } }
    })
    expect(await post(receiver, body, hubSig(body))).toBe(200)
    await flush()
    expect(seen).toEqual([
      {
        notificationId: 'notif_1',
        topic: 'conversation.user.replied',
        item: { id: '1001', state: 'open' }
      }
    ])
  })

  it('401s a forged signature and never delivers', async () => {
    const seen: IntercomWebhookDelivery[] = []
    receiver = await startIntercomWebhookServer({ secret: SECRET })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({
      type: 'notification_event',
      id: 'notif_2',
      topic: 'conversation.user.replied',
      data: { item: { id: '1001' } }
    })
    expect(await post(receiver, body, 'sha1=deadbeef')).toBe(401)
    await flush()
    expect(seen).toHaveLength(0)
  })

  it('400s a verified-but-malformed notification (no data.item) — no run seeded', async () => {
    receiver = await startIntercomWebhookServer({ secret: SECRET, log: () => {} })
    const body = JSON.stringify({
      type: 'notification_event',
      id: 'notif_3',
      topic: 'conversation.user.replied'
    })
    expect(await post(receiver, body, hubSig(body))).toBe(400)
  })

  it('never logs the secret or the body', async () => {
    const logs: string[] = []
    receiver = await startIntercomWebhookServer({ secret: SECRET, log: (m) => logs.push(m) })
    const body = JSON.stringify({ topic: 'x', data: {} })
    await post(receiver, body, 'sha1=bad')
    await flush()
    for (const line of logs) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain(body)
    }
  })
})
