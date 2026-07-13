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

// App.tsx's moveToEnvironment moves a pane (and, if it's grouped, its whole
// group — session-manager's setEnvironment drags every member along
// synchronously) to another environment, then must pick the next focus among
// panes still in the CURRENT environment. Unlike delete/close, the moved
// pane's own record survives (just with a new `environment`), so the call
// site refreshes first and scopes `panes` to the current environment from
// that freshly fetched list — which naturally drops the moved pane and any
// grouped siblings that moved with it, before calling this function. These
// cases pin that call-site contract against this function directly.
describe('nextFocusAfterClose — moveToEnvironment call-site scenarios', () => {
  it('multi-member group move: next focus is not a moved sibling, lands on the nearest remaining pane', () => {
    // b and its group sibling d moved away together; post-refresh, only
    // a, c, e remain scoped to the old environment.
    const panes = [pane('a'), pane('c'), pane('e')]
    expect(nextFocusAfterClose('b', ['a', 'b', 'c', 'd', 'e'], panes)).toBe('a')
  })

  it('solo pane move: lands on the nearest remaining pane (unchanged from prior behavior)', () => {
    const panes = [pane('a'), pane('c')]
    expect(nextFocusAfterClose('b', ['a', 'b', 'c'], panes)).toBe('a')
  })
})

// Regression guard: deleteSession/closeTerminal call this with the
// PRE-refresh `sessions` snapshot, where the just-deleted/closed pane's own
// record — and its groupId — is still present (that's how its groupId is
// recovered). The moveToEnvironment fix must not change this.
describe('nextFocusAfterClose — delete case regression guard', () => {
  it("still prefers a same-group sibling when the closed pane's pre-refresh record is present", () => {
    const panes = [pane('a', 'g1'), pane('b'), pane('c', 'g1')]
    expect(nextFocusAfterClose('a', ['a', 'b', 'c'], panes)).toBe('c')
  })
})
