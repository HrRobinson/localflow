import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { verifyWebhookSignature } from '../../src/main/webhooks/webhook-receiver'
import {
  slackVerifier,
  parseSlackEventBody,
  parseSlackInteractionBody
} from '../../src/main/slack/slack-events-server'

const SECRET = 'slack-signing-secret'

/** Build a valid Slack `v0=` signature over `v0:{ts}:{body}`. */
function sign(body: string, ts: string, secret = SECRET): string {
  const base = `v0:${ts}:${body}`
  return 'v0=' + createHmac('sha256', secret).update(base).digest('hex')
}

function headers(sig: string, ts: string): IncomingHttpHeaders {
  return { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts }
}

describe('slackVerifier over the shared webhook-receiver', () => {
  const now = () => 1_000_000_000_000 // fixed clock (ms)
  const nowSec = String(Math.floor(now() / 1000))
  const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } })

  it('accepts a valid, freshly-signed request', () => {
    const ok = verifyWebhookSignature(
      Buffer.from(body),
      headers(sign(body, nowSec), nowSec),
      slackVerifier,
      SECRET,
      now
    )
    expect(ok).toBe(true)
  })

  it('rejects a bad signature', () => {
    const ok = verifyWebhookSignature(
      Buffer.from(body),
      headers('v0=deadbeef', nowSec),
      slackVerifier,
      SECRET,
      now
    )
    expect(ok).toBe(false)
  })

  it('rejects a signature made with the wrong secret', () => {
    const ok = verifyWebhookSignature(
      Buffer.from(body),
      headers(sign(body, nowSec, 'wrong'), nowSec),
      slackVerifier,
      SECRET,
      now
    )
    expect(ok).toBe(false)
  })

  it('rejects a stale timestamp (outside the 5-min window) — replay defense', () => {
    const staleTs = String(Math.floor(now() / 1000) - 600) // 10 min old
    const ok = verifyWebhookSignature(
      Buffer.from(body),
      headers(sign(body, staleTs), staleTs),
      slackVerifier,
      SECRET,
      now
    )
    expect(ok).toBe(false)
  })

  it('rejects a header without the v0= prefix', () => {
    const raw = createHmac('sha256', SECRET).update(`v0:${nowSec}:${body}`).digest('hex')
    const ok = verifyWebhookSignature(Buffer.from(body), headers(raw, nowSec), slackVerifier, SECRET, now)
    expect(ok).toBe(false)
  })
})

describe('parseSlackEventBody', () => {
  it('echoes the url_verification challenge', () => {
    const parsed = parseSlackEventBody(
      Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'abc123' }))
    )
    expect(parsed).toEqual({ kind: 'challenge', challenge: 'abc123' })
  })

  it('normalizes an event_callback to the same SlackInbound the socket emits', () => {
    const payload = { type: 'event_callback', event: { type: 'message', channel: 'C1' } }
    const parsed = parseSlackEventBody(Buffer.from(JSON.stringify(payload)))
    expect(parsed).toEqual({ kind: 'inbound', inbound: { type: 'events_api', payload } })
  })

  it('drops malformed / unsupported bodies (never throws)', () => {
    expect(parseSlackEventBody(Buffer.from('not json'))).toBeNull()
    expect(parseSlackEventBody(Buffer.from(JSON.stringify({ type: 'other' })))).toBeNull()
  })
})

describe('parseSlackInteractionBody', () => {
  it('decodes a form-encoded payload= interaction to the interactive inbound', () => {
    const interaction = { type: 'block_actions', actions: [{ action_id: 'x' }] }
    const raw = 'payload=' + encodeURIComponent(JSON.stringify(interaction))
    expect(parseSlackInteractionBody(Buffer.from(raw))).toEqual({
      type: 'interactive',
      payload: interaction
    })
  })

  it('returns null on a malformed interaction body', () => {
    expect(parseSlackInteractionBody(Buffer.from('payload=notjson'))).toBeNull()
  })
})
