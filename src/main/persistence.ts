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

/** The persisted, round-trippable shape (what `saveState` writes). */
export interface SavedState {
  sessions: SavedSession[]
  groups: SessionGroup[]
}

/**
 * What `loadSavedState` returns: the state plus two out-of-band signals.
 *
 * `error` — set only when `sessions.json` existed but couldn't be read/parsed
 * (a missing file — first run — is normal and leaves this unset). Mirrors
 * theme-store's `resolveTheme` `.error`: a corrupt/unreadable file must never
 * look identical to a fresh install.
 *
 * `safeToPersist` — the no-clobber invariant. It is TRUE only when overwriting
 * `sessions.json` cannot destroy real data:
 *   • ENOENT (genuine first run — nothing to lose), or
 *   • a clean, parsed load, or
 *   • genuine parse-corruption whose backup rename SUCCEEDED (the real bytes
 *     are safely preserved aside).
 * It is FALSE whenever the on-disk file is likely intact but we returned empty
 * in memory — any read error (EACCES/EBUSY/EIO/EMFILE: we could not read it, so
 * we cannot know it's corrupt), or parse-corruption whose backup rename failed.
 * The caller MUST NOT auto-save while this is false, or a transient glitch
 * would overwrite the user's still-valid layout with empty.
 */
export interface LoadedState extends SavedState {
  error?: string
  safeToPersist: boolean
}

/** Result of an attempted `saveState` write. */
export type SaveStateResult = { ok: true } | { ok: false; error: string }

const EMPTY_STATE: LoadedState = { sessions: [], groups: [], safeToPersist: true }

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

/**
 * We read the bytes and they don't parse — genuine corruption. Back the file
 * up aside. Only if that rename SUCCEEDS is the path safe to overwrite (the
 * real content is preserved under the backup name); if the rename fails the
 * original is still on disk and must not be clobbered.
 */
const parseCorruptStateFor = (file: string, err: unknown): LoadedState => {
  const backupName = backupCorruptFile(file)
  const detail = err instanceof Error ? err.message : String(err)
  if (backupName) {
    return {
      sessions: [],
      groups: [],
      error: `Your saved layout couldn't be read and was reset — the file was backed up to ${backupName}. (${detail})`,
      safeToPersist: true
    }
  }
  return {
    sessions: [],
    groups: [],
    error: `Your saved layout couldn't be read and could not be backed up, so it was left untouched and will NOT be overwritten — fix the problem and relaunch. (${detail})`,
    safeToPersist: false
  }
}

/**
 * `readFileSync` itself failed with a non-ENOENT error (EACCES/EBUSY/EIO/…): we
 * could NOT read the file, so we cannot know it's corrupt and the original is
 * likely intact. Do NOT rename it and do NOT treat it as corrupt — return empty
 * in memory but flag it not-safe-to-persist so a later save can't clobber it.
 */
const readErrorStateFor = (err: unknown): LoadedState => {
  const detail = err instanceof Error ? err.message : String(err)
  return {
    sessions: [],
    groups: [],
    error: `Your saved layout couldn't be read — the file was left untouched and will NOT be overwritten, so nothing is lost. Fix the permission/lock and relaunch. (${detail})`,
    safeToPersist: false
  }
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

export function loadSavedState(file: string): LoadedState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    // Three cases, distinguished so a transient glitch never masquerades as
    // corruption (which would rename the user's valid file aside):
    //   1. ENOENT — no sessions.json yet: a normal first run, no notice.
    //   2. Any other read error (EACCES/EBUSY/EIO/EMFILE/…) — we could NOT read
    //      the bytes, so the file is likely intact. Leave it untouched and mark
    //      not-safe-to-persist so the caller won't overwrite it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE
    return readErrorStateFor(err)
  }
  try {
    const data: unknown = JSON.parse(raw)
    // Legacy shape (pre-M5): a bare array of sessions, no groups.
    if (Array.isArray(data)) {
      return { sessions: filterSessions(data), groups: [], safeToPersist: true }
    }
    if (typeof data !== 'object' || data === null) {
      return { sessions: [], groups: [], safeToPersist: true }
    }
    const obj = data as { sessions?: unknown; groups?: unknown }
    return {
      sessions: Array.isArray(obj.sessions) ? filterSessions(obj.sessions) : [],
      groups: Array.isArray(obj.groups) ? obj.groups.filter(isGroup) : [],
      safeToPersist: true
    }
  } catch (err) {
    //   3. We read the bytes but they don't parse — genuine corruption.
    return parseCorruptStateFor(file, err)
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
