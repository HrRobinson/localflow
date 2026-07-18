import { describe, it, expect, vi } from 'vitest'
import {
  HttpClient,
  MockHttpTransport,
  FetchHttpTransport,
  type HttpRawResponse,
  type DnsLookupFn
} from '../../src/main/http/http-client'
import type { ResolvedRequest } from '../../src/shared/http'

const ok = (over: Partial<HttpRawResponse> = {}): HttpRawResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
  ...over
})

function req(url: string, over: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    method: 'GET',
    url,
    headers: {},
    auth: { scheme: 'none' },
    allowLocal: false,
    ...over
  }
}

/** ★ The security boundary — guarded hardest (spec §4.5, §10). Each blocked URL
 *  must REJECT before the transport is ever touched. */
describe('HttpClient — SSRF guard blocks internal targets BEFORE any socket', () => {
  const blocked: [string, RegExp][] = [
    ['https://127.0.0.1/x', /loopback/i],
    ['https://[::1]/x', /loopback|::1/i],
    ['https://10.0.0.5/x', /private/i],
    ['https://192.168.1.1/x', /private/i],
    ['https://172.16.0.1/x', /private/i],
    ['https://169.254.169.254/latest/meta-data', /link-local|private/i],
    ['https://user:pass@evil.test/x', /credentials/i],
    ['http://example.com/x', /https/i],
    ['https://localhost/api', /loopback/i]
  ]

  for (const [url, reason] of blocked) {
    it(`blocks ${url}, transport never called`, async () => {
      const t = new MockHttpTransport(() => ok())
      await expect(new HttpClient({ transport: t }).send(req(url))).rejects.toThrow(reason)
      expect(t.requests).toHaveLength(0)
    })
  }

  it('the block message points the author at the per-node allowLocal opt-in', async () => {
    const t = new MockHttpTransport(() => ok())
    await expect(new HttpClient({ transport: t }).send(req('https://127.0.0.1/x'))).rejects.toThrow(
      /allowLocal/
    )
  })

  it('re-checks the URL AFTER templating — a template that expands to metadata is blocked', async () => {
    // The client guards the FINAL resolved url string, whatever produced it.
    const t = new MockHttpTransport(() => ok())
    const templated = req('https://169.254.169.254/latest/meta-data/iam/security-credentials/')
    await expect(new HttpClient({ transport: t }).send(templated)).rejects.toThrow(
      /link-local|private/i
    )
    expect(t.requests).toHaveLength(0)
  })
})

describe('HttpClient — allowLocal opt-in permits a local target', () => {
  it('dials http://localhost when the node set allowLocal: true', async () => {
    const t = new MockHttpTransport(() => ok())
    const out = await new HttpClient({ transport: t }).send(
      req('http://localhost:5678/webhook', { allowLocal: true })
    )
    expect(out.status).toBe(200)
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0].url).toBe('http://localhost:5678/webhook')
  })

  it('permits a loopback IP under allowLocal', async () => {
    const t = new MockHttpTransport(() => ok())
    await expect(
      new HttpClient({ transport: t }).send(req('https://127.0.0.1/x', { allowLocal: true }))
    ).resolves.toMatchObject({ status: 200 })
  })

  it('still rejects a non-http(s) scheme even under allowLocal', async () => {
    const t = new MockHttpTransport(() => ok())
    await expect(
      new HttpClient({ transport: t }).send(req('file:///etc/passwd', { allowLocal: true }))
    ).rejects.toThrow(/http\(s\)/i)
    expect(t.requests).toHaveLength(0)
  })
})

/** ★ The string-level `checkBaseUrl` only pattern-matches literal IPs/`localhost`
 *  in the URL text — it never resolves DNS. `FetchHttpTransport` is the live
 *  transport this connector ships, so IT must re-check the RESOLVED IP before
 *  dialing, or a public-looking hostname whose A-record points at a private/
 *  loopback/metadata address (e.g. a sslip.io wildcard host) sails straight
 *  through to a real `fetch()`. These tests inject a fake DNS lookup so the
 *  bypass is reproduced and closed with zero real network I/O. */
describe('FetchHttpTransport — dial-time DNS-resolution SSRF guard', () => {
  it('blocks a public-looking hostname whose A-record resolves to link-local metadata, fetch never called', async () => {
    const lookup: DnsLookupFn = vi.fn(async () => [{ address: '169.254.169.254', family: 4 }])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const transport = new FetchHttpTransport({ lookup })

    await expect(
      transport.send({
        method: 'GET',
        url: 'https://169-254-169-254.sslip.io/latest/meta-data/',
        headers: {}
      })
    ).rejects.toThrow(/resolves to a private\/loopback\/metadata address.*169\.254\.169\.254/i)
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('allows a hostname whose A-record resolves to a public IP', async () => {
    const lookup: DnsLookupFn = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const transport = new FetchHttpTransport({ lookup })

    const res = await transport.send({ method: 'GET', url: 'https://api.example.com/x', headers: {} })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    fetchSpy.mockRestore()
  })

  it('still works for an IP-literal URL (the existing string check already covers it)', async () => {
    const lookup: DnsLookupFn = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const transport = new FetchHttpTransport({ lookup })

    const res = await transport.send({ method: 'GET', url: 'https://93.184.216.34/x', headers: {} })
    expect(res.status).toBe(200)

    fetchSpy.mockRestore()
  })

  it('allowLocal opt-in skips the resolution check for a host that resolves to loopback', async () => {
    const lookup: DnsLookupFn = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }])
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const transport = new FetchHttpTransport({ lookup })

    const res = await transport.send({
      method: 'GET',
      url: 'http://my-local-tunnel.example.com:5678/x',
      headers: {},
      allowLocal: true
    })
    expect(res.status).toBe(200)

    fetchSpy.mockRestore()
  })
})

describe('HttpClient — error mapping carries the real cause (§9)', () => {
  it('resolves the raw response on a 2xx', async () => {
    const t = new MockHttpTransport(() => ok({ status: 201 }))
    await expect(
      new HttpClient({ transport: t }).send(req('https://api.example.com/x'))
    ).resolves.toMatchObject({ status: 201 })
  })

  it('rejects a non-2xx with the status + a body excerpt', async () => {
    const t = new MockHttpTransport(() => ok({ status: 422, body: 'Unprocessable: name required' }))
    await expect(
      new HttpClient({ transport: t }).send(
        req('https://api.example.com/x', { method: 'POST', body: '{}' })
      )
    ).rejects.toThrow(/returned 422.*name required/i)
  })

  it('rejects a 429 surfacing the remote Retry-After verbatim', async () => {
    const t = new MockHttpTransport(() => ok({ status: 429, headers: { 'retry-after': '30' } }))
    await expect(
      new HttpClient({ transport: t }).send(req('https://api.example.com/x'))
    ).rejects.toThrow(/rate-limited \(429; Retry-After: 30\)/)
  })

  it('maps a transport error to a legible reject carrying the Node error code', async () => {
    const t = new MockHttpTransport(() => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' })
    })
    await expect(
      new HttpClient({ transport: t }).send(req('https://nope.invalid/x'))
    ).rejects.toThrow(/Couldn't reach nope\.invalid \(ENOTFOUND\)/)
  })
})
