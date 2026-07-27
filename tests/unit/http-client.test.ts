import http from 'node:http'
import type { AddressInfo } from 'node:net'
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
    ['https://169.254.169.254/latest/meta-data', /cloud-metadata|link-local|private/i],
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
      /cloud-metadata|link-local|private/i
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

    const res = await transport.send({
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: {}
    })
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

/** ★ Pins the empirical finding for the "U+200B defeats `looksLikeSecretLiteral`"
 *  investigation (`http-node-config.ts`'s guard trims with `String.trim()`,
 *  which does not strip U+200B, category Cf). The open question was whether a
 *  header carrying a leading U+200B ever reaches the wire through the REAL
 *  transport — if it does, the guard's blind spot is exploitable; if the
 *  platform itself refuses the header first, it is moot. It refuses: the
 *  WHATWG Fetch `Headers` implementation requires every header name/value to
 *  be ByteString-convertible (code points ≤ 255), and U+200B is 0x200B (8203),
 *  so `fetch()` throws before a socket ever opens — for both a header VALUE
 *  and a header NAME. Confirmed against a real loopback `node:http` server via
 *  the real `FetchHttpTransport`, not a mock. See spec §4.1 for the recorded,
 *  checked-and-closed note. */
describe('FetchHttpTransport — U+200B in a header is refused by the platform before any socket', () => {
  async function startLoopbackServer() {
    const received: http.IncomingHttpHeaders[] = []
    const server = http.createServer((req, res) => {
      received.push(req.headers)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    return { server, received, port }
  }

  it('a header VALUE with a leading U+200B never reaches the wire — fetch() throws', async () => {
    const { server, received, port } = await startLoopbackServer()
    const transport = new FetchHttpTransport()
    try {
      await expect(
        transport.send({
          method: 'GET',
          url: `http://127.0.0.1:${port}/`,
          headers: { 'x-probe': '​sk_live_STOLEN' },
          allowLocal: true
        })
      ).rejects.toThrow(/ByteString/i)
      expect(received).toHaveLength(0)
    } finally {
      server.close()
    }
  })

  it('a header NAME with a leading U+200B never reaches the wire — fetch() throws', async () => {
    const { server, received, port } = await startLoopbackServer()
    const transport = new FetchHttpTransport()
    try {
      await expect(
        transport.send({
          method: 'GET',
          url: `http://127.0.0.1:${port}/`,
          headers: { '​x-probe-name': 'plain-value' },
          allowLocal: true
        })
      ).rejects.toThrow(/ByteString/i)
      expect(received).toHaveLength(0)
    } finally {
      server.close()
    }
  })
})

/** ★ C1 (CRITICAL): `sendRaw`'s catch previously spliced `err.message` straight
 *  into the rejection. undici's `Headers.append` embeds the ENTIRE offending
 *  header value in its `TypeError` when the value carries an embedded LF/NUL
 *  (confirmed directly: `new Headers().append('x', 'line1\nline2')` throws
 *  `TypeError: Headers.append: "line1\nline2" is an invalid header value.`) —
 *  so a withheld value chained into a header (a PEM private key, a
 *  multi-line description) came back to the agent in the clear through this
 *  one path, with no gate, no scrub, no upstream cooperation. This MUST drive
 *  the REAL `FetchHttpTransport`: `MockHttpTransport` never validates
 *  headers, so a synthetic `ECONNREFUSED` (as `api-send.test.ts` already
 *  covers) never enters this path at all — which is exactly why the existing
 *  suite missed it. */
describe('HttpClient.sendRaw — C1: a transport error never carries request content', () => {
  async function startLoopbackServer() {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    return { server, port }
  }

  it('a header value with an embedded LF (e.g. a chained PEM key) never reaches the reject message', async () => {
    const { server, port } = await startLoopbackServer()
    const STOLEN_MARKER =
      '-----BEGIN PRIVATE KEY-----\nFAKE-STOLEN-PEM-MARKER\n-----END PRIVATE KEY-----'
    try {
      const client = new HttpClient({ transport: new FetchHttpTransport() })
      let caught: Error | undefined
      try {
        await client.sendRaw(
          req(`http://127.0.0.1:${port}/`, {
            headers: { 'x-probe': STOLEN_MARKER },
            allowLocal: true
          })
        )
      } catch (err) {
        caught = err as Error
      }
      expect(caught).toBeDefined()
      expect(caught?.message).not.toContain('FAKE-STOLEN-PEM-MARKER')
      expect(caught?.message).not.toContain('Headers.append')
    } finally {
      server.close()
    }
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

  it('falls back to err.cause.code for a real-fetch-shaped failure with no own err.code (C1 minor)', async () => {
    // A real `fetch()` DNS failure never sets `err.code` itself — the Node
    // error code lives one level down, on `err.cause.code` (verified:
    // `fetch('https://no-such-host.invalid/')` throws with
    // `err.code === undefined` and `err.cause.code === 'ENOTFOUND'`). Before
    // this fallback, every real transport failure surfaced only the generic
    // `transport error` label, never the actual code.
    const t = new MockHttpTransport(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' })
      })
    })
    await expect(
      new HttpClient({ transport: t }).send(req('https://nope.invalid/x'))
    ).rejects.toThrow(/Couldn't reach nope\.invalid \(ENOTFOUND\)/)
  })

  it('still falls back to the contentless label when neither err.code nor err.cause.code exist', async () => {
    const t = new MockHttpTransport(() => {
      throw new Error('boom, no code anywhere')
    })
    await expect(
      new HttpClient({ transport: t }).send(req('https://nope.invalid/x'))
    ).rejects.toThrow(/Couldn't reach nope\.invalid \(transport error\)/)
  })

  it('the err.cause fallback never surfaces a header value: a real Headers.append failure still redacts', async () => {
    // Confirms the C1 fix (surfacing `err.cause?.code`) does not reopen C1
    // itself: a real header-validation TypeError from undici carries no
    // `.code` and no `.cause` with a `.code`, so it must still fall through
    // to the fixed, contentless label — never the embedded header value.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const STOLEN_MARKER = 'FAKE-STOLEN-HEADER-VALUE\nLF-INJECTED'
    try {
      const client = new HttpClient({ transport: new FetchHttpTransport() })
      let caught: Error | undefined
      try {
        await client.sendRaw(
          req(`http://127.0.0.1:${port}/`, {
            headers: { 'x-probe': STOLEN_MARKER },
            allowLocal: true
          })
        )
      } catch (err) {
        caught = err as Error
      }
      expect(caught).toBeDefined()
      expect(caught?.message).not.toContain('FAKE-STOLEN-HEADER-VALUE')
      expect(caught?.message).not.toContain('Headers.append')
    } finally {
      server.close()
    }
  })
})

describe('HttpClient.sendRaw', () => {
  const request = {
    method: 'GET' as const,
    url: 'https://api.test/x',
    headers: {},
    auth: { scheme: 'none' as const },
    allowLocal: false
  }

  it('returns a non-2xx as a normal value instead of rejecting', async () => {
    const transport = new MockHttpTransport(() => ({
      status: 404,
      headers: {},
      body: '{"error":"no such charge"}'
    }))
    const res = await new HttpClient({ transport }).sendRaw(request)
    expect(res.status).toBe(404)
    expect(res.body).toBe('{"error":"no such charge"}')
  })

  it('returns a 429 as a normal value too', async () => {
    const transport = new MockHttpTransport(() => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: 'slow down'
    }))
    const res = await new HttpClient({ transport }).sendRaw(request)
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBe('30')
  })

  it('still enforces the SSRF guard before dialling', async () => {
    const transport = new MockHttpTransport(() => ({ status: 200, headers: {}, body: '' }))
    await expect(
      new HttpClient({ transport }).sendRaw({ ...request, url: 'https://127.0.0.1/x' })
    ).rejects.toThrow()
    expect(transport.requests).toHaveLength(0)
  })

  it('still maps a transport failure to the legible reject', async () => {
    const transport = new MockHttpTransport(() => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
    })
    await expect(new HttpClient({ transport }).sendRaw(request)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('send() still rejects on non-2xx (unchanged for the connector)', async () => {
    const transport = new MockHttpTransport(() => ({ status: 500, headers: {}, body: 'nope' }))
    await expect(new HttpClient({ transport }).send(request)).rejects.toThrow(/500/)
  })
})
