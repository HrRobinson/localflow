import { describe, it, expect } from 'vitest'
import { normalizeOrigin, originAllowed } from '../../src/main/api-client/origins'

describe('normalizeOrigin', () => {
  it('reduces a URL to scheme://host[:port]', () => {
    expect(normalizeOrigin('https://api.stripe.com/v1/charges?a=1')).toBe('https://api.stripe.com')
    expect(normalizeOrigin('https://api.stripe.com:8443/x')).toBe('https://api.stripe.com:8443')
  })

  it('drops the default port so it matches the bare form', () => {
    expect(normalizeOrigin('https://api.stripe.com:443')).toBe('https://api.stripe.com')
  })

  it('rejects a non-http(s) scheme and an unparseable string', () => {
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
  })
})

describe('originAllowed', () => {
  const origins = ['https://api.stripe.com', 'https://files.stripe.com']

  it('allows a URL inside a declared origin', () => {
    expect(originAllowed('https://api.stripe.com/v1/charges', origins)).toBe(true)
    expect(originAllowed('https://files.stripe.com/x', origins)).toBe(true)
  })

  it('rejects a different host, scheme, or port', () => {
    expect(originAllowed('https://evil.com/v1', origins)).toBe(false)
    expect(originAllowed('http://api.stripe.com/v1', origins)).toBe(false)
    expect(originAllowed('https://api.stripe.com:8443/v1', origins)).toBe(false)
  })

  it('does NOT treat a subdomain or a prefix as a match', () => {
    expect(originAllowed('https://evil.api.stripe.com/v1', origins)).toBe(false)
    expect(originAllowed('https://api.stripe.com.evil.com/v1', origins)).toBe(false)
  })

  it('rejects an unparseable URL and an empty allowlist', () => {
    expect(originAllowed('not a url', origins)).toBe(false)
    expect(originAllowed('https://api.stripe.com/v1', [])).toBe(false)
  })
})
