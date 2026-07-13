import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGeminiHookSettings,
  removeGeminiHookSettings,
  writeGeminiHookSettings
} from '../../src/main/gemini-hooks'

/**
 * The Notification command is itself wrapped in an outer `sh -c '...'`
 * (so it can inspect stdin before deciding to curl). That means the whole
 * string undergoes a shell parse pass before the inner `curl -d '<json>'`
 * ever runs — a naive `-d '${payload}'` with unescaped single quotes would
 * have its own quotes consumed by the OUTER parse, corrupting the JSON body
 * before curl ever sees it. This runs the real command through `sh -c`
 * (with `curl` swapped for an argv-dumping shell function) to prove the
 * payload survives that outer parse intact.
 */
function runNotificationCommand(command: string, stdinBody: string): string[] {
  const withFakeCurl = command.replace(
    'curl -s -m 3 -X POST',
    // No single quotes here: this substitutes into an already single-quoted
    // outer `sh -c '...'` script, so any `'` in this replacement would hit
    // the exact nested-quoting bug this test exists to catch.
    'f() { for a in "$@"; do printf "%s\\n" "$a"; done; }; f'
  )
  const output = execFileSync('sh', ['-c', withFakeCurl], { input: stdinBody, encoding: 'utf8' })
  return output.split('\n').filter((line) => line.length > 0)
}

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

  it('preserves the JSON payload intact through the outer sh -c parse when gated', () => {
    const settings = buildGeminiHookSettings('p1', 4242, 'tok') as {
      hooks: { Notification: { hooks: { command: string }[] }[] }
    }
    const cmd = settings.hooks.Notification[0].hooks[0].command
    const args = runNotificationCommand(cmd, '{"type":"ToolPermission","foo":1}')
    const dIndex = args.indexOf('-d')
    expect(dIndex).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(args[dIndex + 1])).toEqual({ paneId: 'p1', event: 'Notification' })
  })

  it('does not invoke curl for a non-ToolPermission notification payload', () => {
    const settings = buildGeminiHookSettings('p1', 4242, 'tok') as {
      hooks: { Notification: { hooks: { command: string }[] }[] }
    }
    const cmd = settings.hooks.Notification[0].hooks[0].command
    const args = runNotificationCommand(cmd, '{"type":"Progress"}')
    expect(args).toEqual([])
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

describe('removeGeminiHookSettings', () => {
  it('removes a previously written settings file and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeGeminiHookSettings(dir, 'p3', 1234, 'tok3')
    removeGeminiHookSettings(dir, 'p3')
    expect(existsSync(file)).toBe(false)
    expect(() => removeGeminiHookSettings(dir, 'never-written')).not.toThrow()
    expect(() => removeGeminiHookSettings(dir, '../escape')).not.toThrow()
  })
})
