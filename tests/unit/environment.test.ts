import { describe, it, expect } from 'vitest'
import {
  ENVIRONMENT_MIN,
  ENVIRONMENT_MAX,
  clampEnvironment,
  visibleEnvironments,
  worstStatus
} from '../../src/shared/environment'

describe('clampEnvironment', () => {
  it('passes through integers 1..9', () => {
    expect(clampEnvironment(1)).toBe(1)
    expect(clampEnvironment(9)).toBe(9)
    expect(clampEnvironment(5)).toBe(5)
  })
  it('defaults everything else to 1', () => {
    expect(clampEnvironment(undefined)).toBe(1)
    expect(clampEnvironment(null)).toBe(1)
    expect(clampEnvironment(0)).toBe(1)
    expect(clampEnvironment(10)).toBe(1)
    expect(clampEnvironment(2.5)).toBe(1)
    expect(clampEnvironment('3')).toBe(1)
    expect(clampEnvironment(NaN)).toBe(1)
  })
  it('exports the 1..9 bounds', () => {
    expect(ENVIRONMENT_MIN).toBe(1)
    expect(ENVIRONMENT_MAX).toBe(9)
  })
})

describe('visibleEnvironments', () => {
  it('lists non-empty environments plus the current one, ascending', () => {
    const sessions = [{ environment: 3 }, { environment: 1 }, { environment: 3 }]
    expect(visibleEnvironments(sessions, 5)).toEqual([1, 3, 5])
  })
  it('does not duplicate the current environment when non-empty', () => {
    expect(visibleEnvironments([{ environment: 2 }], 2)).toEqual([2])
  })
  it('is just the current environment when no sessions exist', () => {
    expect(visibleEnvironments([], 4)).toEqual([4])
  })
})

describe('worstStatus', () => {
  it('ranks needs-you > working > running > idle > exited', () => {
    expect(worstStatus(['idle', 'working', 'needs-you'])).toBe('needs-you')
    expect(worstStatus(['exited', 'running', 'working'])).toBe('working')
    expect(worstStatus(['idle', 'running'])).toBe('running')
    expect(worstStatus(['exited', 'idle'])).toBe('idle')
    expect(worstStatus(['exited'])).toBe('exited')
  })
  it('returns exited for an empty list', () => {
    expect(worstStatus([])).toBe('exited')
  })
})
