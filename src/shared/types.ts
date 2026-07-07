export type SessionStatus = 'idle' | 'working' | 'needs-you' | 'running' | 'exited'

export type HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'

export interface HookEvent {
  paneId: string
  event: HookEventName
}

export type AgentId = 'claude' | 'codex' | 'gemini' | 'custom'

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
}
