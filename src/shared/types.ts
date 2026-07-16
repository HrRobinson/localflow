export type SessionStatus = 'idle' | 'working' | 'needs-you' | 'running' | 'exited'

export type HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'

export interface HookEvent {
  paneId: string
  event: HookEventName
}

export type AgentId = 'claude' | 'codex' | 'gemini' | 'openclaw' | 'shell' | 'custom'

/** Every `AgentId`, for validating untrusted input (IPC bodies, control-API
 *  request bodies) at the boundary before it's cast to the narrower type. */
export const VALID_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'openclaw', 'shell', 'custom']

export type SessionKind = 'terminal' | 'browser'

/**
 * The vocabulary of the activity feed (M7): the three hook events localflow
 * applies, plus the lifecycle moments it already knows. Lives only in main's
 * memory — the ring is never persisted, so the feed says "since localflow
 * started".
 */
export type ActivityEventKind =
  HookEventName | 'created' | 'reopened' | 'closed' | 'exited' | 'moved'

/**
 * Lifecycle activity kinds always append to the ring — two consecutive
 * `moved` events with unchanged status are two real history rows — while
 * repeated hook events collapse into the previous entry (count bumped).
 * Shared so main's ring writer (recordActivity) and the renderer's push
 * handler (upsertActivity) agree on which pushes are in-place updates
 * versus fresh rows.
 */
export const LIFECYCLE_KINDS: ReadonlySet<ActivityEventKind> = new Set([
  'created',
  'reopened',
  'closed',
  'exited',
  'moved'
])

/** One entry in a session's in-memory activity ring (last 200 kept, M7). */
export interface ActivityEntry {
  /**
   * Epoch ms; SessionManager's clock (overridable in tests). Refreshed to the
   * latest occurrence when a repeated hook event collapses into this entry.
   */
  timestamp: number
  /** An applied hook event or a lifecycle moment. */
  kind: ActivityEventKind
  /** The session's status immediately after this event. */
  status: SessionStatus
  /**
   * How many consecutive identical hook events collapsed into this entry
   * (absent = 1). A chatty agent re-emitting Notification while already
   * needs-you is one logical "still waiting" signal — the count keeps history
   * honest ("asked N times") without letting duplicates eat the 200-cap ring.
   */
  count?: number
}

export interface LastAgent {
  agentId: AgentId
  /** Only present when agentId === 'custom'. */
  customCommand?: string
}

/** Per-agent spawn overrides (config.json `agents` key; M4). */
export interface AgentOverride {
  /** Extra CLI args appended after resume args, shell-split at spawn. */
  extraArgs?: string
  /** Env var overrides applied at spawn (base-URL etc. for local LLMs). */
  env?: Record<string, string>
}

/**
 * Request to spin up a companion pane next to an existing one (M5 Task 8).
 * Shared (not main-only) because both the IPC boundary (api.ts/preload) and
 * the renderer's picker need the shape.
 */
export type AddPaneRequest =
  { kind: 'terminal'; agentId: AgentId; customCommand?: string } | { kind: 'browser'; url: string }

/** UI: "session". A parent node owning ≥1 panes in one environment (M5). */
export interface SessionGroup {
  id: string
  name: string
  environment: number
}

export interface SessionInfo {
  id: string
  cwd: string
  name: string
  status: SessionStatus
  agentId: AgentId
  command: string
  /** Environment 1-9 this session lives on (one per customer/project, M3.5 rename). */
  environment: number
  /** What this pane hosts. Absent in pre-M3.5 saved files ⇒ 'terminal'. */
  kind: SessionKind
  /** Browser panes only: the current URL, persisted as the user browses. */
  url?: string
  /**
   * When this session entered 'needs-you' (epoch ms), else absent. Set/cleared
   * in SessionManager.setStatus using its clock; in-memory only (never
   * persisted — a restored session is 'exited', so it has none). Drives the
   * Overview's "oldest unattended" and the Activity header's "waiting Nm" (M7).
   */
  needsYouSince?: number
  message?: string
  /**
   * True when the most recent spawn was a resume attempt (restart with
   * fresh=false) and its pty instant-exited — the resumed conversation is
   * likely gone. In-memory only (never persisted, like needsYouSince):
   * cleared the moment any later restart actually spawns.
   */
  resumeFailed?: boolean
  /**
   * Codex cli-args-* panes only: whether lfguard's guard hook has been observed
   * firing for this pane since the current pty was spawned.
   * - 'unverified': guard configured on this launch's CLI, but no invocation
   *   observed yet (the pane may simply not have run a command — silence is not
   *   proof of breakage).
   * - 'observed': the guard hook ran at least once this session — direct proof
   *   Codex accepted and honored the injected -c hooks.PreToolUse override.
   * - undefined: not applicable (non-Codex pane, or a Codex pane with no guard
   *   binary resolved / relaunched unguarded). The renderer shows NOTHING.
   * In-memory only, never persisted; re-initialized on every spawn.
   */
  guardVerification?: 'unverified' | 'observed'
  /** Group ("session") this pane belongs to; absent = solo pane. */
  groupId?: string
}

/** What the renderer needs to render an agent card. */
export interface AgentInfo {
  id: AgentId
  label: string
  /** Command that will be spawned (preset binary or user-configured path). */
  command: string
  /** Absolute path if the command was found on this machine, null otherwise. */
  resolvedPath: string | null
  /** True when sessions of this agent report status via hooks (exact colors). */
  hasStatusFeed: boolean
  /**
   * How much of the {working, needs-you, done} status feed this agent's
   * wired-up hook adapter actually reports, so the UI never claims more
   * fidelity than the adapter delivers:
   * - 'full': all three states are distinguished (settings-file /
   *   env-settings-file adapters — Claude Code, Gemini CLI).
   * - 'done-only': only a turn-complete signal is reported (Codex's
   *   cli-args-notify tier) — idle is accurate as of the last
   *   turn-complete, but working/needs-you are never distinguished.
   * - 'none': no hook adapter is wired up at all.
   */
  statusFidelity: 'full' | 'done-only' | 'none'
  /** True when this agent is the configured default for the launcher. */
  isDefault: boolean
  /** Raw per-agent extra-args string (config.json `agents`). */
  extraArgs: string
  /** Per-agent env overrides applied at spawn. */
  env: Record<string, string>
}

/**
 * Result of a per-agent override write (mirrors BindingChangeResult): an
 * env override naming a key that localflow's hook injection owns is
 * rejected with the offending names, because user env overrides win the
 * spawn env merge and such a clobber would silently kill that agent's
 * status feed.
 */
export type AgentOverrideResult =
  { ok: true; agents: AgentInfo[] } | { ok: false; reserved: string[] }

/**
 * Result of a `guard:setPacks` write (mirrors `AgentOverrideResult`/
 * `BindingChangeResult`): this is a security-relevant setting (which lfguard
 * packs are enforced), so a disk-write failure must be surfaced rather than
 * silently discarded — a checkbox that looks "on" while nothing was actually
 * persisted would leave the user believing protection is active when it
 * isn't.
 */
export type GuardPacksResult = { ok: true; packs: string[] } | { ok: false; reason: string }
