import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import {
  handleWebhookDelivery,
  type ShortCircuit,
  type WebhookReceiverConfig,
  type WebhookVerifier
} from '../../src/main/webhooks/webhook-receiver'

const SECRET = 'whsec_shared_test_secret'
const NOW_SEC = 1_700_000_000
const NOW_MS = NOW_SEC * 1000

function sign(body: string, enc: 'hex' | 'base64', secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest(enc)
}

interface TestEvent {
  ok: true
  body: string
}

const b64Verifier: WebhookVerifier = { scheme: 'hmac', header: 'x-sig', encoding: 'base64' }

function baseConfig(
  over: Partial<WebhookReceiverConfig<TestEvent>> = {}
): WebhookReceiverConfig<TestEvent> {
  return {
    path: '/hook',
    verifier: b64Verifier,
    parse: (raw) => ({ ok: true, body: raw.toString('utf8') }),
    secret: SECRET,
    ...over
  }
}

const hdr = (body: string): IncomingHttpHeaders => ({ 'x-sig': sign(body, 'base64') })

describe('handleWebhookDelivery — the extracted policy core', () => {
  it('200 + delivered event on a verified, parsed body', () => {
    const body = '{"a":1}'
    const out = handleWebhookDelivery(baseConfig(), {
      rawBody: Buffer.from(body),
      headers: hdr(body)
    })
    expect(out.status).toBe(200)
    expect(out.reason).toBe('delivered')
    expect(out.event).toEqual({ ok: true, body })
  })

  it('200 short-circuit (no event) on a preVerify hit, BEFORE verify', () => {
    const preVerify: ShortCircuit = (h) => (h['x-topic'] ? null : 200)
    // No signature at all — preVerify still answers 200 and nothing verifies/parses.
    const out = handleWebhookDelivery(baseConfig({ preVerify }), {
      rawBody: Buffer.from('ping'),
      headers: {}
    })
    expect(out.status).toBe(200)
    expect(out.reason).toBe('pre-verify-short-circuit')
    expect(out.event).toBeUndefined()
  })

  it('401 verify-failed (no event) on a forged signature', () => {
    const out = handleWebhookDelivery(baseConfig(), {
      rawBody: Buffer.from('{"a":1}'),
      headers: { 'x-sig': 'AAAA' }
    })
    expect(out.status).toBe(401)
    expect(out.reason).toBe('verify-failed')
    expect(out.event).toBeUndefined()
  })

  it('200 duplicate (no event) on a dedup hit, AFTER verify', () => {
    const seen = new Set<string>()
    const dedup: ShortCircuit = (h) => {
      const id = h['x-id']
      if (typeof id === 'string' && seen.has(id)) return 200
      if (typeof id === 'string') seen.add(id)
      return null
    }
    const body = '{"a":1}'
    const config = baseConfig({ dedup })
    const first = handleWebhookDelivery(config, {
      rawBody: Buffer.from(body),
      headers: { ...hdr(body), 'x-id': 'dupe' }
    })
    expect(first.reason).toBe('delivered')
    const second = handleWebhookDelivery(config, {
      rawBody: Buffer.from(body),
      headers: { ...hdr(body), 'x-id': 'dupe' }
    })
    expect(second.status).toBe(200)
    expect(second.reason).toBe('duplicate')
    expect(second.event).toBeUndefined()
  })

  it('400 unparseable (no event) when parse returns null', () => {
    const body = '{"a":1}'
    const out = handleWebhookDelivery(baseConfig({ parse: () => null }), {
      rawBody: Buffer.from(body),
      headers: hdr(body)
    })
    expect(out.status).toBe(400)
    expect(out.reason).toBe('unparseable')
    expect(out.event).toBeUndefined()
  })

  it('never writes the secret or the raw body into a log line', () => {
    const logs: string[] = []
    const body = '{"marker":"body-marker-xyz"}'
    handleWebhookDelivery(baseConfig({ log: (m) => logs.push(m) }), {
      rawBody: Buffer.from(body),
      headers: { 'x-sig': 'AAAA' }
    }) // 401
    handleWebhookDelivery(baseConfig({ parse: () => null, log: (m) => logs.push(m) }), {
      rawBody: Buffer.from(body),
      headers: hdr(body)
    }) // 400
    const joined = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(joined).not.toContain(SECRET)
    expect(joined).not.toContain('body-marker-xyz')
  })

  it('rejects an oversized body BEFORE verify/parse when maxBodyBytes is set', () => {
    const logs: string[] = []
    // A body larger than the cap, with a VALID signature — proves the size gate
    // fires ahead of verify (the signature would otherwise pass) and ahead of parse.
    const body = 'x'.repeat(64)
    let parseCalls = 0
    const out = handleWebhookDelivery(
      baseConfig({
        maxBodyBytes: 16,
        parse: (raw) => {
          parseCalls += 1
          return { ok: true, body: raw.toString('utf8') }
        },
        log: (m) => logs.push(m)
      }),
      { rawBody: Buffer.from(body), headers: hdr(body) }
    )
    expect(out.status).toBe(413)
    expect(out.reason).toBe('oversize')
    expect(out.event).toBeUndefined()
    expect(parseCalls).toBe(0) // never parsed
    // The log mirrors the HTTP path's size-cap message and leaks neither secret nor body.
    const joined = logs.join('\n')
    expect(joined).toMatch(/body exceeds 16 bytes/)
    expect(joined).not.toContain(SECRET)
  })

  it('allows an under-cap body to proceed to verify/parse', () => {
    const body = '{"a":1}'
    const out = handleWebhookDelivery(baseConfig({ maxBodyBytes: 1024 }), {
      rawBody: Buffer.from(body),
      headers: hdr(body)
    })
    expect(out.status).toBe(200)
    expect(out.reason).toBe('delivered')
    expect(out.event).toEqual({ ok: true, body })
  })

  it('applies no cap when maxBodyBytes is unset (unchanged)', () => {
    const body = 'y'.repeat(4096)
    const out = handleWebhookDelivery(baseConfig(), {
      rawBody: Buffer.from(body),
      headers: hdr(body)
    })
    expect(out.status).toBe(200)
    expect(out.reason).toBe('delivered')
  })

  it('threads publicUrl through to a URL-signed scheme (HubSpot v3)', () => {
    const PUBLIC_URL = 'https://relay.example.com/hubspot/webhook'
    const now = (): number => NOW_MS
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
    const base = `POST${PUBLIC_URL}${body}${NOW_MS}`
    const config: WebhookReceiverConfig<TestEvent> = {
      path: '/hubspot/webhook',
      verifier,
      parse: (raw) => ({ ok: true, body: raw.toString('utf8') }),
      secret: SECRET,
      now
    }
    const headers: IncomingHttpHeaders = {
      'x-hubspot-signature-v3': sign(base, 'base64'),
      'x-hubspot-request-timestamp': String(NOW_MS)
    }
    // With the public URL the vendor signed → verifies.
    expect(
      handleWebhookDelivery(config, { rawBody: Buffer.from(body), headers, publicUrl: PUBLIC_URL })
        .status
    ).toBe(200)
    // With a bogus URL → 401 (proves publicUrl is the signed URI, not ignored).
    expect(
      handleWebhookDelivery(config, {
        rawBody: Buffer.from(body),
        headers,
        publicUrl: 'https://wrong.example.com/x'
      }).status
    ).toBe(401)
  })
})
