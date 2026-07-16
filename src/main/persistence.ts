import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { basename } from 'node:path'
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
  /**
   * Set only when `sessions.json` existed but couldn't be read/parsed (a
   * missing file — first run — is normal and leaves this unset). The
   * unreadable file is renamed aside (never overwritten) so recovery is
   * possible; mirrors theme-store's `resolveTheme` `.error` pattern — never
   * let a corrupt file look identical to a fresh install.
   */
  error?: string
}

/** Result of an attempted `saveState` write. */
export type SaveStateResult = { ok: true } | { ok: false; error: string }

const EMPTY_STATE: SavedState = { sessions: [], groups: [] }

/**
 * Renames the unreadable file aside so it isn't silently overwritten by the
 * next save, and returns the backup's basename for the error message. `null`
 * if the rename itself failed (e.g. the same permissions problem that broke
 * the read) — the caller still reports the original failure either way.
 */
const backupCorruptFile = (file: string): string | null => {
  const backupPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    renameSync(file, backupPath)
    return basename(backupPath)
  } catch {
    return null
  }
}

const corruptStateFor = (file: string, err: unknown): SavedState => {
  const backupName = backupCorruptFile(file)
  const detail = err instanceof Error ? err.message : String(err)
  const error = backupName
    ? `Your saved layout couldn't be read and was reset — the file was backed up to ${backupName}. (${detail})`
    : `Your saved layout couldn't be read and was reset — it could not be backed up either. (${detail})`
  return { sessions: [], groups: [], error }
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
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    // ENOENT (no sessions.json yet) is a normal first run — not a failure,
    // no notice. Anything else (EACCES, a directory where the file should
    // be, etc.) is a real problem the user needs to know about.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE
    return corruptStateFor(file, err)
  }
  try {
    const data: unknown = JSON.parse(raw)
    // Legacy shape (pre-M5): a bare array of sessions, no groups.
    if (Array.isArray(data)) return { sessions: filterSessions(data), groups: [] }
    if (typeof data !== 'object' || data === null) return { sessions: [], groups: [] }
    const obj = data as { sessions?: unknown; groups?: unknown }
    return {
      sessions: Array.isArray(obj.sessions) ? filterSessions(obj.sessions) : [],
      groups: Array.isArray(obj.groups) ? obj.groups.filter(isGroup) : []
    }
  } catch (err) {
    return corruptStateFor(file, err)
  }
}

export function saveState(file: string, state: SavedState): SaveStateResult {
  // Atomic: a crash mid-write must never leave a truncated sessions.json.
  const tmp = file + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const detail = e.code ? `${e.code}: ${e.message}` : e.message
    return {
      ok: false,
      error: `Couldn't save your session layout — disk write to ${file} failed, so recent pane changes won't survive a restart. (${detail})`
    }
  }
}
