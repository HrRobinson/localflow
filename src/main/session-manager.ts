import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { spawn as ptySpawn } from 'node-pty'
import {
  LIFECYCLE_KINDS,
  type ActivityEntry,
  type ActivityEventKind,
  type AgentId,
  type HookEvent,
  type SessionInfo,
  type SessionStatus
} from '../shared/types'
import { clampEnvironment } from '../shared/environment'
import { normalizeHttpUrl } from '../shared/urls'
import { transition } from './state-machine'
import { hasHookAdapter, type HookAdapterKind } from '../shared/agents'
import { buildHookInjection } from './hook-adapter'
import { ANSI_RE, extractPeekLines } from './peek'

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
  /** Which hook-injection mechanism to use to feed this session's status. */
  hookAdapter: HookAdapterKind
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
  /** In-memory activity ring, last ACTIVITY_LIMIT entries; never persisted. */
  activity: ActivityEntry[]
  /** Set by closeTerminal() right before killing the pty; the
   * eventual real onExit event checks this to avoid re-running the
   * instant-exit message heuristic against a deliberate close, and
   * to avoid double-processing an already-handled transition. */
  closedByUser?: boolean
}

const INSTANT_EXIT_MS = 5000
const ACTIVITY_LIMIT = 200

// Browser panes have no process; their Record_ still carries a SpawnSpec
// because the type requires one. This filler is inert — every code path
// branches on info.kind before touching spec/pty. No 'browser' member is
// added to AgentId (the registry/launcher must never see a fake agent).
const BROWSER_SPEC: SpawnSpec = {
  agentId: 'custom',
  command: '',
  resumeArgs: [],
  hookAdapter: 'none'
}

export class SessionManager {
  private sessions = new Map<string, Record_>()
  /** Set at quit: silences all late pty events (data, exit) app-wide. */
  private disposed = false
  private dataCbs: ((id: string, data: string) => void)[] = []
  private statusCbs: ((id: string, status: SessionStatus) => void)[] = []
  private changedCbs: (() => void)[] = []
  private activityCbs: ((id: string, entry: ActivityEntry) => void)[] = []

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
  onActivity(cb: (id: string, entry: ActivityEntry) => void): void {
    this.activityCbs.push(cb)
  }

  create(cwd: string, spec: SpawnSpec, environment: number): SessionInfo {
    const info = this.spawn(
      randomUUID(),
      cwd,
      spec,
      false,
      basename(cwd),
      clampEnvironment(environment)
    )
    this.recordActivity(info.id, 'created')
    return info
  }

