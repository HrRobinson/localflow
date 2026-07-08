import { describe, it, expect } from 'vitest'
import { nextNeedsYou } from '../../src/renderer/src/lib/needs-you'
import type { SessionInfo } from '../../src/shared/types'

const session = (id: string, status: SessionInfo['status'], workspace = 1): SessionInfo => ({
  id,
  cwd: '/tmp',
  name: id,
  status,
  agentId: 'claude',
  command: 'claude',
  workspace
})

const order = ['a', 'b', 'c', 'd']

describe('nextNeedsYou', () => {
  it('returns null when nothing needs attention', () => {
    const sessions = order.map((id) => session(id, 'working'))
    expect(nextNeedsYou(order, sessions, 'a', 1)).toBeNull()
  })

  it('jumps forward to the next waiting pane after the active one', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'idle'),
      session('c', 'needs-you'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, 'a', 1)).toBe('c')
  })

  it('wraps around past the end of the order', () => {
    const sessions = [
      session('a', 'needs-you'),
      session('b', 'working'),
      session('c', 'working'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, 'c', 1)).toBe('a')
  })

  it('cycles across multiple waiting panes on repeated calls', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'needs-you'),
      session('c', 'working'),
      session('d', 'needs-you')
    ]
    const first = nextNeedsYou(order, sessions, 'a', 1)
    expect(first).toBe('b')
    const second = nextNeedsYou(order, sessions, first, 1)
    expect(second).toBe('d')
    expect(nextNeedsYou(order, sessions, second, 1)).toBe('b')
  })

  it('returns the active pane itself when it is the only one waiting', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'needs-you'),
      session('c', 'working'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, 'b', 1)).toBe('b')
  })

  it('starts from the top for a null activeId (e.g. outside terminals view)', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'needs-you'),
      session('c', 'needs-you'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, null, 1)).toBe('b')
  })

  it('treats an activeId missing from order like null', () => {
    const sessions = [session('a', 'working'), session('b', 'needs-you')]
    expect(nextNeedsYou(['a', 'b'], sessions, 'ghost', 1)).toBe('b')
  })

  it('ignores needs-you sessions not present in order', () => {
    const sessions = [session('a', 'working'), session('zzz', 'needs-you')]
    expect(nextNeedsYou(['a'], sessions, 'a', 1)).toBeNull()
  })

  it('returns null for an empty order', () => {
    expect(nextNeedsYou([], [], null, 1)).toBeNull()
  })
})

describe('nextNeedsYou across workspaces', () => {
  it('prefers waiting panes on the current workspace', () => {
    const sessions = [
      session('a', 'working', 1),
      session('b', 'needs-you', 2),
      session('c', 'needs-you', 1),
      session('d', 'working', 1)
    ]
    expect(nextNeedsYou(order, sessions, 'a', 1)).toBe('c')
  })

  it('falls through to other workspaces when the current one is quiet', () => {
    const sessions = [
      session('a', 'working', 1),
      session('b', 'needs-you', 2),
      session('c', 'idle', 1),
      session('d', 'working', 1)
    ]
    expect(nextNeedsYou(order, sessions, 'a', 1)).toBe('b')
  })

  it('cycles current-workspace panes before foreign ones', () => {
    const sessions = [
      session('a', 'needs-you', 1),
      session('b', 'needs-you', 2),
      session('c', 'needs-you', 1),
      session('d', 'working', 1)
    ]
    const first = nextNeedsYou(order, sessions, 'd', 1)
    expect(first).toBe('a')
    const second = nextNeedsYou(order, sessions, first, 1)
    expect(second).toBe('c')
    const third = nextNeedsYou(order, sessions, second, 1)
    expect(third).toBe('b')
    // Wraps back to the first current-workspace candidate, completing the ring.
    expect(nextNeedsYou(order, sessions, third, 1)).toBe('a')
  })
})
