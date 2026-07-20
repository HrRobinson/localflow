import { describe, it, expect } from 'vitest'
import { createHmac, generateKeyPairSync, sign as edSign } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import {
  verifyWebhookSignature,
  type WebhookVerifier
} from '../../src/main/webhooks/webhook-receiver'

const SECRET = 'whsec_shared_test_secret'

// A fixed clock so replay-window assertions are deterministic (mirrors the gate).
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

// ── Capability 1 — ISO-8601 timestamp unit (Zendesk-shaped) ──────────────────

describe('verifyWebhookSignature — ISO-8601 timestamp unit (Zendesk-shaped)', () => {
  const TS_HEADER = 'x-zendesk-webhook-signature-timestamp'
  // Zendesk: Base64(HMAC-SHA256(secret, timestamp + rawBody)); bare concat; ISO ts.
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'x-zendesk-webhook-signature',
    encoding: 'base64',
    signsTimestamp: true,
    timestampHeader: TS_HEADER,
    timestampUnit: 'iso8601',
    toleranceSec: 300,
    baseString: ({ timestamp, rawBody }) => `${timestamp}${rawBody}`
  }
  const body = '{"type":"ticket.created"}'
  const zendeskHeaders = (iso: string, signOver = `${iso}${body}`): IncomingHttpHeaders => ({
    'x-zendesk-webhook-signature': hmac('sha256', signOver, 'base64'),
    [TS_HEADER]: iso
  })

  it('accepts a valid in-window ISO-8601 timestamp (end-to-end Zendesk shape)', () => {
    const iso = new Date(NOW_MS).toISOString()
    expect(
      verifyWebhookSignature(Buffer.from(body), zendeskHeaders(iso), verifier, SECRET, now)
    ).toBe(true)
  })

  it('rejects an ISO-8601 timestamp outside the tolerance window (replay defense)', () => {
    const iso = new Date(NOW_MS - 400_000).toISOString() // 400s stale > 300s window
    expect(
      verifyWebhookSignature(Buffer.from(body), zendeskHeaders(iso), verifier, SECRET, now)
    ).toBe(false)
  })

  it('rejects a malformed ISO-8601 timestamp (never NaN-compares-as-pass)', () => {
    // Signature is valid over the malformed string; the parse must still reject.
    const bad = 'not-a-real-date'
    expect(
      verifyWebhookSignature(Buffer.from(body), zendeskHeaders(bad), verifier, SECRET, now)
    ).toBe(false)
  })

  it('still binds the timestamp: an in-window ISO but body-only signature rejects', () => {
    const iso = new Date(NOW_MS).toISOString()
    // Sign the body ALONE (drop the timestamp prefix) → must fail the bound base string.
    const headers = zendeskHeaders(iso, body)
    expect(verifyWebhookSignature(Buffer.from(body), headers, verifier, SECRET, now)).toBe(false)
  })
})

// ── Capability 2 — any-of-N signatures / secrets (rotation) ──────────────────

describe('verifyWebhookSignature — any-of-N signatures (PagerDuty-shaped rotation)', () => {
  // parseHeader returns EVERY `v1=` candidate (comma-separated), not just the first.
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'x-pagerduty-signature',
    encoding: 'hex',
    parseHeader: (raw) => {
      const sigs = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('v1='))
        .map((s) => s.slice('v1='.length))
      return { signature: sigs }
    }
  }
  const body = '{"event":{"id":"abc"}}'

  it('passes when the FIRST candidate signature matches', () => {
    const good = hmac('sha256', body, 'hex')
    const header = `v1=${good},v1=${hmac('sha256', body, 'hex', 'other-secret')}`
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-pagerduty-signature', header),
        verifier,
        SECRET
      )
    ).toBe(true)
  })

  it('passes when the SECOND candidate signature matches (rotation window)', () => {
    const good = hmac('sha256', body, 'hex')
    const header = `v1=${hmac('sha256', body, 'hex', 'old-secret')},v1=${good}`
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-pagerduty-signature', header),
        verifier,
        SECRET
      )
    ).toBe(true)
  })

  it('rejects when NONE of the candidate signatures match', () => {
    const header = `v1=${hmac('sha256', body, 'hex', 'a')},v1=${hmac('sha256', body, 'hex', 'b')}`
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-pagerduty-signature', header),
        verifier,
        SECRET
      )
    ).toBe(false)
  })

  it('rejects an EMPTY candidate set (no v1= present)', () => {
    const header = 'v2=deadbeef'
    expect(
      verifyWebhookSignature(
        Buffer.from(body),
        hdr('x-pagerduty-signature', header),
        verifier,
        SECRET
      )
    ).toBe(false)
  })
})

describe('verifyWebhookSignature — any-of-N secrets (secret rotation)', () => {
  const verifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'x-sig',
    encoding: 'hex'
  }
  const body = '{"a":1}'

  it('passes when the signature matches the NEW secret during rotation', () => {
    const sig = hmac('sha256', body, 'hex', 'new-secret')
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-sig', sig), verifier, [
        'old-secret',
        'new-secret'
      ])
    ).toBe(true)
  })

  it('passes when the signature matches the OLD secret during rotation', () => {
    const sig = hmac('sha256', body, 'hex', 'old-secret')
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-sig', sig), verifier, [
        'old-secret',
        'new-secret'
      ])
    ).toBe(true)
  })

  it('rejects when the signature matches NEITHER secret', () => {
    const sig = hmac('sha256', body, 'hex', 'wrong')
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-sig', sig), verifier, [
        'old-secret',
        'new-secret'
      ])
    ).toBe(false)
  })

  it('rejects an EMPTY secret set and a set containing an empty secret', () => {
    const sig = hmac('sha256', body, 'hex', 'new-secret')
    expect(verifyWebhookSignature(Buffer.from(body), hdr('x-sig', sig), verifier, [])).toBe(false)
    expect(
      verifyWebhookSignature(Buffer.from(body), hdr('x-sig', sig), verifier, ['', 'new-secret'])
    ).toBe(false)
  })
})