  restore(
    id: string,
    cwd: string,
    spec: SpawnSpec,
    name?: string,
    environment?: unknown
  ): SessionInfo {
    // Defense in depth: a hand-edited sessions.json can hand us a non-string
    // name (e.g. `"name": 123`) — treat that as absent rather than throwing
    // on .trim() before IPC is even registered. Store the trimmed value so
    // a whitespace-padded name doesn't carry its padding through restarts.
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const info: SessionInfo = {
      id,
      cwd,
      name: trimmed.length > 0 ? trimmed : basename(cwd),
      status: 'exited',
      agentId: spec.agentId,
      command: spec.command,
      environment: clampEnvironment(environment),
      kind: 'terminal' as const
    }
    this.sessions.set(id, { info, spec, pty: null, spawnedAt: 0, tail: '', activity: [] })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  /** A browser pane: an ordinary durable session with a URL instead of a pty. */
  createBrowser(url: string, environment: number): SessionInfo {
    const normalized = normalizeHttpUrl(url)
    if (!normalized) throw new Error(`invalid browser url: ${url}`)
    const info: SessionInfo = {
      id: randomUUID(),
      cwd: '',
      name: new URL(normalized).hostname,
      status: 'running',
      agentId: BROWSER_SPEC.agentId,
      command: BROWSER_SPEC.command,
      environment: clampEnvironment(environment),
      kind: 'browser',
      url: normalized
    }
    this.sessions.set(info.id, {
      info,
      spec: BROWSER_SPEC,
      pty: null,
      spawnedAt: 0,
      tail: '',
      activity: []
    })
    this.changedCbs.forEach((cb) => cb())
    this.recordActivity(info.id, 'created')
    return info
  }

  /** Restores a saved browser pane as exited. Null when the saved url is bad. */
  restoreBrowser(
    id: string,
    url: string,
    name?: string,
    environment?: unknown
  ): SessionInfo | null {
    const normalized = normalizeHttpUrl(url)
    if (!normalized) return null
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const info: SessionInfo = {
      id,
      cwd: '',
      name: trimmed.length > 0 ? trimmed : new URL(normalized).hostname,
      status: 'exited',
      agentId: BROWSER_SPEC.agentId,
      command: BROWSER_SPEC.command,
      environment: clampEnvironment(environment),
      kind: 'browser',
      url: normalized
    }
    this.sessions.set(id, {
      info,
      spec: BROWSER_SPEC,
      pty: null,
      spawnedAt: 0,
      tail: '',
      activity: []
    })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  /** Follows the user's browsing: persist the pane's current URL. */
  setUrl(id: string, url: string): SessionInfo | null {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.kind !== 'browser') return null
    const normalized = normalizeHttpUrl(url)
    if (!normalized) return null
    if (rec.info.url !== normalized) {
      rec.info.url = normalized
      this.changedCbs.forEach((cb) => cb())
    }
    return { ...rec.info }
  }

  /** Relaunch a dead session. `fresh` skips the agent's resume args. */
  restart(id: string, fresh = false): SessionInfo {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status !== 'exited') throw new Error(`cannot restart session ${id}`)
    if (rec.info.kind === 'browser') {
      // Reopen at the stored URL; `fresh` has no meaning without a
      // conversation to resume and is deliberately identical.
      this.setStatus(id, 'running')
      this.recordActivity(id, 'reopened')
      return { ...rec.info }
    }
    const info = this.spawn(id, rec.info.cwd, rec.spec, !fresh, rec.info.name, rec.info.environment)
    this.recordActivity(id, 'reopened')
    return info
  }

