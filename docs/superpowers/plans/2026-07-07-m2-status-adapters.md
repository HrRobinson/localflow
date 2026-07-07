# M2 Status Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Codex and Gemini sessions real hook-driven status colors
(working/needs-you/idle), matching Claude Code today, replacing their
permanent violet `running` fallback. `SpawnSpec.useHooks: boolean` becomes
`SpawnSpec.hookAdapter: HookAdapterKind`, a per-agent dispatch key covering
three injection mechanisms (`--settings` file, env-var-pointed settings
file, raw `-c` CLI args) and, for Codex specifically, two real fidelity
tiers reflecting genuine uncertainty about how much of its hook system is
injectable per-invocation. `custom` sessions are unaffected (`hookAdapter`
resolves to `'none'`, unchanged violet `running`). Spec:
`docs/superpowers/specs/2026-07-07-m2-status-adapters-design.md`.

**Architecture:** One new dispatcher (`src/main/hook-adapter.ts`,
`buildHookInjection(kind, dir, paneId, port, token) → { args, env }`) is the
single point `SessionManager.spawn()` calls instead of today's
`useHooks`-gated ternary. Two new per-agent generator modules
(`src/main/codex-hooks.ts`, `src/main/gemini-hooks.ts`) mirror the existing
`hook-settings.ts` shape (same `assertSafeToken`/`assertValidPort` guards,
same curl-command construction, same 0600-permission file writes for the
file-based ones) and each map their agent's native hook events onto our
existing three canonical `HookEventName`s — `hook-server.ts`,
`state-machine.ts`, and `SessionManager.applyHookEvent` are **untouched**.
`AGENT_PRESETS` (`src/shared/agents.ts`) flips `codex` to
`hookAdapter: 'cli-args-notify'` (the safe, degraded tier — see spec for
why not the optimistic `cli-args-full`) and `gemini` to
`hookAdapter: 'env-settings-file'`. E2E coverage adds two fixture scripts
(`tests/fixtures/fake-codex.sh`, `fake-gemini.sh`) that simulate each CLI's
own hook-firing behavior by executing whatever command localflow injected,
proving the wiring works independent of whether the real CLIs' injection
mechanisms match research assumptions — that residual risk is closed by a
documented manual-verification checklist for a developer with the real
CLIs installed, not by CI.

**Tech Stack:** existing app (Electron, React, TS strict, Vitest,
Playwright, `node-pty`, no shell involved in spawning — args are argv
arrays, not shell strings).

## Global Constraints

- Conventional Commits, subject ≤50 chars (commitlint-enforced).
- TypeScript strict, no `any`.
- Every new generator reuses the exact validation pattern already in
  `src/main/hook-settings.ts` (`assertSafeToken` against
  `/^[A-Za-z0-9-]+$/` for `paneId`/`token`, `assertValidPort`) — do not
  invent a second validation scheme; if it's worth sharing verbatim,
  extract it to a tiny internal helper only if three call sites make the
  duplication genuinely annoying (judgment call for whoever implements
  Task 1 — duplication is currently deliberate in this codebase, e.g.
  `hook-server.ts` has its own independent token check).
- **This plan changes shipped defaults, not just adds code:** `codex` and
  `gemini` presets move off `hookAdapter: 'none'` (functionally, off
  `useHooks: false`). Existing tests that asserted "codex/gemini stay
  `running` forever" (`tests/unit/session-manager.test.ts`'s `codexSpec`
  fixture and its two `status === 'running'` assertions,
  `tests/unit/agent-registry.test.ts`'s `useHooks('codex') === false`
  assertion) are **expected to change**, not stay green untouched — update
  them as part of the same TDD red/green cycle in Task 3, don't work
  around them.
- `HookAdapterKind`'s five members are the only values ever assigned to
  `AgentPreset.hookAdapter`/`SpawnSpec.hookAdapter` — no other agent gets a
  bespoke sixth mechanism this milestone (Windows/PowerShell quoting for
  any of these is out of scope, tracked separately in the roadmap's
  "Platform & tooling" section).
