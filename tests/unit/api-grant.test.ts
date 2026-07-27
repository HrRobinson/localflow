import { describe, it, expect } from 'vitest'
import { ApiGrantStore } from '../../src/main/api-client/api-grant'

describe('ApiGrantStore', () => {
  it('mints a token that resolves to its environment and scope', () => {
    const s = new ApiGrantStore()
    const token = s.grant(1, ['stripe', 'internal'])
    const grant = s.resolve(token)
    expect(grant?.environment).toBe(1)
    expect([...(grant?.collections ?? [])].sort()).toEqual(['internal', 'stripe'])
  })

  it('returns null for an unknown, empty, or non-string token', () => {
    const s = new ApiGrantStore()
    s.grant(1, ['stripe'])
    expect(s.resolve('nope')).toBeNull()
    expect(s.resolve('')).toBeNull()
    expect(s.resolve(undefined as unknown as string)).toBeNull()
  })

  it('stops resolving immediately on revoke', () => {
    const s = new ApiGrantStore()
    const token = s.grant(1, ['stripe'])
    s.revoke(1)
    expect(s.resolve(token)).toBeNull()
    expect(s.isGranted(1)).toBe(false)
  })

  it('re-granting the same environment returns the existing token', () => {
    const s = new ApiGrantStore()
    expect(s.grant(1, ['stripe'])).toBe(s.grant(1, ['stripe']))
  })

  it('re-granting keeps the original scope even if collections narrow', () => {
    const s = new ApiGrantStore()
    s.grant(1, ['stripe', 'internal'])
    s.grant(1, ['stripe'])
    expect(s.scopeFor(1)?.sort()).toEqual(['internal', 'stripe'])
  })

  it('mutating the collections returned by resolve does not affect scopeFor', () => {
    const s = new ApiGrantStore()
    const token = s.grant(1, ['stripe'])
    const grant = s.resolve(token)
    ;(grant?.collections as Set<string>).add('internal')
    expect(s.scopeFor(1)).toEqual(['stripe'])
  })

  it('mints distinct tokens per environment', () => {
    const s = new ApiGrantStore()
    const a = s.grant(1, ['stripe'])
    const b = s.grant(2, ['stripe'])
    expect(a).not.toBe(b)
    expect(s.resolve(b)?.environment).toBe(2)
  })

  it('reports the scope for an environment', () => {
    const s = new ApiGrantStore()
    s.grant(1, ['stripe'])
    expect(s.scopeFor(1)).toEqual(['stripe'])
    expect(s.scopeFor(2)).toBeUndefined()
  })
})
