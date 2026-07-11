import { describe, it, expect } from 'vitest'
import { PaneRegistry } from '../../src/main/pane-registry'
import type { SessionInfo } from '../../src/shared/types'

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'x',
    cwd: '/p',
    name: 'p',
    status: 'idle',
    agentId: 'claude',
    command: 'claude',
    environment: 1,
    kind: 'terminal',
    ...over
  }
}

function fakeManager(sessions: SessionInfo[]): {
  list: () => SessionInfo[]
  get: (id: string) => SessionInfo | null
} {
  return { list: () => sessions, get: (id) => sessions.find((s) => s.id === id) ?? null }
}

describe('PaneRegistry', () => {
  const a1 = session({ id: 'a1', environment: 1, name: 'shopA-term' })
  const a2 = session({
    id: 'a2',
    environment: 1,
    kind: 'browser',
    url: 'http://localhost:3000',
    name: 'shopA-web'
  })
  const b1 = session({ id: 'b1', environment: 2, name: 'shopB-term' })
  const reg = new PaneRegistry(fakeManager([a1, a2, b1]))

  it('lists only panes in the given environment', () => {
    const handles = reg
      .list(1)
      .map((p) => p.handle)
      .sort()
    expect(handles).toEqual(['a1', 'a2'])
  })

  it('resolves a handle only within its environment', () => {
    expect(reg.resolve('a1', 1)?.id).toBe('a1')
    // Foreign-environment handle is rejected — the isolation guarantee.
    expect(reg.resolve('b1', 1)).toBeNull()
    expect(reg.resolve('a1', 2)).toBeNull()
    expect(reg.resolve('nope', 1)).toBeNull()
  })

  it('projects a browser pane to a PaneView with its url', () => {
    const view = reg.list(1).find((p) => p.handle === 'a2')
    expect(view).toMatchObject({
      kind: 'browser',
      url: 'http://localhost:3000',
      title: 'shopA-web'
    })
  })
})