  private spawn(
    id: string,
    cwd: string,
    spec: SpawnSpec,
    resume: boolean,
    name: string,
    environment: number
  ): SessionInfo {
    // A restart replaces the pty (and the Record_), but the durable session's
    // activity history must survive — carry the existing ring forward.
    const activity = this.sessions.get(id)?.activity ?? []
    const info: SessionInfo = {
      id,
      cwd,
      name,
      // Hook-fed agents report their own states; others we only know as alive.
      status: hasHookAdapter(spec.hookAdapter) ? 'idle' : 'running',
      agentId: spec.agentId,
      command: spec.command,
      environment,
      kind: 'terminal' as const
    }
    let pty: PtyLike
    try {
      const injection = buildHookInjection(
        spec.hookAdapter,
        this.opts.settingsDir,
        id,
        this.opts.port,
        this.opts.token
      )
      const resumeArgs = resume ? spec.resumeArgs : []
      pty = (this.opts.spawnFn ?? defaultSpawn)(spec.command, [...injection.args, ...resumeArgs], {
        cwd,
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
        env: { ...process.env, ...injection.env }
      })
    } catch {
      const message = `Could not start '${spec.command}'. Check the agent's path in the launcher.`
      info.status = 'exited'
      info.message = message
      this.sessions.set(id, { info, spec, pty: null, spawnedAt: 0, tail: '', activity })
      this.changedCbs.forEach((cb) => cb())
      this.dataCbs.forEach((cb) => cb(id, `\r\n${message}\r\n`))
      return info
    }
    // Capture THIS call's record so the closures below can detect a
    // respawn (restart() replaces the map entry for `id` with a new
    // Record_ object). Without this, a stale pty's onData/onExit — which
    // can fire well after kill() (SIGHUP is not synchronous) — would look
    // up the record by id, find the NEW one, and clobber it: nulling its
    // live pty (orphaning the resumed agent — unreachable by
    // write/delete/disposeAll) and forcing it back to exited with a bogus
    // "Exited right away" message.
    const rec: Record_ = { info, spec, pty, spawnedAt: this.now(), tail: '', activity }
    this.sessions.set(id, rec)
    pty.onData((d) => {
      if (this.disposed) return
      if (this.sessions.get(id) !== rec) return
      // Keep a generous raw tail. Two consumers: the instant-exit message
      // (last 160 cleaned chars — a front-cut escape fragment far upstream
      // can never reach it) and the approve peek (last few cleaned lines).
      // TUI agents redraw whole frames of ANSI per keystroke, so raw chars
      // are mostly escapes — 16 KiB keeps a real screenful of visible text.
      rec.tail = (rec.tail + d).slice(-16384)
      this.dataCbs.forEach((cb) => cb(id, d))
    })
    pty.onExit(() => {
      if (this.disposed) return
      // Bail unless this record is still the live one for `id` — a stale
      // exit from a pty that was replaced by restart() must not touch the
      // new record.
      if (this.sessions.get(id) !== rec) return
      // Drop the pty reference first: its fd is gone, and any late
      // write/resize against it would throw EBADF in the main process.
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
      this.recordActivity(id, 'exited')
    })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  applyHookEvent(e: HookEvent): void {
    const rec = this.sessions.get(e.paneId)
    if (!rec || rec.info.kind === 'browser') return
    this.setStatus(e.paneId, transition(rec.info.status, e.event))
    this.recordActivity(e.paneId, e.event)
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
    if (!rec) return
    if (rec.info.kind === 'browser') {
      if (rec.info.status === 'exited') return
      this.setStatus(id, 'exited')
      this.recordActivity(id, 'closed')
      this.changedCbs.forEach((cb) => cb())
      return
    }
    if (!rec.pty) return
    rec.closedByUser = true
    try {
      rec.pty.kill()
    } catch {
      /* dead pty */
    }
    rec.pty = null
    this.setStatus(id, 'exited')
    this.recordActivity(id, 'closed')
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

  /** Moves a session to another environment (1-9, clamped). Null for unknown id. */
  setEnvironment(id: string, environment: number): SessionInfo | null {
    const rec = this.sessions.get(id)
    if (!rec) return null
    rec.info.environment = clampEnvironment(environment)
    this.recordActivity(id, 'moved')
    this.changedCbs.forEach((cb) => cb())
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

  /** Last `maxLines` cleaned output lines — the approve control's peek. */
  peek(id: string, maxLines = 5): string[] {
    const rec = this.sessions.get(id)
    if (!rec) return []
    return extractPeekLines(rec.tail, maxLines)
  }

  /** Append one entry to a session's ring (capped), notifying listeners. */
  private recordActivity(id: string, kind: ActivityEventKind): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    // A repeated hook event that lands on the same status (e.g. a chatty
    // agent re-emitting Notification while already needs-you) is one logical
    // "still waiting" signal — collapse it into the previous entry so a run
    // of duplicates cannot evict distinct history from the capped ring. The
    // count preserves the truth ("asked N times"); the timestamp tracks the
    // latest occurrence. Lifecycle kinds always append.
    const last = rec.activity[rec.activity.length - 1]
    if (
      last &&
      !LIFECYCLE_KINDS.has(kind) &&
      last.kind === kind &&
      last.status === rec.info.status
    ) {
      last.count = (last.count ?? 1) + 1
      last.timestamp = this.now()
      // Push a copy: listeners (IPC) must not hold a live ring reference.
      this.activityCbs.forEach((cb) => cb(id, { ...last }))
      return
    }
    const entry: ActivityEntry = { timestamp: this.now(), kind, status: rec.info.status }
    rec.activity.push(entry)
    if (rec.activity.length > ACTIVITY_LIMIT) rec.activity.shift()
    this.activityCbs.forEach((cb) => cb(id, entry))
  }

  /** The session's activity ring, oldest first. Empty for unknown ids. */
  getActivity(id: string): ActivityEntry[] {
    return this.sessions.get(id)?.activity.map((e) => ({ ...e })) ?? []
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
    // Track how long a session has kept the user waiting: stamp on entry into
    // needs-you, clear on any exit from it (including 'exited'). The manager's
    // clock keeps this deterministic in tests; in-memory only (never persisted).
    if (status === 'needs-you') {
      rec.info.needsYouSince = this.now()
    } else {
      delete rec.info.needsYouSince
    }
    rec.info.status = status
    this.statusCbs.forEach((cb) => cb(id, status))
  }
}
