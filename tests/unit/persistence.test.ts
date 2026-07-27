import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:os'
import { loadSavedState, saveState, type SavedSession } from '../../src/main/persistence'
import { PersistenceNoticeRouter } from '../../src/main/persistence-notice'

const loadSavedSessions = (file: string): SavedSession[] => loadSavedState(file).sessions
const saveSessions = (file: string, sessions: SavedSession[]): void => {
  saveState(file, { sessions, groups: [] })
}

describe('persistence', () => {
  it('round-trips sessions and tolerates a missing file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    expect(loadSavedSessions(file)).toEqual([])
    saveSessions(file, [{ id: 'a', cwd: '/x' }])
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  it('returns [] on corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saiife-p-'))
    const file = join(dir, 'sessions.json')
    saveSessions(file, [])
    writeFileSync(file, 'garbage')
    expect(loadSavedSessions(file)).toEqual([])
  })
  it('backs up a corrupt file and reports a human+technical error instead of looking like a fresh install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saiife-p-'))
    const file = join(dir, 'sessions.json')
    saveSessions(file, [{ id: 'a', cwd: '/x' }])
    writeFileSync(file, 'garbage')
    const state = loadSavedState(file)
    expect(state.sessions).toEqual([])
    expect(state.groups).toEqual([])
    expect(state.error).toMatch(/couldn't be read and was reset/i)
    expect(state.error).toMatch(/backed up to sessions\.json\.corrupt-/)
    // The original corrupt content is preserved under the backup name, not
    // silently discarded or overwritten by a later save.
    expect(existsSync(file)).toBe(false)
    const backups = readdirSync(dir).filter((f) => f.startsWith('sessions.json.corrupt-'))
    expect(backups).toHaveLength(1)
  })
  it('round-trips an optional name', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    saveSessions(file, [{ id: 'a', cwd: '/x', name: 'my project' }])
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x', name: 'my project' }])
  })
  it('tolerates a saved session with no name key at all', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    writeFileSync(file, JSON.stringify([{ id: 'a', cwd: '/x' }]))
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  it('tolerates a non-string name, treating it as absent', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    writeFileSync(file, JSON.stringify([{ id: 'a', cwd: '/x', name: 123 }]))
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  it('round-trips the environment field and tolerates its absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saiife-p-'))
    const file = join(dir, 'sessions.json')
    saveSessions(file, [
      { id: 'a', cwd: '/x', environment: 3 },
      { id: 'b', cwd: '/y' }
    ])
    const loaded = loadSavedSessions(file)
    expect(loaded.find((s) => s.id === 'a')?.environment).toBe(3)
    expect(loaded.find((s) => s.id === 'b')?.environment).toBeUndefined()
  })
  it('round-trips kind and url for browser panes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    saveSessions(file, [{ id: 'b', cwd: '', kind: 'browser', url: 'https://example.com/' }])
    const loaded = loadSavedSessions(file)
    expect(loaded[0]?.kind).toBe('browser')
    expect(loaded[0]?.url).toBe('https://example.com/')
  })
  it('round-trips groupId through the save-shape mapper used at startup', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    saveState(file, {
      sessions: [
        { id: 'a', cwd: '/x', groupId: 'g1' },
        { id: 'b', cwd: '/y' }
      ],
      groups: [{ id: 'g1', name: 'checkout', environment: 2 }]
    })
    const state = loadSavedState(file)
    expect(state.sessions.find((s) => s.id === 'a')?.groupId).toBe('g1')
    expect(state.sessions.find((s) => s.id === 'b')?.groupId).toBeUndefined()
    expect(state.groups).toEqual([{ id: 'g1', name: 'checkout', environment: 2 }])
  })
})

