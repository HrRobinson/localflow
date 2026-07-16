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
import type { ResolvedGuard } from '../../src/main/guard-hook'

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
    const settings = buildGeminiHookSettings('p1', 4242, 'tok', null) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    const before = settings.hooks.BeforeAgent[0].hooks[0].command
    expect(before).toContain('http://127.0.0.1:4242/event')
    expect(before).toContain('"event":"UserPromptSubmit"')
    const after = settings.hooks.AfterAgent[0].hooks[0].command
    expect(after).toContain('"event":"Stop"')
  })

  it('gates Notification on a ToolPermission stdin payload', () => {
    const settings = buildGeminiHookSettings('p1', 4242, 'tok', null) as {
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
    const settings = buildGeminiHookSettings('p1', 4242, 'tok', null) as {
      hooks: { Notification: { hooks: { command: string }[] }[] }
    }
    const cmd = settings.hooks.Notification[0].hooks[0].command
    const args = runNotificationCommand(cmd, '{"type":"ToolPermission","foo":1}')
    const dIndex = args.indexOf('-d')
    expect(dIndex).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(args[dIndex + 1])).toEqual({ paneId: 'p1', event: 'Notification' })
  })

  it('does not invoke curl for a non-ToolPermission notification payload', () => {
    const settings = buildGeminiHookSettings('p1', 4242, 'tok', null) as {
      hooks: { Notification: { hooks: { command: string }[] }[] }
    }
    const cmd = settings.hooks.Notification[0].hooks[0].command
    const args = runNotificationCommand(cmd, '{"type":"Progress"}')
    expect(args).toEqual([])
  })

  it('emits a PostToolUse event via an AfterTool hook (Claude parity)', () => {
    const settings = buildGeminiHookSettings('p1', 4242, 'tok', null) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const cmd = settings.hooks.AfterTool[0].hooks[0].command
    expect(cmd).toContain('"event":"PostToolUse"')
    expect(cmd).toContain('http://127.0.0.1:4242/event')
  })

  it('throws on an unsafe paneId or token', () => {
    expect(() => buildGeminiHookSettings("p'; rm -rf /", 4242, 'tok', null)).toThrow()
    expect(() => buildGeminiHookSettings('p1', 4242, "tok'; rm -rf /", null)).toThrow()
  })

  it('throws on an invalid port', () => {
    expect(() => buildGeminiHookSettings('p1', 0, 'tok', null)).toThrow()
  })
})

describe('buildGeminiHookSettings BeforeTool', () => {
  const guard: ResolvedGuard = {
    bin: '/g/lfguard',
    auditLog: '/g/audit.jsonl',
    packs: [],
    seenDir: '/g/guard-seen'
  }

  it('adds a BeforeTool guard hook matched to run_shell_command', () => {
    const s = buildGeminiHookSettings('pane1', 8080, 'tok', guard) as {
      hooks: { BeforeTool?: Array<{ matcher: string; hooks: Array<{ command: string }> }> }
    }
    const entry = s.hooks.BeforeTool![0]
    expect(entry.matcher).toBe('run_shell_command')
    expect(entry.hooks[0].command).toContain('check --hook-exit')
  })

  it('omits BeforeTool when no guard', () => {
    const s = buildGeminiHookSettings('pane1', 8080, 'tok', null) as {
      hooks: Record<string, unknown>
    }
    expect(s.hooks.BeforeTool).toBeUndefined()
  })

  it('produces byte-identical output to the no-guard shape when guard is null', () => {
    const withNull = buildGeminiHookSettings('pane1', 8080, 'tok', null)
    expect(JSON.stringify(withNull)).not.toContain('BeforeTool')
    // AfterTool (PostToolUse parity, Task 6) is unconditional — present with
    // or without a guard, unlike guard-gated BeforeTool.
    expect(Object.keys((withNull as { hooks: object }).hooks)).toEqual([
      'BeforeAgent',
      'Notification',
      'AfterAgent',
      'AfterTool'
    ])
  })
})

describe('writeGeminiHookSettings', () => {
  it('writes valid JSON with 0600 permissions and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeGeminiHookSettings(dir, 'p2', 1234, 'tok2', null)
    expect(file).toBe(join(dir, 'localflow-gemini-hooks-p2.json'))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.hooks.AfterAgent).toBeDefined()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('throws when paneId attempts path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    expect(() => writeGeminiHookSettings(dir, '../escape', 1234, 'tok2', null)).toThrow()
  })
})

describe('removeGeminiHookSettings', () => {
  it('removes a previously written settings file and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeGeminiHookSettings(dir, 'p3', 1234, 'tok3', null)
    removeGeminiHookSettings(dir, 'p3')
    expect(existsSync(file)).toBe(false)
    expect(() => removeGeminiHookSettings(dir, 'never-written')).not.toThrow()
    expect(() => removeGeminiHookSettings(dir, '../escape')).not.toThrow()
  })
})
