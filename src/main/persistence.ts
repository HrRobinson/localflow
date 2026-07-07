import { readFileSync, writeFileSync } from 'node:fs'

export interface SavedSession {
  id: string
  cwd: string
  /** Agent preset id; older files may lack it (treated as claude). */
  agentId?: string
  /** Spawned command, needed to restore custom sessions verbatim. */
  command?: string
  /** User-editable label; absent on files predating M1.6 (falls back to basename(cwd)). */
  name?: string
}

export function loadSavedSessions(file: string): SavedSession[] {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(data)) return []
    return data
      .filter(
        (s): s is SavedSession =>
          typeof s === 'object' &&
          s !== null &&
          typeof s.id === 'string' &&
          typeof s.cwd === 'string'
      )
      .map((s) => (typeof s.name === 'string' ? s : { ...s, name: undefined }))
  } catch {
    return []
  }
}

export function saveSessions(file: string, sessions: SavedSession[]): void {
  writeFileSync(file, JSON.stringify(sessions, null, 2))
}
