import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type WebhookReceiver,
  type WebhookVerifier
} from '../../src/main/webhooks/webhook-receiver'

const SECRET = 'whsec_shared_test_secret'
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

// A fixed clock so replay-window assertions are deterministic.
const NOW_SEC = 1_700_000_000
const NOW_MS = NOW_SEC * 1000
const now = (): number => NOW_MS

function hmac(
  algo: 'sha256' | 'sha1',
  body: string,
  enc: 'hex' | 'base64',
  secret = SECRET
): string {
  return createHmac(algo, secret).update(body, 'utf8').digest(enc)
}

const hdr = (name: string, value: string): IncomingHttpHeaders => ({ [name]: value })

// ── Verifier-scheme matrix (verifyWebhookSignature) ──────────────────────────

describe('verifyWebhookSignature — HMAC body-only', () => {
  const hexVerifier: WebhookVerifier = {
    scheme: 'hmac',
    header: 'linear-signature',
    encoding: 'hex'
  }
  const b64Verifier: WebhookVerifier = {
    scheme: 'hmac',
    header: 'x-shopify-hmac-sha256',
    encoding: 'base64'
  }
  const body = '{"id":1}'

  it('accepts a correct HMAC-SHA256 hex signature (Linear)', () => {
    const sig = hmac('sha256', body, 'hex')
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('linear-signature', sig), hexVerifier, SECRET)
    ).toBe(true)
  })

  it('accepts a correct HMAC-SHA256 base64 signature (Shopify/Woo)', () => {
    const sig = hmac('sha256', body, 'base64')
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-shopify-hmac-sha256', sig),
        b64Verifier,
        SECRET
      )
    ).toBe(true)
  })

  it('rejects a forged signature, an empty signature, a missing header, and an empty secret', () => {
    const good = hmac('sha256', body, 'hex')
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('linear-signature', hmac('sha256', body, 'hex', 'nope')),
        hexVerifier,
        SECRET
      )
    ).toBe(false)
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('linear-signature', ''), hexVerifier, SECRET)
    ).toBe(false)
    expect(verifyWebhookSignature(Buffer.from(body), {}, hexVerifier, SECRET)).toBe(false)
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('linear-signature', good), hexVerifier, '')
    ).toBe(false)
  })

  it('rejects a non-string (array) header value', () => {
    const sig = hmac('sha256', body, 'hex')
    expect(
      verifyWebhookSignature(Buffer.from(body), { 'linear-signature': [sig] }, hexVerifier, SECRET)
    ).toBe(false)
  })
})

describe('verifyWebhookSignature — HMAC-SHA1 (Intercom)', () => {
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha1',
    header: 'x-hub-signature',
    encoding: 'hex'
  }
  const body = '{"event":"ping"}'

  it('accepts a correct SHA1 signature and rejects a SHA256 one', () => {
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-hub-signature', hmac('sha1', body, 'hex')),
        verifier,
        SECRET
      )
    ).toBe(true)
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-hub-signature', hmac('sha256', body, 'hex')),
        verifier,
        SECRET
      )
    ).toBe(false)
  })
})

