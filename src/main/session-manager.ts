import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
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
  /** Clock override for tests. */
  now?: () => number
}

interface Record_ {
  info: SessionInfo
  spec: SpawnSpec
  pty: PtyLike | null
  /** When the current pty was spawned; 0 for restored placeholders. */
  spawnedAt: number
  /** Rolling tail of recent output, used to explain instant exits. */
  tail: string
  /** Set by closeTerminal() right before killing the pty; the
   * eventual real onExit event checks this to avoid re-running the
   * instant-exit message heuristic against a deliberate close, and
   * to avoid double-processing an already-handled transition. */
  closedByUser?: boolean
}

// Strips ANSI/VT escape sequences per the ECMA-48 grammar: CSI with full
// parameter bytes (covers private-mode like ESC[>0q), OSC titles ended by
// BEL/ST, DCS-family strings, other C1 escapes, and stray control bytes.
// Also covers the 8-bit C1 CSI () form some agents/terminfo emit
// instead of the 7-bit ESC[ prefix — same CSI grammar, single code unit.
// Partial stripping here leaks garbage like "0q4mu" into user messages.

const ANSI_RE = new RegExp(
  [
    '\\u001b\\[[0-9:;<=>?]*[ -/]*[@-~]',
    '\\u009b[0-9:;<=>?]*[ -/]*[@-~]',
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?',
    '\\u001b[PX^_][^\\u001b]*(?:\\u001b\\\\)?',
    '\\u001b[@-Z\\\\-_]',
    '[\\u0000-\\u0008\\u000b-\\u001f\\u007f]'
  ].join('|'),
  'g'
)

const INSTANT_EXIT_MS = 5000

export class SessionManager {
  private sessions = new Map<string, Record_>()
  /** Set at quit: silences all late pty events (data, exit) app-wide. */
  private disposed = false
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
    return this.spawn(randomUUID(), cwd, spec, false, basename(cwd))
  }

  restore(id: string, cwd: string, spec: SpawnSpec, name?: string): SessionInfo {
    const info: SessionInfo = {
      id,
      cwd,
      name: name && name.trim().length > 0 ? name : basename(cwd),
      status: 'exited',
      agentId: spec.agentId,
      command: spec.command
    }
    this.sessions.set(id, { info, spec, pty: null, spawnedAt: 0, tail: '' })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  /** Relaunch a dead session. `fresh` skips the agent's resume args. */
  restart(id: string, fresh = false): SessionInfo {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status !== 'exited') throw new Error(`cannot restart session ${id}`)
    return this.spawn(id, rec.info.cwd, rec.spec, !fresh, rec.info.name)
  }

  private spawn(
    id: string,
    cwd: string,
    spec: SpawnSpec,
    resume: boolean,
    name: string
  ): SessionInfo {
    const info: SessionInfo = {
      id,
      cwd,
      name,
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
      this.sessions.set(id, { info, spec, pty: null, spawnedAt: 0, tail: '' })
      this.changedCbs.forEach((cb) => cb())
      this.dataCbs.forEach((cb) => cb(id, `\r\n${message}\r\n`))
      return info
    }
    this.sessions.set(id, { info, spec, pty, spawnedAt: this.now(), tail: '' })
    pty.onData((d) => {
      if (this.disposed) return
      const rec = this.sessions.get(id)
      if (!rec) return
      rec.tail = (rec.tail + d).slice(-500)
      this.dataCbs.forEach((cb) => cb(id, d))
    })
    pty.onExit(() => {
      if (this.disposed) return
      // Drop the pty reference first: its fd is gone, and any late
      // write/resize against it would throw EBADF in the main process.
      const rec = this.sessions.get(id)
      if (!rec) return
      if (rec.closedByUser) {
        // closeTerminal() already transitioned this session; the pty's
        // own exit event arrived late (kill() is not synchronous) and
        // must not re-run the instant-exit message logic below.
        rec.closedByUser = false
        return
      }
      rec.pty = null
      // An agent that dies within seconds never showed the user anything —
      // surface its last words in the restart overlay (e.g. claude's
      // "No conversation found" when --continue has nothing to resume).
      if (!rec.info.message && this.now() - rec.spawnedAt < INSTANT_EXIT_MS) {
        const tail = rec.tail.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim().slice(-160)
        rec.info.message = tail
          ? `Exited right away — last output: \u201c${tail}\u201d`
          : 'Exited right away with no output.'
      }
      this.setStatus(id, transition(this.status(id), 'pty-exit'))
    })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  applyHookEvent(e: HookEvent): void {
    const rec = this.sessions.get(e.paneId)
    if (!rec) return
    this.setStatus(e.paneId, transition(rec.info.status, e.event))
  }

  // The pty's fd can die at any moment (process exit races these calls),
  // so treat write/resize/kill errors as "session already gone" no-ops.
  write(id: string, data: string): void {
    try {
      this.sessions.get(id)?.pty?.write(data)
    } catch {
      /* dead pty */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.pty?.resize(cols, rows)
    } catch {
      /* dead pty */
    }
  }

  /** Ends the pty, keeps the session record (durable session, ephemeral terminal). */
  closeTerminal(id: string): void {
    const rec = this.sessions.get(id)
    if (!rec || !rec.pty) return
    rec.closedByUser = true
    try {
      rec.pty.kill()
    } catch {
      /* dead pty */
    }
    rec.pty = null
    this.setStatus(id, 'exited')
    this.changedCbs.forEach((cb) => cb())
  }

  /** Kills the pty (if alive) and forgets the session entirely. */
  deleteSession(id: string): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    try {
      rec.pty?.kill()
    } catch {
      /* dead pty */
    }
    this.sessions.delete(id)
    this.changedCbs.forEach((cb) => cb())
  }

  rename(id: string, name: string): SessionInfo | null {
    const rec = this.sessions.get(id)
    if (!rec) return null
    const trimmed = name.trim()
    if (trimmed.length > 0) {
      rec.info.name = trimmed
      this.changedCbs.forEach((cb) => cb())
    }
    return { ...rec.info }
  }

  /**
   * Quit-time cleanup: kill every live pty and set the disposed flag, which
   * the onData/onExit closures check — so late stream events truly cannot
   * fire into a tearing-down app (the isDestroyed guard in main/index.ts is
   * the second line of defense). Sessions stay in the map (and thus in
   * sessions.json) so they restore on next launch.
   */
  disposeAll(): void {
    this.disposed = true
    for (const rec of this.sessions.values()) {
      try {
        rec.pty?.kill()
      } catch {
        /* dead pty */
      }
      rec.pty = null
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((r) => ({ ...r.info }))
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
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
