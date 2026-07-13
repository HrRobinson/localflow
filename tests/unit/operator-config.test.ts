import { describe, it, expect } from 'vitest'
import { parseOperatorRevokeOnExit } from '../../src/main/operator-config'

describe('parseOperatorRevokeOnExit', () => {
  it('defaults to false when absent or malformed', () => {
    expect(parseOperatorRevokeOnExit({})).toBe(false)
    expect(parseOperatorRevokeOnExit(null)).toBe(false)
    expect(parseOperatorRevokeOnExit([1, 2])).toBe(false)
    expect(parseOperatorRevokeOnExit({ operatorRevokeOnExit: 'true' })).toBe(false)
    expect(parseOperatorRevokeOnExit({ operatorRevokeOnExit: 1 })).toBe(false)
    expect(parseOperatorRevokeOnExit({ operatorRevokeOnExit: false })).toBe(false)
  })

  it('enables only on a literal true', () => {
    expect(parseOperatorRevokeOnExit({ operatorRevokeOnExit: true })).toBe(true)
  })
})
