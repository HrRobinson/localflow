import { describe, it, expect } from 'vitest'
import {
  SentryHttpApi,
  type SentryRequest,
  type SentryResponse,
  type SentryTransport
} from '../../src/main/sentry/sentry-api'

/** A recording transport that returns a canned response per call. */
function recorder(responder: (req: SentryRequest) => SentryResponse): {
  transport: SentryTransport
  calls: SentryRequest[]
} {
  const calls: SentryRequest[] = []
  return {
    calls,
    transport: {
      send: (req) => {
        calls.push(req)
        return Promise.resolve(responder(req))
      }
    }
  }
}

const ok = (body: unknown): SentryResponse => ({ status: 200, body: JSON.stringify(body) })

function api(deps: {
  responder: (req: SentryRequest) => SentryResponse
  projectSlug?: string
  baseUrl?: string
}): { api: SentryHttpApi; calls: SentryRequest[] } {
  const { transport, calls } = recorder(deps.responder)
  return {
    calls,
    api: new SentryHttpApi({
      transport,
      orgSlug: 'my-org',
      projectSlug: deps.projectSlug,
      baseUrl: deps.baseUrl,
      reveal: () => 'sntrys_tok',
      sleep: () => Promise.resolve()
    })
  }
}

describe('SentryHttpApi — endpoint construction', () => {
  it('getEvent hits the issue latest-event endpoint by default', async () => {
    const { api: a, calls } = api({ responder: () => ok({ eventID: 'e1' }) })
    await a.getEvent({ id: '4509' })
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://sentry.io/api/0/issues/4509/events/latest/')
    expect(calls[0].headers.Authorization).toBe('Bearer sntrys_tok')
  })

  it('getIssue hits the org-scoped issue endpoint', async () => {
    const { api: a, calls } = api({ responder: () => ok({ id: '4509' }) })
    await a.getIssue('4509')
    expect(calls[0].url).toBe('https://sentry.io/api/0/organizations/my-org/issues/4509/')
  })
})

describe('SentryHttpApi — the project-scoped resolve detail (§2.2)', () => {
  it('resolveIssue WITHOUT statusDetails uses the org-level issue endpoint', async () => {
    const { api: a, calls } = api({ responder: () => ok({}), projectSlug: 'frontend' })
    await a.resolveIssue({ id: '4509' })
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe('https://sentry.io/api/0/issues/4509/')
    expect(JSON.parse(calls[0].body!)).toEqual({ status: 'resolved' })
  })

  it('resolveIssue WITH statusDetails.inCommit uses the PROJECT-scoped endpoint (honors inCommit)', async () => {
    const { api: a, calls } = api({ responder: () => ok({}), projectSlug: 'frontend' })
    await a.resolveIssue({
      id: '4509',
      statusDetails: { inCommit: { commit: 'deadbeef' } }
    })
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe('https://sentry.io/api/0/projects/my-org/frontend/issues/?id=4509')
    expect(JSON.parse(calls[0].body!)).toEqual({
      status: 'resolved',
      statusDetails: { inCommit: { commit: 'deadbeef' } }
    })
  })

  it('rejects legibly when a project-scoped resolve is requested with no project slug', async () => {
    const { api: a } = api({ responder: () => ok({}) }) // no projectSlug
    await expect(
      a.resolveIssue({ id: '4509', statusDetails: { inCommit: { commit: 'x' } } })
    ).rejects.toThrow(/Sentry resolve with commit\/release details needs a project slug/)
  })

  it('the missing-slug error names the ACTUAL op — ignore says ignore, not resolve', async () => {
    // The project-scoped path is shared by resolve + ignore; the error must be
    // action-accurate for whichever mutation the author actually invoked.
    const { api: a } = api({ responder: () => ok({}) }) // no projectSlug
    await expect(
      a.ignoreIssue({ id: '4509', statusDetails: { inRelease: 'latest' } })
    ).rejects.toThrow(/Sentry ignore with commit\/release details needs a project slug/)
  })
})

describe('SentryHttpApi — error mapping (§11) and SSRF (§5.2)', () => {
  it('maps 401 / 403 / 404 to actionable messages carrying the real cause', async () => {
    const a401 = api({ responder: () => ({ status: 401, body: '' }) }).api
    await expect(a401.getIssue('1')).rejects.toThrow(/rejected the auth token \(401\)/)

    const a403 = api({
      responder: () => ({ status: 403, body: JSON.stringify({ detail: 'need event:write' }) })
    }).api
    await expect(a403.resolveIssue({ id: '1' })).rejects.toThrow(
      /missing a required scope.*event:write/
    )

    const a404 = api({ responder: () => ({ status: 404, body: '' }) }).api
    await expect(a404.getIssue('nope')).rejects.toThrow(/no such resource \(404/)
  })

  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    let n = 0
    const { api: a, calls } = api({
      responder: () => (n++ === 0 ? { status: 429, body: '', retryAfterSec: 0 } : ok({ id: '1' }))
    })
    await a.getIssue('1')
    expect(calls).toHaveLength(2)
  })

  it('refuses a private/loopback baseUrl BEFORE any request (SSRF guard)', async () => {
    const { api: a, calls } = api({
      responder: () => ok({}),
      baseUrl: 'https://127.0.0.1'
    })
    await expect(a.getIssue('1')).rejects.toThrow(/private\/loopback address/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a non-https baseUrl', async () => {
    const { api: a } = api({ responder: () => ok({}), baseUrl: 'http://sentry.mycorp.com' })
    await expect(a.getIssue('1')).rejects.toThrow(/must be https/)
  })
})
