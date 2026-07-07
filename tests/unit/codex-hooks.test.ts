import { describe, it, expect } from 'vitest'
import { buildCodexHookArgs } from '../../src/main/codex-hooks'

// NOTE: the task brief's original test cases asserted LITERAL payload
// substrings (e.g. `toContain('"event":"Stop"')`). Those assertions were
// the bug in the brief, not the reference implementation: the curl
// command is embedded in the -c value via JSON.stringify, which escapes
// inner double quotes as \" — valid TOML basic-string escaping (TOML and
// JSON escape `"` identically), so the emitted value is parseable under
// both candidate -c grammars. The assertions below therefore check the
// ESCAPED forms the correct output actually contains.

describe('buildCodexHookArgs', () => {
  it("tier 'none' returns no args", () => {
    expect(buildCodexHookArgs('p1', 4242, 'tok', 'none')).toEqual([])
  })

  it("tier 'notify' embeds only the Stop-mapped event", () => {
    const args = buildCodexHookArgs('p1', 4242, 'tok', 'notify')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('-c')
    expect(args[1]).toMatch(/^notify=/)
    const joined = args.join(' ')
    expect(joined).toContain('http://127.0.0.1:4242/event')
    expect(joined).toContain('X-Localflow-Token: tok')
    expect(joined).toContain('\\"paneId\\":\\"p1\\"')
    expect(joined).toContain('\\"event\\":\\"Stop\\"')
    expect(joined).not.toContain('\\"event\\":\\"UserPromptSubmit\\"')
    expect(joined).not.toContain('\\"event\\":\\"Notification\\"')
  })

  it("tier 'full' embeds all three canonical events", () => {
    const args = buildCodexHookArgs('p2', 4242, 'tok', 'full')
    expect(args).toHaveLength(6)
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe('-c')
    }
    const joined = args.join(' ')
    expect(joined).toContain('\\"paneId\\":\\"p2\\"')
    expect(joined).toContain('\\"event\\":\\"UserPromptSubmit\\"')
    expect(joined).toContain('\\"event\\":\\"Notification\\"')
    expect(joined).toContain('\\"event\\":\\"Stop\\"')
    // PermissionRequest is Codex's native name but must never leak
    // through unmapped — every consumer sees only canonical names.
    expect(joined).not.toContain('\\"event\\":\\"PermissionRequest\\"')
  })

  it('throws on an unsafe paneId or token', () => {
    expect(() => buildCodexHookArgs("p'; rm -rf /", 4242, 'tok', 'notify')).toThrow()
    expect(() => buildCodexHookArgs('p1', 4242, "tok'; rm -rf /", 'notify')).toThrow()
  })

  it('throws on an invalid port', () => {
    expect(() => buildCodexHookArgs('p1', 0, 'tok', 'notify')).toThrow()
    expect(() => buildCodexHookArgs('p1', 65536, 'tok', 'full')).toThrow()
  })
})
