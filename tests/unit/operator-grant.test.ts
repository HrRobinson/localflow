import { describe, it, expect } from 'vitest'
import { OperatorGrantStore } from '../../src/main/operator-grant'

describe('OperatorGrantStore', () => {
  it('mints a per-environment secret and resolves it back to the env', () => {
    const store = new OperatorGrantStore()
    const tokenA = store.grant(1)
    const tokenB = store.grant(2)
    expect(tokenA).not.toBe(tokenB)
    expect(store.environmentForToken(tokenA)).toBe(1)
    expect(store.environmentForToken(tokenB)).toBe(2)
    expect(store.environmentForToken('garbage')).toBeNull()
  })

  it('is idempotent per environment (one operator per env)', () => {
    const store = new OperatorGrantStore()
    expect(store.grant(3)).toBe(store.grant(3))
    expect(store.isGranted(3)).toBe(true)
  })

  it('revocation invalidates the token immediately', () => {
    const store = new OperatorGrantStore()
    const token = store.grant(4)
    store.revoke(4)
    expect(store.environmentForToken(token)).toBeNull()
    expect(store.isGranted(4)).toBe(false)
  })

  it('tracks connected once the token is used', () => {
    const store = new OperatorGrantStore()
    store.grant(5)
    expect(store.isConnected(5)).toBe(false)
    store.markConnected(5)
    expect(store.isConnected(5)).toBe(true)
  })

  it('rejects malformed tokens without throwing', () => {
    const store = new OperatorGrantStore()
    store.grant(6)
    expect(store.environmentForToken('')).toBeNull()
    expect(store.environmentForToken(null as unknown as string)).toBeNull()
    expect(store.environmentForToken(42 as unknown as string)).toBeNull()
  })
})