describe('verifyWebhookSignature — Stripe (t=,v1=; ${ts}.${body}; replay window)', () => {
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'stripe-signature',
    encoding: 'hex',
    signsTimestamp: true,
    toleranceSec: 300,
    parseHeader: (raw) => {
      const parts = Object.fromEntries(raw.split(',').map((p) => p.split('=')))
      return parts.t && parts.v1 ? { timestamp: parts.t, signature: parts.v1 } : null
    }
  }
  const body = '{"type":"charge.refunded"}'
  const stripeHeader = (ts: number, signOver = `${ts}.${body}`): string =>
    `t=${ts},v1=${hmac('sha256', signOver, 'hex')}`

  it('accepts an in-window signature over ${ts}.${body}', () => {
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('stripe-signature', stripeHeader(NOW_SEC)),
        verifier,
        SECRET,
        now
      )
    ).toBe(true)
  })

  it('rejects a STALE timestamp outside the tolerance window (replay defense)', () => {
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('stripe-signature', stripeHeader(NOW_SEC - 400)),
        verifier,
        SECRET,
        now
      )
    ).toBe(false)
  })

  it('rejects a body signed WITHOUT the ${ts}. prefix', () => {
    // Sign the body alone — a classic replay/forgery — must fail against ${ts}.${body}.
    const forged = `t=${NOW_SEC},v1=${hmac('sha256', body, 'hex')}`
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('stripe-signature', forged),
        verifier,
        SECRET,
        now
      )
    ).toBe(false)
  })

  it('rejects a missing or NaN timestamp and an unparseable header', () => {
    const noTs = `v1=${hmac('sha256', `${NOW_SEC}.${body}`, 'hex')}`
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('stripe-signature', noTs),
        verifier,
        SECRET,
        now
      )
    ).toBe(false)
    const nan = `t=notanumber,v1=${hmac('sha256', `notanumber.${body}`, 'hex')}`
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('stripe-signature', nan), verifier, SECRET, now)
    ).toBe(false)
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('stripe-signature', 'garbage'),
        verifier,
        SECRET,
        now
      )
    ).toBe(false)
  })
})

describe('verifyWebhookSignature — Slack (v0= prefix; v0:${ts}:${body}; separate ts header)', () => {
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'x-slack-signature',
    encoding: 'hex',
    signsTimestamp: true,
    timestampHeader: 'x-slack-request-timestamp',
    toleranceSec: 300,
    parseHeader: (raw) => (raw.startsWith('v0=') ? { signature: raw.slice(3) } : null),
    baseString: ({ timestamp, rawBody }) => `v0:${timestamp}:${rawBody}`
  }
  const body = '{"type":"event_callback"}'

  it('accepts a correct v0 signature over v0:${ts}:${body}', () => {
    const sig = 'v0=' + hmac('sha256', `v0:${NOW_SEC}:${body}`, 'hex')
    const headers: IncomingHttpHeaders = {
      'x-slack-signature': sig,
      'x-slack-request-timestamp': String(NOW_SEC)
    }
    expect(verifyWebhookSignature(Buffer.from(body), headers, verifier, SECRET, now)).toBe(true)
  })

  it('rejects a stale Slack timestamp and a body signed with the Stripe composition', () => {
    const stale: IncomingHttpHeaders = {
      'x-slack-signature': 'v0=' + hmac('sha256', `v0:${NOW_SEC - 400}:${body}`, 'hex'),
      'x-slack-request-timestamp': String(NOW_SEC - 400)
    }
    expect(verifyWebhookSignature(Buffer.from(body), stale, verifier, SECRET, now)).toBe(false)
    // A Stripe-style ${ts}.${body} composition must NOT verify under Slack's scheme.
    const wrongComposition: IncomingHttpHeaders = {
      'x-slack-signature': 'v0=' + hmac('sha256', `${NOW_SEC}.${body}`, 'hex'),
      'x-slack-request-timestamp': String(NOW_SEC)
    }
    expect(verifyWebhookSignature(Buffer.from(body), wrongComposition, verifier, SECRET, now)).toBe(
      false
    )
  })
})

