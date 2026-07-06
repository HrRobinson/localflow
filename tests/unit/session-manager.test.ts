import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type PtyLike, type SpawnFn } from '../../src/main/session-manager'

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
      claudeBin: 'fake-claude',
      spawnFn
    })
  })

  it('create spawns claude with --settings in the cwd, idle status', () => {
    const info = mgr.create('/some/project')
    expect(info.status).toBe('idle')
    expect(spawnCalls[0].bin).toBe('fake-claude')
    expect(spawnCalls[0].cwd).toBe('/some/project')
    expect(spawnCalls[0].args[0]).toBe('--settings')
    expect(spawnCalls[0].args[1]).toContain(`localflow-hooks-${info.id}.json`)
  })

  it('hook events drive status and notify listeners', () => {
    const info = mgr.create('/p')
    const statuses: string[] = []
    mgr.onStatus((id, s) => id === info.id && statuses.push(s))
    mgr.applyHookEvent({ paneId: info.id, event: 'UserPromptSubmit' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Stop' })
    expect(statuses).toEqual(['working', 'needs-you', 'idle'])
    expect(mgr.list()[0].status).toBe('idle')
  })

  it('pty exit marks session exited; restart respawns with --continue', () => {
    const info = mgr.create('/p')
    ptys[0].exitCb?.()
    expect(mgr.list()[0].status).toBe('exited')
    const restarted = mgr.restart(info.id)
    expect(restarted.id).toBe(info.id)
    expect(restarted.status).toBe('idle')
    expect(spawnCalls[1].args).toContain('--continue')
  })

  it('restore registers an exited placeholder without spawning', () => {
    const info = mgr.restore('saved-id', '/old/project')
    expect(info).toEqual({ id: 'saved-id', cwd: '/old/project', status: 'exited' })
    expect(spawnCalls).toHaveLength(0)
  })

  it('spawn failure yields an exited session with an error message', () => {
    const failing = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
      port: 9999,
      token: 'tok',
      claudeBin: 'missing',
      spawnFn: () => {
        throw new Error('ENOENT')
      }
    })
    const messages: string[] = []
    failing.onData((_id, d) => messages.push(d))
    const info = failing.create('/p')
    expect(info.status).toBe('exited')
    expect(messages.join('')).toContain('Could not start')
  })

  it('kill removes the session and kills the pty', () => {
    const info = mgr.create('/p')
    mgr.kill(info.id)
    expect(ptys[0].killed).toBe(true)
    expect(mgr.list()).toHaveLength(0)
  })

  it('does not forward late data from a killed session', () => {
    const info = mgr.create('/p')
    const messages: string[] = []
    mgr.onData((_id, d) => messages.push(d))
    mgr.kill(info.id)
    ptys[0].dataCb?.('late buffered output')
    expect(messages).toEqual([])
  })

  it('restart of a restored session with an invalid id does not throw and reports failure', () => {
    mgr.restore('bad/id', '/p')
    const messages: string[] = []
    mgr.onData((_id, d) => messages.push(d))
    let restarted: ReturnType<typeof mgr.restart> | undefined
    expect(() => {
      restarted = mgr.restart('bad/id')
    }).not.toThrow()
    expect(restarted?.status).toBe('exited')
    expect(messages.join('')).toContain('Could not start')
  })
})
