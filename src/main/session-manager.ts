import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { spawn as ptySpawn } from 'node-pty'
import {
  LIFECYCLE_KINDS,
  type ActivityEntry,
  type ActivityEventKind,
  type AgentId,
  type HookEvent,
  type SessionGroup,
  type SessionInfo,
  type SessionStatus
} from '../shared/types'
import { clampEnvironment } from '../shared/environment'
import { normalizeHttpUrl } from '../shared/urls'
import { transition } from './state-machine'
import { hasHookAdapter, type HookAdapterKind } from '../shared/agents'
import { buildHookInjection, removeHookInjectionFiles } from './hook-adapter'
import { ANSI_RE, extractPeekLines } from './peek'

export interface PtyLike {
  onData(cb: (d: string) => void): void
  /** node-pty's real exit payload — carried through so instant-exit messages
   * can name the actual exit code/signal instead of going silent on it.
   * Both params are optional so test doubles can invoke the callback with
   * zero args (a bare "it exited" signal) without a synthetic exit code. */
  onExit(cb: (exitCode?: number, signal?: number) => void): void
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
  /**
   * Args appended on a fresh (non-resume) launch (agent-specific, M4.1).
   * Optional so existing hand-built SpawnSpec fixtures keep compiling;
   * absent means no preset args on a fresh launch (unchanged behavior).
   */
  startArgs?: string[]
  /** Which hook-injection mechanism to use to feed this session's status. */
  hookAdapter: HookAdapterKind
  /** Extra CLI args appended after resume args (per-agent override, M4). */
  extraArgs?: string[]
  /** Env overrides applied last at spawn (per-agent override, M4). */
  env?: Record<string, string>
}

