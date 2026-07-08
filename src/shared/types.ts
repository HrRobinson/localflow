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
}