// ── Capability 3 — Ed25519 scheme (Discord HTTP-interactions shape) ───────────

describe('verifyWebhookSignature — Ed25519 scheme (Discord-shaped)', () => {
  const TS_HEADER = 'x-signature-timestamp'
  const SIG_HEADER = 'x-signature-ed25519'
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // Discord ships the app's Ed25519 public key as a 32-byte hex string (NON-secret).
  const derPub = publicKey.export({ type: 'spki', format: 'der' })
  const pubHex = derPub.subarray(derPub.length - 32).toString('hex')

  const verifier: WebhookVerifier = {
    scheme: 'ed25519',
    header: SIG_HEADER,
    encoding: 'hex',
    timestampHeader: TS_HEADER
  }
  const body = '{"type":1}'
  const ts = String(NOW_SEC)
  const signed = (message: string): string =>
    edSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')

  it('accepts a validly-signed body (message = timestamp + rawBody)', () => {
    const headers: IncomingHttpHeaders = {
      [SIG_HEADER]: signed(`${ts}${body}`),
      [TS_HEADER]: ts
    }
    expect(verifyWebhookSignature(Buffer.from(body), headers, verifier, pubHex)).toBe(true)
  })

  it('rejects a forged signature', () => {
    const headers: IncomingHttpHeaders = {
      [SIG_HEADER]: 'ab'.repeat(32), // 64 hex chars, wrong bytes
      [TS_HEADER]: ts
    }
    expect(verifyWebhookSignature(Buffer.from(body), headers, verifier, pubHex)).toBe(false)
  })

  it('rejects a tampered body (signature was over the original)', () => {
    const headers: IncomingHttpHeaders = {
      [SIG_HEADER]: signed(`${ts}${body}`),
      [TS_HEADER]: ts
    }
    expect(verifyWebhookSignature(Buffer.from('{"type":2}'), headers, verifier, pubHex)).toBe(false)
  })

  it('rejects a missing timestamp header and an empty public key', () => {
    const headers: IncomingHttpHeaders = { [SIG_HEADER]: signed(`${ts}${body}`) }
    expect(verifyWebhookSignature(Buffer.from(body), headers, verifier, pubHex)).toBe(false)
    const full: IncomingHttpHeaders = { [SIG_HEADER]: signed(`${ts}${body}`), [TS_HEADER]: ts }
    expect(verifyWebhookSignature(Buffer.from(body), full, verifier, '')).toBe(false)
  })
})

// ── Ed25519 replay/freshness window (toleranceSec) ────────────────────────────

describe('verifyWebhookSignature — Ed25519 replay window (toleranceSec)', () => {
  const TS_HEADER = 'x-signature-timestamp'
  const SIG_HEADER = 'x-signature-ed25519'
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const derPub = publicKey.export({ type: 'spki', format: 'der' })
  const pubHex = derPub.subarray(derPub.length - 32).toString('hex')
  const body = '{"type":1}'
  const signed = (message: string): string =>
    edSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex')

  // With toleranceSec set, the timestamp header (Discord: epoch seconds) is bound
  // to the replay window — a captured signature no longer replays forever.
  const withWindow: WebhookVerifier = {
    scheme: 'ed25519',
    header: SIG_HEADER,
    encoding: 'hex',
    timestampHeader: TS_HEADER,
    toleranceSec: 300
  }
  // No toleranceSec → preserve the original no-window behavior.
  const noWindow: WebhookVerifier = {
    scheme: 'ed25519',
    header: SIG_HEADER,
    encoding: 'hex',
    timestampHeader: TS_HEADER
  }
  const headersFor = (tsStr: string): IncomingHttpHeaders => ({
    [SIG_HEADER]: signed(`${tsStr}${body}`),
    [TS_HEADER]: tsStr
  })

  it('accepts a fresh in-window timestamp', () => {
    const ts = String(NOW_SEC)
    expect(verifyWebhookSignature(Buffer.from(body), headersFor(ts), withWindow, pubHex, now)).toBe(
      true
    )
  })

  it('rejects a stale timestamp outside the tolerance window (replay defense)', () => {
    const ts = String(NOW_SEC - 400) // 400s stale > 300s window
    expect(verifyWebhookSignature(Buffer.from(body), headersFor(ts), withWindow, pubHex, now)).toBe(
      false
    )
  })

  it('rejects a future timestamp outside the tolerance window (clock-skew abuse)', () => {
    const ts = String(NOW_SEC + 400)
    expect(verifyWebhookSignature(Buffer.from(body), headersFor(ts), withWindow, pubHex, now)).toBe(
      false
    )
  })

  it('rejects an unparseable timestamp when toleranceSec is set (never NaN-passes)', () => {
    // Signature is valid over the malformed string; the freshness parse must reject.
    const bad = 'not-a-number'
    expect(
      verifyWebhookSignature(Buffer.from(body), headersFor(bad), withWindow, pubHex, now)
    ).toBe(false)
  })

  it('preserves no-window behavior when toleranceSec is unset (stale still passes)', () => {
    const ts = String(NOW_SEC - 400) // ancient, but no window configured
    expect(verifyWebhookSignature(Buffer.from(body), headersFor(ts), noWindow, pubHex, now)).toBe(
      true
    )
  })
})
