import { describe, it, expect } from 'vitest'
import { groupedOrder } from '../../src/shared/group-order'
import type { SessionInfo } from '../../src/shared/types'

// Minimal pane fixture: groupedOrder only reads `id` and `groupId`.
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

describe('groupedOrder', () => {
  it('pulls grouped members adjacent at the position of the first member', () => {
    const panes = [pane('a', 'g1'), pane('b'), pane('c', 'g1'), pane('d')]
    expect(groupedOrder(['a', 'b', 'c', 'd'], panes)).toEqual([
      { group: 'g1', ids: ['a', 'c'] },
      { group: null, ids: ['b'] },
      { group: null, ids: ['d'] }
    ])
  })

  it('returns an empty array for empty inputs', () => {
    expect(groupedOrder([], [])).toEqual([])
  })

  it('skips ids in order that are not in panes', () => {
    const panes = [pane('a'), pane('c')]
    expect(groupedOrder(['a', 'b', 'c'], panes)).toEqual([
      { group: null, ids: ['a'] },
      { group: null, ids: ['c'] }
    ])
  })

  it('preserves relative order of solo panes around a group', () => {
    const panes = [pane('a'), pane('b', 'g1'), pane('c'), pane('d', 'g1')]
    expect(groupedOrder(['a', 'b', 'c', 'd'], panes)).toEqual([
      { group: null, ids: ['a'] },
      { group: 'g1', ids: ['b', 'd'] },
      { group: null, ids: ['c'] }
    ])
  })

  it('handles a single group spanning the whole order', () => {
    const panes = [pane('a', 'g1'), pane('b', 'g1')]
    expect(groupedOrder(['a', 'b'], panes)).toEqual([{ group: 'g1', ids: ['a', 'b'] }])
  })
})
