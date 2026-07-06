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
})
