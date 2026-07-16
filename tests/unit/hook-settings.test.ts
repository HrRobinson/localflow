import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildHookSettings,
  removeHookSettings,
  writeHookSettings
} from '../../src/main/hook-settings'
import type { ResolvedGuard } from '../../src/main/guard-hook'

describe('buildHookSettings', () => {
  it('creates a curl hook for each emitted event', () => {
    const settings = buildHookSettings('p1', 4242, 'tok', null) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    for (const name of ['UserPromptSubmit', 'Notification', 'Stop', 'PostToolUse']) {
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
    const file = writeHookSettings(dir, 'p2', 1234, 'tok2', null)
    expect(file).toBe(join(dir, 'localflow-hooks-p2.json'))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.hooks.Stop).toBeDefined()
  })

  it('writes the file with owner-only permissions (0600)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeHookSettings(dir, 'p3', 1234, 'tok3', null)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('throws when paneId attempts path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    expect(() => writeHookSettings(dir, '../escape', 1234, 'tok2', null)).toThrow()
  })
})

describe('removeHookSettings', () => {
  it('removes a previously written settings file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeHookSettings(dir, 'p4', 1234, 'tok4', null)
    removeHookSettings(dir, 'p4')
    expect(existsSync(file)).toBe(false)
  })

  it('never throws: missing file and unsafe paneId are no-ops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    expect(() => removeHookSettings(dir, 'never-written')).not.toThrow()
    // A traversal-shaped id was never writable, so removal must not touch it.
    const outside = writeHookSettings(dir, 'p5', 1234, 'tok5', null)
    expect(() => removeHookSettings(join(dir, 'sub'), '../escape')).not.toThrow()
    expect(existsSync(outside)).toBe(true)
  })
})

describe('input validation', () => {
  it('throws when paneId contains a single quote', () => {
    expect(() => buildHookSettings("p'; rm -rf /tmp/x'", 4242, 'tok', null)).toThrow()
  })

  it('throws when token contains a single quote', () => {
    expect(() => buildHookSettings('p1', 4242, "tok'; rm -rf /tmp/x'", null)).toThrow()
  })

  it('throws when port is not a positive integer <= 65535', () => {
    expect(() => buildHookSettings('p1', 0, 'tok', null)).toThrow()
    expect(() => buildHookSettings('p1', -1, 'tok', null)).toThrow()
    expect(() => buildHookSettings('p1', 65536, 'tok', null)).toThrow()
    expect(() => buildHookSettings('p1', 1.5, 'tok', null)).toThrow()
  })
})

describe('buildHookSettings PreToolUse', () => {
  const guard: ResolvedGuard = {
    bin: '/g/lfguard',
    auditLog: '/g/audit.jsonl',
    packs: ['cloud.gcloud'],
    seenDir: '/g/guard-seen'
  }

  it('omits PreToolUse when no guard', () => {
    const s = buildHookSettings('pane1', 8080, 'tok', null) as { hooks: Record<string, unknown> }
    expect(s.hooks.PreToolUse).toBeUndefined()
    expect(s.hooks.Stop).toBeDefined()
  })

  it('adds a Bash-matched PreToolUse guard hook when guard present', () => {
    const s = buildHookSettings('pane1', 8080, 'tok', guard) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    }
    const entry = s.hooks.PreToolUse[0]
    expect(entry.matcher).toBe('Bash')
    expect(entry.hooks[0].command).toContain("'/g/lfguard' check --hook-exit")
    expect(entry.hooks[0].command).toContain('--pack cloud.gcloud')
    expect(entry.hooks[0].command).toContain('--audit-tag pane1')
  })
})
