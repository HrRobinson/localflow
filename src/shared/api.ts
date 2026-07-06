import type { SessionInfo, SessionStatus } from './types'

export interface LocalflowApi {
  createSession(cwd?: string): Promise<SessionInfo | null>
  restartSession(id: string): Promise<SessionInfo>
  killSession(id: string): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onData(cb: (id: string, data: string) => void): () => void
  onStatus(cb: (id: string, status: SessionStatus) => void): () => void
}
