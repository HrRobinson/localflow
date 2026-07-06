import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
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
})