describe('verifyWebhookSignature — HubSpot v3 (${method}${uri}${body}${ts}; ms timestamp; public URL)', () => {
  const PUBLIC_URL = 'https://relay.example.com/hubspot/webhook'
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'x-hubspot-signature-v3',
    encoding: 'base64',
    signsTimestamp: true,
    timestampHeader: 'x-hubspot-request-timestamp',
    timestampUnit: 'milliseconds',
    toleranceSec: 300,
    baseString: ({ method, requestUri, rawBody, timestamp }) =>
      `${method}${requestUri}${rawBody}${timestamp}`
  }
  const body = '[{"objectId":1}]'

  it('accepts a v3 signature over method+publicUrl+body+ts (ms), using publicUrl not req.url', () => {
    const base = `POST${PUBLIC_URL}${body}${NOW_MS}`
    const headers: IncomingHttpHeaders = {
      'x-hubspot-signature-v3': hmac('sha256', base, 'base64'),
      'x-hubspot-request-timestamp': String(NOW_MS)
    }
    expect(
      verifyWebhookSignature(Buffer.from(body), headers, verifier, SECRET, now, {
        method: 'POST',
        requestUri: PUBLIC_URL
      })
    ).toBe(true)
  })

  it('rejects when the loopback path is used instead of the public URL', () => {
    const base = `POST${PUBLIC_URL}${body}${NOW_MS}`
    const headers: IncomingHttpHeaders = {
      'x-hubspot-signature-v3': hmac('sha256', base, 'base64'),
      'x-hubspot-request-timestamp': String(NOW_MS)
    }
    expect(
      verifyWebhookSignature(Buffer.from(body), headers, verifier, SECRET, now, {
        method: 'POST',
        requestUri: '/hubspot/webhook'
      })
    ).toBe(false)
  })

  it('rejects a stale ms timestamp outside the 5-minute window', () => {
    const staleMs = NOW_MS - 400_000
    const base = `POST${PUBLIC_URL}${body}${staleMs}`
    const headers: IncomingHttpHeaders = {
      'x-hubspot-signature-v3': hmac('sha256', base, 'base64'),
      'x-hubspot-request-timestamp': String(staleMs)
    }
    expect(
      verifyWebhookSignature(Buffer.from(body), headers, verifier, SECRET, now, {
        method: 'POST',
        requestUri: PUBLIC_URL
      })
    ).toBe(false)
  })
})

describe('verifyWebhookSignature — token (GitLab X-Gitlab-Token)', () => {
  const verifier: WebhookVerifier = { scheme: 'token', header: 'x-gitlab-token' }
  const body = '{"object_kind":"push"}'

  it('accepts the exact shared secret, rejects a wrong/empty token and an empty secret', () => {
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-gitlab-token', SECRET), verifier, SECRET)
    ).toBe(true)
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-gitlab-token', 'wrong'), verifier, SECRET)
    ).toBe(false)
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-gitlab-token', ''), verifier, SECRET)
    ).toBe(false)
    expect(verifyWebhookSignature(Buffer.from(body), {}, verifier, SECRET)).toBe(false)
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-gitlab-token', SECRET), verifier, '')
    ).toBe(false)
  })

  it('is timing-safe against a much longer token (no length-throw)', () => {
    const longToken = 'x'.repeat(4096)
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-gitlab-token', longToken), verifier, SECRET)
    ).toBe(false)
  })
})

describe('verifyWebhookSignature — parseHeader for GitHub sha256= prefix', () => {
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    header: 'x-hub-signature-256',
    encoding: 'hex',
    parseHeader: (raw) => (raw.startsWith('sha256=') ? { signature: raw.slice(7) } : null)
  }
  const body = '{"zen":"ok"}'

  it('strips the sha256= prefix and verifies; an unparseable header rejects', () => {
    const sig = 'sha256=' + hmac('sha256', body, 'hex')
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-hub-signature-256', sig), verifier, SECRET)
    ).toBe(true)
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-hub-signature-256', 'md5=abc'),
        verifier,
        SECRET
      )
    ).toBe(false)
  })
})

// ── Pipeline (startWebhookReceiver) ──────────────────────────────────────────

interface TestEvent {
  ok: true
}

