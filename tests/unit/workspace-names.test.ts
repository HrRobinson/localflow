import { describe, it, expect } from 'vitest'
import { parseWorkspaceNames } from '../../src/main/workspace-names'

describe('parseWorkspaceNames', () => {
  it('keeps entries keyed 1-9 with non-empty string values', () => {
    expect(parseWorkspaceNames({ '3': 'backend', '1': 'web' })).toEqual({
      '1': 'web',
      '3': 'backend'
    })
  })

  it('drops out-of-range keys, non-string and empty values', () => {
    expect(
      parseWorkspaceNames({ '0': 'x', '10': 'y', '2': 42, '4': '', '5': '  ', '6': 'ok' })
    ).toEqual({ '6': 'ok' })
  })

  it('returns {} for non-objects', () => {
    expect(parseWorkspaceNames(undefined)).toEqual({})
    expect(parseWorkspaceNames(null)).toEqual({})
    expect(parseWorkspaceNames('nope')).toEqual({})
    expect(parseWorkspaceNames([1, 2])).toEqual({})
  })

  it('trims whitespace-padded names', () => {
    expect(parseWorkspaceNames({ '7': '  infra  ' })).toEqual({ '7': 'infra' })
  })

  it('drops non-canonical numeric keys so they cannot collide with canonical ones', () => {
    expect(parseWorkspaceNames({ '01': 'a' })).toEqual({})
    expect(parseWorkspaceNames({ '1.0': 'b' })).toEqual({})
    expect(parseWorkspaceNames({ ' 1': 'c' })).toEqual({})
    expect(parseWorkspaceNames({ '1e0': 'd' })).toEqual({})
    // A canonical key always wins outright — the alias is simply ignored.
    expect(parseWorkspaceNames({ '1': 'web', '01': 'shadow' })).toEqual({ '1': 'web' })
  })
})
