import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeSkillEnv, writeSkillEnv } from '../../src/main/openclaw-config'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'localflow-ocfg-'))
  file = join(dir, 'openclaw.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = (): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'))

describe('writeSkillEnv', () => {
  it('writes skills.entries.localflow.env into an existing config, preserving the rest', () => {
    writeFileSync(
      file,
      JSON.stringify({
        model: 'big',
        skills: { entries: { other: { env: { A: '1' } } } }
      })
    )
    const r = writeSkillEnv(file, 'http://127.0.0.1:5000', 'tok')
    expect(r).toEqual({ ok: true, written: true })
    expect(read()).toEqual({
      model: 'big',
      skills: {
        entries: {
          other: { env: { A: '1' } },
          localflow: {
            env: { LOCALFLOW_ENDPOINT: 'http://127.0.0.1:5000', LOCALFLOW_TOKEN: 'tok' }
          }
        }
      }
    })
  })

  it('overwrites a previous grant and keeps sibling localflow keys', () => {
    writeFileSync(
      file,
      JSON.stringify({
        skills: { entries: { localflow: { enabled: true, env: { LOCALFLOW_TOKEN: 'old' } } } }
      })
    )
    expect(writeSkillEnv(file, 'http://127.0.0.1:1', 'new').ok).toBe(true)
    const localflow = (read() as { skills: { entries: { localflow: Record<string, unknown> } } })
      .skills.entries.localflow
    expect(localflow.enabled).toBe(true)
    expect(localflow.env).toEqual({
      LOCALFLOW_ENDPOINT: 'http://127.0.0.1:1',
      LOCALFLOW_TOKEN: 'new'
    })
  })

  it('is a no-op when the config does not exist (never creates it)', () => {
    expect(writeSkillEnv(file, 'http://127.0.0.1:1', 'tok')).toEqual({ ok: true, written: false })
    expect(existsSync(file)).toBe(false)
  })

  it('fails non-fatally on malformed JSON, leaving the file untouched', () => {
    writeFileSync(file, '{ not json')
    const r = writeSkillEnv(file, 'http://127.0.0.1:1', 'tok')
    expect(r.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  it('never replaces a user container that is not an object', () => {
    writeFileSync(file, JSON.stringify({ skills: 'custom' }))
    const r = writeSkillEnv(file, 'http://127.0.0.1:1', 'tok')
    expect(r.ok).toBe(false)
    expect(read()).toEqual({ skills: 'custom' })
  })
})

describe('removeSkillEnv', () => {
  it('removes exactly the env entry, keeping sibling keys and other skills', () => {
    writeFileSync(
      file,
      JSON.stringify({
        model: 'big',
        skills: {
          entries: {
            other: { env: { A: '1' } },
            localflow: { enabled: true, env: { LOCALFLOW_TOKEN: 'tok' } }
          }
        }
      })
    )
    expect(removeSkillEnv(file)).toEqual({ ok: true, written: true })
    expect(read()).toEqual({
      model: 'big',
      skills: {
        entries: {
          other: { env: { A: '1' } },
          localflow: { enabled: true }
        }
      }
    })
  })

  it('is a no-op when the file or the entry is absent', () => {
    expect(removeSkillEnv(file)).toEqual({ ok: true, written: false })
    writeFileSync(file, JSON.stringify({ skills: { entries: {} } }))
    expect(removeSkillEnv(file)).toEqual({ ok: true, written: false })
    expect(read()).toEqual({ skills: { entries: {} } })
  })

  it('fails non-fatally on malformed JSON', () => {
    writeFileSync(file, 'nope')
    expect(removeSkillEnv(file).ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('nope')
  })
})

describe('legacy skill-env cleanup', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openclaw-legacy-'))
    file = join(dir, 'openclaw.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const legacyConfig = {
    skills: {
      entries: {
        localflow: { env: { LOCALFLOW_ENDPOINT: 'http://127.0.0.1:5000', LOCALFLOW_TOKEN: 'old' } },
        other: { env: { KEEP: 'me' } }
      }
    },
    unrelated: true
  }

  it('writeSkillEnv removes the pre-rebrand block while writing the current one', () => {
    writeFileSync(file, JSON.stringify(legacyConfig))
    const result = writeSkillEnv(file, 'http://127.0.0.1:6000', 'new')
    expect(result).toEqual({ ok: true, written: true })
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, never>
    const entries = (parsed as unknown as { skills: { entries: Record<string, unknown> } }).skills
      .entries
    // Pre-Task-10, the current key and LEGACY_SKILL_KEY are both literally
    // 'localflow' (the rename hasn't touched the hardcoded path yet), so the
    // sweep-then-write leaves the key present but holding only the fresh
    // grant — the stale legacy token must not survive as a duplicate/merge.
    expect(entries['localflow']).toEqual({
      env: { LOCALFLOW_ENDPOINT: 'http://127.0.0.1:6000', LOCALFLOW_TOKEN: 'new' }
    })
    expect(entries['other']).toEqual({ env: { KEEP: 'me' } })
  })

  it('removeSkillEnv strips the pre-rebrand block too', () => {
    writeFileSync(file, JSON.stringify(legacyConfig))
    const result = removeSkillEnv(file)
    expect(result).toEqual({ ok: true, written: true })
    const entries = (
      JSON.parse(readFileSync(file, 'utf8')) as { skills: { entries: Record<string, unknown> } }
    ).skills.entries
    expect(entries['localflow']).toBeUndefined()
    expect(entries['other']).toEqual({ env: { KEEP: 'me' } })
  })

  it('keeps sibling keys the user put under the pre-rebrand entry', () => {
    writeFileSync(
      file,
      JSON.stringify({
        skills: { entries: { localflow: { env: { LOCALFLOW_TOKEN: 't' }, notes: 'mine' } } }
      })
    )
    removeSkillEnv(file)
    const entries = (
      JSON.parse(readFileSync(file, 'utf8')) as { skills: { entries: Record<string, unknown> } }
    ).skills.entries
    expect(entries['localflow']).toEqual({ notes: 'mine' })
  })

  it('is a silent no-op when no pre-rebrand block exists', () => {
    writeFileSync(file, JSON.stringify({ skills: { entries: {} } }))
    expect(removeSkillEnv(file)).toEqual({ ok: true, written: false })
  })
})
