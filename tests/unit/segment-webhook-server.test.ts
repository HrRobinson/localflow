import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startSegmentWebhookServer,
  SEGMENT_VERIFIER,
  type SegmentWebhookDelivery,
  type SegmentWebhookServer
} from '../../src/main/segment/segment-webhook-server'
import { verifyWebhookSignature } from '../../src/main/webhooks/webhook-receiver'

const SECRET = 'segment_shared_secret_value'
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Segment signs the raw body with hex HMAC-SHA1 in the `x-signature` header. */
function sig(body: string, secret = SECRET): string {
  return createHmac('sha1', secret).update(body, 'utf8').digest('hex')
}

describe('SEGMENT_VERIFIER (§4.2, §8) — the X-Signature SHA1 case', () => {
  it('pins the scheme: hmac-sha1 hex over the raw body, x-signature header', () => {
    expect(SEGMENT_VERIFIER).toMatchObject({
      scheme: 'hmac',
      algo: 'sha1',
      header: 'x-signature',
      encoding: 'hex'
    })
  })

  it('accepts a valid signature and rejects a one-byte-mutated body (the security invariant)', () => {
    const body = '{"type":"track","event":"Subscription Downgraded"}'
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'x-signature': sig(body) },
        SEGMENT_VERIFIER,
        SECRET
      )
    ).toBe(true)
    // Flip one byte of the body; the same signature must no longer verify.
    const mutated = body.replace('Downgraded', 'Downgradee')
    expect(
      verifyWebhookSignature(
        Buffer.from(mutated),
        { 'x-signature': sig(body) },
        SEGMENT_VERIFIER,
        SECRET
      )
    ).toBe(false)
  })

  it('rejects an empty secret (a forgeable HMAC) outright', () => {
    const body = '{"type":"track"}'
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { 'x-signature': sig(body, '') },
        SEGMENT_VERIFIER,
        ''
      )
    ).toBe(false)
  })
})

describe('startSegmentWebhookServer — end-to-end pipeline', () => {
  let receiver: SegmentWebhookServer | undefined
  afterEach(() => {
    receiver?.close()
    receiver = undefined
  })

  async function post(r: SegmentWebhookServer, body: string, signature: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${r.port}/segment/webhook`, {
      method: 'POST',
      headers: { 'x-signature': signature },
      body
    })
    return res.status
  }

  it('verifies, parses a well-formed event, and delivers a SegmentWebhookDelivery once', async () => {
    const seen: SegmentWebhookDelivery[] = []
    receiver = await startSegmentWebhookServer({ secret: SECRET })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({
      type: 'track',
      event: 'Subscription Downgraded',
      userId: 'u_1',
      messageId: 'm_1',
      properties: { mrr: 500 }
    })
    expect(await post(receiver, body, sig(body))).toBe(200)
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0].body).toMatchObject({ type: 'track', event: 'Subscription Downgraded' })
  })

  it('401s a forged signature and never delivers', async () => {
    const seen: SegmentWebhookDelivery[] = []
    receiver = await startSegmentWebhookServer({ secret: SECRET, log: () => {} })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({ type: 'track', event: 'X' })
    expect(await post(receiver, body, 'deadbeef')).toBe(401)
    await flush()
    expect(seen).toHaveLength(0)
  })

  it('400s a verified-but-non-object body — no run seeded', async () => {
    receiver = await startSegmentWebhookServer({ secret: SECRET, log: () => {} })
    const body = JSON.stringify(['not', 'an', 'object'])
    expect(await post(receiver, body, sig(body))).toBe(400)
  })
})