describe('startWebhookReceiver — pipeline', () => {
  let receiver: WebhookReceiver<TestEvent> | undefined
  afterEach(() => {
    receiver?.close()
    receiver = undefined
  })

  const b64Verifier: WebhookVerifier = { scheme: 'hmac', header: 'x-sig', encoding: 'base64' }
  const sign = (body: string): string => hmac('sha256', body, 'base64')

  async function post(
    r: WebhookReceiver<TestEvent>,
    body: string,
    headers: Record<string, string>,
    path = '/hook'
  ): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${r.port}${path}`, { method: 'POST', headers, body })
    return res.status
  }

  it('verifies, 200-fasts, and delivers exactly once on a later tick', async () => {
    const seen: TestEvent[] = []
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => ({ ok: true }),
      secret: SECRET
    })
    receiver.onEvent((e) => seen.push(e))
    const body = '{"a":1}'
    expect(await post(receiver, body, { 'x-sig': sign(body) })).toBe(200)
    await flush()
    expect(seen).toHaveLength(1) // delivered exactly once, on a later tick
  })

  it('404s a wrong path or method', async () => {
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => ({ ok: true }),
      secret: SECRET
    })
    expect(await post(receiver, '{}', { 'x-sig': sign('{}') }, '/nope')).toBe(404)
    const res = await fetch(`http://127.0.0.1:${receiver.port}/hook`, { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('rejects an oversized body with 413 BEFORE verify/parse', async () => {
    let parsed = false
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => {
        parsed = true
        return { ok: true }
      },
      secret: SECRET,
      maxBodyBytes: 1024
    })
    const body = 'x'.repeat(2048)
    expect(await post(receiver, body, { 'x-sig': sign(body) })).toBe(413)
    await flush()
    expect(parsed).toBe(false)
  })

  it('401s a forged signature and never parses/delivers', async () => {
    const seen: TestEvent[] = []
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => ({ ok: true }),
      secret: SECRET
    })
    receiver.onEvent((e) => seen.push(e))
    expect(await post(receiver, '{"a":1}', { 'x-sig': 'AAAA' })).toBe(401)
    await flush()
    expect(seen).toHaveLength(0)
  })

  it('400s when parse returns null', async () => {
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => null,
      secret: SECRET
    })
    const body = '{"a":1}'
    expect(await post(receiver, body, { 'x-sig': sign(body) })).toBe(400)
  })

  it('preVerify short-circuits a ping with 200 BEFORE verify (unsigned)', async () => {
    const seen: TestEvent[] = []
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => ({ ok: true }),
      secret: SECRET,
      preVerify: (headers) => (headers['x-topic'] ? null : 200)
    })
    receiver.onEvent((e) => seen.push(e))
    // No signature at all — a ping still 200s and seeds no run.
    expect(await post(receiver, 'ping', {})).toBe(200)
    await flush()
    expect(seen).toHaveLength(0)
  })

  it('dedup short-circuits a repeat with 200 AFTER verify and drops the second', async () => {
    const seen: TestEvent[] = []
    const seenIds = new Set<string>()
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => ({ ok: true }),
      secret: SECRET,
      dedup: (headers) => {
        const id = headers['x-id']
        if (typeof id === 'string' && seenIds.has(id)) return 200
        if (typeof id === 'string') seenIds.add(id)
        return null
      }
    })
    receiver.onEvent((e) => seen.push(e))
    const body = '{"a":1}'
    expect(await post(receiver, body, { 'x-sig': sign(body), 'x-id': 'dupe' })).toBe(200)
    expect(await post(receiver, body, { 'x-sig': sign(body), 'x-id': 'dupe' })).toBe(200)
    await flush()
    expect(seen).toHaveLength(1)
  })

  it('catches and logs a throwing handler (route + reason, never the body)', async () => {
    const logs: string[] = []
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => ({ ok: true }),
      secret: SECRET,
      log: (m) => logs.push(m)
    })
    receiver.onEvent(() => {
      throw new Error('handler blew up')
    })
    const body = '{"card":"4111111111111111"}'
    expect(await post(receiver, body, { 'x-sig': sign(body) })).toBe(200)
    await flush()
    const joined = logs.join('\n')
    expect(joined).toContain('handler blew up')
    expect(joined).not.toContain(SECRET)
    expect(joined).not.toContain('4111111111111111')
  })

  it('never writes the secret or the raw body into any log line', async () => {
    const logs: string[] = []
    receiver = await startWebhookReceiver<TestEvent>({
      path: '/hook',
      verifier: b64Verifier,
      parse: () => null,
      secret: SECRET,
      log: (m) => logs.push(m)
    })
    const body = '{"marker":"body-marker-xyz"}'
    await post(receiver, body, { 'x-sig': 'AAAA' }) // 401
    await post(receiver, body, { 'x-sig': sign(body) }) // 400 (parse null)
    await flush()
    const joined = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(joined).not.toContain(SECRET)
    expect(joined).not.toContain('body-marker-xyz')
  })
})
