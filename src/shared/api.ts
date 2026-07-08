import type { AgentId, AgentInfo, LastAgent, SessionInfo, SessionStatus } from './types'
import type { KeyAction } from './keybindings'

export interface LocalflowApi {
  /**
   * Start a session for an agent. The `cwd` parameter is honored only under
   * LOCALFLOW_E2E=1 (test harness); production always opens the folder
   * picker. `customCommand` is required when agentId is 'custom'.
   * `environment` defaults to 1.
   */
  createSession(
    agentId: AgentId,
    cwd?: string,
    customCommand?: string,
    environment?: number
  ): Promise<SessionInfo | null>
  /** Relaunch a dead session; `fresh` starts a new conversation instead of resuming. */
  restartSession(id: string, fresh?: boolean): Promise<SessionInfo>
  /** Ends the pty; the session stays listed as exited, reopenable via resume/fresh. */
  closeTerminal(id: string): Promise<void>
  /** Removes the session entirely — separate, explicit, irreversible action. */
  deleteSession(id: string): Promise<void>
  /** Renames a session; empty/whitespace name is a no-op. Returns the updated info, or null if the id is unknown. */
  renameSession(id: string, name: string): Promise<SessionInfo | null>
  /** Moves a session to environment 1-9 (clamped). Null if the id is unknown. */
  setEnvironment(id: string, environment: number): Promise<SessionInfo | null>
  listSessions(): Promise<SessionInfo[]>
  /** Last few cleaned output lines of a session — the approve control's peek. */
  peekSession(id: string, maxLines?: number): Promise<string[]>
  listAgents(): Promise<AgentInfo[]>
  /** Opens a file picker to locate the agent binary; returns the updated list. */
  setAgentPath(agentId: AgentId): Promise<AgentInfo[] | null>
  getLastAgent(): Promise<LastAgent | null>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onData(cb: (id: string, data: string) => void): () => void
  onStatus(cb: (id: string, status: SessionStatus) => void): () => void
  getKeybindings(): Promise<Record<KeyAction, string>>
  /** Optional hand-configured environment names from config.json ("3" -> "backend"). */
  getEnvironmentNames(): Promise<Record<string, string>>
}
