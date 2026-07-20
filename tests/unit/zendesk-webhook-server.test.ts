import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startZendeskWebhookServer,
  ZENDESK_VERIFIER,
  ZENDESK_SIGNATURE_HEADER,
  ZENDESK_TIMESTAMP_HEADER,
  type ZendeskWebhookDelivery,
  type ZendeskWebhookServer
} from '../../src/main/zendesk/zendesk-webhook-server'
import { verifyWebhookSignature } from '../../src/main/webhooks/webhook-receiver'

const SECRET = 'zendesk_webhook_signing_secret'
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * Build a valid Zendesk signature for the SHIPPED signature-only interim. Because
 * `signsTimestamp: false`, the shared receiver composes the base string as
 * `${''}${rawBody}` (the timestamp is bound on the wire but the receiver doesn't
 * fold it in until the ISO-8601 extension lands — TODO iso8601 replay-window), so
 * the interim base string is the raw body. Signature = base64(HMAC-SHA256(body)).
 */
function zendeskSig(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64')
}

const ISO_TS = '2026-07-20T14:31:08Z'

describe('ZENDESK_VERIFIER config (§7.1) — signature-only interim', () => {
  it('pins the Zendesk scheme: hmac-sha256, base64, separate timestamp header', () => {
    expect(ZENDESK_VERIFIER).toMatchObject({
      scheme: 'hmac',
      algo: 'sha256',
      header: 'x-zendesk-webhook-signature',
      encoding: 'base64',
      signsTimestamp: false, // interim — replay WINDOW deferred (ISO-8601 not parsed yet)
      timestampHeader: 'x-zendesk-webhook-signature-timestamp',
      toleranceSec: 300
    })
  })

  it('the baseString composer is `${timestamp}${rawBody}` (bare concat, no separator)', () => {
    const compose = ZENDESK_VERIFIER.scheme === 'hmac' ? ZENDESK_VERIFIER.baseString : undefined
    expect(compose?.({ method: 'POST', requestUri: '', timestamp: '2026', rawBody: 'BODY' })).toBe(
      '2026BODY'
    )
  })

  it('verifies a valid base64 HMAC over the body and rejects a forged one', () => {
    const body = '{"type":"ticket.commentAdded"}'
    const headers = {
      [ZENDESK_SIGNATURE_HEADER]: zendeskSig(body),
      [ZENDESK_TIMESTAMP_HEADER]: ISO_TS
    }
    expect(verifyWebhookSignature(Buffer.from(body), headers, ZENDESK_VERIFIER, SECRET)).toBe(true)
    // Forged signature over a different body.
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        {
          [ZENDESK_SIGNATURE_HEADER]: zendeskSig('{"type":"other"}'),
          [ZENDESK_TIMESTAMP_HEADER]: ISO_TS
        },
        ZENDESK_VERIFIER,
        SECRET
      )
    ).toBe(false)
  })

  it('an ISO-8601 timestamp header never trips the epoch replay math (would be NaN under signsTimestamp)', () => {
    // The whole reason we ship signature-only: an ISO timestamp under the epoch
    // replay window would render NaN → rejected. Signature-only still verifies.
    const body = '{"type":"ticket.created"}'
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        { [ZENDESK_SIGNATURE_HEADER]: zendeskSig(body), [ZENDESK_TIMESTAMP_HEADER]: ISO_TS },
        ZENDESK_VERIFIER,
        SECRET
      )
    ).toBe(true)
  })
})

describe('startZendeskWebhookServer — end-to-end pipeline', () => {
  let receiver: ZendeskWebhookServer | undefined
  afterEach(() => {
    receiver?.close()
    receiver = undefined
  })

  async function post(r: ZendeskWebhookServer, body: string, sig: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${r.port}/zendesk/webhook`, {
      method: 'POST',
      headers: { [ZENDESK_SIGNATURE_HEADER]: sig, [ZENDESK_TIMESTAMP_HEADER]: ISO_TS },
      body
    })
    return res.status
  }

  it('verifies, parses a well-formed delivery, and delivers a ZendeskWebhookDelivery once', async () => {
    const seen: ZendeskWebhookDelivery[] = []
    receiver = await startZendeskWebhookServer({ secret: SECRET })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({
      id: 'delivery_1',
      type: 'ticket.commentAdded',
      ticket: { id: 35436, requester_email: 'buyer@x.com' },
      comment: { id: 5, plain_body: 'still broken', public: true }
    })
    expect(await post(receiver, body, zendeskSig(body))).toBe(200)
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ eventId: 'delivery_1', type: 'ticket.commentAdded' })
  })

  it('401s a forged signature and never delivers', async () => {
    const seen: ZendeskWebhookDelivery[] = []
    receiver = await startZendeskWebhookServer({ secret: SECRET })
    receiver.onEvent((d) => seen.push(d))
    const body = JSON.stringify({ id: 'd2', type: 'ticket.created', ticket: { id: 1 } })
    expect(await post(receiver, body, 'not-a-valid-signature')).toBe(401)
    await flush()
    expect(seen).toHaveLength(0)
  })

  it('400s a verified-but-typeless payload — no run seeded', async () => {
    receiver = await startZendeskWebhookServer({ secret: SECRET, log: () => {} })
    const body = JSON.stringify({ id: 'd3', ticket: { id: 1 } }) // no `type`
    expect(await post(receiver, body, zendeskSig(body))).toBe(400)
  })
})
