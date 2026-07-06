import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHookSettings, writeHookSettings } from '../../src/main/hook-settings'

describe('buildHookSettings', () => {
  it('creates a curl hook for each of the three events', () => {
    const settings = buildHookSettings('p1', 4242, 'tok') as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    for (const name of ['UserPromptSubmit', 'Notification', 'Stop']) {
      const cmd = settings.hooks[name][0].hooks[0].command
      expect(settings.hooks[name][0].hooks[0].type).toBe('command')
      expect(cmd).toContain('http://127.0.0.1:4242/event')
      expect(cmd).toContain('X-Localflow-Token: tok')
      expect(cmd).toContain(`"paneId":"p1"`)
      expect(cmd).toContain(`"event":"${name}"`)
    }
  })
})

describe('writeHookSettings', () => {
  it('writes valid JSON and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeHookSettings(dir, 'p2', 1234, 'tok2')
    expect(file).toBe(join(dir, 'localflow-hooks-p2.json'))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.hooks.Stop).toBeDefined()
  })

  it('writes the file with owner-only permissions (0600)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeHookSettings(dir, 'p3', 1234, 'tok3')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('throws when paneId attempts path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    expect(() => writeHookSettings(dir, '../escape', 1234, 'tok2')).toThrow()
  })
})

describe('input validation', () => {
  it('throws when paneId contains a single quote', () => {
    expect(() => buildHookSettings("p'; rm -rf /tmp/x'", 4242, 'tok')).toThrow()
  })

  it('throws when token contains a single quote', () => {
    expect(() => buildHookSettings('p1', 4242, "tok'; rm -rf /tmp/x'")).toThrow()
  })

  it('throws when port is not a positive integer <= 65535', () => {
    expect(() => buildHookSettings('p1', 0, 'tok')).toThrow()
    expect(() => buildHookSettings('p1', -1, 'tok')).toThrow()
    expect(() => buildHookSettings('p1', 65536, 'tok')).toThrow()
    expect(() => buildHookSettings('p1', 1.5, 'tok')).toThrow()
  })
})