- No auto-detection of the real CLI's capabilities at runtime — tier
  selection is a static preset value (see spec's "Non-goals").
- Neither `codex` nor `gemini` is installed on this machine or in CI —
  every new generator must be fully unit-testable on pure string/object
  output, and every e2e test must run against the fixture scripts added in
  Task 4, never a real `codex`/`gemini` binary.

---

### Task 1: Codex hook-arg generator (TDD)

**Files:**
- Create: `src/main/codex-hooks.ts`
- Test: `tests/unit/codex-hooks.test.ts`

**Interfaces (produces — later tasks import these exact names):**

```ts
// src/main/codex-hooks.ts
export type CodexHookTier = 'full' | 'notify' | 'none'

/**
 * Codex hook injection via `-c key=value` overrides — no on-disk config
 * file is touched. UNVERIFIED: the exact `-c` value grammar below is a
 * best-effort guess at Codex's TOML-override-style CLI syntax and MUST be
 * confirmed/corrected against a real `codex --help`/docs before the
 * 'full' tier is trusted in production (see the plan's Task 4 manual
 * verification checklist). What IS verified here, independent of that
 * grammar: tier selection, canonical-event mapping, and safe embedding of
 * paneId/port/token.
 */
export function buildCodexHookArgs(
  paneId: string,
  port: number,
  token: string,
  tier: CodexHookTier
): string[]
```

Semantics (mirrors `hook-settings.ts`'s validation exactly):

- Throws on the same conditions `buildHookSettings` throws on today:
  `paneId`/`token` not matching `/^[A-Za-z0-9-]+$/`, `port` not a positive
  integer ≤ 65535 — call `assertValidPort`/a paneId-and-token check with
  the identical regex, duplicated in this file per Global Constraints.
- `tier === 'none'` → returns `[]`.
- `tier === 'notify'` → returns a `-c` pair whose value embeds a shell
  command posting `{paneId, event: "Stop"}` — the **only** event this tier
  ever produces (never `UserPromptSubmit`, never `Notification` — see
  spec's "honest fallback" section for why fabricating those would be
  wrong, not merely incomplete).
- `tier === 'full'` → returns three `-c` pairs (one per Codex hook event:
  `UserPromptSubmit`, `PermissionRequest`, `Stop`), each embedding a shell
  command posting the canonically-mapped event
  (`UserPromptSubmit`→`UserPromptSubmit`, `PermissionRequest`→
  `Notification`, `Stop`→`Stop`).
- Every embedded command follows the exact curl invocation shape already
  used in `hook-settings.ts` (`curl -s -m 3 -X POST
  http://127.0.0.1:<port>/event -H 'Content-Type: application/json' -H
  'X-Localflow-Token: <token>' -d '<json>'`), so the receiving side
  (`hook-server.ts`) needs zero changes.

- [ ] **Step 1: Write the failing tests.**

  ```ts
  // tests/unit/codex-hooks.test.ts
  import { describe, it, expect } from 'vitest'
  import { buildCodexHookArgs } from '../../src/main/codex-hooks'

  describe('buildCodexHookArgs', () => {
    it("tier 'none' returns no args", () => {
      expect(buildCodexHookArgs('p1', 4242, 'tok', 'none')).toEqual([])
    })

    it("tier 'notify' embeds only the Stop-mapped event", () => {
      const args = buildCodexHookArgs('p1', 4242, 'tok', 'notify')
      const joined = args.join(' ')
      expect(joined).toContain('http://127.0.0.1:4242/event')
      expect(joined).toContain('X-Localflow-Token: tok')
      expect(joined).toContain('"paneId":"p1"')
      expect(joined).toContain('"event":"Stop"')
      expect(joined).not.toContain('"event":"UserPromptSubmit"')
      expect(joined).not.toContain('"event":"Notification"')
    })

    it("tier 'full' embeds all three canonical events", () => {
      const args = buildCodexHookArgs('p2', 4242, 'tok', 'full')
      const joined = args.join(' ')
      expect(joined).toContain('"event":"UserPromptSubmit"')
      expect(joined).toContain('"event":"Notification"')
      expect(joined).toContain('"event":"Stop"')
      // PermissionRequest is Codex's native name but must never leak
      // through unmapped — every consumer sees only canonical names.
      expect(joined).not.toContain('"event":"PermissionRequest"')
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
  ```

- [ ] **Step 2:** `npm test` → FAIL (`codex-hooks.ts` doesn't exist yet).
  Record RED.

- [ ] **Step 3: Implement** `src/main/codex-hooks.ts`:

  ```ts
  import type { HookEventName } from '../shared/types'

  export type CodexHookTier = 'full' | 'notify' | 'none'

  const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/

  function assertSafeToken(value: string, name: string): void {
    if (!SAFE_TOKEN_RE.test(value)) throw new Error(`invalid ${name}`)
  }

  function assertValidPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('invalid port')
    }
  }

  function curlCommand(paneId: string, port: number, token: string, event: HookEventName): string {
    const payload = JSON.stringify({ paneId, event })
    return `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H 'Content-Type: application/json' -H 'X-Localflow-Token: ${token}' -d '${payload}'`
  }

  /**
   * UNVERIFIED: the `-c key=value` grammar below is a best-effort guess
   * at Codex's config-override CLI syntax (see module doc comment).
   * Confirm against a real `codex` binary before trusting 'full' in
   * production.
   */
  export function buildCodexHookArgs(
    paneId: string,
    port: number,
    token: string,
    tier: CodexHookTier
  ): string[] {
    assertSafeToken(paneId, 'paneId')
    assertSafeToken(token, 'token')
    assertValidPort(port)
    if (tier === 'none') return []
    if (tier === 'notify') {
      return ['-c', `notify=["sh","-c",${JSON.stringify(curlCommand(paneId, port, token, 'Stop'))}]`]
    }
    const table: [string, HookEventName][] = [
      ['UserPromptSubmit', 'UserPromptSubmit'],
      ['PermissionRequest', 'Notification'],
      ['Stop', 'Stop']
    ]
    return table.flatMap(([codexEvent, canonical]) => [
      '-c',
      `hooks.${codexEvent}=[{command=["sh","-c",${JSON.stringify(curlCommand(paneId, port, token, canonical))}]}]`
    ])
  }
  ```

- [ ] **Step 4:** `npm test` → PASS. `npm run check` clean.
- [ ] **Step 5:** Commit: `feat: add Codex hook-arg generator`

---

### Task 2: Gemini hook-settings generator (TDD)

**Files:**
- Create: `src/main/gemini-hooks.ts`
- Test: `tests/unit/gemini-hooks.test.ts`

**Interfaces:**

```ts
// src/main/gemini-hooks.ts
export function buildGeminiHookSettings(paneId: string, port: number, token: string): object
export function writeGeminiHookSettings(
  dir: string,
  paneId: string,
  port: number,
  token: string
): string
```

Semantics (mirrors `hook-settings.ts`'s `buildHookSettings`/
`writeHookSettings` exactly, including the same throw conditions, same
0600 permission, same `localflow-hooks-<paneId>.json`-style naming under
a distinct prefix to avoid collisions with Claude's file for the same
paneId in a hypothetical mixed setup):

- Emits a `{ hooks: { BeforeAgent, Notification, AfterAgent } }` object.
  `BeforeAgent`/`AfterAgent` are plain curl commands posting
  `UserPromptSubmit`/`Stop` respectively — identical shape to Claude's.
- `Notification`'s command is not a bare curl: it reads its own stdin,
  and only curls `{paneId, event: "Notification"}` if the stdin body
  contains the substring `"type":"ToolPermission"` (compact JSON) or
  `"type": "ToolPermission"` (space-after-colon) — any other notification
  payload is a silent no-op (exit 0, no POST). This is the one place this
  milestone's mapping is payload-shape-dependent rather than purely
  event-name-dependent; see spec for the documented "silent partial
  degradation" this implies if Gemini's real field name/casing differs.
- `writeGeminiHookSettings` writes to
  `join(dir, 'localflow-gemini-hooks-<paneId>.json')` with mode `0o600`,
  returning the path (this is what becomes
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH`'s value in Task 3).

- [ ] **Step 1: Write the failing tests.**

  ```ts
  // tests/unit/gemini-hooks.test.ts
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
  ```

- [ ] **Step 2:** `npm test` → FAIL. Record RED.

- [ ] **Step 3: Implement** `src/main/gemini-hooks.ts` (structure mirrors
  `hook-settings.ts`):

  ```ts
  import { writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  import type { HookEventName } from '../shared/types'

  const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/

  function assertSafeToken(value: string, name: string): void {
    if (!SAFE_TOKEN_RE.test(value)) throw new Error(`invalid ${name}`)
  }

  function assertValidPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('invalid port')
    }
  }

  function curlCommand(paneId: string, port: number, token: string, event: HookEventName): string {
    const payload = JSON.stringify({ paneId, event })
    return `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H 'Content-Type: application/json' -H 'X-Localflow-Token: ${token}' -d '${payload}'`
  }

  /**
   * UNVERIFIED: the exact stdin field name/casing Gemini uses to mark a
   * ToolPermission notification is a research gap, not a confirmed fact —
   * see module doc / spec. If it differs, this simply never fires
   * (silent partial degradation), it never fires on the wrong condition.
   */
  function notificationCommand(paneId: string, port: number, token: string): string {
    const payload = JSON.stringify({ paneId, event: 'Notification' as HookEventName })
    const curl = `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H "Content-Type: application/json" -H "X-Localflow-Token: ${token}" -d '${payload}'`
    return `sh -c 'body=$(cat); case "$body" in *"\\"type\\":\\"ToolPermission\\""*|*"\\"type\\": \\"ToolPermission\\""*) ${curl} ;; esac'`
  }

  export function buildGeminiHookSettings(paneId: string, port: number, token: string): object {
    assertSafeToken(paneId, 'paneId')
    assertSafeToken(token, 'token')
    assertValidPort(port)
    return {
      hooks: {
        BeforeAgent: [
          { hooks: [{ type: 'command', command: curlCommand(paneId, port, token, 'UserPromptSubmit') }] }
        ],
        Notification: [
          { hooks: [{ type: 'command', command: notificationCommand(paneId, port, token) }] }
        ],
        AfterAgent: [{ hooks: [{ type: 'command', command: curlCommand(paneId, port, token, 'Stop') }] }]
      }
    }
  }

  export function writeGeminiHookSettings(
    dir: string,
    paneId: string,
    port: number,
    token: string
  ): string {
    assertSafeToken(paneId, 'paneId')
    assertSafeToken(token, 'token')
    assertValidPort(port)
    const file = join(dir, `localflow-gemini-hooks-${paneId}.json`)
    writeFileSync(file, JSON.stringify(buildGeminiHookSettings(paneId, port, token), null, 2), {
      mode: 0o600
    })
    return file
  }
  ```

- [ ] **Step 4:** `npm test` → PASS. `npm run check` clean.
- [ ] **Step 5:** Commit: `feat: add Gemini hook-settings generator`

---

### Task 3: Adapter dispatcher + `SpawnSpec`/preset wiring (TDD)

**Files:**
- Create: `src/main/hook-adapter.ts`
- Test: `tests/unit/hook-adapter.test.ts`
- Modify: `src/shared/agents.ts`, `src/main/agent-registry.ts`,
  `src/main/session-manager.ts`, `src/main/index.ts`
- Test (modify existing): `tests/unit/session-manager.test.ts`,
  `tests/unit/agent-registry.test.ts`

**Interfaces (produces — later tasks/renderer import these exact names):**

```ts
// src/shared/agents.ts
export type HookAdapterKind =
  | 'settings-file'
  | 'env-settings-file'
  | 'cli-args-full'
  | 'cli-args-notify'
  | 'none'

export function hasHookAdapter(kind: HookAdapterKind): boolean {
  return kind !== 'none'
}

export interface AgentPreset {
  id: AgentId
  label: string
  bin: string
  resumeArgs: string[]
  hookAdapter: HookAdapterKind // replaces useHooks: boolean
}
```

```ts
// src/main/hook-adapter.ts
export interface HookInjection {
  args: string[]
  env: Record<string, string>
}

export function buildHookInjection(
  kind: HookAdapterKind,
  dir: string,
  paneId: string,
  port: number,
  token: string
): HookInjection
```

```ts
// src/main/session-manager.ts — SpawnSpec
export interface SpawnSpec {
  agentId: AgentId
  command: string
  resumeArgs: string[]
  hookAdapter: HookAdapterKind // replaces useHooks: boolean
}
```

```ts
// src/main/agent-registry.ts
hookAdapter(agentId: AgentId): HookAdapterKind // replaces useHooks(agentId): boolean
```

- [ ] **Step 1: Write the failing tests.**

  `tests/unit/hook-adapter.test.ts` (new):
  ```ts
  import { describe, it, expect } from 'vitest'
  import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { buildHookInjection } from '../../src/main/hook-adapter'

  describe('buildHookInjection', () => {
    it("'settings-file' writes a Claude settings file and returns --settings args", () => {
      const dir = mkdtempSync(join(tmpdir(), 'localflow-hi-'))
      const { args, env } = buildHookInjection('settings-file', dir, 'p1', 4242, 'tok')
      expect(args[0]).toBe('--settings')
      expect(existsSync(args[1])).toBe(true)
      expect(env).toEqual({})
    })

    it("'env-settings-file' writes a Gemini settings file and returns the env var, no args", () => {
      const dir = mkdtempSync(join(tmpdir(), 'localflow-hi-'))
      const { args, env } = buildHookInjection('env-settings-file', dir, 'p1', 4242, 'tok')
      expect(args).toEqual([])
      expect(existsSync(env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'])).toBe(true)
    })

    it("'cli-args-full' and 'cli-args-notify' return Codex -c args, no env, no file", () => {
      const dir = mkdtempSync(join(tmpdir(), 'localflow-hi-'))
      const full = buildHookInjection('cli-args-full', dir, 'p1', 4242, 'tok')
      expect(full.env).toEqual({})
      expect(full.args.join(' ')).toContain('"event":"UserPromptSubmit"')
      const notify = buildHookInjection('cli-args-notify', dir, 'p1', 4242, 'tok')
      expect(notify.args.join(' ')).toContain('"event":"Stop"')
      expect(notify.args.join(' ')).not.toContain('"event":"UserPromptSubmit"')
    })

    it("'none' returns no args and no env", () => {
      const dir = mkdtempSync(join(tmpdir(), 'localflow-hi-'))
      expect(buildHookInjection('none', dir, 'p1', 4242, 'tok')).toEqual({ args: [], env: {} })
    })
  })
  ```

  `tests/unit/session-manager.test.ts` — update the two fixtures and
  their dependent assertions:
  ```ts
  const claudeSpec: SpawnSpec = {
    agentId: 'claude',
    command: 'fake-claude',
    resumeArgs: ['--continue'],
    hookAdapter: 'settings-file' // was: useHooks: true
  }

  const codexSpec: SpawnSpec = {
    agentId: 'codex',
    command: 'fake-codex',
    resumeArgs: ['resume', '--last'],
    hookAdapter: 'cli-args-notify' // was: useHooks: false — codex is now a
    // real (degraded) adapter, not the no-adapter case; add a new
    // `noAdapterSpec` fixture below for tests that specifically want
    // today's 'running'-forever behavior (there must be at least one,
    // since 'none' — used by `custom` — still needs coverage).
  }

  const noAdapterSpec: SpawnSpec = {
    agentId: 'custom',
    command: 'fake-custom',
    resumeArgs: [],
    hookAdapter: 'none'
  }
  ```
  Change the two existing assertions that relied on `codexSpec` meaning
  "no adapter" to use `noAdapterSpec` instead (they test generic
  no-adapter behavior, not anything codex-specific):
  - The `mgr.create('/p', codexSpec)` / `expect(info.status).toBe('running')`
    test → `mgr.create('/p', noAdapterSpec)`.
  - The `restart()` test asserting `restarted.status).toBe('running')` for
    a codex-spec session → `noAdapterSpec`.
  - The `mgr.create('/p1', claudeSpec); mgr.create('/p2', codexSpec)` test
    (mixed-agent listing) can keep `codexSpec` as-is if it only asserts
    presence/count, not status — check status assertions in that specific
    test after re-reading it; if it does assert `'running'` for the codex
    row, switch to `noAdapterSpec` there too.
  - Add one new test: `mgr.create('/p', codexSpec).status` is `'idle'`
    (codex now behaves like every other real-adapter agent at spawn —
    proves the uniform `hasHookAdapter()` rule from the spec, not a
    codex-specific carve-out).

  `tests/unit/agent-registry.test.ts` — update:
  ```ts
  it('claude env override wins and each agent gets its preset hook adapter', () => {
    const reg = new AgentRegistry(tmpConfig(), async () => null, '/tmp/fake-claude.sh')
    expect(reg.commandFor('claude')).toBe('/tmp/fake-claude.sh')
    expect(reg.hookAdapter('claude')).toBe('settings-file')
    expect(reg.hookAdapter('codex')).toBe('cli-args-notify') // was 'false'/'none'
    expect(reg.hookAdapter('gemini')).toBe('env-settings-file') // was 'false'/'none'
    expect(reg.hookAdapter('custom')).toBe('none')
  })
  ```
  And in the `list()` test, add:
  ```ts
  expect(agents.find((a) => a.id === 'codex')?.hasStatusFeed).toBe(true) // was false
  ```

- [ ] **Step 2:** `npm test` → FAIL (new module missing, changed
  fixtures/types don't compile against old `SpawnSpec`/`AgentPreset`
  shapes, changed status assertions fail against unmodified `spawn()`).
  Record RED.

- [ ] **Step 3: Implement.**

  `src/shared/agents.ts`:
  ```ts
  import type { AgentId } from './types'

  export type HookAdapterKind =
    | 'settings-file'
    | 'env-settings-file'
    | 'cli-args-full'
    | 'cli-args-notify'
    | 'none'

  export function hasHookAdapter(kind: HookAdapterKind): boolean {
    return kind !== 'none'
  }

  export interface AgentPreset {
    id: AgentId
    label: string
    bin: string
    resumeArgs: string[]
    /**
     * Which hook-injection mechanism/tier localflow uses for this agent's
     * status feed. 'cli-args-notify' (not the optimistic 'cli-args-full')
     * is Codex's shipped default — see
     * docs/superpowers/specs/2026-07-07-m2-status-adapters-design.md for
     * why the degraded tier is the safer default until manually verified.
     */
    hookAdapter: HookAdapterKind
  }

  export const AGENT_PRESETS: AgentPreset[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      bin: 'claude',
      resumeArgs: ['--continue'],
      hookAdapter: 'settings-file'
    },
    {
      id: 'codex',
      label: 'Codex',
      bin: 'codex',
      resumeArgs: ['resume', '--last'],
      hookAdapter: 'cli-args-notify'
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      bin: 'gemini',
      resumeArgs: ['--resume', 'latest'],
      hookAdapter: 'env-settings-file'
    }
  ]

  export function presetFor(id: AgentId): AgentPreset | undefined {
    return AGENT_PRESETS.find((p) => p.id === id)
  }
  ```

  `src/main/hook-adapter.ts` (new):
  ```ts
  import type { HookAdapterKind } from '../shared/agents'
  import { writeHookSettings } from './hook-settings'
  import { buildCodexHookArgs } from './codex-hooks'
  import { writeGeminiHookSettings } from './gemini-hooks'

  export interface HookInjection {
    args: string[]
    env: Record<string, string>
  }

  export function buildHookInjection(
    kind: HookAdapterKind,
    dir: string,
    paneId: string,
    port: number,
    token: string
  ): HookInjection {
    switch (kind) {
      case 'settings-file':
        return { args: ['--settings', writeHookSettings(dir, paneId, port, token)], env: {} }
      case 'env-settings-file':
        return {
          args: [],
          env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: writeGeminiHookSettings(dir, paneId, port, token) }
        }
      case 'cli-args-full':
        return { args: buildCodexHookArgs(paneId, port, token, 'full'), env: {} }
      case 'cli-args-notify':
        return { args: buildCodexHookArgs(paneId, port, token, 'notify'), env: {} }
      case 'none':
        return { args: [], env: {} }
    }
  }
  ```

  `src/main/agent-registry.ts` — replace:
  ```ts
  useHooks(agentId: AgentId): boolean {
    return presetFor(agentId)?.useHooks ?? false
  }
  ```
  with:
  ```ts
  hookAdapter(agentId: AgentId): HookAdapterKind {
    return presetFor(agentId)?.hookAdapter ?? 'none'
  }
  ```
  (add `HookAdapterKind` to the existing `import ... from '../shared/agents'`
  line) and in `list()`, replace `hasStatusFeed: preset.useHooks` with
  `hasStatusFeed: hasHookAdapter(preset.hookAdapter)` (add `hasHookAdapter`
  to the same import).

  `src/main/session-manager.ts`:
  1. Add imports: `import { hasHookAdapter, type HookAdapterKind } from
     '../shared/agents'` and `import { buildHookInjection } from
     './hook-adapter'`; remove the now-unused `writeHookSettings` import.
  2. `SpawnSpec`: replace `useHooks: boolean` with
     `hookAdapter: HookAdapterKind` (keep the doc comment, update its text
     to reference the adapter kind instead of the boolean).
  3. In `spawn()`, replace:
     ```ts
     status: spec.useHooks ? 'idle' : 'running',
     ```
     with:
     ```ts
     status: hasHookAdapter(spec.hookAdapter) ? 'idle' : 'running',
     ```
  4. Replace:
     ```ts
     const hookArgs = spec.useHooks
       ? ['--settings', writeHookSettings(this.opts.settingsDir, id, this.opts.port, this.opts.token)]
       : []
     const resumeArgs = resume ? spec.resumeArgs : []
     pty = (this.opts.spawnFn ?? defaultSpawn)(spec.command, [...hookArgs, ...resumeArgs], {
       cwd,
       cols: 80,
       rows: 24,
       name: 'xterm-256color',
       env: process.env
     })
     ```
     with:
     ```ts
     const injection = buildHookInjection(
       spec.hookAdapter,
       this.opts.settingsDir,
       id,
       this.opts.port,
       this.opts.token
     )
     const resumeArgs = resume ? spec.resumeArgs : []
     pty = (this.opts.spawnFn ?? defaultSpawn)(spec.command, [...injection.args, ...resumeArgs], {
       cwd,
       cols: 80,
       rows: 24,
       name: 'xterm-256color',
       env: { ...process.env, ...injection.env }
     })
     ```

  `src/main/index.ts` — `specFor`:
  ```ts
  const specFor = (agentId: AgentId, customCommand?: string): SpawnSpec => ({
    agentId,
    command: registry.commandFor(agentId, customCommand),
    resumeArgs: registry.argsFor(agentId, true),
    hookAdapter: registry.hookAdapter(agentId)
  })
  ```

- [ ] **Step 4:** `npm run check` clean (lint, typecheck, `npm test` all
  green — this touches enough call sites that a `tsc` pass across both
  `tsconfig.node.json`/`tsconfig.web.json` is the real gate here, not just
  vitest).
- [ ] **Step 5:** Commit: `feat: adapter-based hook injection for codex/gemini`

---

### Task 4: E2E fixture scripts + manual verification checklist

**Files:**
- Create: `tests/fixtures/fake-codex.sh`, `tests/fixtures/fake-gemini.sh`
- Modify: `tests/e2e/smoke.spec.ts`, `README.md`

**Fixture design (per spec's "Testing strategy"):** these scripts do not
attempt to parse Codex's/Gemini's real argv/config grammar — they trust
that *whatever string localflow's generator embedded* is a directly
executable shell command (true by construction: every adapter's embedded
command is a `curl ...`/`sh -c '...'` string, never a value that needs a
real CLI's own parser to become executable). Each fixture executes that
command at a scripted moment to simulate the corresponding lifecycle
event, proving the localflow-side wiring end-to-end. This is explicitly
**not** proof that the real CLI would invoke the command the same way —
that gap is closed by the manual checklist below, not by these fixtures.

- [ ] **Step 1:** `tests/fixtures/fake-codex.sh` — scans its own argv for
  `-c` values, extracts anything that looks like an embedded shell command
  (contains `curl`), and runs each one via `eval` shortly after start
  (simulating a fast turn-complete):
  ```sh
  #!/bin/sh
  # Stands in for the codex CLI in e2e. Scans argv for -c overrides
  # embedding localflow's hook commands (see src/main/codex-hooks.ts) and
  # executes them, simulating whichever Codex lifecycle events this
  # invocation's tier wired up. Does NOT validate that a real `codex`
  # binary accepts this exact -c grammar — see the manual verification
  # checklist in docs/superpowers/plans/2026-07-07-m2-status-adapters.md.
  echo "fake-codex started in $PWD with args: $@"
  prev=""
  for arg in "$@"; do
    case "$prev" in
      -c)
        case "$arg" in
          *curl*)
            # Extract the sh -c '...' payload and run it.
            cmd=$(echo "$arg" | sed -n 's/.*"sh","-c",\(".*"\)\].*/\1/p')
            [ -n "$cmd" ] && eval "$(echo "$cmd" | sed 's/^"//;s/"$//')"
            ;;
        esac
        ;;
    esac
    prev="$arg"
  done
  sleep 600
  ```

- [ ] **Step 2:** `tests/fixtures/fake-gemini.sh` — reads
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, greps the JSON file for each hook's
  `"command"` line, and runs `BeforeAgent`/`AfterAgent` directly plus
  `Notification` with a fake `{"type":"ToolPermission"}` piped to its
  stdin (exercising the payload-gated branch from Task 2):
  ```sh
  #!/bin/sh
  # Stands in for the gemini CLI in e2e. Reads the settings file
  # localflow pointed at via GEMINI_CLI_SYSTEM_SETTINGS_PATH (see
  # src/main/gemini-hooks.ts) and runs each hook's command, simulating
  # BeforeAgent/Notification(ToolPermission)/AfterAgent. Does NOT validate
  # that a real `gemini` binary uses this settings shape or this
  # notification field name — see the manual verification checklist.
  echo "fake-gemini started in $PWD, settings: $GEMINI_CLI_SYSTEM_SETTINGS_PATH"
  extract() { grep -A2 "\"$1\"" "$GEMINI_CLI_SYSTEM_SETTINGS_PATH" | grep '"command"' | head -1 | sed 's/.*"command": "\(.*\)"/\1/'; }
  before=$(extract BeforeAgent)
  notif=$(extract Notification)
  after=$(extract AfterAgent)
  [ -n "$before" ] && eval "$before"
  [ -n "$notif" ] && echo '{"type":"ToolPermission"}' | eval "$notif"
  sleep 600
  [ -n "$after" ] && eval "$after"
  ```
  (Adjust the `sed`/`grep` extraction once Task 2's exact generated JSON
  indentation is in hand — this step should re-run
  `writeGeminiHookSettings` in a scratch script first to confirm the
  line-shape the `grep -A2`/`sed` pattern assumes actually matches the
  real `JSON.stringify(..., null, 2)` output before wiring it into the
  fixture.)

- [ ] **Step 3:** `tests/e2e/smoke.spec.ts` — add a `launchAppWithAgents`
  variant (or extend `launchApp`'s existing config-merge helper with an
  optional `agentPaths` override param) that points `codex`/`gemini` at
  the two new fixtures instead of `/nonexistent/...`:
  ```ts
  function launchApp(userData: string, agentPaths: Record<string, string> = {}): Promise<ElectronApplication> {
    // ...existing body, but merge `agentPaths` over the /nonexistent
    // defaults instead of always writing /nonexistent/codex,/gemini.
  }
  ```
  Add two new `test()`s (same launch/create/open pattern as the existing
  Claude hook-color test):
  - **Codex (notify tier):** create a codex session pointed at
    `fake-codex.sh`, open it, assert the pane's `data-status` reaches
    `'idle'` (the fixture's simulated Stop fires shortly after start) and
    never regresses to `'running'`.
  - **Gemini (env tier):** create a gemini session pointed at
    `fake-gemini.sh`, open it, assert `data-status` sequences through
    `'working'` (from the fixture's `BeforeAgent` run) then `'needs-you'`
    (from the fake `ToolPermission` payload) — proving the payload-gated
    branch actually fires end-to-end, not just that the settings file
    parses.
- [ ] **Step 4:** `npm run e2e` → all pass (record output).
- [ ] **Step 5:** README.md — add a short "Status adapters" paragraph
  under wherever hook-driven status is currently documented (search for
  the existing Claude Code hooks mention): Codex and Gemini sessions now
  get real status colors too; Codex ships on a deliberately conservative
  tier (turn-complete only — idle/exited are accurate, working/needs-you
  are not yet distinguished) pending manual verification of its `-c`
  hook-injection grammar against a real install; Gemini ships full
  three-state fidelity pending the same kind of verification for its
  notification payload shape. Link both to the design spec.
- [ ] **Step 6:** Add the manual verification checklist as a new
  `## Manual verification (Codex / Gemini hooks)` section in this plan
  file (kept here, not in README, since it's a one-time
  developer-facing task, not end-user documentation):
  - Install `codex` (or point `agentPaths.codex` at a real dev build);
    inspect `codex --help` / its docs for the actual `-c`/`--profile`
    override grammar; confirm whether a nested table like
    `hooks.<Event>=[{command=[...]}]` is accepted, rejected, or silently
    ignored. Adjust `buildCodexHookArgs`'s `'full'` branch to match
    reality (or, if nothing beyond legacy `notify` works, leave the
    shipped default at `'cli-args-notify'` and file a follow-up noting
    `'cli-args-full'` is unreachable until Codex adds real per-invocation
    hook-table support).
  - If `'full'` verifies correctly, flip `AGENT_PRESETS`'s `codex` entry
    to `hookAdapter: 'cli-args-full'`, re-run `npm run check`, and update
    the two codex-specific e2e assertions above to expect `working`/
    `needs-you` transitions rather than idle-only.
  - Install `gemini` (or point `agentPaths.gemini` at a real dev build);
    trigger an actual tool-permission approval prompt and inspect the
    real stdin payload the `Notification` hook receives (e.g. temporarily
    swap the hook command for `cat > /tmp/gemini-notif.json` and inspect
    the file) to confirm the notification-kind field name/casing.
    Correct `notificationCommand`'s grep pattern in
    `src/main/gemini-hooks.ts` if it differs from
    `"type":"ToolPermission"`.
  - Neither check blocks this milestone's merge — they're follow-up
    verification, tracked here so they aren't lost, matching the spec's
    stance that shipped defaults are the safe tiers until confirmed.
