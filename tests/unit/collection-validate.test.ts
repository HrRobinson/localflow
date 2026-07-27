import { describe, it, expect } from 'vitest'
import { validateCollection, toCollectionView } from '../../src/main/api-client/collection-validate'
import type { Collection } from '../../src/shared/api-client'

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Stripe',
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }],
    ...over
  }
}

describe('validateCollection', () => {
  it('accepts a well-formed collection and stamps id + environment', () => {
    const res = validateCollection(raw(), 2, 'col-1')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.id).toBe('col-1')
    expect(res.collection.environment).toBe(2)
    expect(res.collection.name).toBe('Stripe')
  })

  it('normalises origins and strips path/query', () => {
    const res = validateCollection(raw({ origins: ['https://api.stripe.com/v1?a=1'] }), 1, 'c')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.origins).toEqual(['https://api.stripe.com'])
  })

  it('rejects an unusable origin, naming the expected form', () => {
    const res = validateCollection(raw({ origins: ['not a url'] }), 1, 'c')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/scheme:\/\/host/)
  })

  it('rejects a non-http(s) origin', () => {
    expect(validateCollection(raw({ origins: ['file:///etc/passwd'] }), 1, 'c').ok).toBe(false)
  })

  it('requires at least one origin', () => {
    expect(validateCollection(raw({ origins: [] }), 1, 'c').ok).toBe(false)
  })

  it('requires a non-empty name', () => {
    expect(validateCollection(raw({ name: '   ' }), 1, 'c').ok).toBe(false)
  })

  it('rejects an unknown auth scheme', () => {
    expect(validateCollection(raw({ auth: { scheme: 'magic' } }), 1, 'c').ok).toBe(false)
  })

  it('requires a secretRef for every scheme except none', () => {
    expect(validateCollection(raw({ auth: { scheme: 'bearer' } }), 1, 'c').ok).toBe(false)
    expect(validateCollection(raw({ auth: { scheme: 'none' } }), 1, 'c').ok).toBe(true)
  })

  it('requires a header name for the header scheme', () => {
    const bad = raw({ auth: { scheme: 'header', secretRef: 'k' } })
    expect(validateCollection(bad, 1, 'c').ok).toBe(false)
    const good = raw({ auth: { scheme: 'header', secretRef: 'k', header: 'X-API-Key' } })
    expect(validateCollection(good, 1, 'c').ok).toBe(true)
  })

  it('REFUSES a secret-shaped varSet value and names secretRef', () => {
    // varSets live in plaintext on disk; a credential belongs in the keychain.
    const bad = raw({ varSets: { test: { key: 'sk_live_abc123' } } })
    const res = validateCollection(bad, 1, 'c')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/secretRef/)
      expect(res.reason).toMatch(/test/)
      expect(res.reason).toMatch(/key/)
    }
  })

  it('refuses a Bearer-prefixed varSet value too', () => {
    expect(validateCollection(raw({ varSets: { d: { a: 'Bearer xyz' } } }), 1, 'c').ok).toBe(false)
  })

  it('allows ordinary varSet values', () => {
    const ok = raw({ varSets: { test: { base_url: 'https://api.stripe.com', acct: 'acct_1' } } })
    expect(validateCollection(ok, 1, 'c').ok).toBe(true)
  })

  it('rejects a request with an unpinned method', () => {
    const bad = raw({ requests: [{ id: 'r', name: 'r', method: 'TRACE', path: '/x' }] })
    expect(validateCollection(bad, 1, 'c').ok).toBe(false)
  })

  it('rejects a malformed payload outright', () => {
    expect(validateCollection(null, 1, 'c').ok).toBe(false)
    expect(validateCollection('nope', 1, 'c').ok).toBe(false)
    expect(validateCollection(raw({ varSets: 'nope' }), 1, 'c').ok).toBe(false)
    expect(validateCollection(raw({ requests: 'nope' }), 1, 'c').ok).toBe(false)
  })

  it('ignores id and environment from the payload — caller wins', () => {
    const res = validateCollection(raw({ id: 'evil', environment: 99 }), 1, 'c')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.id).toBe('c')
    expect(res.collection.environment).toBe(1)
  })

  it('carries an explicit allowLocal: true through', () => {
    const res = validateCollection(raw({ allowLocal: true }), 1, 'c')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.allowLocal).toBe(true)
  })

  it('defaults allowLocal to falsy when omitted', () => {
    const res = validateCollection(raw(), 1, 'c')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.allowLocal).toBeFalsy()
  })

  it('does not let a truthy-but-not-true allowLocal opt in', () => {
    const res = validateCollection(raw({ allowLocal: 'yes' }), 1, 'c')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.allowLocal).toBe(false)
  })
})

describe('toCollectionView', () => {
  it('carries presence only, never a secret value', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Stripe',
      environment: 1,
      origins: ['https://api.stripe.com'],
      auth: { scheme: 'bearer', secretRef: 'apiKey' },
      varSets: {},
      requests: []
    }
    const view = toCollectionView(collection, true)
    expect(view.hasSecret).toBe(true)
    expect(JSON.stringify(view)).not.toContain('sk_')
    expect(Object.keys(view)).not.toContain('secret')
  })

  it('carries allowLocal through to the renderer view', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Stripe',
      environment: 1,
      origins: ['https://api.stripe.com'],
      allowLocal: true,
      auth: { scheme: 'bearer', secretRef: 'apiKey' },
      varSets: {},
      requests: []
    }
    const view = toCollectionView(collection, true)
    expect(view.allowLocal).toBe(true)
  })
})