const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const pty = ptySpawn(bin, args, opts)
  return {
    onData: (cb) => pty.onData(cb),
    onExit: (cb) => pty.onExit(({ exitCode, signal }) => cb(exitCode, signal)),
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
  /** Resolves the guard config at spawn time (null = no guard). */
  guard?: () => import('./guard-hook').ResolvedGuard | null
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
  /** True only when the guard rode this launch's CLI args (Codex
   * cli-args-* adapters). Gates the fail-open relaunch in onExit: a wrong
   * guard flag can make codex reject its own launch, and the retry (spawned
   * with skipGuard) resets this to false so it can never loop. */
  guardOnCli: boolean
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
  private groups = new Map<string, SessionGroup>()
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
    environment?: unknown,
    groupId?: string
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
    this.reconnectGroup(info, groupId)
    this.sessions.set(id, {
      info,
      spec,
      pty: null,
      spawnedAt: 0,
      tail: '',
      activity: [],
      guardOnCli: false
    })
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
      activity: [],
      guardOnCli: false
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
    environment?: unknown,
    groupId?: string
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
    this.reconnectGroup(info, groupId)
    this.sessions.set(id, {
      info,
      spec: BROWSER_SPEC,
      pty: null,
      spawnedAt: 0,
      tail: '',
      activity: [],
      guardOnCli: false
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

  /**
   * Merges env overrides into a terminal session's stored spawn spec, taking
   * effect on its next (re)spawn. Used to refresh injected credentials (e.g.
   * a relaunched OpenClaw session's re-granted operator token) — a live pty
   * keeps the env it was spawned with.
   */
  updateSpecEnv(id: string, env: Record<string, string>): void {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.kind !== 'terminal') return
    rec.spec = { ...rec.spec, env: { ...rec.spec.env, ...env } }
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
    environment: number,
    skipGuard = false
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
    // A relaunch after a guard-induced instant exit passes skipGuard=true so
    // the retry runs unguarded (fail open). Otherwise resolve the guard now.
    const guard = skipGuard ? null : (this.opts.guard?.() ?? null)
    let pty: PtyLike
    try {
      const injection = buildHookInjection(
        spec.hookAdapter,
        this.opts.settingsDir,
        id,
        this.opts.port,
        this.opts.token,
        guard
      )
      // Fresh (non-resume) launches use the preset's startArgs (e.g.
      // openclaw → ['chat']) instead of resumeArgs; either way, a user's
      // Settings extra args are appended last.
      const presetArgs = resume ? spec.resumeArgs : (spec.startArgs ?? [])
      pty = (this.opts.spawnFn ?? defaultSpawn)(
        spec.command,
        [...injection.args, ...presetArgs, ...(spec.extraArgs ?? [])],
        {
          cwd,
          cols: 80,
          rows: 24,
          name: 'xterm-256color',
          // Precedence: process env < hook injection < user override. User
          // overrides win last (explicit intent); collisions with the
          // hook-owned vars cannot reach here — setAgentOverride rejects
          // RESERVED_ENV_KEYS (hook-adapter.ts) at the config boundary.
          env: { ...process.env, ...injection.env, ...(spec.env ?? {}) }
        }
      )
    } catch (e) {
      // `e` can come from either ptySpawn/spawnFn (ENOENT/EACCES/ENOTDIR/EMFILE
      // — a real path problem) or buildHookInjection's settings-file write
      // (a disk-full/permission error in userData that has nothing to do
      // with the agent's path). Thread the real message/code through instead
      // of always blaming the path.
      const detail =
        e instanceof Error
          ? (e as NodeJS.ErrnoException).code
            ? `${(e as NodeJS.ErrnoException).code}: ${e.message}`
            : e.message
          : String(e)
      const message = `Could not start '${spec.command}' — ${detail}. Check its path in Settings → Agents.`
      info.status = 'exited'
      info.message = message
      this.sessions.set(id, {
        info,
        spec,
        pty: null,
        spawnedAt: 0,
        tail: '',
        activity,
        guardOnCli: false
      })
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
    // Remember whether the guard rode the CLI (Codex cli-args-* adapters):
    // only then can a bad guard flag brick the launch, and only then does the
    // onExit fail-open relaunch fire. settings-file/env-settings-file agents
    // inject via files and can never fail a launch on the guard.
    const guardOnCli =
      guard !== null &&
      (spec.hookAdapter === 'cli-args-full' || spec.hookAdapter === 'cli-args-notify')
    // Codex self-verify badge: only when the guard rode this launch's CLI can
    // the -c hooks.PreToolUse grammar silently fail. Start 'unverified'; the
    // seen-dir marker watcher flips it to 'observed' on the first invocation.
    // Any other pane (settings-file/env-file agents, unguarded, skipGuard
    // relaunch) leaves it undefined — the renderer shows nothing. Rebuilt each
    // spawn, so a respawn always re-proves enforcement.
    if (guardOnCli) info.guardVerification = 'unverified'
    const rec: Record_ = {
      info,
      spec,
      pty,
      spawnedAt: this.now(),
      tail: '',
      activity,
      guardOnCli
    }
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
    pty.onExit((exitCode, signal) => {
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
      // Codex-style CLI guard args can make the agent reject its own launch
      // (unknown flag / bad -c grammar) → instant exit. Fail OPEN: relaunch
      // this pane once without the guard rather than leave a dead pane.
      // guardOnCli is only set when the guard rode the CLI (Codex); a
      // settings-file agent never reaches here. The relaunch passes
      // skipGuard=true, so the new record's guardOnCli is false and a second
      // instant exit cannot loop back into another guard-relaunch.
      if (rec.guardOnCli && this.now() - rec.spawnedAt < INSTANT_EXIT_MS) {
        rec.pty = null
        this.dataCbs.forEach((cb) =>
          cb(
            id,
            '\r\nlfguard: the command guard hook was rejected by this agent; ' +
              'relaunched without the guard (running unguarded).\r\n'
          )
        )
        this.spawn(id, cwd, spec, resume, name, environment, true) // skipGuard = true
        return
      }
      rec.pty = null
      // An agent that dies within seconds never showed the user anything —
      // surface its last words in the restart overlay (e.g. claude's
      // "No conversation found" when --continue has nothing to resume).
      if (!rec.info.message && this.now() - rec.spawnedAt < INSTANT_EXIT_MS) {
        const tail = rec.tail.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim().slice(-160)
        // exitCode is optional on the callback type (test doubles may fire
        // a bare 0-arg exit) — node-pty itself always supplies a real
        // number, so 'unknown' only ever shows up from a synthetic test
        // exit, never in production.
        const code = `exit code ${exitCode ?? 'unknown'}${signal ? `, signal ${signal}` : ''}`
        // The "failed to start" claim is only warranted when the evidence
        // actually supports it: a nonzero exit with no signal. A signal
        // means node-pty saw a process that WAS running get killed
        // (SIGKILL/OOM, SIGSEGV, ...), a clean exitCode 0 isn't a failure at
        // all (e.g. an agent that validates a flag and exits 0), and a
        // missing exitCode is simply no evidence at all — asserting a cause
        // in any of those cases would contradict (or outrun) the very
        // evidence shown alongside it, so stay neutral instead.
        const impliesLaunchFailure = !signal && exitCode !== undefined && exitCode !== 0
        rec.info.message = tail
          ? `Exited right away (${code}) — last output: \u201c${tail}\u201d`
          : impliesLaunchFailure
            ? `Exited right away (${code}) with no output — likely the agent binary failed ` +
              `to start. Check '${spec.command}' in Settings → Agents.`
            : `Exited right away (${code}) with no output.`
        // Only a resume attempt that died instantly implicates the resumed
        // conversation itself — a fresh start's instant exit is some other
        // launch failure and must not steer the user away from resuming.
        if (resume) rec.info.resumeFailed = true
      }
      this.setStatus(id, transition(this.status(id), 'pty-exit'))
      this.recordActivity(id, 'exited')
    })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  /**
   * Marks a Codex pane's guard as observed-enforcing: called once lfguard's
   * invocation marker for this pane's id has been written. No-op for an unknown
   * id, a non-Codex/undefined pane, or a pane already 'observed' (idempotent —
   * a second invocation must not re-fire changedCbs). Never un-sets: only a
   * fresh spawn resets the field back to 'unverified'.
   */
  markGuardObserved(id: string): void {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.guardVerification !== 'unverified') return
    rec.info.guardVerification = 'observed'
    this.changedCbs.forEach((cb) => cb())
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

  /**
   * Push a synthetic line to the pane's renderer WITHOUT writing to the pty.
   * Same fan-out the instant-exit and relaunch notices use. Used to surface an
   * lfguard block in the pane the operator tried to drive.
   */
  emitNotice(id: string, text: string): void {
    this.dataCbs.forEach((cb) => cb(id, text))
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
    // A group that just lost its last member is gone too — there is no UI
    // for an empty "session" and nothing else references it by id.
    this.reapIfEmpty(rec.info.groupId)
    // The session is gone for good — its per-session hook-settings files
    // (written at spawn) have no further reader; remove them (best-effort).
    removeHookInjectionFiles(this.opts.settingsDir, id)
    this.changedCbs.forEach((cb) => cb())
  }

  /** Deletes a group once nothing references it any more — mirrors
   * deleteSession's reap so ungrouping/reassigning can't strand an empty
   * group. No-op when `groupId` is unset or the group still has members. */
  private reapIfEmpty(groupId: string | undefined): void {
    if (groupId && ![...this.sessions.values()].some((r) => r.info.groupId === groupId)) {
      this.groups.delete(groupId)
    }
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
   * Moves a session to another environment (1-9, clamped). Null for unknown
   * id. A grouped pane drags its whole group along — the group ("session")
   * and every member pane move together, one `moved` activity per pane, a
   * single changed callback at the end.
   */
  setEnvironment(id: string, environment: number): SessionInfo | null {
    const rec = this.sessions.get(id)
    if (!rec) return null
    const clamped = clampEnvironment(environment)
    const group = rec.info.groupId ? this.groups.get(rec.info.groupId) : undefined
    if (group) {
      group.environment = clamped
      for (const member of this.sessions.values()) {
        if (member.info.groupId === group.id) {
          member.info.environment = clamped
          this.recordActivity(member.info.id, 'moved')
        }
      }
    } else {
      rec.info.environment = clamped
      this.recordActivity(id, 'moved')
    }
    this.changedCbs.forEach((cb) => cb())
    return { ...rec.info }
  }

  createGroup(name: string, environment: number): SessionGroup {
    const group: SessionGroup = {
      id: randomUUID(),
      name: name.trim(),
      environment: clampEnvironment(environment)
    }
    this.groups.set(group.id, group)
    this.changedCbs.forEach((cb) => cb())
    return { ...group }
  }

  renameGroup(id: string, name: string): SessionGroup | null {
    const group = this.groups.get(id)
    if (!group) return null
    const trimmed = name.trim()
    if (trimmed.length > 0) {
      group.name = trimmed
      this.changedCbs.forEach((cb) => cb())
    }
    return { ...group }
  }

  /**
   * Sets or clears (`groupId: null`) a pane's group. Rejects (returns null)
   * when the pane is unknown, the group is unknown, or the pane's and
   * group's environments differ — a group only ever spans one environment.
   */
  assignToGroup(paneId: string, groupId: string | null): SessionInfo | null {
    const rec = this.sessions.get(paneId)
    if (!rec) return null
    if (groupId === null) {
      const oldGroupId = rec.info.groupId
      delete rec.info.groupId
      this.reapIfEmpty(oldGroupId)
    } else {
      const group = this.groups.get(groupId)
      if (!group || group.environment !== rec.info.environment) return null
      const oldGroupId = rec.info.groupId
      rec.info.groupId = groupId
      // Moving a pane out of its old group can strand that group empty —
      // reap it the same way ungrouping and deleteSession do.
      if (oldGroupId && oldGroupId !== groupId) {
        this.reapIfEmpty(oldGroupId)
      }
    }
    this.recordActivity(paneId, 'moved')
    this.changedCbs.forEach((cb) => cb())
    return { ...rec.info }
  }

  listGroups(): SessionGroup[] {
    return [...this.groups.values()].map((g) => ({ ...g }))
  }

  getGroup(id: string): SessionGroup | null {
    const group = this.groups.get(id)
    return group ? { ...group } : null
  }

  /** Bulk-loads groups at startup, before session restore. Trusts its input
   * — persistence already validated the shape when it read sessions.json. */
  restoreGroups(groups: SessionGroup[]): void {
    for (const group of groups) {
      this.groups.set(group.id, { ...group })
    }
  }

  /** Reconnects a restored pane to its saved group, only when the group
   * exists and its environment still matches the pane's. */
  private reconnectGroup(info: SessionInfo, groupId?: string): void {
    if (!groupId) return
    const group = this.groups.get(groupId)
    if (group && group.environment === info.environment) {
      info.groupId = groupId
    }
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

  /** A snapshot of one session's info, or null if the id is unknown. */
  get(id: string): SessionInfo | null {
    const rec = this.sessions.get(id)
    return rec ? { ...rec.info } : null
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
