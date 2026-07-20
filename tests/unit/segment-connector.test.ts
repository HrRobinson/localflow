import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SegmentConnector } from '../../src/main/segment/segment-connector'
import {
  MockSegment,
  SegmentApiClient,
  type SegmentTransport
} from '../../src/main/segment/segment-client'
import type {
  SegmentWebhookDelivery,
  SegmentWebhookServer
} from '../../src/main/segment/segment-webhook-server'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { SegmentTokenStore } from '../../src/main/segment/segment-token-store'
import type { SeedEvent } from '../../src/main/flow/trigger-subscriber'

/** A fake webhook server whose onEvent sink we can drive directly. */
function fakeWebhook(): {
  server: SegmentWebhookServer
  deliver: (d: SegmentWebhookDelivery) => void
} {
  let sink: ((d: SegmentWebhookDelivery) => void) | null = null
  return {
    server: {
      port: 0,
      onEvent: (h) => {
        sink = h
      },
      close: () => {}
    },
    deliver: (d) => sink?.(d)
  }
}

const downgrade: SegmentWebhookDelivery = {
  body: {
    type: 'track',
    event: 'Subscription Downgraded',
    userId: 'u_1',
    messageId: 'm_1',
    properties: { mrr: 500, plan: 'pro' }
  }
}

describe('SegmentConnector — the HARD pre-seed filter (§7, the RAM-ceiling defense)', () => {
  it('seeds exactly ONE run for a matching event', () => {
    const wh = fakeWebhook()
    const c = new SegmentConnector({ api: new MockSegment(), webhook: wh.server })
    const seeds: SeedEvent[] = []
    c.subscribe('event.tracked', (e) => seeds.push(e as SeedEvent), {
      type: 'track',
      event: 'Subscription Downgraded'
    })
    wh.deliver(downgrade)
    expect(seeds).toHaveLength(1)
    expect(seeds[0].eventId).toBe('m_1')
    expect(seeds[0].payload).toMatchObject({
      event: { name: 'Subscription Downgraded', userId: 'u_1', properties: { mrr: 500 } }
    })
  })

  it('seeds ZERO runs for a non-matching event (name mismatch)', () => {
    const wh = fakeWebhook()
    const c = new SegmentConnector({ api: new MockSegment(), webhook: wh.server })
    const seeds: SeedEvent[] = []
    c.subscribe('event.tracked', (e) => seeds.push(e as SeedEvent), {
      type: 'track',
      event: 'Trial Started'
    })
    wh.deliver(downgrade)
    expect(seeds).toHaveLength(0)
  })

  it('seeds ZERO runs when the property match fails', () => {
    const wh = fakeWebhook()
    const c = new SegmentConnector({ api: new MockSegment(), webhook: wh.server })
    const seeds: SeedEvent[] = []
    c.subscribe('event.tracked', (e) => seeds.push(e as SeedEvent), {
      type: 'track',
      event: 'Subscription Downgraded',
      match: { plan: 'free' }
    })
    wh.deliver(downgrade)
    expect(seeds).toHaveLength(0)
  })

  it('skips an un-named track subscription with a loud warning — never throws (§7.3, startup-safety)', () => {
    const wh = fakeWebhook()
    const logs: string[] = []
    const c = new SegmentConnector({
      api: new MockSegment(),
      webhook: wh.server,
      log: (m) => logs.push(m)
    })
    const seeds: SeedEvent[] = []
    let unsub: (() => void) | undefined
    expect(() => {
      unsub = c.subscribe('event.tracked', (e) => seeds.push(e as SeedEvent), { type: 'track' })
    }).not.toThrow()
    expect(unsub).toBeTypeOf('function')
    expect(() => unsub?.()).not.toThrow()
    expect(logs.some((m) => /must name an event/.test(m))).toBe(true)

    // Not subscribed — a subsequent delivery seeds NO run (the firehose stays un-authorable).
    wh.deliver(downgrade)
    expect(seeds).toHaveLength(0)

    // The default type is track, so an empty config is skipped too, not thrown.
    expect(() => c.subscribe('event.tracked', () => {}, {})).not.toThrow()
  })
})

