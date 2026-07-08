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
})
