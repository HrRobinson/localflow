import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  type PtyLike,
  type SpawnFn,
  type SpawnSpec
} from '../../src/main/session-manager'
import type { ResolvedGuard } from '../../src/main/guard-hook'

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
  hookAdapter: 'settings-file'
}

const codexSpec: SpawnSpec = {
  agentId: 'codex',
  command: 'fake-codex',
  resumeArgs: ['resume', '--last'],
  hookAdapter: 'cli-args-notify'
}

const noAdapterSpec: SpawnSpec = {
  agentId: 'custom',
  command: 'fake-custom',
  resumeArgs: [],
  hookAdapter: 'none'
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
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].dataCb?.(
      '\u001b[>0q\u001b]0;claude\u0007\u001b[4m\u001b[31mNo conversation found in this directory\u001b[0m\r\n'
    )
    ptys[0].exitCb?.()
    const msg = mgr.list().find((s) => s.id === info.id)?.message
    expect(msg).toContain('No conversation found')
    expect(msg).not.toContain('\u001b')
    expect(msg).not.toContain('0q')
    expect(msg).not.toContain('4m')
  })

  it('instant exit strips 8-bit C1 CSI sequences too', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].dataCb?.('31mRed0m')
    ptys[0].exitCb?.()
    const msg = mgr.list().find((s) => s.id === info.id)?.message
    expect(msg).toContain('Red')
    expect(msg).not.toContain('')
    expect(msg).not.toContain('31m')
  })

  it('strips charset designations and survives mid-sequence truncation', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    // ESC(B charset designation (leaked as "(B" before) plus a long padding
    // that pushes an escape sequence across the tail-truncation boundary —
    // stripping must happen before truncation so no orphan fragments remain.
    const padding = '\u001b[38;5;178m.\u001b[0m'.repeat(60)
    ptys[0].dataCb?.(
      padding + '\u001b(B\u001b[78;1H No conversation found to continue \u001b(B\u001b[7m'
    )
    ptys[0].exitCb?.()
    const msg = mgr.list().find((s) => s.id === info.id)?.message ?? ''
    expect(msg).toContain('No conversation found')
    expect(msg).not.toContain('(B')
    expect(msg).not.toContain('78')
    expect(msg).not.toContain('\u001b')
  })

  it('instant exit with no output still gets an explanatory message', () => {
    const info = mgr.create('/p', claudeSpec, 1)
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
    const info = mgrT.create('/p', claudeSpec, 1)
    t = 60_000
    ptysT[0].exitCb?.()
    expect(mgrT.list().find((s) => s.id === info.id)?.message).toBeUndefined()
  })

  it('create spawns a hook agent with --settings in the cwd, idle status', () => {
    const info = mgr.create('/some/project', claudeSpec, 1)
    expect(info.status).toBe('idle')
    expect(info.agentId).toBe('claude')
    expect(spawnCalls[0].bin).toBe('fake-claude')
    expect(spawnCalls[0].cwd).toBe('/some/project')
    expect(spawnCalls[0].args[0]).toBe('--settings')
    expect(spawnCalls[0].args[1]).toContain(`localflow-hooks-${info.id}.json`)
  })

  it('deleteSession removes the per-session hook-settings file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-sm-'))
    const mgrD = new SessionManager({
      settingsDir: dir,
      port: 9999,
      token: 'tok',
      spawnFn: () => new FakePty()
    })
    const info = mgrD.create('/p', claudeSpec, 1)
    const file = join(dir, `localflow-hooks-${info.id}.json`)
    expect(existsSync(file)).toBe(true)
    mgrD.deleteSession(info.id)
    expect(existsSync(file)).toBe(false)
    expect(mgrD.list()).toEqual([])
  })

  it('create defaults name to the cwd basename', () => {
    const info = mgr.create('/some/project', claudeSpec, 1)
    expect(info.name).toBe('project')
  })

  it('create spawns a non-adapter agent without settings, running status', () => {
    const info = mgr.create('/p', noAdapterSpec, 1)
    expect(info.status).toBe('running')
    expect(info.agentId).toBe('custom')
    expect(spawnCalls[0].bin).toBe('fake-custom')
    expect(spawnCalls[0].args).toEqual([])
  })

  it('create spawns a codex (degraded-adapter) agent as idle', () => {
    const info = mgr.create('/p', codexSpec, 1)
    expect(info.status).toBe('idle')
  })

  it('hook events drive status and notify listeners', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    const statuses: string[] = []
    mgr.onStatus((id, s) => id === info.id && statuses.push(s))
    mgr.applyHookEvent({ paneId: info.id, event: 'UserPromptSubmit' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Stop' })
    expect(statuses).toEqual(['working', 'needs-you', 'idle'])
    expect(mgr.list()[0].status).toBe('idle')
  })

  it('pty exit marks session exited; restart respawns with agent resume args', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].exitCb?.()
    expect(mgr.list()[0].status).toBe('exited')
    const restarted = mgr.restart(info.id)
    expect(restarted.id).toBe(info.id)
    expect(restarted.status).toBe('idle')
    expect(spawnCalls[1].args).toContain('--continue')
  })

  it('fresh restart skips resume args (new conversation)', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].exitCb?.()
    mgr.restart(info.id, true)
    expect(spawnCalls[1].args).not.toContain('--continue')
    expect(spawnCalls[1].args[0]).toBe('--settings')
  })

  it('restart of a no-adapter agent uses its own resume args and no settings', () => {
    const info = mgr.create('/p', noAdapterSpec, 1)
    ptys[0].exitCb?.()
    const restarted = mgr.restart(info.id)
    expect(restarted.status).toBe('running')
    expect(spawnCalls[1].args).toEqual([])
  })

  it('instant exit after a resume restart sets resumeFailed', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].exitCb?.()
    mgr.restart(info.id)
    ptys[1].exitCb?.()
    expect(mgr.list().find((s) => s.id === info.id)?.resumeFailed).toBe(true)
  })

  it('instant exit of a fresh (first) launch does not set resumeFailed', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].exitCb?.()
    expect(mgr.list().find((s) => s.id === info.id)?.resumeFailed).toBeUndefined()
  })

  it('instant exit after a fresh restart does not set resumeFailed', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].exitCb?.()
    mgr.restart(info.id, true)
    ptys[1].exitCb?.()
    expect(mgr.list().find((s) => s.id === info.id)?.resumeFailed).toBeUndefined()
  })

  it('a later restart clears resumeFailed at spawn time', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].exitCb?.()
    mgr.restart(info.id)
    ptys[1].exitCb?.()
    expect(mgr.list().find((s) => s.id === info.id)?.resumeFailed).toBe(true)
    const restarted = mgr.restart(info.id, true)
    expect(restarted.resumeFailed).toBeUndefined()
    expect(mgr.list().find((s) => s.id === info.id)?.resumeFailed).toBeUndefined()
  })

  it('restore registers an exited placeholder without spawning', () => {
    const info = mgr.restore('saved-id', '/old/project', claudeSpec)
    expect(info).toEqual({
      id: 'saved-id',
      cwd: '/old/project',
      name: 'project',
      status: 'exited',
      agentId: 'claude',
      command: 'fake-claude',
      environment: 1,
      kind: 'terminal'
    })
    expect(spawnCalls).toHaveLength(0)
  })

  it('restore uses a saved name verbatim when present', () => {
    const info = mgr.restore('saved-id', '/old/project', claudeSpec, 'kept name')
    expect(info.name).toBe('kept name')
  })

  it('restore falls back to basename(cwd) with no name arg', () => {
    const info = mgr.restore('saved-id', '/old/project', claudeSpec)
    expect(info.name).toBe('project')
  })

  it('restore falls back to basename(cwd) with an empty-string name', () => {
    const info = mgr.restore('saved-id', '/old/project', claudeSpec, '')
    expect(info.name).toBe('project')
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
    const info = failing.create('/p', { ...claudeSpec, command: 'missing' }, 1)
    expect(info.status).toBe('exited')
    expect(messages.join('')).toContain('Could not start')
    expect(info.message).toContain('Could not start')
  })

  it('disposeAll kills every pty, keeps sessions, silences late data', () => {
    const a = mgr.create('/p1', claudeSpec, 1)
    mgr.create('/p2', codexSpec, 1)
    const messages: string[] = []
    mgr.onData((_id, d) => messages.push(d))
    mgr.disposeAll()
    expect(ptys[0].killed).toBe(true)
    expect(ptys[1].killed).toBe(true)
    expect(mgr.list()).toHaveLength(2)
    // Late flushed output after dispose must be swallowed, not forwarded.
    ptys[0].dataCb?.('late output after quit')
    ptys[1].exitCb?.()
    expect(messages).toEqual([])
    expect(() => mgr.write(a.id, 'x')).not.toThrow()
    expect(ptys[0].written).toEqual([])
  })

  it('deleteSession removes the session and kills the pty', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    mgr.deleteSession(info.id)
    expect(ptys[0].killed).toBe(true)
    expect(mgr.list()).toHaveLength(0)
  })

  it('does not forward late data from a deleted session', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    const messages: string[] = []
    mgr.onData((_id, d) => messages.push(d))
    mgr.deleteSession(info.id)
    ptys[0].dataCb?.('late buffered output')
    expect(messages).toEqual([])
  })

  it('closeTerminal kills the pty and keeps the session as exited, no message', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    mgr.closeTerminal(info.id)
    expect(ptys[0].killed).toBe(true)
    const list = mgr.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(info.id)
    expect(list[0].status).toBe('exited')
    expect(list[0].message).toBeUndefined()
  })

  it('closeTerminal then a late real onExit does not re-run the instant-exit message', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    mgr.closeTerminal(info.id)
    ptys[0].exitCb?.()
    const list = mgr.list()
    expect(list[0].status).toBe('exited')
    expect(list[0].message).toBeUndefined()
  })

  it('closeTerminal on a session with no live pty is a no-op', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    mgr.closeTerminal(info.id)
    const before = mgr.list()
    expect(() => mgr.closeTerminal(info.id)).not.toThrow()
    expect(mgr.list()).toEqual(before)
  })

  it('closeTerminal on a restored placeholder (no live pty) is a no-op', () => {
    mgr.restore('saved-id', '/old/project', claudeSpec)
    const before = mgr.list()
    expect(() => mgr.closeTerminal('saved-id')).not.toThrow()
    expect(mgr.list()).toEqual(before)
  })

  it('closeTerminal on an unknown id does not throw', () => {
    expect(() => mgr.closeTerminal('no-such-id')).not.toThrow()
  })

  it('rename trims and updates the name', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    const renamed = mgr.rename(info.id, '  New Name  ')
    expect(renamed).toEqual({ ...info, name: 'New Name' })
    expect(mgr.list()[0].name).toBe('New Name')
  })

  it('rename no-ops on empty/whitespace-only names', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    const renamedEmpty = mgr.rename(info.id, '')
    expect(renamedEmpty?.name).toBe(info.name)
    const renamedBlank = mgr.rename(info.id, '   ')
    expect(renamedBlank?.name).toBe(info.name)
    expect(mgr.list()[0].name).toBe(info.name)
  })

  it('rename on an unknown id returns null', () => {
    expect(mgr.rename('missing-id', 'x')).toBeNull()
  })

  it('rename fires onSessionsChanged (persisted immediately)', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    let fired = false
    mgr.onSessionsChanged(() => {
      fired = true
    })
    mgr.rename(info.id, 'New Name')
    expect(fired).toBe(true)
  })

  it('restart preserves a renamed session name, not recomputed from cwd', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    mgr.rename(info.id, 'Renamed')
    ptys[0].exitCb?.()
    const restarted = mgr.restart(info.id)
    expect(restarted.name).toBe('Renamed')
  })

  it('resize and write after pty exit never reach the dead pty', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].exitCb?.()
    expect(() => {
      mgr.resize(info.id, 120, 40)
      mgr.write(info.id, 'ls\n')
    }).not.toThrow()
    expect(ptys[0].written).toEqual([])
  })

  it('resize survives a pty whose fd died mid-call', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].resize = () => {
      throw new Error('ioctl(2) failed, EBADF')
    }
    expect(() => mgr.resize(info.id, 120, 40)).not.toThrow()
  })

  it('stale exit from a pty killed by closeTerminal+restart does not clobber the new record', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    const oldPty = ptys[0]
    mgr.closeTerminal(info.id)
    mgr.restart(info.id)
    const newPty = ptys[1]
    expect(newPty).not.toBe(oldPty)
    // The old pty's real onExit arrives late (SIGHUP is not synchronous) —
    // it must be a no-op against the already-replaced record.
    oldPty.exitCb?.()
    const after = mgr.list().find((s) => s.id === info.id)
    expect(after?.status).not.toBe('exited')
    expect(after?.message).toBeUndefined()
    // The new pty must still be reachable through the manager.
    mgr.write(info.id, 'hello\n')
    expect(newPty.written).toContain('hello\n')
  })

  it('stale data from a pty killed by closeTerminal+restart is not forwarded or tailed', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    const oldPty = ptys[0]
    mgr.closeTerminal(info.id)
    mgr.restart(info.id)
    const newPty = ptys[1]
    const messages: string[] = []
    mgr.onData((_id, d) => messages.push(d))
    oldPty.dataCb?.('OLD STALE DATA')
    expect(messages).toEqual([])
    newPty.dataCb?.('new data')
    newPty.exitCb?.()
    const msg = mgr.list().find((s) => s.id === info.id)?.message
    expect(msg).toContain('new data')
    expect(msg).not.toContain('OLD STALE DATA')
  })

  it('restore stores a trimmed name, not the raw padded value', () => {
    const info = mgr.restore('saved-id', '/old/project', claudeSpec, '  padded name  ')
    expect(info.name).toBe('padded name')
  })

  it('restore treats a non-string name as absent (malformed sessions.json)', () => {
    const info = mgr.restore('saved-id', '/old/project', claudeSpec, 123 as unknown as string)
    expect(info.name).toBe('project')
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

  describe('get', () => {
    it('returns a copy of a session by id, null for unknown', () => {
      const info = mgr.create('/tmp/repo', claudeSpec, 1)
      const got = mgr.get(info.id)
      expect(got?.id).toBe(info.id)
      expect(got?.cwd).toBe('/tmp/repo')
      // A copy, not the live record.
      expect(got).not.toBe(mgr.get(info.id))
      expect(mgr.get('nope')).toBeNull()
    })
  })

  describe('peek', () => {
    it('returns the last cleaned lines of a live session output', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      ptys[0].dataCb?.('[1mDo you want to run npm test?[0m\n(y/n)\n')
      expect(mgr.peek(info.id)).toEqual(['Do you want to run npm test?', '(y/n)'])
    })

    it('respects maxLines', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      ptys[0].dataCb?.('a\nb\nc\n')
      expect(mgr.peek(info.id, 2)).toEqual(['b', 'c'])
    })

    it('returns [] for an unknown session id', () => {
      expect(mgr.peek('nope')).toEqual([])
    })
  })

  describe('environments', () => {
    it('create assigns the given environment', () => {
      const info = mgr.create('/tmp', claudeSpec, 3)
      expect(info.environment).toBe(3)
    })

    it('restore clamps a bad saved environment to 1', () => {
      const info = mgr.restore('id-1', '/tmp', claudeSpec, undefined, 42 as number)
      expect(info.environment).toBe(1)
    })

    it('setEnvironment moves a session and returns updated info', () => {
      const info = mgr.create('/tmp', claudeSpec, 1)
      const updated = mgr.setEnvironment(info.id, 7)
      expect(updated?.environment).toBe(7)
      expect(mgr.list().find((s) => s.id === info.id)?.environment).toBe(7)
    })

    it('setEnvironment returns null for an unknown id and clamps range', () => {
      expect(mgr.setEnvironment('nope', 3)).toBeNull()
      const info = mgr.create('/tmp', claudeSpec, 2)
      expect(mgr.setEnvironment(info.id, 99)?.environment).toBe(1)
    })

    it('restart keeps the environment', () => {
      const info = mgr.create('/tmp', claudeSpec, 4)
      mgr.closeTerminal(info.id)
      const restarted = mgr.restart(info.id)
      expect(restarted.environment).toBe(4)
    })
  })

  describe('browser sessions', () => {
    it('createBrowser makes a running, pty-less record named after the host', () => {
      const info = mgr.createBrowser('https://docs.example.com/guide', 3)
      expect(info.kind).toBe('browser')
      expect(info.status).toBe('running')
      expect(info.url).toBe('https://docs.example.com/guide')
      expect(info.name).toBe('docs.example.com')
      expect(info.environment).toBe(3)
      expect(info.cwd).toBe('')
    })

    it('closeTerminal exits a browser pane; restart reopens it', () => {
      const info = mgr.createBrowser('https://example.com/', 1)
      mgr.closeTerminal(info.id)
      expect(mgr.list().find((s) => s.id === info.id)?.status).toBe('exited')
      const reopened = mgr.restart(info.id)
      expect(reopened.status).toBe('running')
      expect(reopened.url).toBe('https://example.com/')
    })

    it('write/resize/peek are safe no-ops on browser panes', () => {
      const info = mgr.createBrowser('https://example.com/', 1)
      expect(() => mgr.write(info.id, 'x')).not.toThrow()
      expect(() => mgr.resize(info.id, 80, 24)).not.toThrow()
      expect(mgr.peek(info.id)).toEqual([])
    })

    it('setUrl updates and persists-notifies; rejects unknown ids', () => {
      const info = mgr.createBrowser('https://example.com/', 1)
      const updated = mgr.setUrl(info.id, 'https://example.com/deep/page')
      expect(updated?.url).toBe('https://example.com/deep/page')
      expect(mgr.setUrl('nope', 'https://x.y/')).toBeNull()
    })

    it('restoreBrowser recreates an exited pane; invalid url yields null', () => {
      const info = mgr.restoreBrowser('rb-1', 'https://example.com/', 'My docs', 2)
      expect(info?.status).toBe('exited')
      expect(info?.kind).toBe('browser')
      expect(info?.environment).toBe(2)
      expect(info?.name).toBe('My docs')
      expect(mgr.restoreBrowser('rb-2', 'file:///etc/passwd')).toBeNull()
    })

    it('hook events never touch browser panes', () => {
      const info = mgr.createBrowser('https://example.com/', 1)
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      expect(mgr.list().find((s) => s.id === info.id)?.status).toBe('running')
    })
  })

  describe('per-agent spawn overrides', () => {
    it('a fresh (create) openclaw session launches with `chat`, extraArgs after', () => {
      const calls: { args: string[] }[] = []
      const spawnFn: SpawnFn = (_bin, args) => {
        calls.push({ args })
        return new FakePty()
      }
      const m = new SessionManager({
        settingsDir: mkdtempSync(join(tmpdir(), 'localflow-oc-fresh-')),
        port: 1,
        token: 't',
        spawnFn
      })
      const spec: SpawnSpec = {
        agentId: 'openclaw',
        command: 'fake-openclaw',
        resumeArgs: [],
        startArgs: ['chat'],
        hookAdapter: 'none',
        extraArgs: ['--verbose']
      }
      m.create('/tmp', spec, 1)
      expect(calls[0].args).toEqual(['chat', '--verbose'])
    })

    it('a fresh session with no startArgs launches with no preset args', () => {
      const calls: { args: string[] }[] = []
      const spawnFn: SpawnFn = (_bin, args) => {
        calls.push({ args })
        return new FakePty()
      }
      const m = new SessionManager({
        settingsDir: mkdtempSync(join(tmpdir(), 'localflow-custom-fresh-')),
        port: 1,
        token: 't',
        spawnFn
      })
      // noAdapterSpec has no hook adapter (no injected args) and no
      // startArgs, so a fresh launch should carry no args at all.
      m.create('/tmp', noAdapterSpec, 1)
      expect(calls[0].args).toEqual([])
    })

    it('appends extraArgs after resume args and merges env last', () => {
      const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
      const spawnFn: SpawnFn = (_bin, args, opts) => {
        calls.push({ args, env: opts.env })
        return new FakePty()
      }
      const m = new SessionManager({
        settingsDir: mkdtempSync(join(tmpdir(), 'localflow-ov-')),
        port: 1,
        token: 't',
        spawnFn
      })
      const spec: SpawnSpec = {
        agentId: 'gemini',
        command: 'fake-gemini',
        resumeArgs: ['--resume', 'latest'],
        hookAdapter: 'none',
        extraArgs: ['--foo', 'a b'],
        env: { OLLAMA_HOST: 'http://127.0.0.1' }
      }
      m.restore('ov-1', '/tmp', spec, 'g', 1)
      m.restart('ov-1') // resume path: resumeArgs then extraArgs
      expect(calls[0].args.slice(-4)).toEqual(['--resume', 'latest', '--foo', 'a b'])
      expect(calls[0].env.OLLAMA_HOST).toBe('http://127.0.0.1')
    })

    it('updateSpecEnv refreshes the env the next restart spawns with', () => {
      const calls: { env: NodeJS.ProcessEnv }[] = []
      const spawnFn: SpawnFn = (_bin, _args, opts) => {
        calls.push({ env: opts.env })
        return new FakePty()
      }
      const m = new SessionManager({
        settingsDir: mkdtempSync(join(tmpdir(), 'localflow-se-')),
        port: 1,
        token: 't',
        spawnFn
      })
      const spec: SpawnSpec = {
        agentId: 'openclaw',
        command: 'fake-openclaw',
        resumeArgs: [],
        hookAdapter: 'none',
        env: { LOCALFLOW_ENDPOINT: 'http://127.0.0.1:1', LOCALFLOW_TOKEN: 'stale' }
      }
      m.restore('oc-1', '/tmp', spec, 'oc', 1)
      // A live pty keeps its env; the merge only shapes the NEXT spawn.
      m.updateSpecEnv('oc-1', { LOCALFLOW_TOKEN: 'fresh' })
      m.restart('oc-1')
      expect(calls[0].env.LOCALFLOW_TOKEN).toBe('fresh')
      expect(calls[0].env.LOCALFLOW_ENDPOINT).toBe('http://127.0.0.1:1')
    })

    it('updateSpecEnv ignores unknown ids and browser panes', () => {
      const m = new SessionManager({
        settingsDir: mkdtempSync(join(tmpdir(), 'localflow-se2-')),
        port: 1,
        token: 't',
        spawnFn: () => new FakePty()
      })
      m.updateSpecEnv('nope', { A: 'b' }) // must not throw
      const b = m.createBrowser('http://localhost:3000', 1)
      m.updateSpecEnv(b.id, { A: 'b' }) // must not throw either
    })
  })

  describe('activity ring + needsYouSince', () => {
    it('records a created entry with the resulting status', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const ring = mgr.getActivity(info.id)
      expect(ring).toHaveLength(1)
      expect(ring[0].kind).toBe('created')
      expect(ring[0].status).toBe('idle')
      expect(typeof ring[0].timestamp).toBe('number')
    })

    it('records applied hook events with their resulting status, in order', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      mgr.applyHookEvent({ paneId: info.id, event: 'UserPromptSubmit' })
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      mgr.applyHookEvent({ paneId: info.id, event: 'Stop' })
      expect(mgr.getActivity(info.id).map((e) => [e.kind, e.status])).toEqual([
        ['created', 'idle'],
        ['UserPromptSubmit', 'working'],
        ['Notification', 'needs-you'],
        ['Stop', 'idle']
      ])
    })

    it('records lifecycle moments: close, reopen, exit, move', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      mgr.closeTerminal(info.id)
      const reopened = mgr.restart(info.id)
      mgr.setEnvironment(reopened.id, 4)
      ptys[1].exitCb?.()
      expect(mgr.getActivity(info.id).map((e) => e.kind)).toEqual([
        'created',
        'closed',
        'reopened',
        'moved',
        'exited'
      ])
    })

    it('caps the ring at the last 200 entries', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      // Alternate kinds so every event appends a distinct entry (identical
      // consecutive hook events collapse instead of appending).
      for (let i = 0; i < 250; i++) {
        mgr.applyHookEvent({
          paneId: info.id,
          event: i % 2 === 0 ? 'UserPromptSubmit' : 'Notification'
        })
      }
      const ring = mgr.getActivity(info.id)
      expect(ring).toHaveLength(200)
      // Oldest kept is not 'created' anymore — it was shifted off the front.
      expect(ring[0].kind).toBe('UserPromptSubmit')
    })

    it('restart preserves the ring across the pty swap', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      mgr.closeTerminal(info.id)
      mgr.restart(info.id)
      // created + closed survive; reopened is appended.
      expect(mgr.getActivity(info.id).map((e) => e.kind)).toEqual(['created', 'closed', 'reopened'])
    })

    it('restore records nothing (loaded from disk, not created)', () => {
      const info = mgr.restore('saved-id', '/old/project', claudeSpec)
      expect(mgr.getActivity(info.id)).toEqual([])
    })

    it('onActivity notifies listeners with the new entry', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const seen: string[] = []
      mgr.onActivity((id, entry) => id === info.id && seen.push(entry.kind))
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      expect(seen).toEqual(['Notification'])
    })

    it('getActivity returns [] for an unknown id', () => {
      expect(mgr.getActivity('nope')).toEqual([])
    })

    it('stamps needsYouSince on entering needs-you and clears it on leaving', () => {
      let t = 1000
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
      const info = mgrT.create('/p', claudeSpec, 1)
      expect(mgrT.list()[0].needsYouSince).toBeUndefined()
      t = 5000
      mgrT.applyHookEvent({ paneId: info.id, event: 'Notification' })
      expect(mgrT.list()[0].needsYouSince).toBe(5000)
      // A repeated Notification (no-op transition) keeps the original stamp.
      t = 9000
      mgrT.applyHookEvent({ paneId: info.id, event: 'Notification' })
      expect(mgrT.list()[0].needsYouSince).toBe(5000)
      // Leaving needs-you clears it.
      mgrT.applyHookEvent({ paneId: info.id, event: 'Stop' })
      expect(mgrT.list()[0].needsYouSince).toBeUndefined()
    })

    it('clears needsYouSince when the process exits while waiting', () => {
      let t = 1000
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
      const info = mgrT.create('/p', claudeSpec, 1)
      t = 5000
      mgrT.applyHookEvent({ paneId: info.id, event: 'Notification' })
      expect(mgrT.list()[0].needsYouSince).toBe(5000)
      t = 6000
      ptysT[0].exitCb?.()
      expect(mgrT.list()[0].status).toBe('exited')
      expect(mgrT.list()[0].needsYouSince).toBeUndefined()
    })

    it('collapses consecutive identical hook events into one counted entry', () => {
      let t = 1000
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
      const info = mgrT.create('/p', claudeSpec, 1)
      t = 2000
      mgrT.applyHookEvent({ paneId: info.id, event: 'Notification' })
      t = 3000
      mgrT.applyHookEvent({ paneId: info.id, event: 'Notification' })
      t = 4000
      mgrT.applyHookEvent({ paneId: info.id, event: 'Notification' })
      const ring = mgrT.getActivity(info.id)
      expect(ring.map((e) => e.kind)).toEqual(['created', 'Notification'])
      expect(ring[1].count).toBe(3)
      expect(ring[1].status).toBe('needs-you')
      // The collapsed entry's timestamp tracks the latest occurrence.
      expect(ring[1].timestamp).toBe(4000)
    })

    it('does not collapse alternating hook event kinds', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      mgr.applyHookEvent({ paneId: info.id, event: 'UserPromptSubmit' })
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      const ring = mgr.getActivity(info.id)
      expect(ring.map((e) => e.kind)).toEqual([
        'created',
        'Notification',
        'UserPromptSubmit',
        'Notification'
      ])
      expect(ring.every((e) => e.count === undefined)).toBe(true)
    })

    it('a lifecycle event between duplicates breaks the collapse run', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      // 'moved' does not change the status (still needs-you), but it must
      // always append — and the next Notification lands after it, unmerged.
      mgr.setEnvironment(info.id, 4)
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      const ring = mgr.getActivity(info.id)
      expect(ring.map((e) => [e.kind, e.count])).toEqual([
        ['created', undefined],
        ['Notification', 2],
        ['moved', undefined],
        ['Notification', undefined]
      ])
    })

    it("getActivity's defensive copy includes count and does not share it", () => {
      const info = mgr.create('/p', claudeSpec, 1)
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
      const ring = mgr.getActivity(info.id)
      expect(ring[1].count).toBe(2)
      ring[1].count = 99
      expect(mgr.getActivity(info.id)[1].count).toBe(2)
    })
  })

  describe('groups', () => {
    it('createGroup + assignToGroup sets groupId; ungroup clears it', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const group = mgr.createGroup('g', 1)
      expect(group.name).toBe('g')
      expect(group.environment).toBe(1)
      const assigned = mgr.assignToGroup(info.id, group.id)
      expect(assigned?.groupId).toBe(group.id)
      expect(mgr.list()[0].groupId).toBe(group.id)
      const ungrouped = mgr.assignToGroup(info.id, null)
      expect(ungrouped?.groupId).toBeUndefined()
      expect(mgr.list()[0].groupId).toBeUndefined()
    })

    it('createGroup trims a padded name, like renameGroup', () => {
      const group = mgr.createGroup('  Padded Name  ', 1)
      expect(group.name).toBe('Padded Name')
    })

    it('assignToGroup rejects cross-environment assignment', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const group = mgr.createGroup('g', 2)
      const result = mgr.assignToGroup(info.id, group.id)
      expect(result).toBeNull()
      expect(mgr.list()[0].groupId).toBeUndefined()
    })

    it('assignToGroup rejects an unknown group id', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      expect(mgr.assignToGroup(info.id, 'no-such-group')).toBeNull()
    })

    it('assignToGroup returns null for an unknown pane id', () => {
      const group = mgr.createGroup('g', 1)
      expect(mgr.assignToGroup('no-such-pane', group.id)).toBeNull()
    })

    it('deleting the last member deletes the group', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const group = mgr.createGroup('g', 1)
      mgr.assignToGroup(info.id, group.id)
      mgr.deleteSession(info.id)
      expect(mgr.listGroups()).toEqual([])
    })

    it('deleting a non-last member keeps the group', () => {
      const a = mgr.create('/p1', claudeSpec, 1)
      const b = mgr.create('/p2', claudeSpec, 1)
      const group = mgr.createGroup('g', 1)
      mgr.assignToGroup(a.id, group.id)
      mgr.assignToGroup(b.id, group.id)
      mgr.deleteSession(a.id)
      expect(mgr.listGroups()).toEqual([group])
      expect(mgr.list().find((s) => s.id === b.id)?.groupId).toBe(group.id)
    })

    it('ungrouping the last member deletes the group', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const group = mgr.createGroup('g', 1)
      mgr.assignToGroup(info.id, group.id)
      mgr.assignToGroup(info.id, null)
      expect(mgr.listGroups()).toEqual([])
    })

    it('ungrouping one of two members keeps the group', () => {
      const a = mgr.create('/p1', claudeSpec, 1)
      const b = mgr.create('/p2', claudeSpec, 1)
      const group = mgr.createGroup('g', 1)
      mgr.assignToGroup(a.id, group.id)
      mgr.assignToGroup(b.id, group.id)
      mgr.assignToGroup(a.id, null)
      expect(mgr.listGroups()).toEqual([group])
      expect(mgr.list().find((s) => s.id === b.id)?.groupId).toBe(group.id)
    })

    it('reassigning the last member of a group to another group reaps the old one', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const groupA = mgr.createGroup('A', 1)
      const groupB = mgr.createGroup('B', 1)
      mgr.assignToGroup(info.id, groupA.id)
      mgr.assignToGroup(info.id, groupB.id)
      expect(mgr.listGroups()).toEqual([groupB])
      expect(mgr.list().find((s) => s.id === info.id)?.groupId).toBe(groupB.id)
    })

    it('reassigning one of two members to another group keeps both groups', () => {
      const a = mgr.create('/p1', claudeSpec, 1)
      const b = mgr.create('/p2', claudeSpec, 1)
      const groupA = mgr.createGroup('A', 1)
      const groupB = mgr.createGroup('B', 1)
      mgr.assignToGroup(a.id, groupA.id)
      mgr.assignToGroup(b.id, groupA.id)
      mgr.assignToGroup(a.id, groupB.id)
      expect(mgr.listGroups()).toHaveLength(2)
      expect(mgr.listGroups()).toEqual(expect.arrayContaining([groupA, groupB]))
      expect(mgr.list().find((s) => s.id === a.id)?.groupId).toBe(groupB.id)
      expect(mgr.list().find((s) => s.id === b.id)?.groupId).toBe(groupA.id)
    })

    it('closeTerminal never touches groups', () => {
      const info = mgr.create('/p', claudeSpec, 1)
      const group = mgr.createGroup('g', 1)
      mgr.assignToGroup(info.id, group.id)
      mgr.closeTerminal(info.id)
      expect(mgr.list()[0].groupId).toBe(group.id)
      expect(mgr.listGroups()).toEqual([group])
    })

    it('setEnvironment on a grouped pane moves the whole group', () => {
      const a = mgr.create('/p1', claudeSpec, 1)
      const b = mgr.create('/p2', claudeSpec, 1)
      const solo = mgr.create('/p3', claudeSpec, 1)
      const group = mgr.createGroup('g', 1)
      mgr.assignToGroup(a.id, group.id)
      mgr.assignToGroup(b.id, group.id)
      const updated = mgr.setEnvironment(a.id, 3)
      expect(updated?.environment).toBe(3)
      expect(mgr.getGroup(group.id)?.environment).toBe(3)
      expect(mgr.list().find((s) => s.id === a.id)?.environment).toBe(3)
      expect(mgr.list().find((s) => s.id === b.id)?.environment).toBe(3)
      expect(mgr.list().find((s) => s.id === solo.id)?.environment).toBe(1)
    })

    it('renameGroup trims and ignores empty, like session rename', () => {
      const group = mgr.createGroup('g', 1)
      const renamed = mgr.renameGroup(group.id, '  New Name  ')
      expect(renamed?.name).toBe('New Name')
      const renamedEmpty = mgr.renameGroup(group.id, '')
      expect(renamedEmpty?.name).toBe('New Name')
      const renamedBlank = mgr.renameGroup(group.id, '   ')
      expect(renamedBlank?.name).toBe('New Name')
      expect(mgr.renameGroup('missing-id', 'x')).toBeNull()
    })

    it('restoreGroups then restore() members reconnects groupId', () => {
      const group = { id: 'grp-1', name: 'Saved', environment: 2 }
      mgr.restoreGroups([group])
      expect(mgr.listGroups()).toEqual([group])
      const restored = mgr.restore('saved-id', '/old/project', claudeSpec, 'kept', 2, 'grp-1')
      expect(restored.groupId).toBe('grp-1')
      expect(mgr.list().find((s) => s.id === 'saved-id')?.groupId).toBe('grp-1')
    })

    it('restore ignores a groupId when environments differ', () => {
      mgr.restoreGroups([{ id: 'grp-1', name: 'Saved', environment: 2 }])
      const restored = mgr.restore('saved-id', '/old/project', claudeSpec, 'kept', 5, 'grp-1')
      expect(restored.groupId).toBeUndefined()
    })

    it('restore ignores an unknown groupId', () => {
      const restored = mgr.restore(
        'saved-id',
        '/old/project',
        claudeSpec,
        'kept',
        1,
        'no-such-group'
      )
      expect(restored.groupId).toBeUndefined()
    })

    it('restoreBrowser also reconnects groupId when environments match', () => {
      mgr.restoreGroups([{ id: 'grp-1', name: 'Saved', environment: 2 }])
      const restored = mgr.restoreBrowser('rb-1', 'https://example.com/', 'docs', 2, 'grp-1')
      expect(restored?.groupId).toBe('grp-1')
    })

    it('createGroup fires onSessionsChanged', () => {
      let fired = false
      mgr.onSessionsChanged(() => {
        fired = true
      })
      mgr.createGroup('g', 1)
      expect(fired).toBe(true)
    })
  })

  describe('codex guard fail-open relaunch (G2)', () => {
    // A ResolvedGuard whose CLI args are identifiable: buildCodexHookArgs
    // embeds `--dangerously-bypass-hook-trust` and a `check --hook-exit`
    // command string, so we can assert whether the guard rode the CLI.
    const guard: ResolvedGuard = {
      bin: '/fake/lfguard',
      auditLog: '/fake/audit.log',
      packs: ['default']
    }

    let t: number
    let calls: string[][]
    let guardedPtys: FakePty[]
    let guardedMgr: SessionManager

    const makeMgr = (guardFn?: () => ResolvedGuard | null): SessionManager => {
      calls = []
      guardedPtys = []
      const spawnFn: SpawnFn = (_bin, args) => {
        calls.push(args)
        const pty = new FakePty()
        guardedPtys.push(pty)
        return pty
      }
      return new SessionManager({
        settingsDir: mkdtempSync(join(tmpdir(), 'localflow-g2-')),
        port: 9999,
        token: 'tok',
        now: () => t,
        spawnFn,
        guard: guardFn
      })
    }

    const hasGuardArgs = (args: string[]): boolean =>
      args.some((a) => a.includes('--dangerously-bypass-hook-trust'))

    beforeEach(() => {
      t = 0
    })

    it('relaunches a codex pane without the guard on instant exit', () => {
      guardedMgr = makeMgr(() => guard)
      const info = guardedMgr.create('/p', codexSpec, 1)
      expect(calls).toHaveLength(1)
      expect(hasGuardArgs(calls[0])).toBe(true)
      // Instant exit (< 5000ms) — the guard flag likely bricked the launch.
      t = 1000
      guardedPtys[0].exitCb?.()
      // Relaunched once, this time WITHOUT the guard args.
      expect(calls).toHaveLength(2)
      expect(hasGuardArgs(calls[1])).toBe(false)
      // The pane is alive again, not left dead/exited.
      expect(guardedMgr.list().find((s) => s.id === info.id)?.status).not.toBe('exited')
    })

    it('does not relaunch when the codex exit is not instant (> 5000ms)', () => {
      guardedMgr = makeMgr(() => guard)
      const info = guardedMgr.create('/p', codexSpec, 1)
      t = 6000
      guardedPtys[0].exitCb?.()
      expect(calls).toHaveLength(1)
      expect(guardedMgr.list().find((s) => s.id === info.id)?.status).toBe('exited')
    })

    it('never relaunches a settings-file (Claude) agent — guard not on CLI', () => {
      guardedMgr = makeMgr(() => guard)
      const info = guardedMgr.create('/p', claudeSpec, 1)
      t = 1000
      guardedPtys[0].exitCb?.()
      // No relaunch; normal instant-exit handling ran.
      expect(calls).toHaveLength(1)
      const listed = guardedMgr.list().find((s) => s.id === info.id)
      expect(listed?.status).toBe('exited')
      expect(listed?.message).toContain('Exited right away')
    })

    it('prevents a relaunch loop: a second instant exit does not spawn a third time', () => {
      guardedMgr = makeMgr(() => guard)
      guardedMgr.create('/p', codexSpec, 1)
      t = 1000
      guardedPtys[0].exitCb?.() // triggers the guard-less relaunch (spawn #2)
      expect(calls).toHaveLength(2)
      // The retry pty also exits instantly — but its record has guardOnCli
      // false, so it must NOT trigger another relaunch.
      t = 2000
      guardedPtys[1].exitCb?.()
      expect(calls).toHaveLength(2)
    })

    it('does not relaunch a codex pane the user closed, even on an instant exit', () => {
      guardedMgr = makeMgr(() => guard)
      const info = guardedMgr.create('/p', codexSpec, 1)
      guardedMgr.closeTerminal(info.id) // sets closedByUser, kills pty
      t = 1000
      guardedPtys[0].exitCb?.() // late real onExit
      expect(calls).toHaveLength(1)
      expect(guardedMgr.list().find((s) => s.id === info.id)?.status).toBe('exited')
    })
  })

  describe('SessionManager.emitNotice', () => {
    it('fans a synthetic line out to every onData subscriber', () => {
      const mgr = new SessionManager({
        settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
        port: 0,
        token: 'tok'
      })
      const seen: { id: string; data: string }[] = []
      mgr.onData((id, data) => seen.push({ id, data }))
      mgr.onData((id, data) => seen.push({ id, data }))
      mgr.emitNotice('pane-7', '\r\n⛔ blocked\r\n')
      expect(seen).toEqual([
        { id: 'pane-7', data: '\r\n⛔ blocked\r\n' },
        { id: 'pane-7', data: '\r\n⛔ blocked\r\n' }
      ])
    })
  })
})
