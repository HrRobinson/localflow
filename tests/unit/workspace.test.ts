import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_MIN,
  WORKSPACE_MAX,
  clampWorkspace,
  visibleWorkspaces,
  worstStatus
} from '../../src/shared/workspace'

describe('clampWorkspace', () => {
  it('passes through integers 1..9', () => {
    expect(clampWorkspace(1)).toBe(1)
    expect(clampWorkspace(9)).toBe(9)
    expect(clampWorkspace(5)).toBe(5)
  })
  it('defaults everything else to 1', () => {
    expect(clampWorkspace(undefined)).toBe(1)
    expect(clampWorkspace(null)).toBe(1)
    expect(clampWorkspace(0)).toBe(1)
    expect(clampWorkspace(10)).toBe(1)
    expect(clampWorkspace(2.5)).toBe(1)
    expect(clampWorkspace('3')).toBe(1)
    expect(clampWorkspace(NaN)).toBe(1)
  })
  it('exports the 1..9 bounds', () => {
    expect(WORKSPACE_MIN).toBe(1)
    expect(WORKSPACE_MAX).toBe(9)
  })
})

describe('visibleWorkspaces', () => {
  it('lists non-empty workspaces plus the current one, ascending', () => {
    const sessions = [{ workspace: 3 }, { workspace: 1 }, { workspace: 3 }]
    expect(visibleWorkspaces(sessions, 5)).toEqual([1, 3, 5])
  })
  it('does not duplicate the current workspace when non-empty', () => {
    expect(visibleWorkspaces([{ workspace: 2 }], 2)).toEqual([2])
  })
  it('is just the current workspace when no sessions exist', () => {
    expect(visibleWorkspaces([], 4)).toEqual([4])
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
