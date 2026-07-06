import type { AgentId, AgentInfo, SessionInfo, SessionStatus } from './types'

export interface LocalflowApi {
  /**
   * Start a session for an agent. The `cwd` parameter is honored only under
   * LOCALFLOW_E2E=1 (test harness); production always opens the folder
   * picker. `customCommand` is required when agentId is 'custom'.
   */
  createSession(agentId: AgentId, cwd?: string, customCommand?: string): Promise<SessionInfo | null>
  restartSession(id: string): Promise<SessionInfo>
  killSession(id: string): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  listAgents(): Promise<AgentInfo[]>
  /** Opens a file picker to locate the agent binary; returns the updated list. */
  setAgentPath(agentId: AgentId): Promise<AgentInfo[] | null>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onData(cb: (id: string, data: string) => void): () => void
  onStatus(cb: (id: string, status: SessionStatus) => void): () => void
}