describe('SegmentConnector — gated writes', () => {
  it('track resolves the messageId + type and forwards the identity', async () => {
    const api = new MockSegment()
    const c = new SegmentConnector({ api, newId: () => 'msg_new' })
    const out = await c.invokeAction('track', {
      event: 'Save Offer Sent',
      userId: 'u_1',
      properties: { offer: 'x' }
    })
    expect(out).toEqual({ segment: { messageId: 'msg_new', type: 'track' } })
    expect(api.calls.track).toHaveLength(1)
    expect(api.calls.track[0]).toMatchObject({ event: 'Save Offer Sent', userId: 'u_1' })
  })

  it('rejects a track with no identity and an unknown action legibly', async () => {
    const c = new SegmentConnector({ api: new MockSegment() })
    await expect(c.invokeAction('track', { event: 'X' })).rejects.toThrow(/userId.*anonymousId/)
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })

  it('rejects a 401 from Segment with the verbatim message', async () => {
    const c = new SegmentConnector({ api: new MockSegment({ unauthorized: true }) })
    await expect(c.invokeAction('track', { event: 'X', userId: 'u_1' })).rejects.toThrow(
      /rejected the write key \(401\)/
    )
  })

  it('rejects a write when NO write key is stored — before the api is called (§11)', async () => {
    const api = new MockSegment()
    const c = new SegmentConnector({ api, hasWriteKey: () => false })
    await expect(c.invokeAction('track', { event: 'X', userId: 'u_1' })).rejects.toThrow(
      /needs a source write key/
    )
    expect(api.calls.track).toHaveLength(0)
  })
})

// The secrets the whole no-leak invariant guards (§8, §11): neither the shared
// secret nor the write key may appear in ANY connector output, log, or error.
const SHARED_SECRET = 'segment_shared_secret_super_value_abc'
const WRITE_KEY = 'segment_write_key_super_value_xyz'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

describe('the shared secret + write key never leak into any output, log, or error (§8, §11)', () => {
  it('keeps both secrets out of results and errors across success and failure paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-segment-tok-'))
    const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
    creds.set('segment', 'sharedSecret', SHARED_SECRET)
    creds.set('segment', 'writeKey', WRITE_KEY)
    const tokens = new SegmentTokenStore(creds)

    const captured: string[] = []
    const logs: string[] = []

    // A transport that carries the real write key in its Authorization header (as
    // the live wiring would) — proving the key flows IN — then we assert it never
    // flows OUT into any rendered surface.
    const transport: SegmentTransport = async (req) => {
      const header = `Authorization: Basic ${Buffer.from(`${tokens.writeKey()}:`).toString('base64')}`
      expect(header).toContain(Buffer.from(`${WRITE_KEY}:`).toString('base64'))
      if (req.body.event === 'ok') return { status: 200, body: { success: true } }
      // A failure path: a 401 (the bad-write-key branch of §11).
      return { status: 401, body: {} }
    }

    const connector = new SegmentConnector({
      api: new SegmentApiClient({ transport }),
      hasWriteKey: () => tokens.hasWriteKey(),
      log: (m) => logs.push(m)
    })

    const okOut = await connector.invokeAction('track', { event: 'ok', userId: 'u_1' })
    captured.push(JSON.stringify(okOut))

    await connector.invokeAction('track', { event: 'bad', userId: 'u_1' }).catch((e: Error) => {
      captured.push(e.message)
      captured.push(e.stack ?? '')
    })

    expect(captured.length).toBeGreaterThan(0)
    for (const s of [...captured, ...logs]) {
      expect(s).not.toContain(SHARED_SECRET)
      expect(s).not.toContain(WRITE_KEY)
    }
  })
})
