import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startPagerDutyWebhookServer,
  verifyPagerDutySignature,
  selectV1Signature,
  type PagerDutyWebhookServer,
  type PagerDutyWebhookDelivery
} from '../../src/main/pagerduty/pagerduty-webhook-server'

const SECRET = 'pd_v3_signing_secret'

/** PagerDuty v3 signs the RAW body with HEX HMAC-SHA256, prefixed `v1=` (§4.4). */
function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')
}
const v1 = (body: string, secret = SECRET): string => `v1=${sign(body, secret)}`

let server: PagerDutyWebhookServer | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function post(
  s: PagerDutyWebhookServer,
  body: string,
  headers: Record<string, string>
): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${s.port}/pagerduty/webhook`, {
    method: 'POST',
    headers,
    body
  })
  return res.status
}

const hdrs = (sig: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-pagerduty-signature': sig
})

const envelope = (eventType = 'incident.triggered', id = 'evt-1'): string =>
  JSON.stringify({
    event: {
      id,
      event_type: eventType,
      resource_type: 'incident',
      data: { id: 'PABC', title: 'boom', status: 'triggered' }
    }
  })

describe('selectV1Signature (the pinned parseHeader)', () => {
  it('picks the v1= signature from a single-value header', () => {
    expect(selectV1Signature('v1=abc123')).toEqual({ signature: 'abc123' })
  })
  it('picks the FIRST v1= from a comma-separated rotation header', () => {
    expect(selectV1Signature('v1=aaa, v1=bbb')).toEqual({ signature: 'aaa' })
  })
  it('returns null when no v1= is present', () => {
    expect(selectV1Signature('v2=xyz')).toBeNull()
    expect(selectV1Signature('')).toBeNull()
  })
})

describe('verifyPagerDutySignature', () => {
  it('accepts a correct v1= hex HMAC-SHA256 over the raw body', () => {
    const body = envelope()
    expect(verifyPagerDutySignature(Buffer.from(body), v1(body), SECRET)).toBe(true)
  })
  it('rejects a wrong secret, a missing v1=, a non-string, and an empty secret', () => {
    const body = envelope()
    expect(verifyPagerDutySignature(Buffer.from(body), v1(body, 'other'), SECRET)).toBe(false)
    expect(verifyPagerDutySignature(Buffer.from(body), sign(body), SECRET)).toBe(false) // no v1= prefix
    expect(verifyPagerDutySignature(Buffer.from(body), undefined, SECRET)).toBe(false)
    expect(verifyPagerDutySignature(Buffer.from(body), v1(body), '')).toBe(false)
  })
})

describe('pagerduty webhook server (shared receiver + v3 verifier)', () => {
  it('accepts a valid, signed delivery and unwraps the v3 event envelope', async () => {
    const seen: PagerDutyWebhookDelivery[] = []
    server = await startPagerDutyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = envelope('incident.triggered', 'evt-1')
    expect(await post(server, body, hdrs(v1(body)))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      id: 'evt-1',
      eventType: 'incident.triggered',
      resourceType: 'incident'
    })
    expect(seen[0].data).toMatchObject({ id: 'PABC' })
  })

  it('verifies against a comma-separated rotation header when the FIRST v1= matches', async () => {
    const seen: PagerDutyWebhookDelivery[] = []
    server = await startPagerDutyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = envelope()
    const rotationHeader = `${v1(body)}, v1=deadbeefstale`
    expect(await post(server, body, hdrs(rotationHeader))).toBe(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
  })

  it('rejects a forged signature with 401 and never emits', async () => {
    const seen: PagerDutyWebhookDelivery[] = []
    server = await startPagerDutyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = envelope()
    expect(await post(server, body, hdrs('v1=deadbeef'))).toBe(401)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('rejects a body missing the v3 event envelope with 400 and no emit', async () => {
    const seen: PagerDutyWebhookDelivery[] = []
    server = await startPagerDutyWebhookServer({ secret: SECRET, log: () => {} })
    server.onEvent((d) => seen.push(d))
    const body = JSON.stringify({ not_an_event: true })
    expect(await post(server, body, hdrs(v1(body)))).toBe(400)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(0)
  })

  it('rejects malformed JSON with 400', async () => {
    server = await startPagerDutyWebhookServer({ secret: SECRET, log: () => {} })
    const body = 'not json'
    expect(await post(server, body, hdrs(v1(body)))).toBe(400)
  })

  it('never logs the secret or the raw body', async () => {
    const logs: string[] = []
    server = await startPagerDutyWebhookServer({ secret: SECRET, log: (m) => logs.push(m) })
    const body = envelope() + '{"pan":"4111111111111111"}'
    await post(server, body, hdrs('v1=deadbeef'))
    await new Promise((r) => setTimeout(r, 20))
    for (const line of logs) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain('4111111111111111')
    }
  })
})
