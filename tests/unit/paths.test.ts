import { describe, it, expect } from 'vitest'
import { looksLikeTypedPath, expandTypedPath, resolveDefaultCwd } from '../../src/shared/paths'
import type { SessionInfo } from '../../src/shared/types'

describe('looksLikeTypedPath', () => {
  it('accepts absolute paths', () => {
    expect(looksLikeTypedPath('/Users/jonas/code')).toBe(true)
  })
  it('accepts home-relative paths', () => {
    expect(looksLikeTypedPath('~/.volta/bin/openclaw')).toBe(true)
    expect(looksLikeTypedPath('~')).toBe(true)
  })
  it('rejects empty/whitespace-only input', () => {
    expect(looksLikeTypedPath('')).toBe(false)
    expect(looksLikeTypedPath('   ')).toBe(false)
  })
  it('rejects relative paths', () => {
    expect(looksLikeTypedPath('code/project')).toBe(false)
    expect(looksLikeTypedPath('./project')).toBe(false)
  })
  it('trims surrounding whitespace before checking', () => {
    expect(looksLikeTypedPath('  /Users/jonas  ')).toBe(true)
  })
})

describe('expandTypedPath', () => {
  const home = '/Users/jonas'

  it('passes absolute paths through unchanged (trimmed)', () => {
    expect(expandTypedPath('/opt/bin/claude', home)).toBe('/opt/bin/claude')
    expect(expandTypedPath('  /opt/bin/claude  ', home)).toBe('/opt/bin/claude')
  })

  it('expands a bare tilde to home', () => {
    expect(expandTypedPath('~', home)).toBe('/Users/jonas')
  })

  it('expands a tilde-prefixed path to home', () => {
    expect(expandTypedPath('~/.volta/bin/openclaw', home)).toBe('/Users/jonas/.volta/bin/openclaw')
  })

  it('rejects empty and whitespace-only input', () => {
    expect(expandTypedPath('', home)).toBeNull()
    expect(expandTypedPath('   ', home)).toBeNull()
  })

  it('rejects relative paths', () => {
    expect(expandTypedPath('code/project', home)).toBeNull()
    expect(expandTypedPath('./project', home)).toBeNull()
  })

  it('rejects a user-prefixed tilde (~otheruser) — not expanded, not absolute', () => {
    expect(expandTypedPath('~otheruser/code', home)).toBeNull()
  })
})

function session(cwd: string, kind: SessionInfo['kind'] = 'terminal'): SessionInfo {
  return {
    id: cwd,
    cwd,
    name: cwd,
    status: 'exited',
    agentId: 'claude',
    command: 'claude',
    environment: 1,
    kind
  }
}

describe('resolveDefaultCwd', () => {
  const home = '/Users/jonas'

  it('falls back to home when there are no sessions', () => {
    expect(resolveDefaultCwd([], home)).toBe(home)
  })

  it('falls back to home when every session is a browser pane', () => {
    const sessions = [session('/ignored', 'browser'), session('/also-ignored', 'browser')]
    expect(resolveDefaultCwd(sessions, home)).toBe(home)
  })

  it('returns the most recently created terminal session cwd (last in list order)', () => {
    const sessions = [session('/Users/jonas/first'), session('/Users/jonas/second')]
    expect(resolveDefaultCwd(sessions, home)).toBe('/Users/jonas/second')
  })

  it('skips trailing browser panes to find the most recent terminal cwd', () => {
    const sessions = [session('/Users/jonas/project'), session('https://example.com', 'browser')]
    expect(resolveDefaultCwd(sessions, home)).toBe('/Users/jonas/project')
  })

  it('falls back to home when the most recent terminal session has an empty cwd', () => {
    const sessions = [session('')]
    expect(resolveDefaultCwd(sessions, home)).toBe(home)
  })
})
