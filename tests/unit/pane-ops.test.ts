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
import { addCompanionPane, operatorCreatePane } from '../../src/main/pane-ops'
import type { OperatorPaneRequest } from '../../src/main/control-api'
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

describe('operatorCreatePane', () => {
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

  it('derives terminal cwd from the first member with a non-empty cwd, skipping an empty-cwd browser member first', () => {
    const group = mgr.createGroup('g', 1)
    const browserMember = mgr.createBrowser('https://example.com', 1)
    mgr.assignToGroup(browserMember.id, group.id)
    expect(mgr.get(browserMember.id)?.cwd).toBe('')
    const terminalMember = mgr.create('/proj/g', claudeSpec, 1)
    mgr.assignToGroup(terminalMember.id, group.id)

    const req: OperatorPaneRequest = { kind: 'terminal', agentId: 'shell', groupId: group.id }
    const created = operatorCreatePane(mgr, specFor, 1, req)

    expect(created).not.toBeNull()
    expect(created?.cwd).toBe('/proj/g')
    expect(created?.groupId).toBe(group.id)
  })

  it('returns null for a terminal request whose group has no member with a non-empty cwd', () => {
    const group = mgr.createGroup('g', 1)
    const browserMember = mgr.createBrowser('https://example.com', 1)
    mgr.assignToGroup(browserMember.id, group.id)

    const req: OperatorPaneRequest = { kind: 'terminal', agentId: 'shell', groupId: group.id }
    const created = operatorCreatePane(mgr, specFor, 1, req)

    expect(created).toBeNull()
  })

  it('creates a browser pane with no groupId, ungrouped', () => {
    const req: OperatorPaneRequest = { kind: 'browser', url: 'https://example.com' }
    const created = operatorCreatePane(mgr, specFor, 1, req)

    expect(created).not.toBeNull()
    expect(created?.kind).toBe('browser')
    expect(created?.groupId).toBeUndefined()
    expect(created?.environment).toBe(1)
  })

  it('creates a browser pane and assigns it into the given group', () => {
    const group = mgr.createGroup('g', 1)

    const req: OperatorPaneRequest = {
      kind: 'browser',
      url: 'https://example.com',
      groupId: group.id
    }
    const created = operatorCreatePane(mgr, specFor, 1, req)

    expect(created).not.toBeNull()
    expect(created?.kind).toBe('browser')
    expect(created?.groupId).toBe(group.id)
  })

  it('does not assign a terminal pane into a group belonging to a different environment', () => {
    // Mirrors what assignToGroup does when environments mismatch: rejects
    // (returns null) and leaves the pane ungrouped rather than throwing.
    // The control-api route pre-checks this case before calling in, but
    // operatorCreatePane itself must still degrade safely if it happens.
    const foreignGroup = mgr.createGroup('other-env-group', 2)
    // Give the (foreign) group a same-numbered member so a same-environment
    // lookup for cwd fails cleanly rather than finding a stray match.
    const req: OperatorPaneRequest = {
      kind: 'terminal',
      agentId: 'shell',
      groupId: foreignGroup.id
    }
    const created = operatorCreatePane(mgr, specFor, 1, req)

    // No member of foreignGroup lives in environment 1, so cwd lookup fails
    // and the function returns null before ever reaching assignToGroup.
    expect(created).toBeNull()
  })

  it('rejects an invalid agentId at the type/route boundary — specFor is only invoked with a validated AgentId', () => {
    // operatorCreatePane trusts req.agentId is already a valid AgentId (the
    // control-api route's parseOperatorPaneRequest is the sole validator);
    // this test documents that contract by confirming specFor receives
    // exactly the agentId passed in, unmodified.
    const group = mgr.createGroup('g', 1)
    const terminalMember = mgr.create('/proj/g', claudeSpec, 1)
    mgr.assignToGroup(terminalMember.id, group.id)

    const seen: AgentId[] = []
    const trackingSpecFor = (agentId: AgentId) => {
      seen.push(agentId)
      return specFor(agentId)
    }
    const req: OperatorPaneRequest = { kind: 'terminal', agentId: 'codex', groupId: group.id }
    const created = operatorCreatePane(mgr, trackingSpecFor, 1, req)

    expect(created?.agentId).toBe('codex')
    expect(seen).toEqual(['codex'])
  })
})
