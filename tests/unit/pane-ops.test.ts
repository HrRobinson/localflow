import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  type PtyLike,
  type SpawnFn,
  type SpawnSpec
} from '../../src/main/session-manager'
import { addCompanionPane } from '../../src/main/pane-ops'
import type { AgentId } from '../../src/shared/types'

class FakePty implements PtyLike {
  onData(): void {}
  onExit(): void {}
  write(): void {}
  resize(): void {}
  kill(): void {}
}

const claudeSpec: SpawnSpec = {
  agentId: 'claude',
  command: 'fake-claude',
  resumeArgs: ['--continue'],
  hookAdapter: 'settings-file'
}

const specFor = (agentId: AgentId): SpawnSpec => ({
  agentId,
  command: `fake-${agentId}`,
  resumeArgs: [],
  hookAdapter: 'none'
})

describe('addCompanionPane', () => {
  let mgr: SessionManager

  beforeEach(() => {
    const spawnFn: SpawnFn = () => new FakePty()
    mgr = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-pane-ops-')),
      port: 9999,
      token: 'tok',
      spawnFn
    })
  })

  it('wraps a solo source into a fresh group named after it', () => {
    const source = mgr.create('/proj/foo', claudeSpec, 3)
    expect(source.groupId).toBeUndefined()

    const companion = addCompanionPane(mgr, specFor, source.id, {
      kind: 'terminal',
      agentId: 'shell'
    })

    expect(companion).not.toBeNull()
    const refreshedSource = mgr.get(source.id)
    expect(refreshedSource?.groupId).toBeDefined()
    expect(companion?.groupId).toBe(refreshedSource?.groupId)
    const group = mgr.listGroups().find((g) => g.id === companion?.groupId)
    expect(group?.name).toBe(source.name)
    expect(group?.environment).toBe(3)
  })

  it('reuses an existing group when the source already belongs to one', () => {
    const source = mgr.create('/proj/foo', claudeSpec, 2)
    const group = mgr.createGroup('my-session', 2)
    mgr.assignToGroup(source.id, group.id)

    const before = mgr.listGroups().length
    const companion = addCompanionPane(mgr, specFor, source.id, {
      kind: 'terminal',
      agentId: 'shell'
    })

    expect(companion?.groupId).toBe(group.id)
    expect(mgr.listGroups().length).toBe(before)
  })

  it('derives the companion cwd/environment from the source record, never the caller', () => {
    const source = mgr.create('/proj/bar', claudeSpec, 5)

    const companion = addCompanionPane(mgr, specFor, source.id, {
      kind: 'terminal',
      agentId: 'shell'
    })

    expect(companion?.cwd).toBe('/proj/bar')
    expect(companion?.environment).toBe(5)
  })

  it('falls back to homedir for a terminal companion of a browser source (empty cwd)', () => {
    const source = mgr.createBrowser('https://example.com', 1)
    expect(source.cwd).toBe('')

    const companion = addCompanionPane(mgr, specFor, source.id, {
      kind: 'terminal',
      agentId: 'shell'
    })

    expect(companion).not.toBeNull()
    expect(companion?.cwd).toBe(homedir())
  })

  it('creates a browser companion via manager.createBrowser, grouped with the source', () => {
    const source = mgr.create('/proj/baz', claudeSpec, 4)

    const companion = addCompanionPane(mgr, specFor, source.id, {
      kind: 'browser',
      url: 'https://example.com'
    })

    expect(companion).not.toBeNull()
    expect(companion?.kind).toBe('browser')
    expect(companion?.environment).toBe(4)
    const refreshedSource = mgr.get(source.id)
    expect(companion?.groupId).toBe(refreshedSource?.groupId)
  })

  it('returns null for an unknown source pane id', () => {
    const companion = addCompanionPane(mgr, specFor, 'no-such-pane', {
      kind: 'terminal',
      agentId: 'shell'
    })
    expect(companion).toBeNull()
  })
})
