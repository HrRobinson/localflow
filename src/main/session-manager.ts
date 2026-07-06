import { randomUUID } from 'node:crypto'
import { spawn as ptySpawn } from 'node-pty'
import type { AgentId, HookEvent, SessionInfo, SessionStatus } from '../shared/types'
import { transition } from './state-machine'
import { writeHookSettings } from './hook-settings'

export interface PtyLike {
  onData(cb: (d: string) => void): void
  onExit(cb: () => void): void
  write(d: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; name: string; env: NodeJS.ProcessEnv }
) => PtyLike

/** Everything needed to (re)launch one session's agent process. */
export interface SpawnSpec {
  agentId: AgentId
  command: string
  /** Args appended when resuming a dead session (agent-specific). */
  resumeArgs: string[]
  /** Inject localflow status hooks (exact colors) — Claude Code only for now. */
  useHooks: boolean
}

const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const pty = ptySpawn(bin, args, opts)
  return {
    onData: (cb) => pty.onData(cb),
    onExit: (cb) => pty.onExit(() => cb()),
    write: (d) => pty.write(d),
    resize: (c, r) => pty.resize(c, r),
    kill: () => pty.kill()
  }
}

interface Options {
  settingsDir: string
  port: number
  token: string
  spawnFn?: SpawnFn
}

interface Record_ {
  info: SessionInfo
  spec: SpawnSpec
  pty: PtyLike | null
}

export class SessionManager {
  private sessions = new Map<string, Record_>()
  private dataCbs: ((id: string, data: string) => void)[] = []
  private statusCbs: ((id: string, status: SessionStatus) => void)[] = []
  private changedCbs: (() => void)[] = []

  constructor(private opts: Options) {}

  onData(cb: (id: string, data: string) => void): void {
    this.dataCbs.push(cb)
  }
  onStatus(cb: (id: string, status: SessionStatus) => void): void {
    this.statusCbs.push(cb)
  }
  onSessionsChanged(cb: () => void): void {
    this.changedCbs.push(cb)
  }

  create(cwd: string, spec: SpawnSpec): SessionInfo {
    return this.spawn(randomUUID(), cwd, spec, false)
  }

  restore(id: string, cwd: string, spec: SpawnSpec): SessionInfo {
    const info: SessionInfo = {
      id,
      cwd,
      status: 'exited',
      agentId: spec.agentId,
      command: spec.command
    }
    this.sessions.set(id, { info, spec, pty: null })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  restart(id: string): SessionInfo {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status !== 'exited') throw new Error(`cannot restart session ${id}`)
    return this.spawn(id, rec.info.cwd, rec.spec, true)
  }

  private spawn(id: string, cwd: string, spec: SpawnSpec, resume: boolean): SessionInfo {
    const info: SessionInfo = {
      id,
      cwd,
      // Hook-fed agents report their own states; others we only know as alive.
      status: spec.useHooks ? 'idle' : 'running',
      agentId: spec.agentId,
      command: spec.command
    }
    let pty: PtyLike
    try {
      const hookArgs = spec.useHooks
        ? [
            '--settings',
            writeHookSettings(this.opts.settingsDir, id, this.opts.port, this.opts.token)
          ]
        : []
      const resumeArgs = resume ? spec.resumeArgs : []
      pty = (this.opts.spawnFn ?? defaultSpawn)(spec.command, [...hookArgs, ...resumeArgs], {
        cwd,
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
        env: process.env
      })
    } catch {
      const message = `Could not start '${spec.command}'. Check the agent's path in the launcher.`
      info.status = 'exited'
      info.message = message
      this.sessions.set(id, { info, spec, pty: null })
      this.changedCbs.forEach((cb) => cb())
      this.dataCbs.forEach((cb) => cb(id, `\r\n${message}\r\n`))
      return info
    }
    this.sessions.set(id, { info, spec, pty })
    pty.onData((d) => {
      if (this.sessions.has(id)) this.dataCbs.forEach((cb) => cb(id, d))
    })
    pty.onExit(() => this.setStatus(id, transition(this.status(id), 'pty-exit')))
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  applyHookEvent(e: HookEvent): void {
    const rec = this.sessions.get(e.paneId)
    if (!rec) return
    this.setStatus(e.paneId, transition(rec.info.status, e.event))
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty?.resize(cols, rows)
  }

  kill(id: string): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    rec.pty?.kill()
    this.sessions.delete(id)
    this.changedCbs.forEach((cb) => cb())
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((r) => ({ ...r.info }))
  }

  private status(id: string): SessionStatus {
    return this.sessions.get(id)?.info.status ?? 'exited'
  }

  private setStatus(id: string, status: SessionStatus): void {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status === status) return
    rec.info.status = status
    this.statusCbs.forEach((cb) => cb(id, status))
  }
}