- [ ] **Step 7:** `npm run check` clean. Commit:
  `test: add codex/gemini e2e fixtures and status coverage`

---

## Manual verification (Codex / Gemini hooks)

One-time developer-facing checklist for whoever has real `codex`/`gemini`
CLIs installed. Not end-user documentation (see README's "Status adapters"
section for that) and **not required to merge this milestone** — the
shipped defaults (`codex: cli-args-notify`, `gemini: env-settings-file`)
are the safe/degraded-where-uncertain tiers, chosen precisely so this
verification can happen later without blocking anything.

### Codex `-c` hook-injection grammar

- [ ] Install `codex` (or point `agentPaths.codex` in `config.json` at a
  real dev build) and inspect `codex --help` / its docs for the actual
  `-c`/`--profile`/config-override grammar it accepts on the command line.
- [ ] Confirm whether a nested table like
  `hooks.<Event>=[{command=["sh","-c","..."]}]` (the `'full'` tier's shape,
  see `buildCodexHookArgs` in `src/main/codex-hooks.ts`) is accepted,
  rejected outright, or silently ignored by a real invocation. The legacy
  `notify=["sh","-c","..."]` form (the shipped `'notify'` tier) is the
  fallback already believed more likely to work, since `notify` is Codex's
  longer-standing turn-complete mechanism.
