import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSavedSessions, saveSessions } from '../../src/main/persistence'

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
})
