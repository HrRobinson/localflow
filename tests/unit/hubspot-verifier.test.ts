import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startHubSpotWebhookReceiver,
  verifyHubSpotSignature,
  type HubSpotWebhookOptions
} from '../../src/main/hubspot/hubspot-verifier'
import type { WebhookReceiver } from '../../src/main/webhooks/webhook-receiver'
import type { HubSpotWebhookEvent } from '../../src/main/hubspot/hubspot-normalize'

const SECRET = 'app-client-secret-value'
const PUBLIC_URL = 'https://relay.example.com/hubspot/webhook'

/** Compose the v3 base string exactly as HubSpot does and sign it. */
function sign(body: string, tsMs: number, secret = SECRET, url = PUBLIC_URL): string {
  const base = `POST${url}${body}${tsMs}`
  return createHmac('sha256', secret).update(base, 'utf8').digest('base64')
}

describe('verifyHubSpotSignature — the v3 composed string (§5.2)', () => {
  const now = (): number => 1_000_000_000_000
  const body = '[{"subscriptionType":"contact.creation","objectId":1,"eventId":9}]'
  const ts = now()

  it('accepts a signature over method+publicUrl+body+timestamp (ms)', () => {
    expect(
      verifyHubSpotSignature(
        Buffer.from(body),
        { signature: sign(body, ts), timestamp: String(ts), publicUrl: PUBLIC_URL },
        SECRET,
        now
      )
    ).toBe(true)
  })

  it('rejects when the loopback path is used instead of the public URL (§5.3)', () => {
    expect(
      verifyHubSpotSignature(
        Buffer.from(body),
        { signature: sign(body, ts), timestamp: String(ts), publicUrl: '/hubspot/webhook' },
        SECRET,
        now
      )
    ).toBe(false)
  })

  it('rejects a wrong signature, an empty client secret, and a stale timestamp', () => {
    expect(
      verifyHubSpotSignature(
        Buffer.from(body),
        { signature: sign(body, ts, 'other'), timestamp: String(ts), publicUrl: PUBLIC_URL },
        SECRET,
        now
      )
    ).toBe(false)
    expect(
      verifyHubSpotSignature(
        Buffer.from(body),
        { signature: sign(body, ts), timestamp: String(ts), publicUrl: PUBLIC_URL },
        '',
        now
      )
    ).toBe(false)
    const staleTs = ts - 400_000 // > 5 min
    expect(
      verifyHubSpotSignature(
        Buffer.from(body),
        { signature: sign(body, staleTs), timestamp: String(staleTs), publicUrl: PUBLIC_URL },
        SECRET,
        now
      )
    ).toBe(false)
  })
})

// ── Shared-receiver integration (the §5.4 signed-string hook proven) ──────────

let receiver: WebhookReceiver<HubSpotWebhookEvent[]> | undefined
afterEach(() => {
  receiver?.close()
  receiver = undefined
})

async function start(
  opts?: Partial<HubSpotWebhookOptions>
): Promise<WebhookReceiver<HubSpotWebhookEvent[]>> {
  return startHubSpotWebhookReceiver({
    secret: SECRET,
    publicUrl: PUBLIC_URL,
    log: () => {},
    ...opts
  })
}

async function post(
  r: WebhookReceiver<HubSpotWebhookEvent[]>,
  body: string,
  headers: Record<string, string>
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${r.port}/hubspot/webhook`, {
    method: 'POST',
    headers,
    body
  })
  return res.status
}

const hdrs = (body: string, tsMs = Date.now(), sig = sign(body, tsMs)): Record<string, string> => ({
  'content-type': 'application/json',
  'x-hubspot-signature-v3': sig,
  'x-hubspot-request-timestamp': String(tsMs)
})

describe('HubSpot shared-receiver integration', () => {
  it('accepts a valid, signed, fresh batch and emits ONE event per array element', async () => {
    receiver = await start()
    const seen: HubSpotWebhookEvent[][] = []
    receiver.onEvent((e) => seen.push(e))
    const body = JSON.stringify([
      { subscriptionType: 'contact.creation', objectId: 501, eventId: 1 },
      {
        subscriptionType: 'deal.propertyChange',
        objectId: 77,
        propertyName: 'dealstage',
        propertyValue: 'closedwon',
        eventId: 2
      }
    ])
    expect(await post(receiver, body, hdrs(body))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0].map((e) => e.triggerId)).toEqual(['contact.created', 'deal.stageChanged'])
  })

  it('rejects a forged signature with 401 and seeds nothing', async () => {
    receiver = await start()
    const seen: unknown[] = []
    receiver.onEvent((e) => seen.push(e))
    const body = JSON.stringify([{ subscriptionType: 'contact.creation', objectId: 1, eventId: 1 }])
    const ts = Date.now()
    expect(await post(receiver, body, hdrs(body, ts, sign(body, ts, 'wrong-secret')))).toBe(401)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('rejects a stale delivery (timestamp > 5 min) with 401', async () => {
    receiver = await start()
    const body = JSON.stringify([{ subscriptionType: 'contact.creation', objectId: 1, eventId: 1 }])
    const stale = Date.now() - 400_000
    expect(await post(receiver, body, hdrs(body, stale))).toBe(401)
  })

  it('400s a valid-signed but unusable batch (no supported events)', async () => {
    receiver = await start()
    const body = JSON.stringify([{ subscriptionType: 'contact.deletion', objectId: 1, eventId: 1 }])
    expect(await post(receiver, body, hdrs(body))).toBe(400)
  })
})