- [ ] If `'full'` verifies correctly: flip `AGENT_PRESETS`'s `codex` entry
  in `src/shared/agents.ts` to `hookAdapter: 'cli-args-full'`, re-run
  `npm run check`, and update `tests/e2e/smoke.spec.ts`'s codex test to
  expect `working`/`needs-you` transitions (via `UserPromptSubmit` and
  `PermissionRequest`-mapped-to-`Notification`) rather than idle-only.
- [ ] If nothing beyond legacy `notify` works: leave the shipped default at
  `'cli-args-notify'` and file a follow-up issue noting `'cli-args-full'`
  is unreachable until Codex adds real per-invocation hook-table support.

### Gemini notification payload shape

- [ ] Install `gemini` (or point `agentPaths.gemini` at a real dev build)
  and trigger an actual tool-permission approval prompt in a live session.
- [ ] Inspect the real stdin payload the `Notification` hook receives — the
  quickest way is to temporarily swap `notificationCommand`'s generated
  command (in `src/main/gemini-hooks.ts`) for something like
  `cat > /tmp/gemini-notif.json` and read the file back afterward — to
  confirm the actual notification-kind field name/casing Gemini sends.
- [ ] If it differs from `"type":"ToolPermission"` (case sensitivity,
  different field name, different value, etc.), correct the `case`
  pattern inside `notificationCommand`'s generated `sh -c '...'` script
  accordingly, re-run `npm run check`, and confirm
  `tests/unit/gemini-hooks.test.ts`'s payload-gating tests still reflect
  the corrected shape.

