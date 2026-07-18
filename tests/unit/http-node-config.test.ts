import { describe, it, expect } from 'vitest'
import { resolveRequest, resolveWebhook } from '../../src/main/http/http-node-config'

describe('resolveRequest — http.get', () => {
  it('resolves a templated URL to a GET with no body, auth ref carried (not the secret)', () => {
    const req = resolveRequest('http.get', {
      url: 'https://api.internal/orders/42',
      auth: { scheme: 'bearer', secretRef: 'apiToken' }
    })
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://api.internal/orders/42')
    expect(req.body).toBeUndefined()
    expect(req.auth).toEqual({ scheme: 'bearer', secretRef: 'apiToken' })
    expect(req.allowLocal).toBe(false)
  })

  it('ignores a method on http.get (GET is fixed)', () => {
    const req = resolveRequest('http.get', { url: 'https://x.test', method: 'DELETE' })
    expect(req.method).toBe('GET')
  })
})

describe('resolveRequest — http.send', () => {
  it('defaults to POST, JSON-serializes an object body + sets content-type', () => {
    const req = resolveRequest('http.send', {
      url: 'https://ops.example.com/hook',
      body: { text: 'Order failed' }
    })
    expect(req.method).toBe('POST')
    expect(req.body).toBe('{"text":"Order failed"}')
    expect(req.headers['content-type']).toBe('application/json')
  })

  it('passes a string body through untouched and preserves an author content-type', () => {
    const req = resolveRequest('http.send', {
      url: 'https://x.test',
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'raw-payload'
    })
    expect(req.method).toBe('PUT')
    expect(req.body).toBe('raw-payload')
    expect(req.headers['content-type']).toBe('text/plain')
  })

  it('carries allowLocal + timeoutMs through', () => {
    const req = resolveRequest('http.send', {
      url: 'http://localhost:5678/webhook',
      allowLocal: true,
      timeoutMs: 3000
    })
    expect(req.allowLocal).toBe(true)
    expect(req.timeoutMs).toBe(3000)
  })
})

describe('resolveRequest — validate at the boundary (§9, §10)', () => {
  it('rejects a missing URL legibly', () => {
    expect(() => resolveRequest('http.send', {})).toThrow(/missing a URL/i)
  })

  it('rejects an invalid http.send method legibly', () => {
    expect(() => resolveRequest('http.send', { url: 'https://x.test', method: 'FETCH' })).toThrow(
      /invalid method/i
    )
  })

  it('rejects auth without a secretRef (never a silent default)', () => {
    expect(() =>
      resolveRequest('http.get', { url: 'https://x.test', auth: { scheme: 'bearer' } })
    ).toThrow(/secretRef/i)
  })

  it("rejects the 'header' scheme without a header name", () => {
    expect(() =>
      resolveRequest('http.get', {
        url: 'https://x.test',
        auth: { scheme: 'header', secretRef: 'k' }
      })
    ).toThrow(/header/i)
  })

  it('★ catches a secret literal smuggled into config.headers — never sends it (§10)', () => {
    expect(() =>
      resolveRequest('http.get', {
        url: 'https://x.test',
        headers: { Authorization: 'Bearer shpat_realsecret' }
      })
    ).toThrow(/secret literal/i)
  })
})

describe('resolveWebhook — incoming (Half 2 vocabulary pinned)', () => {
  it('resolves a token verifier node config', () => {
    const wh = resolveWebhook({
      inboundPath: '/wh/9f3a',
      verifier: { scheme: 'token', header: 'X-Auth' },
      secretRef: 'inKey'
    })
    expect(wh).toEqual({
      path: '/wh/9f3a',
      secretRef: 'inKey',
      verifier: { scheme: 'token', header: 'X-Auth' }
    })
  })

  it('rejects a path that is not rooted at "/"', () => {
    expect(() =>
      resolveWebhook({
        inboundPath: 'wh',
        verifier: { scheme: 'token', header: 'X' },
        secretRef: 'k'
      })
    ).toThrow(/inboundPath/i)
  })

  it('rejects an unknown verifier scheme', () => {
    expect(() =>
      resolveWebhook({
        inboundPath: '/wh',
        verifier: { scheme: 'jwt', header: 'X' },
        secretRef: 'k'
      })
    ).toThrow(/scheme/i)
  })

  it('rejects a missing secretRef', () => {
    expect(() =>
      resolveWebhook({ inboundPath: '/wh', verifier: { scheme: 'token', header: 'X' } })
    ).toThrow(/secretRef/i)
  })
})
