import { describe, it, expect } from 'vitest'
import {
  PostHogHttpApi,
  type PostHogRequest,
  type PostHogResponse,
  type PostHogTransport
} from '../../src/main/posthog/posthog-api'

/**
 * `posthog-api` security + transport behavior (spec §4.4, §11). The user-supplied
 * `host` passes the SHARED SSRF guard BEFORE any request is built; the personal
 * API key rides only in the Bearer header (revealed at call time); errors carry
 * the real PostHog cause. Driven over a recording transport — no live HTTP.
 */

const KEY = 'phx_live_SECRET_do_not_leak_9f3a'

class RecordingTransport implements PostHogTransport {
  readonly requests: PostHogRequest[] = []
  constructor(private readonly respond: (req: PostHogRequest) => PostHogResponse) {}
  send(req: PostHogRequest): Promise<PostHogResponse> {
    this.requests.push(req)
    return Promise.resolve(this.respond(req))
  }
}

const ok = (value: unknown): PostHogResponse => ({ status: 200, body: JSON.stringify(value) })

function buildApi(host: string, transport: RecordingTransport, allowInsecureLocalHost = false) {
  return new PostHogHttpApi({
    transport,
    host,
    projectApiKey: 'phc_public',
    reveal: () => KEY,
    allowInsecureLocalHost,
    sleep: () => Promise.resolve()
  })
}

describe('PostHogHttpApi — SSRF guard on the user-supplied host (spec §4.4)', () => {
  const cases: [string, RegExp][] = [
    ['http://us.posthog.com', /https:\/\//i], // non-https
    ['https://127.0.0.1', /loopback/i],
    ['https://10.0.0.5', /private/i],
    ['https://192.168.1.10', /private/i],
    ['https://169.254.169.254', /cloud-metadata/i], // cloud metadata endpoint
    ['https://localhost', /loopback/i]
  ]

  for (const [host, reason] of cases) {
    it(`refuses ${host} BEFORE any request`, async () => {
      const t = new RecordingTransport(() => ok({}))
      await expect(buildApi(host, t).getInsight('5')).rejects.toThrow(reason)
      expect(t.requests).toHaveLength(0)
    })
  }

  it('allows a public cloud host and sends a Bearer header (key never in the URL)', async () => {
    const t = new RecordingTransport(() => ok({ id: 5 }))
    await buildApi('https://us.posthog.com', t).getInsight('5')
    expect(t.requests[0].url).toBe('https://us.posthog.com/api/projects/@current/insights/5/')
    expect(t.requests[0].headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(t.requests[0].url).not.toContain(KEY)
  })

  it('allowInsecureLocalHost flips a localhost self-host from blocked to allowed', async () => {
    const t = new RecordingTransport(() => ok({ id: 5 }))
    // Blocked by default…
    await expect(buildApi('https://localhost:8000', t).getInsight('5')).rejects.toThrow(/loopback/i)
    expect(t.requests).toHaveLength(0)
    // …allowed behind the explicit opt-in (the reviewed self-host-on-LAN hatch).
    await buildApi('https://localhost:8000', t, true).getInsight('5')
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0].url).toBe('https://localhost:8000/api/projects/@current/insights/5/')
  })
})

describe('PostHogHttpApi — error mapping carries the real cause (spec §11)', () => {
  it('401 → re-enter the key', async () => {
    const t = new RecordingTransport(() => ({ status: 401, body: '' }))
    await expect(buildApi('https://us.posthog.com', t).getInsight('5')).rejects.toThrow(
      /revoked or is wrong/i
    )
  })

  it('403 → forwards the scope detail', async () => {
    const t = new RecordingTransport(() => ({
      status: 403,
      body: JSON.stringify({ detail: 'You do not have write access to feature flags' })
    }))
    await expect(
      buildApi('https://us.posthog.com', t).updateFeatureFlag('3', { active: false })
    ).rejects.toThrow(/write access to feature flags/)
  })

  it('404 → names the resource, not a bare 404', async () => {
    const t = new RecordingTransport(() => ({ status: 404, body: '' }))
    await expect(buildApi('https://us.posthog.com', t).getInsight('999')).rejects.toThrow(
      /no such resource.*insights\/999/i
    )
  })

  it('429 → backs off then rejects (no infinite retry), never swallowed', async () => {
    const t = new RecordingTransport(() => ({ status: 429, body: '', retryAfterSeconds: 0 }))
    await expect(buildApi('https://us.posthog.com', t).getInsight('5')).rejects.toThrow(
      /throttled/i
    )
    expect(t.requests.length).toBeGreaterThan(1) // it retried before giving up
  })

  it('queryEvents builds an ascending HogQL query and unwraps positional rows', async () => {
    const t = new RecordingTransport(() =>
      ok({
        columns: ['uuid', 'event', 'distinct_id', 'timestamp', 'properties'],
        results: [['e1', '$error', 'p', '2026-07-18T10:00:00Z', {}]]
      })
    )
    const rows = await buildApi('https://us.posthog.com', t).queryEvents({
      event: '$error',
      after: '2026-07-18T09:00:00Z'
    })
    expect(rows).toEqual([
      {
        uuid: 'e1',
        event: '$error',
        distinct_id: 'p',
        timestamp: '2026-07-18T10:00:00Z',
        properties: {}
      }
    ])
    const body = JSON.parse(t.requests[0].body ?? '{}')
    expect(body.query.query).toMatch(/ORDER BY timestamp ASC/)
    expect(body.query.query).toMatch(/timestamp >= '2026-07-18T09:00:00Z'/)
  })
})

describe('PostHogHttpApi — no key leak on error', () => {
  it('a 401 error message never contains the key', async () => {
    const t = new RecordingTransport(() => ({ status: 401, body: '' }))
    let msg = ''
    try {
      await buildApi('https://us.posthog.com', t).updateFeatureFlag('3', { active: false })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).not.toContain(KEY)
    expect(msg).not.toContain('phx_')
  })
})