### Notes for whoever runs this

- Neither check blocks this milestone's merge — they're follow-up
  verification, tracked here so they aren't lost, matching the spec's
  stance that shipped defaults are the safe tiers until confirmed.
- The e2e fixtures (`tests/fixtures/fake-codex.sh`,
  `tests/fixtures/fake-gemini.sh`) prove localflow's own wiring — that the
  generated `-c` args / settings-file env var actually reach a spawned
  child process and, once executed, correctly reach `hook-server.ts` — but
  they are not a substitute for either check above, since both fixtures
  execute the injected command themselves rather than going through a real
  CLI's own hook-firing logic.
- Building the fixtures surfaced one non-obvious pitfall worth knowing
  before touching either generator again: `buildCodexHookArgs` and
  `writeGeminiHookSettings` both embed the curl command as a
  `JSON.stringify`-escaped string (once for Codex's `-c` value, once for
  Gemini's settings-file `"command"` field). Extracting that value back out
  with `grep`/`sed` and stripping only the *outer* wrapping quotes leaves
  literal backslash-quote (`\"`) pairs sitting inside the extracted
  command's own single-quoted `-d '...'` JSON body. POSIX shell does not
  treat backslash as an escape character inside single quotes, so `eval`ing
  that string verbatim sends the literal backslashes to curl, producing a
  body `hook-server.ts`'s `JSON.parse` rejects (silently — the event is
  simply dropped) — status never updates, and it looks like the hook never
  fired at all. Both fixtures reverse this with an explicit `unescape()`
  step (`\\` → placeholder → `\"` → `"` → placeholder → `\`) before
  `eval`, verified against the real generators' output (not just the
  brief's sketch) with a live HTTP listener before being wired into the
  Playwright tests.

---

## Self-Review Notes

- Spec coverage: `HookAdapterKind` and the dispatcher replace
  `useHooks: boolean` everywhere it appeared (T3); per-agent generators
  for Codex (two tiers, one mechanism-level fork, T1) and Gemini (one
  mechanism, one payload-gated silent-degradation branch, T2) both map
  native events to the existing three canonical `HookEventName`s without
  touching `hook-server.ts`/`state-machine.ts`; the "honest fallback"
  requirement from the task is addressed explicitly in both the spec (a
  dedicated subsection per agent) and in code comments at the exact
  branch that would otherwise fabricate a `working`/`needs-you` signal
  that doesn't exist in the degraded tier; e2e fixture-script strategy
  (T4) plus a documented, non-blocking manual-verification checklist
  close the "can't test real CLIs" gap without pretending CI coverage
  substitutes for it.
- Type consistency: `HookAdapterKind` defined once in `src/shared/agents.ts`
  (T3), consumed by `AgentPreset` (T3), `SpawnSpec` (T3), `hook-adapter.ts`'s
  dispatcher (T3), and `AgentRegistry.hookAdapter`/`hasStatusFeed` (T3) — no
  parallel boolean left behind; `HookEventName` (unchanged, `shared/types.ts`)
  is the only vocabulary any generated hook command ever embeds, verified by
  the "must not contain the native event name" assertions in T1/T3's tests.
- Known risk: Task 1's `-c` grammar and Task 2's notification-payload grep
  are both explicitly unverified guesses, flagged in three places (spec,
  module doc comments, this plan's Task 4 checklist) so the gap can't be
  silently forgotten — but this means Codex's `'full'` tier and (less
  severely) Gemini's `Notification` hook may simply not work at all until
  the manual checklist is run; the shipped defaults are chosen so that
  failure mode is invisible-but-honest (falls back to the equivalent of
  today's behavior) rather than visibly broken or misleading.
- Known risk: Task 3's fixture updates to `session-manager.test.ts` require
  re-reading the current file's exact test bodies before editing (per the
  Global Constraints note) — the plan describes the intent (which
  assertions move from `codexSpec` to a new `noAdapterSpec`) but the
  precise line numbers will have drifted if any other concurrent
  milestone touched that file first.
- Known risk: `tests/fixtures/fake-gemini.sh`'s `grep`/`sed` extraction
  (T4, Step 2) is written against an assumed `JSON.stringify(...,
  null, 2)` line layout; the plan calls out re-verifying this against
  Task 2's actual output before trusting it, rather than treating the
  shell snippet above as final.
- Non-goals respected: no runtime CLI-capability probing, no change to
  the receiving-side hook pipeline, no attempt to merge with a user's own
  pre-existing Codex/Gemini hook config on disk (all per spec's
  "Non-goals").
</content>
