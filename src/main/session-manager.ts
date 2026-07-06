import { randomUUID } from 'node:crypto'
import { spawn as ptySpawn } from 'node-pty'
import type { HookEvent, SessionInfo, SessionStatus } from '../shared/types'
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
  claudeBin: string
  spawnFn?: SpawnFn
}

interface Record_ {
  info: SessionInfo
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

  create(cwd: string): SessionInfo {
    return this.spawn(randomUUID(), cwd, [])
  }

  restore(id: string, cwd: string): SessionInfo {
    const info: SessionInfo = { id, cwd, status: 'exited' }
    this.sessions.set(id, { info, pty: null })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  restart(id: string): SessionInfo {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status !== 'exited') throw new Error(`cannot restart session ${id}`)
    return this.spawn(id, rec.info.cwd, ['--continue'])
  }

  private spawn(id: string, cwd: string, extraArgs: string[]): SessionInfo {
    const settingsFile = writeHookSettings(
      this.opts.settingsDir,
      id,
      this.opts.port,
      this.opts.token
    )
    const info: SessionInfo = { id, cwd, status: 'idle' }
    let pty: PtyLike
    try {
      pty = (this.opts.spawnFn ?? defaultSpawn)(
        this.opts.claudeBin,
        ['--settings', settingsFile, ...extraArgs],
        { cwd, cols: 80, rows: 24, name: 'xterm-256color', env: process.env }
      )
    } catch {
      info.status = 'exited'
      this.sessions.set(id, { info, pty: null })
      this.changedCbs.forEach((cb) => cb())
      this.dataCbs.forEach((cb) =>
        cb(
          id,
          `\r\nCould not start '${this.opts.claudeBin}'. Is Claude Code installed and on your PATH?\r\n`
        )
      )
      return info
    }
    this.sessions.set(id, { info, pty })
    pty.onData((d) => this.dataCbs.forEach((cb) => cb(id, d)))
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
