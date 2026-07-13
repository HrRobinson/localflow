import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { SessionGroup } from '../shared/types'

export interface SavedSession {
  id: string
  cwd: string
  /** Agent preset id; older files may lack it (treated as claude). */
  agentId?: string
  /** Spawned command, needed to restore custom sessions verbatim. */
  command?: string
  /** User-editable label; absent on files predating M1.6 (falls back to basename(cwd)). */
  name?: string
  /** Environment 1-9; absent on files predating M3 (falls back to 1). */
  environment?: number
  /** 'browser' for browser panes; absent ⇒ 'terminal'. */
  kind?: string
  /** Browser panes only. */
  url?: string
  /** Group ("session") this pane belongs to; absent = solo pane. */
  groupId?: string
}

export interface SavedState {
  sessions: SavedSession[]
  groups: SessionGroup[]
}

const filterSessions = (data: unknown): SavedSession[] => {
  if (!Array.isArray(data)) return []
  return data
    .filter(
      (s): s is SavedSession =>
        typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.cwd === 'string'
    )
    .map((s) => (typeof s.name === 'string' ? s : { ...s, name: undefined }))
}

const isGroup = (g: unknown): g is SessionGroup =>
  typeof g === 'object' &&
  g !== null &&
  typeof (g as SessionGroup).id === 'string' &&
  typeof (g as SessionGroup).name === 'string' &&
  typeof (g as SessionGroup).environment === 'number'

export function loadSavedState(file: string): SavedState {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    // Legacy shape (pre-M5): a bare array of sessions, no groups.
    if (Array.isArray(data)) return { sessions: filterSessions(data), groups: [] }
    if (typeof data !== 'object' || data === null) return { sessions: [], groups: [] }
    const obj = data as { sessions?: unknown; groups?: unknown }
    return {
      sessions: Array.isArray(obj.sessions) ? filterSessions(obj.sessions) : [],
      groups: Array.isArray(obj.groups) ? obj.groups.filter(isGroup) : []
    }
  } catch {
    return { sessions: [], groups: [] }
  }
}

export function saveState(file: string, state: SavedState): void {
  // Atomic: a crash mid-write must never leave a truncated sessions.json.
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file)
}
