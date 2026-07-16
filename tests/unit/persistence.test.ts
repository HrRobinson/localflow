import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:os'
import { loadSavedState, saveState, type SavedSession } from '../../src/main/persistence'

const loadSavedSessions = (file: string): SavedSession[] => loadSavedState(file).sessions
const saveSessions = (file: string, sessions: SavedSession[]): void => {
  saveState(file, { sessions, groups: [] })
}

describe('persistence', () => {
  it('round-trips sessions and tolerates a missing file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'localflow-p-')), 'sessions.json')
    expect(loadSavedSessions(file)).toEqual([])
    saveSessions(file, [{ id: 'a', cwd: '/x' }])
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  it('returns [] on corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-p-'))
    const file = join(dir, 'sessions.json')
    saveSessions(file, [])
    writeFileSync(file, 'garbage')
    expect(loadSavedSessions(file)).toEqual([])
  })
  it('backs up a corrupt file and reports a human+technical error instead of looking like a fresh install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-p-'))
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
    const file = join(mkdtempSync(join(tmpdir(), 'localflow-p-')), 'sessions.json')
    saveSessions(file, [{ id: 'a', cwd: '/x', name: 'my project' }])
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x', name: 'my project' }])
  })
  it('tolerates a saved session with no name key at all', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'localflow-p-')), 'sessions.json')
    writeFileSync(file, JSON.stringify([{ id: 'a', cwd: '/x' }]))
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  it('tolerates a non-string name, treating it as absent', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'localflow-p-')), 'sessions.json')
    writeFileSync(file, JSON.stringify([{ id: 'a', cwd: '/x', name: 123 }]))
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  it('round-trips the environment field and tolerates its absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-p-'))
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
    const file = join(mkdtempSync(join(tmpdir(), 'localflow-p-')), 'sessions.json')
    saveSessions(file, [{ id: 'b', cwd: '', kind: 'browser', url: 'https://example.com/' }])
    const loaded = loadSavedSessions(file)
    expect(loaded[0]?.kind).toBe('browser')
    expect(loaded[0]?.url).toBe('https://example.com/')
  })
  it('round-trips groupId through the save-shape mapper used at startup', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'localflow-p-')), 'sessions.json')
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
    expect(loadSavedState(join(dir, 'nope.json'))).toEqual({ sessions: [], groups: [] })
  })

  it('returns empty state with an error for a corrupt file, and backs it up', () => {
    writeFileSync(file, '{{{')
    const state = loadSavedState(file)
    expect(state.sessions).toEqual([])
    expect(state.groups).toEqual([])
    expect(typeof state.error).toBe('string')
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('sessions.json.corrupt-'))).toBe(true)
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
