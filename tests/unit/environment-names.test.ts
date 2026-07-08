import { describe, it, expect } from 'vitest'
import { parseEnvironmentNames } from '../../src/main/environment-names'

describe('parseEnvironmentNames', () => {
  it('keeps entries keyed 1-9 with non-empty string values', () => {
    expect(parseEnvironmentNames({ '3': 'backend', '1': 'web' })).toEqual({
      '1': 'web',
      '3': 'backend'
    })
  })

  it('drops out-of-range keys, non-string and empty values', () => {
    expect(
      parseEnvironmentNames({ '0': 'x', '10': 'y', '2': 42, '4': '', '5': '  ', '6': 'ok' })
    ).toEqual({ '6': 'ok' })
  })

  it('returns {} for non-objects', () => {
    expect(parseEnvironmentNames(undefined)).toEqual({})
    expect(parseEnvironmentNames(null)).toEqual({})
    expect(parseEnvironmentNames('nope')).toEqual({})
    expect(parseEnvironmentNames([1, 2])).toEqual({})
  })

  it('trims whitespace-padded names', () => {
    expect(parseEnvironmentNames({ '7': '  infra  ' })).toEqual({ '7': 'infra' })
  })

  it('drops non-canonical numeric keys so they cannot collide with canonical ones', () => {
    expect(parseEnvironmentNames({ '01': 'a' })).toEqual({})
    expect(parseEnvironmentNames({ '1.0': 'b' })).toEqual({})
    expect(parseEnvironmentNames({ ' 1': 'c' })).toEqual({})
    expect(parseEnvironmentNames({ '1e0': 'd' })).toEqual({})
    // A canonical key always wins outright — the alias is simply ignored.
    expect(parseEnvironmentNames({ '1': 'web', '01': 'shadow' })).toEqual({ '1': 'web' })
  })
})
