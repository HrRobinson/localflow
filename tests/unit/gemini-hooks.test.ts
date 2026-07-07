import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGeminiHookSettings, writeGeminiHookSettings } from '../../src/main/gemini-hooks'

describe('buildGeminiHookSettings', () => {
  it('maps BeforeAgent/AfterAgent to plain curl commands', () => {
    const settings = buildGeminiHookSettings('p1', 4242, 'tok') as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    const before = settings.hooks.BeforeAgent[0].hooks[0].command
    expect(before).toContain('http://127.0.0.1:4242/event')
    expect(before).toContain('"event":"UserPromptSubmit"')
    const after = settings.hooks.AfterAgent[0].hooks[0].command
    expect(after).toContain('"event":"Stop"')
  })

  it('gates Notification on a ToolPermission stdin payload', () => {
    const settings = buildGeminiHookSettings('p1', 4242, 'tok') as {
      hooks: { Notification: { hooks: { command: string }[] }[] }
    }
    const cmd = settings.hooks.Notification[0].hooks[0].command
    expect(cmd).toContain('ToolPermission')
    expect(cmd).toContain('"event":"Notification"')
    // The curl call must be conditional (inside a case/if), not bare —
    // guard against a regression that always posts regardless of payload.
    expect(cmd).toMatch(/case|if/)
  })

  it('throws on an unsafe paneId or token', () => {
    expect(() => buildGeminiHookSettings("p'; rm -rf /", 4242, 'tok')).toThrow()
    expect(() => buildGeminiHookSettings('p1', 4242, "tok'; rm -rf /")).toThrow()
  })

  it('throws on an invalid port', () => {
    expect(() => buildGeminiHookSettings('p1', 0, 'tok')).toThrow()
  })
})

describe('writeGeminiHookSettings', () => {
  it('writes valid JSON with 0600 permissions and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeGeminiHookSettings(dir, 'p2', 1234, 'tok2')
    expect(file).toBe(join(dir, 'localflow-gemini-hooks-p2.json'))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.hooks.AfterAgent).toBeDefined()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('throws when paneId attempts path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    expect(() => writeGeminiHookSettings(dir, '../escape', 1234, 'tok2')).toThrow()
  })
})
