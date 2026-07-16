import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { buildCodexHookArgs } from '../../src/main/codex-hooks'
import type { ResolvedGuard } from '../../src/main/guard-hook'

// NOTE: the task brief's original test cases asserted LITERAL payload
// substrings (e.g. `toContain('"event":"Stop"')`). Those assertions were
// the bug in the brief, not the reference implementation: the curl
// command is embedded in the -c value via JSON.stringify, which escapes
// inner double quotes as \" — valid TOML basic-string escaping (TOML and
// JSON escape `"` identically), so the emitted value is parseable under
// both candidate -c grammars. The assertions below therefore check the
// ESCAPED forms the correct output actually contains.

/**
 * Extracts the inner `sh -c` script from a `notify=["sh","-c","<script>"]`
 * -c value (reversing the single JSON.stringify escaping pass), then runs
 * it through a REAL `sh -c` invocation with `curl` swapped for an
 * argv-dumping shell function — proving both (a) the case-guard's
 * positional-arg matching actually works under a real shell, not just
 * that the generated string contains the right substrings, and (b) the
 * $0-vs-$1 semantics this test exists to pin down: for `sh -c 'script'
 * extraArg`, POSIX assigns the lone appended arg to $0, not $1 (verified
 * directly below with a plain `sh -c 'echo "0=$0 1=$1"' arg-test` probe).
 */
function extractScript(notifyArg: string): string {
  const match = notifyArg.match(/^notify=\["sh","-c",(".*")\]$/)
  if (!match) throw new Error('unexpected notify arg shape')
  return JSON.parse(match[1]) as string
}

function runNotifyScript(script: string, extraArgs: string[]): string[] {
  const withFakeCurl = script.replace(
    'curl -s -m 3 -X POST',
    'f() { for a in "$@"; do printf "%s\\n" "$a"; done; }; f'
  )
  const output = execFileSync('sh', ['-c', withFakeCurl, ...extraArgs], { encoding: 'utf8' })
  return output.split('\n').filter((line) => line.length > 0)
}

describe('buildCodexHookArgs', () => {
  it("tier 'none' returns no args", () => {
    expect(buildCodexHookArgs('p1', 4242, 'tok', 'none', null)).toEqual([])
  })

  it("tier 'notify' embeds only the Stop-mapped event", () => {
    const args = buildCodexHookArgs('p1', 4242, 'tok', 'notify', null)
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
    const args = buildCodexHookArgs('p2', 4242, 'tok', 'full', null)
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
    expect(() => buildCodexHookArgs("p'; rm -rf /", 4242, 'tok', 'notify', null)).toThrow()
    expect(() => buildCodexHookArgs('p1', 4242, "tok'; rm -rf /", 'notify', null)).toThrow()
  })

  it('throws on an invalid port', () => {
    expect(() => buildCodexHookArgs('p1', 0, 'tok', 'notify', null)).toThrow()
    expect(() => buildCodexHookArgs('p1', 65536, 'tok', 'full', null)).toThrow()
  })

  it("tier 'notify' gates the curl behind a case guard, not a bare call", () => {
    const args = buildCodexHookArgs('p1', 4242, 'tok', 'notify', null)
    const script = extractScript(args[1])
    expect(script).toMatch(/^case "\$0\$1" in/)
    expect(script).toContain('*agent-turn-complete*')
    expect(script).toMatch(/esac$/)
  })

  const guard: ResolvedGuard = {
    bin: '/g/lfguard',
    auditLog: '/g/audit.jsonl',
    packs: [],
    seenDir: '/g/guard-seen'
  }

  it('appends PreToolUse hook + trust bypass when guard present', () => {
    const args = buildCodexHookArgs('pane1', 8080, 'tok', 'notify', guard)
    expect(args).toContain('--dangerously-bypass-hook-trust')
    const joined = args.join(' ')
    expect(joined).toContain('hooks.PreToolUse=')
    expect(joined).toContain('^Bash$')
    expect(joined).toContain('check --hook-exit')
  })

  it('omits guard args when no guard', () => {
    const args = buildCodexHookArgs('pane1', 8080, 'tok', 'notify', null)
    expect(args).not.toContain('--dangerously-bypass-hook-trust')
  })
})

/**
 * Pins down, via real `sh` invocations (not assertions about training
 * data), the exact positional-arg semantics of `sh -c 'script' extraArg`
 * — the fact the whole gating design in codex-hooks.ts depends on: a
 * single argument appended after the script goes to $0, not $1.
 */
describe('sh -c positional-arg semantics (real shell, not assumed)', () => {
  it('a single extra arg after the script becomes $0, and $1 is empty', () => {
    const out = execFileSync('sh', ['-c', 'echo "0=$0 1=$1"', 'arg-test'], {
      encoding: 'utf8'
    }).trim()
    expect(out).toBe('0=arg-test 1=')
  })

  it('two extra args: the first becomes $0, the second becomes $1', () => {
    const out = execFileSync('sh', ['-c', 'echo "0=$0 1=$1"', 'scriptname', 'arg-test'], {
      encoding: 'utf8'
    }).trim()
    expect(out).toBe('0=scriptname 1=arg-test')
  })
})

describe("codex notify tier's case guard against realistic invocation shapes", () => {
  const args = buildCodexHookArgs('p1', 4242, 'tok', 'notify', null)
  const script = extractScript(args[1])

  it('fires when Codex appends the notification JSON as the single extra arg ($0)', () => {
    const out = runNotifyScript(script, ['{"type":"agent-turn-complete","turn_id":"t1"}'])
    const dIndex = out.indexOf('-d')
    expect(dIndex).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(out[dIndex + 1])).toEqual({ paneId: 'p1', event: 'Stop' })
  })

  it('also fires if a future invocation shape lands the payload in $1 instead', () => {
    const out = runNotifyScript(script, ['notify', '{"type":"agent-turn-complete"}'])
    const dIndex = out.indexOf('-d')
    expect(dIndex).toBeGreaterThanOrEqual(0)
  })

  it('does not fire for a non-turn-complete notification payload', () => {
    const out = runNotifyScript(script, ['{"type":"agent-turn-error"}'])
    expect(out).toEqual([])
  })

  it('does not fire with no extra arg at all', () => {
    const out = runNotifyScript(script, [])
    expect(out).toEqual([])
  })
})
