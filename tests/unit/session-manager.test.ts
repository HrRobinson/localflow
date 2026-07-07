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

class FakePty implements PtyLike {
  dataCb: ((d: string) => void) | null = null
  exitCb: (() => void) | null = null
  written: string[] = []
  killed = false
  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: () => void): void {
    this.exitCb = cb
  }
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  kill(): void {
    this.killed = true
  }
}

const claudeSpec: SpawnSpec = {
  agentId: 'claude',
  command: 'fake-claude',
  resumeArgs: ['--continue'],
  useHooks: true
}

const codexSpec: SpawnSpec = {
  agentId: 'codex',
  command: 'fake-codex',
  resumeArgs: ['resume', '--last'],
  useHooks: false
}

describe('SessionManager', () => {
  let spawnCalls: { bin: string; args: string[]; cwd: string }[]
  let ptys: FakePty[]
  let mgr: SessionManager

  beforeEach(() => {
    spawnCalls = []
    ptys = []
    const spawnFn: SpawnFn = (bin, args, opts) => {
      spawnCalls.push({ bin, args, cwd: opts.cwd })
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    }
    mgr = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
      port: 9999,
      token: 'tok',
      spawnFn
    })
  })

  it('instant exit surfaces the last output in message (ANSI stripped)', () => {
    const info = mgr.create('/p', claudeSpec)
    ptys[0].dataCb?.('\u001b[31mNo conversation found in this directory\u001b[0m\r\n')
    ptys[0].exitCb?.()
    const msg = mgr.list().find((s) => s.id === info.id)?.message
    expect(msg).toContain('No conversation found')
    expect(msg).not.toContain('\u001b')
  })

  it('instant exit with no output still gets an explanatory message', () => {
    const info = mgr.create('/p', claudeSpec)
    ptys[0].exitCb?.()
    expect(mgr.list().find((s) => s.id === info.id)?.message).toContain('Exited right away')
  })

  it('long-lived session exit sets no message', () => {
    let t = 0
    const ptysT: FakePty[] = []
    const mgrT = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
      port: 9999,
      token: 'tok',
      now: () => t,
      spawnFn: () => {
        const pty = new FakePty()
        ptysT.push(pty)
        return pty
      }
    })
    const info = mgrT.create('/p', claudeSpec)
    t = 60_000
    ptysT[0].exitCb?.()
    expect(mgrT.list().find((s) => s.id === info.id)?.message).toBeUndefined()
  })

  it('create spawns a hook agent with --settings in the cwd, idle status', () => {
    const info = mgr.create('/some/project', claudeSpec)
    expect(info.status).toBe('idle')
    expect(info.agentId).toBe('claude')
    expect(spawnCalls[0].bin).toBe('fake-claude')
    expect(spawnCalls[0].cwd).toBe('/some/project')
    expect(spawnCalls[0].args[0]).toBe('--settings')
    expect(spawnCalls[0].args[1]).toContain(`localflow-hooks-${info.id}.json`)
  })

  it('create spawns a non-hook agent without settings, running status', () => {
    const info = mgr.create('/p', codexSpec)
    expect(info.status).toBe('running')
    expect(info.agentId).toBe('codex')
    expect(spawnCalls[0].bin).toBe('fake-codex')
    expect(spawnCalls[0].args).toEqual([])
  })

  it('hook events drive status and notify listeners', () => {
    const info = mgr.create('/p', claudeSpec)
    const statuses: string[] = []
    mgr.onStatus((id, s) => id === info.id && statuses.push(s))
    mgr.applyHookEvent({ paneId: info.id, event: 'UserPromptSubmit' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Stop' })
    expect(statuses).toEqual(['working', 'needs-you', 'idle'])
    expect(mgr.list()[0].status).toBe('idle')
  })

  it('pty exit marks session exited; restart respawns with agent resume args', () => {
    const info = mgr.create('/p', claudeSpec)
    ptys[0].exitCb?.()
    expect(mgr.list()[0].status).toBe('exited')
    const restarted = mgr.restart(info.id)
    expect(restarted.id).toBe(info.id)
    expect(restarted.status).toBe('idle')
    expect(spawnCalls[1].args).toContain('--continue')
  })

  it('fresh restart skips resume args (new conversation)', () => {
    const info = mgr.create('/p', claudeSpec)
    ptys[0].exitCb?.()
    mgr.restart(info.id, true)
    expect(spawnCalls[1].args).not.toContain('--continue')
    expect(spawnCalls[1].args[0]).toBe('--settings')
  })

  it('restart of a non-hook agent uses its own resume args and no settings', () => {
    const info = mgr.create('/p', codexSpec)
    ptys[0].exitCb?.()
    const restarted = mgr.restart(info.id)
    expect(restarted.status).toBe('running')
    expect(spawnCalls[1].args).toEqual(['resume', '--last'])
  })

  it('restore registers an exited placeholder without spawning', () => {
    const info = mgr.restore('saved-id', '/old/project', claudeSpec)
    expect(info).toEqual({
      id: 'saved-id',
      cwd: '/old/project',
      status: 'exited',
      agentId: 'claude',
      command: 'fake-claude'
    })
    expect(spawnCalls).toHaveLength(0)
  })

  it('spawn failure yields an exited session with an error message', () => {
    const failing = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
      port: 9999,
      token: 'tok',
      spawnFn: () => {
        throw new Error('ENOENT')
      }
    })
    const messages: string[] = []
    failing.onData((_id, d) => messages.push(d))
    const info = failing.create('/p', { ...claudeSpec, command: 'missing' })
    expect(info.status).toBe('exited')
    expect(messages.join('')).toContain('Could not start')
    expect(info.message).toContain('Could not start')
  })

  it('kill removes the session and kills the pty', () => {
    const info = mgr.create('/p', claudeSpec)
    mgr.kill(info.id)
    expect(ptys[0].killed).toBe(true)
    expect(mgr.list()).toHaveLength(0)
  })

  it('does not forward late data from a killed session', () => {
    const info = mgr.create('/p', claudeSpec)
    const messages: string[] = []
    mgr.onData((_id, d) => messages.push(d))
    mgr.kill(info.id)
    ptys[0].dataCb?.('late buffered output')
    expect(messages).toEqual([])
  })

  it('resize and write after pty exit never reach the dead pty', () => {
    const info = mgr.create('/p', claudeSpec)
    ptys[0].exitCb?.()
    expect(() => {
      mgr.resize(info.id, 120, 40)
      mgr.write(info.id, 'ls\n')
    }).not.toThrow()
    expect(ptys[0].written).toEqual([])
  })

  it('resize survives a pty whose fd died mid-call', () => {
    const info = mgr.create('/p', claudeSpec)
    ptys[0].resize = () => {
      throw new Error('ioctl(2) failed, EBADF')
    }
    expect(() => mgr.resize(info.id, 120, 40)).not.toThrow()
  })

  it('restart of a restored session with an invalid id does not throw and reports failure', () => {
    mgr.restore('bad/id', '/p', claudeSpec)
    const messages: string[] = []
    mgr.onData((_id, d) => messages.push(d))
    let restarted: ReturnType<typeof mgr.restart> | undefined
    expect(() => {
      restarted = mgr.restart('bad/id')
    }).not.toThrow()
    expect(restarted?.status).toBe('exited')
    expect(messages.join('')).toContain('Could not start')
    expect(restarted?.message).toContain('Could not start')
  })
})
