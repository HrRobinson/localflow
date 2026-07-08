export type SessionStatus = 'idle' | 'working' | 'needs-you' | 'running' | 'exited'

export type HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'

export interface HookEvent {
  paneId: string
  event: HookEventName
}

export type AgentId = 'claude' | 'codex' | 'gemini' | 'custom'

export type SessionKind = 'terminal' | 'browser'

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
  message?: string
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