describe('persistence v2', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lf-persist-'))
    file = join(dir, 'sessions.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('loads a legacy bare-array file as all-solo state', () => {
    writeFileSync(file, JSON.stringify([{ id: 'a', cwd: '/x' }]))
    const state = loadSavedState(file)
    expect(state.sessions).toEqual([{ id: 'a', cwd: '/x' }])
    expect(state.groups).toEqual([])
  })

  it('round-trips the v2 object shape atomically', () => {
    saveState(file, {
      sessions: [{ id: 'a', cwd: '/x', groupId: 'g1' }],
      groups: [{ id: 'g1', name: 'checkout', environment: 2 }]
    })
    expect(existsSync(file + '.tmp')).toBe(false)
    const state = loadSavedState(file)
    expect(state.sessions[0].groupId).toBe('g1')
    expect(state.groups).toEqual([{ id: 'g1', name: 'checkout', environment: 2 }])
  })

  it('drops malformed group entries, keeps valid ones', () => {
    writeFileSync(
      file,
      JSON.stringify({
        sessions: [],
        groups: [{ id: 'g1', name: 'ok', environment: 1 }, { id: 7 }, 'junk', null]
      })
    )
    expect(loadSavedState(file).groups).toEqual([{ id: 'g1', name: 'ok', environment: 1 }])
  })

  it('returns empty state with no error for a genuinely missing file (first run)', () => {
    const state = loadSavedState(join(dir, 'nope.json'))
    expect(state).toEqual({ sessions: [], groups: [], safeToPersist: true })
    expect(state.error).toBeUndefined()
  })

  it('backs up genuine parse-corruption and stays safe-to-persist when the backup succeeds', () => {
    writeFileSync(file, '{{{')
    const state = loadSavedState(file)
    expect(state.sessions).toEqual([])
    expect(state.groups).toEqual([])
    expect(typeof state.error).toBe('string')
    expect(state.error).toMatch(/backed up to sessions\.json\.corrupt-/)
    // Real bytes preserved aside → the path is now free to be overwritten.
    expect(state.safeToPersist).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('sessions.json.corrupt-'))).toBe(true)
  })

  it('does not rename or corrupt-flag a file it could not read (transient read error)', () => {
    if (platform() === 'win32') return // chmod-based unreadable files aren't reliable on Windows CI
    // A VALID file we simply can't read this moment (cloud-sync lock, AV, a
    // momentary permission window). It must NOT be misread as corruption.
    saveState(file, { sessions: [{ id: 'a', cwd: '/x' }], groups: [] })
    chmodSync(file, 0o000)
    try {
      const state = loadSavedState(file)
      expect(state.sessions).toEqual([])
      expect(state.groups).toEqual([])
      expect(typeof state.error).toBe('string')
      // The intact original is left exactly where it was — never renamed aside.
      expect(existsSync(file)).toBe(true)
      expect(readdirSync(dir).some((f) => f.startsWith('sessions.json.corrupt-'))).toBe(false)
      // And the caller is told not to overwrite it.
      expect(state.safeToPersist).toBe(false)
    } finally {
      chmodSync(file, 0o600)
    }
  })

  it('leaves a corrupt file intact and not-safe-to-persist when the backup rename fails', () => {
    if (platform() === 'win32') return // chmod-based read-only dirs aren't reliable on Windows CI
    // Content we CAN read but can't parse, in a directory we can't write to:
    // the rename-aside fails, so the original bytes must be left untouched
    // rather than clobbered by a later save.
    writeFileSync(file, 'garbage-not-json')
    chmodSync(dir, 0o500) // read + execute — reads still work, renames/writes fail
    try {
      const state = loadSavedState(file)
      expect(state.sessions).toEqual([])
      expect(state.groups).toEqual([])
      expect(typeof state.error).toBe('string')
      expect(state.error).toMatch(/will NOT be overwritten/i)
      expect(state.safeToPersist).toBe(false)
      expect(existsSync(file)).toBe(true)
      expect(readdirSync(dir).some((f) => f.startsWith('sessions.json.corrupt-'))).toBe(false)
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('saveState reports a write failure instead of throwing or swallowing it', () => {
    if (platform() === 'win32') return // chmod-based read-only dirs aren't reliable on Windows CI
    const roDir = mkdtempSync(join(tmpdir(), 'lf-persist-ro-'))
    const roFile = join(roDir, 'sessions.json')
    chmodSync(roDir, 0o500) // read + execute only — writes to new files inside must fail
    try {
      const result = saveState(roFile, { sessions: [], groups: [] })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/couldn't save your session layout/i)
        expect(result.error).toContain(roFile)
      }
    } finally {
      chmodSync(roDir, 0o700)
      rmSync(roDir, { recursive: true, force: true })
    }
  })

  it('saveState succeeds normally (ok:true, no error)', () => {
    expect(saveState(file, { sessions: [], groups: [] })).toEqual({ ok: true })
  })
})

describe('PersistenceNoticeRouter', () => {
  it('buffers a pre-window failure and flushes it once the window is ready', () => {
    let windowReady = false
    const sent: string[] = []
    const router = new PersistenceNoticeRouter((m) => {
      if (!windowReady) return false
      sent.push(m)
      return true
    })
    // Save fails during the pre-window startup restore — nothing delivered yet.
    router.report('disk full')
    expect(sent).toEqual([])
    // Window comes up → the buffered notice is delivered.
    windowReady = true
    router.flush()
    expect(sent).toEqual(['disk full'])
  })

  it('does not let the de-dupe permanently mute a never-shown recurring error', () => {
    let windowReady = false
    const sent: string[] = []
    const router = new PersistenceNoticeRouter((m) => {
      if (!windowReady) return false
      sent.push(m)
      return true
    })
    router.report('disk full') // buffered (no window)
    router.report('disk full') // identical + still no window — must not be dropped for good
    expect(sent).toEqual([])
    windowReady = true
    router.flush()
    expect(sent).toEqual(['disk full']) // the user finally sees it exactly once
  })

  it('de-dupes an already-delivered identical error but re-announces a new one', () => {
    const sent: string[] = []
    const router = new PersistenceNoticeRouter((m) => {
      sent.push(m)
      return true
    })
    router.report('err A')
    router.report('err A') // same, already shown → suppressed
    router.report('err B') // different cause → shown
    expect(sent).toEqual(['err A', 'err B'])
  })

  it('a successful save clears state so a pre-window failure that recovered is not shown', () => {
    let windowReady = false
    const sent: string[] = []
    const router = new PersistenceNoticeRouter((m) => {
      if (!windowReady) return false
      sent.push(m)
      return true
    })
    router.report('disk full') // buffered
    router.report(null) // a later save succeeded before the window opened
    windowReady = true
    router.flush()
    expect(sent).toEqual([]) // nothing stale flashed
  })
})
