import type { SessionInfo, SessionStatus } from './types'

export interface LocalflowApi {
  /**
   * Starts a new session. The `cwd` argument is only honored when the app is
   * running with `LOCALFLOW_E2E=1` (used by the e2e suite to bypass the OS
   * folder picker). In production `cwd` is ignored and the main process
   * always opens a native folder-picker dialog for the user to choose from.
   */
  createSession(cwd?: string): Promise<SessionInfo | null>
  restartSession(id: string): Promise<SessionInfo>
  killSession(id: string): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onData(cb: (id: string, data: string) => void): () => void
  onStatus(cb: (id: string, status: SessionStatus) => void): () => void
}
