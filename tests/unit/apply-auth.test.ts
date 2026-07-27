import { describe, it, expect } from 'vitest'
import { applyAuth } from '../../src/main/http/apply-auth'
import type { ResolvedRequest } from '../../src/shared/http'

function request(auth: ResolvedRequest['auth']): ResolvedRequest {
  return {
    method: 'GET',
    url: 'https://x.test/y',
    headers: { accept: 'json' },
    auth,
    allowLocal: false
  }
}

describe('applyAuth', () => {
  it('applies the bearer scheme', () => {
    const r = applyAuth(request({ scheme: 'bearer', secretRef: 'k' }), 'S3CRET')
    expect(r.headers.authorization).toBe('Bearer S3CRET')
  })

  it('base64-encodes the basic scheme', () => {
    const r = applyAuth(request({ scheme: 'basic', secretRef: 'k' }), 'u:p')
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  it('places the secret in the named header', () => {
    const r = applyAuth(request({ scheme: 'header', header: 'X-API-Key', secretRef: 'k' }), 'S')
    expect(r.headers['X-API-Key']).toBe('S')
  })

  it('falls back to authorization when the header scheme names none', () => {
    const r = applyAuth(request({ scheme: 'header', secretRef: 'k' }), 'S')
    expect(r.headers.authorization).toBe('S')
  })

  it('returns the request untouched for scheme none', () => {
    const original = request({ scheme: 'none' })
    expect(applyAuth(original, 'S')).toBe(original)
  })

  it('does not mutate the input request', () => {
    const original = request({ scheme: 'bearer', secretRef: 'k' })
    applyAuth(original, 'S')
    expect(original.headers.authorization).toBeUndefined()
  })
})
