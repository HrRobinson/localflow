import { describe, it, expect } from 'vitest'
import { nextNeedsYou } from '../../src/renderer/src/lib/needs-you'
import type { SessionInfo } from '../../src/shared/types'

const session = (id: string, status: SessionInfo['status']): SessionInfo => ({
  id,
  cwd: '/tmp',
  name: id,
  status,
  agentId: 'claude',
  command: 'claude'
})

const order = ['a', 'b', 'c', 'd']

describe('nextNeedsYou', () => {
  it('returns null when nothing needs attention', () => {
    const sessions = order.map((id) => session(id, 'working'))
    expect(nextNeedsYou(order, sessions, 'a')).toBeNull()
  })

  it('jumps forward to the next waiting pane after the active one', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'idle'),
      session('c', 'needs-you'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, 'a')).toBe('c')
  })

  it('wraps around past the end of the order', () => {
    const sessions = [
      session('a', 'needs-you'),
      session('b', 'working'),
      session('c', 'working'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, 'c')).toBe('a')
  })

  it('cycles across multiple waiting panes on repeated calls', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'needs-you'),
      session('c', 'working'),
      session('d', 'needs-you')
    ]
    const first = nextNeedsYou(order, sessions, 'a')
    expect(first).toBe('b')
    const second = nextNeedsYou(order, sessions, first)
    expect(second).toBe('d')
    expect(nextNeedsYou(order, sessions, second)).toBe('b')
  })

  it('returns the active pane itself when it is the only one waiting', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'needs-you'),
      session('c', 'working'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, 'b')).toBe('b')
  })

  it('starts from the top for a null activeId (e.g. outside terminals view)', () => {
    const sessions = [
      session('a', 'working'),
      session('b', 'needs-you'),
      session('c', 'needs-you'),
      session('d', 'working')
    ]
    expect(nextNeedsYou(order, sessions, null)).toBe('b')
  })

  it('treats an activeId missing from order like null', () => {
    const sessions = [session('a', 'working'), session('b', 'needs-you')]
    expect(nextNeedsYou(['a', 'b'], sessions, 'ghost')).toBe('b')
  })

  it('ignores needs-you sessions not present in order', () => {
    const sessions = [session('a', 'working'), session('zzz', 'needs-you')]
    expect(nextNeedsYou(['a'], sessions, 'a')).toBeNull()
  })

  it('returns null for an empty order', () => {
    expect(nextNeedsYou([], [], null)).toBeNull()
  })
})
