import { describe, it, expect } from 'vitest'
import { nextFocusAfterClose } from '../../src/shared/close-focus'
import type { SessionInfo } from '../../src/shared/types'

// Minimal pane fixture: nextFocusAfterClose only reads `id` and `groupId`.
function pane(id: string, groupId?: string): SessionInfo {
  return {
    id,
    cwd: '/',
    name: id,
    status: 'idle',
    agentId: 'claude',
    command: 'claude',
    environment: 1,
    kind: 'terminal',
    groupId
  }
}

describe('nextFocusAfterClose', () => {
  it('prefers a farther grouped sibling over a nearer non-sibling', () => {
    const panes = [pane('a'), pane('b', 'g1'), pane('x'), pane('y'), pane('d', 'g1')]
    expect(nextFocusAfterClose('b', ['a', 'b', 'x', 'y', 'd'], panes)).toBe('d')
  })

  it('falls back to nearest pane in order when the closed pane has no sibling', () => {
    const panes = [pane('b', 'g1'), pane('c'), pane('d')]
    expect(nextFocusAfterClose('b', ['b', 'c', 'd'], panes)).toBe('c')
  })

  it('returns null when no pane remains', () => {
    expect(nextFocusAfterClose('a', ['a'], [])).toBeNull()
  })

  it('prefers the earlier pane in order on a distance tie', () => {
    const panes = [pane('a'), pane('b'), pane('c')]
    expect(nextFocusAfterClose('b', ['a', 'b', 'c'], panes)).toBe('a')
  })

  it('handles the delete case where the closed pane is already gone from panes', () => {
    const panes = [pane('a'), pane('c')]
    expect(nextFocusAfterClose('b', ['a', 'b', 'c'], panes)).toBe('a')
  })
})
