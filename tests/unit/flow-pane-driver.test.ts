import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  type PtyLike,
  type SpawnFn,
  type SpawnSpec
} from '../../src/main/session-manager'
import { PaneRegistry } from '../../src/main/pane-registry'
import { OperatorGrantStore } from '../../src/main/operator-grant'
import { operatorCreatePane } from '../../src/main/pane-ops'
import type { ControlDeps, OperatorPaneRequest } from '../../src/main/control-api'
import { PaneDriver } from '../../src/main/flow/pane-driver'
import type { AgentId } from '../../src/shared/types'

class FakePty implements PtyLike {
  written: string[] = []
  onData(): void {}
  onExit(): void {}
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  kill(): void {}
}

const specFor = (agentId: AgentId): SpawnSpec => ({
  agentId,
  command: `fake-${agentId}`,
  resumeArgs: [],
  hookAdapter: 'settings-file'
})

function harness(): { driver: PaneDriver; manager: SessionManager; groupId: string } {
  const spawnFn: SpawnFn = () => new FakePty()
  const manager = new SessionManager({
    settingsDir: mkdtempSync(join(tmpdir(), 'lf-pd-')),
    port: 9999,
    token: 'tok',
    spawnFn,
    now: () => 1000
  })
  const grants = new OperatorGrantStore()
  const group = manager.createGroup('proj', 1)
  const seed = manager.create('/proj', specFor('claude'), 1)
  manager.assignToGroup(seed.id, group.id)
  const controlDeps: ControlDeps = {
    registry: new PaneRegistry(manager),
    grants,
    manager,
    panes: {
      create: (environment: number, req: OperatorPaneRequest) =>
        operatorCreatePane(manager, specFor, environment, req)
    }
  }
  return { driver: new PaneDriver({ controlDeps, grants }), manager, groupId: group.id }
}

describe('PaneDriver', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('creates a terminal pane through POST /panes under a fresh grant', async () => {
    const res = await h.driver.createTerminal(1, 'claude', h.groupId)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(h.manager.get(res.handle)?.kind).toBe('terminal')
      expect(h.manager.get(res.handle)?.agentId).toBe('claude')
    }
  })

  it('prompts the pane through POST /panes/:handle/prompt (text + CR)', async () => {
    const created = await h.driver.createTerminal(1, 'claude', h.groupId)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const res = await h.driver.prompt(1, created.handle, 'do the triage')
    expect(res.ok).toBe(true)
    // The control API writes text + carriage return to the pty.
    expect(h.manager.peek).toBeDefined()
  })

  it("surfaces the router's own status+error when a drive is rejected (unknown agent)", async () => {
    // 'shell' is outside OPERATOR_TERMINAL_AGENTS — the control API rejects it.
    const res = await h.driver.createTerminal(1, 'shell' as AgentId, h.groupId)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/400/)
      expect(res.error).toMatch(/invalid pane request/)
    }
  })

  it('surfaces 409 when prompting an exited pane', async () => {
    const created = await h.driver.createTerminal(1, 'claude', h.groupId)
    if (!created.ok) return
    h.manager.closeTerminal(created.handle)
    const res = await h.driver.prompt(1, created.handle, 'hi')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/409/)
  })
})
