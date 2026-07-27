import { describe, it, expect } from 'vitest'
import { buildRequest } from '../../openclaw/skills/saiife-api/bin/saiife-api.mjs'

describe('saiife-api buildRequest', () => {
  const base = 'http://127.0.0.1:5000'

  it('maps collections to GET /http/collections', () => {
    expect(buildRequest(base, ['collections'])).toMatchObject({
      method: 'GET',
      path: '/http/collections'
    })
  })

  it('maps send of a saved request to POST /http/send', () => {
    const r = buildRequest(base, ['send', 'stripe', '--request', 'charges', '--varset', 'test'])
    expect(r).toMatchObject({
      method: 'POST',
      path: '/http/send',
      body: { collectionId: 'stripe', requestId: 'charges', varSet: 'test' }
    })
  })

  it('maps send with an inline JSON spec to POST /http/send', () => {
    const spec = JSON.stringify({ method: 'GET', path: '/v1/charges' })
    const r = buildRequest(base, ['send', 'stripe', '--spec', spec])
    expect(r).toMatchObject({
      method: 'POST',
      path: '/http/send',
      body: { collectionId: 'stripe', spec: { method: 'GET', path: '/v1/charges' } }
    })
  })

  it('maps response to GET /http/responses/:id', () => {
    expect(buildRequest(base, ['response', 'r3'])).toMatchObject({
      method: 'GET',
      path: '/http/responses/r3'
    })
  })

  it('maps pull to GET /http/responses/:id/pull with an encoded path query', () => {
    const r = buildRequest(base, ['pull', 'r3', '$.data[0].id'])
    expect(r).toMatchObject({
      method: 'GET',
      path: `/http/responses/r3/pull?path=${encodeURIComponent('$.data[0].id')}`
    })
  })

  it('throws on an unknown verb', () => {
    expect(() => buildRequest(base, ['nope'])).toThrow(/unknown verb/)
  })

  it('throws when send has neither --request nor --spec', () => {
    expect(() => buildRequest(base, ['send', 'stripe'])).toThrow(/--request or --spec/)
  })
})
