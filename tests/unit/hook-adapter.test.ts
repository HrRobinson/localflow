import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHookInjection } from '../../src/main/hook-adapter'

describe('buildHookInjection', () => {
  it("'settings-file' writes a Claude settings file and returns --settings args", () => {
    const dir = mkdtempSync(join(tmpdir(), 'saiife-hi-'))
    const { args, env } = buildHookInjection('settings-file', dir, 'p1', 4242, 'tok', null)
    expect(args[0]).toBe('--settings')
    expect(existsSync(args[1])).toBe(true)
    expect(env).toEqual({})
  })

  it("'env-settings-file' writes a Gemini settings file and returns the env var, no args", () => {
    const dir = mkdtempSync(join(tmpdir(), 'saiife-hi-'))
    const { args, env } = buildHookInjection('env-settings-file', dir, 'p1', 4242, 'tok', null)
    expect(args).toEqual([])
    expect(existsSync(env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'])).toBe(true)
  })

  it("'cli-args-full' and 'cli-args-notify' return Codex -c args, no env, no file", () => {
    // The -c value embeds the curl command via JSON.stringify, which escapes
    // inner double quotes as \" (valid TOML/JSON escaping) — see the note in
    // tests/unit/codex-hooks.test.ts for why these assertions target the
    // escaped form rather than a literal, unescaped substring.
    const dir = mkdtempSync(join(tmpdir(), 'saiife-hi-'))
    const full = buildHookInjection('cli-args-full', dir, 'p1', 4242, 'tok', null)
    expect(full.env).toEqual({})
    expect(full.args.join(' ')).toContain('\\"event\\":\\"UserPromptSubmit\\"')
    const notify = buildHookInjection('cli-args-notify', dir, 'p1', 4242, 'tok', null)
    expect(notify.args.join(' ')).toContain('\\"event\\":\\"Stop\\"')
    expect(notify.args.join(' ')).not.toContain('\\"event\\":\\"UserPromptSubmit\\"')
  })

  it("'none' returns no args and no env", () => {
    const dir = mkdtempSync(join(tmpdir(), 'saiife-hi-'))
    expect(buildHookInjection('none', dir, 'p1', 4242, 'tok', null)).toEqual({ args: [], env: {} })
  })
})
