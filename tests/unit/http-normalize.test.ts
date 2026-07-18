import { describe, it, expect } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
import { responseToContext, webhookToContext } from '../../src/main/http/http-normalize'
import type { HttpRawResponse } from '../../src/main/http/http-client'

describe('responseToContext (§6.5)', () => {
  it('parses a JSON body by content-type, derives ok, lowercases header keys', () => {
    const res: HttpRawResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Rate': '5' },
      body: '{"id":42,"status":"failed"}'
    }
    expect(responseToContext(res)).toEqual({
      http: {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/json', 'x-rate': '5' },
        body: { id: 42, status: 'failed' }
      }
    })
  })

  it('leaves a non-JSON body as a string', () => {
    const res: HttpRawResponse = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'hello'
    }
    expect(responseToContext(res).http.body).toBe('hello')
  })

  it('derives ok=false for a 4xx and keeps the body a string when not JSON', () => {
    const res: HttpRawResponse = { status: 404, headers: {}, body: 'nope' }
    const ctx = responseToContext(res)
    expect(ctx.http.ok).toBe(false)
    expect(ctx.http.body).toBe('nope')
  })

  it('falls back to the raw string when a JSON content-type body does not parse', () => {
    const res: HttpRawResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'not json{'
    }
    expect(responseToContext(res).http.body).toBe('not json{')
  })

  it('exposes http.status as a number and http.ok as a boolean for conditions', () => {
    const ctx = responseToContext({ status: 204, headers: {}, body: '' })
    expect(typeof ctx.http.status).toBe('number')
    expect(ctx.http.ok).toBe(true)
  })
})

describe('webhookToContext (§6.5, Half 2)', () => {
  it('maps headers (lowercased), a JSON body, and the query string', () => {
    const headers: IncomingHttpHeaders = { 'Content-Type': 'application/json', 'X-Auth': 't' }
    const ctx = webhookToContext(
      Buffer.from('{"type":"payment_failed"}'),
      headers,
      '/wh/9f3a?src=n8n&id=7'
    )
    expect(ctx).toEqual({
      webhook: {
        headers: { 'content-type': 'application/json', 'x-auth': 't' },
        body: { type: 'payment_failed' },
        query: { src: 'n8n', id: '7' }
      }
    })
  })

  it('keeps a non-JSON body a string and yields an empty query when absent', () => {
    const ctx = webhookToContext('raw text', { 'content-type': 'text/plain' }, '/wh/9f3a')
    expect(ctx.webhook.body).toBe('raw text')
    expect(ctx.webhook.query).toEqual({})
  })
})
