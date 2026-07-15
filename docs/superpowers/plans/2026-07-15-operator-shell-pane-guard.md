# Operator Shell-Pane Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an lfguard command-check before any operator prompt write reaches a pane's pty, closing lfguard G2's one coverage gap (raw operator bytes bypass agent hooks).

**Architecture:** A pure, injectable `operator-guard.ts` unit spawns `lfguard test <text> --pack …` (argv array, no shell) and returns an allow/deny verdict, fail-open on every failure mode. `control-api.ts`'s `POST /panes/:handle/prompt` route awaits the verdict before writing; on deny it returns 403, echoes a notice into the pane (`session-manager.emitNotice`), and emits a `guard` console row via `onGuardBlock`. `index.ts` wires the already-resolved `guardBin` + `registry.getGuardPacks()` and routes `onGuardBlock` to the existing G2 console `guard` source.

**Tech Stack:** TypeScript, Electron main process, Node `child_process.execFile`, Vitest.

## Global Constraints

- **Fail-open is absolute.** Missing binary, spawn error, timeout, or any non-0/1 exit code → the write is ALLOWED. A broken guard must never block a legitimate write.
- **Deny signal is the exit code (1); stderr is best-effort enrichment.** If stderr can't be parsed, still deny with `reason: 'blocked by command guard'`, `pack: 'unknown'`.
- **No shell.** Spawn the binary with an argv array; the operator's text is one argv element (zero quoting/escaping; multi-line passes through for lfguard's own tokenizer).
- **Timeout:** `2000` ms default (catastrophe backstop, not the expected path).
- **Back-compatible.** The `guard` / `onGuardBlock` control-API deps are OPTIONAL; omitting them restores prior behavior exactly.
- **Reuse G2, add no new console plumbing:** the `guard` console source, `toGuardEvent`, and `GuardAuditRecord` already exist in `src/shared/console.ts`.
- **stderr deny line format (verbatim from `guard/crates/lfguard/src/main.rs`):** `lfguard: BLOCKED by <pack>: <reason>[ (inline: <i>)]`. Other stderr lines (pack warnings) may also be present, so match the `BLOCKED by` line specifically, not "the last line".

---

### Task 1: `operator-guard.ts` — the guard unit

**Files:**
- Create: `src/main/operator-guard.ts`
- Test: `tests/unit/operator-guard.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Uses Node `execFile` for the default runner.
- Produces:
  - `type GuardVerdict = { allowed: true } | { allowed: false; reason: string; pack: string }`
  - `type GuardRunner = (bin: string, args: string[], opts: { timeout: number }) => Promise<{ code: number | null; stderr: string; timedOut: boolean }>`
  - `interface OperatorGuardOptions { resolveBinary: () => string | null; getPacks: () => string[]; runner?: GuardRunner; timeoutMs?: number }`
  - `interface OperatorGuard { check(command: string): Promise<GuardVerdict> }`
  - `function makeOperatorGuard(opts: OperatorGuardOptions): OperatorGuard`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/operator-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeOperatorGuard, type GuardRunner } from '../../src/main/operator-guard'

// A runner that returns a canned result and records how it was called.
function fakeRunner(
  result: { code: number | null; stderr: string; timedOut: boolean }
): { runner: GuardRunner; calls: { bin: string; args: string[]; timeout: number }[] } {
  const calls: { bin: string; args: string[]; timeout: number }[] = []
  const runner: GuardRunner = async (bin, args, opts) => {
    calls.push({ bin, args, timeout: opts.timeout })
    return result
  }
  return { runner, calls }
}

const base = {
  resolveBinary: () => '/bin/lfguard',
  getPacks: () => [] as string[]
}

describe('makeOperatorGuard', () => {
  it('denies on exit 1 and parses pack + reason from stderr', async () => {
    const { runner } = fakeRunner({
      code: 1,
      stderr: 'lfguard: BLOCKED by core.filesystem: catastrophic rm',
      timedOut: false
    })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('rm -rf /')).toEqual({
      allowed: false,
      reason: 'catastrophic rm',
      pack: 'core.filesystem'
    })
  })

  it('finds the BLOCKED line even when pack warnings precede it', async () => {
    const { runner } = fakeRunner({
      code: 1,
      stderr:
        'lfguard: pack warning (core.git): noise\n' +
        'lfguard: BLOCKED by core.filesystem: catastrophic rm (inline: bash -c)',
      timedOut: false
    })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({
      allowed: false,
      reason: 'catastrophic rm (inline: bash -c)',
      pack: 'core.filesystem'
    })
  })

  it('allows on exit 0', async () => {
    const { runner } = fakeRunner({ code: 0, stderr: '', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('ls')).toEqual({ allowed: true })
  })

  it('denies on exit 1 with unparseable stderr using a generic reason', async () => {
    const { runner } = fakeRunner({ code: 1, stderr: 'garbled output', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({
      allowed: false,
      reason: 'blocked by command guard',
      pack: 'unknown'
    })
  })

  it('fails open on a spawn error (code null)', async () => {
    const { runner } = fakeRunner({ code: null, stderr: '', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })

  it('fails open on timeout', async () => {
    const { runner } = fakeRunner({ code: null, stderr: '', timedOut: true })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })

  it('fails open on any other exit code', async () => {
    const { runner } = fakeRunner({ code: 2, stderr: 'clap parse error', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })

  it('allows empty/whitespace commands without invoking the runner', async () => {
    let called = false
    const runner: GuardRunner = async () => {
      called = true
      return { code: 0, stderr: '', timedOut: false }
    }
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('   ')).toEqual({ allowed: true })
    expect(called).toBe(false)
  })

  it('allows without invoking the runner when the binary is absent', async () => {
    let called = false
    const runner: GuardRunner = async () => {
      called = true
      return { code: 0, stderr: '', timedOut: false }
    }
    const g = makeOperatorGuard({ resolveBinary: () => null, getPacks: () => [], runner })
    expect(await g.check('rm -rf /')).toEqual({ allowed: true })
    expect(called).toBe(false)
  })

  it('forwards packs as repeated --pack args and passes command as one argv element', async () => {
    const { runner, calls } = fakeRunner({ code: 0, stderr: '', timedOut: false })
    const g = makeOperatorGuard({
      resolveBinary: () => '/bin/lfguard',
      getPacks: () => ['cloud.gcloud', 'db.postgres'],
      runner
    })
    await g.check('gcloud auth print-access-token')
    expect(calls[0].bin).toBe('/bin/lfguard')
    expect(calls[0].args).toEqual([
      'test',
      'gcloud auth print-access-token',
      '--pack',
      'cloud.gcloud',
      '--pack',
      'db.postgres'
    ])
  })

  it('passes the configured timeout to the runner (default 2000)', async () => {
    const { runner, calls } = fakeRunner({ code: 0, stderr: '', timedOut: false })
    const g = makeOperatorGuard({ ...base, runner })
    await g.check('ls')
    expect(calls[0].timeout).toBe(2000)
  })

  it('fails open if the runner itself throws', async () => {
    const runner: GuardRunner = async () => {
      throw new Error('boom')
    }
    const g = makeOperatorGuard({ ...base, runner })
    expect(await g.check('x')).toEqual({ allowed: true })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/operator-guard.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/operator-guard'`.

- [ ] **Step 3: Implement `src/main/operator-guard.ts`**

```ts
import { execFile } from 'node:child_process'

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; pack: string }

/**
 * Runs the guard binary and normalizes the outcome. `code` is the process exit
 * code (0 = allow, 1 = deny) or `null` when the process could not run / was
 * killed (spawn error, timeout). Injected in tests to avoid real subprocesses.
 */
export type GuardRunner = (
  bin: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ code: number | null; stderr: string; timedOut: boolean }>

export interface OperatorGuardOptions {
  /** Resolved lfguard binary path, or null when none is bundled. */
  resolveBinary: () => string | null
  /** Currently-enabled opt-in pack ids (core.* are always active in the binary). */
  getPacks: () => string[]
  /** Subprocess seam; defaults to an execFile-backed runner. */
  runner?: GuardRunner
  /** Fail-open backstop in ms; default 2000. */
  timeoutMs?: number
}

export interface OperatorGuard {
  check(command: string): Promise<GuardVerdict>
}

const defaultRunner: GuardRunner = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout, encoding: 'utf8' }, (err, _stdout, stderr) => {
      if (err) {
        // execFile sets `killed` when it kills the child on timeout.
        if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          return resolve({ code: null, stderr: stderr ?? '', timedOut: true })
        }
        // On a normal non-zero exit, `err.code` is the numeric exit code.
        // On a spawn failure (ENOENT, EACCES) it is a string errno → treat as null.
        const code = typeof err.code === 'number' ? err.code : null
        return resolve({ code, stderr: stderr ?? '', timedOut: false })
      }
      resolve({ code: 0, stderr: stderr ?? '', timedOut: false })
    })
  })

function parseDeny(stderr: string): { allowed: false; reason: string; pack: string } {
  // Format: `lfguard: BLOCKED by <pack>: <reason>` — pack warnings may share stderr,
  // so match the BLOCKED line specifically. `.` stops at newline, so <reason> is one line.
  const m = /lfguard: BLOCKED by (.+?): (.+)/.exec(stderr)
  if (m) return { allowed: false, pack: m[1], reason: m[2].trim() }
  return { allowed: false, reason: 'blocked by command guard', pack: 'unknown' }
}

export function makeOperatorGuard(opts: OperatorGuardOptions): OperatorGuard {
  const run = opts.runner ?? defaultRunner
  const timeout = opts.timeoutMs ?? 2000
  return {
    async check(command: string): Promise<GuardVerdict> {
      if (command.trim() === '') return { allowed: true }
      const bin = opts.resolveBinary()
      if (!bin) return { allowed: true }
      const args = ['test', command, ...opts.getPacks().flatMap((p) => ['--pack', p])]
      let res: { code: number | null; stderr: string; timedOut: boolean }
      try {
        res = await run(bin, args, { timeout })
      } catch {
        return { allowed: true } // runner threw → fail open
      }
      if (res.timedOut || res.code === null || res.code === 0) return { allowed: true }
      if (res.code === 1) return parseDeny(res.stderr)
      return { allowed: true } // any other exit code → fail open
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/operator-guard.test.ts`
Expected: PASS (12 tests).

Then: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/operator-guard.ts tests/unit/operator-guard.test.ts
git commit -m "feat: operator prompt guard unit"
```

---

### Task 2: `session-manager.emitNotice`

**Files:**
- Modify: `src/main/session-manager.ts` (add a public method near `write`, ~line 457)
- Test: `tests/unit/session-manager.test.ts` (extend)

**Interfaces:**
- Consumes: the existing private `dataCbs: ((id: string, data: string) => void)[]` field and `onData(cb)` registration (line 112 / 119).
- Produces: `emitNotice(id: string, text: string): void` on `SessionManager` — pushes a synthetic line to every registered `onData` callback WITHOUT touching the pty.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/session-manager.test.ts` (new top-level `describe` block; it needs no pty/spawn — `emitNotice` only fans out to `onData` callbacks). `SessionManager`, `mkdtempSync`, `tmpdir`, and `join` are already imported at the top of this file:

```ts
describe('SessionManager.emitNotice', () => {
  it('fans a synthetic line out to every onData subscriber', () => {
    const mgr = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
      port: 0,
      token: 'tok'
    })
    const seen: { id: string; data: string }[] = []
    mgr.onData((id, data) => seen.push({ id, data }))
    mgr.onData((id, data) => seen.push({ id, data }))
    mgr.emitNotice('pane-7', '\r\n⛔ blocked\r\n')
    expect(seen).toEqual([
      { id: 'pane-7', data: '\r\n⛔ blocked\r\n' },
      { id: 'pane-7', data: '\r\n⛔ blocked\r\n' }
    ])
  })
})
```

> The required `settingsDir`/`port`/`token` options mirror the construction the existing tests use (line ~68). `emitNotice` touches nothing else, so no `spawnFn` is needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/session-manager.test.ts -t emitNotice`
Expected: FAIL — `mgr.emitNotice is not a function`.

- [ ] **Step 3: Implement**

In `src/main/session-manager.ts`, immediately after the `write` method (ends ~line 463), add:

```ts
  /**
   * Push a synthetic line to the pane's renderer WITHOUT writing to the pty.
   * Same fan-out the instant-exit and relaunch notices use. Used to surface an
   * lfguard block in the pane the operator tried to drive.
   */
  emitNotice(id: string, text: string): void {
    this.dataCbs.forEach((cb) => cb(id, text))
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/session-manager.test.ts -t emitNotice`
Expected: PASS.

Then: `npx vitest run tests/unit/session-manager.test.ts` (whole file, ensure no regression) + `npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/session-manager.ts tests/unit/session-manager.test.ts
git commit -m "feat: emitNotice for synthetic pane lines"
```

---

### Task 3: `control-api.ts` — enforce the guard in the prompt route

**Files:**
- Modify: `src/main/control-api.ts` (`ControlDeps` interface ~line 15-33; `prompt` branch ~line 215-226)
- Test: `tests/unit/control-api.test.ts` (extend the `deps()` factory + new cases)

**Interfaces:**
- Consumes: `GuardVerdict` from Task 1 (`src/main/operator-guard`); `emitNotice` from Task 2; `GuardAuditRecord` from `src/shared/console` (already exists — `{ ts: number; tag: string | null; command: string; reason: string; pack: string }`).
- Produces: `ControlDeps` gains optional `guard?: { check(command: string): Promise<GuardVerdict> }` and `onGuardBlock?: (record: GuardAuditRecord, environment: number) => void`; the `manager` Pick gains `'emitNotice'`.

- [ ] **Step 1: Write the failing test**

First extend the `deps()` factory in `tests/unit/control-api.test.ts` so tests can inject a guard and observe the notice/block side effects. Change its signature and body:

```ts
function deps(opts?: {
  guard?: { check: (command: string) => Promise<import('../../src/main/operator-guard').GuardVerdict> }
}): {
  deps: ControlDeps
  grants: OperatorGrantStore
  writes: string[]
  notices: { id: string; text: string }[]
  blocks: { record: import('../../src/shared/console').GuardAuditRecord; environment: number }[]
} {
  // ... existing `sessions`, `groups`, `grants`, `writes`, `nextId` setup unchanged ...
  const notices: { id: string; text: string }[] = []
  const blocks: { record: import('../../src/shared/console').GuardAuditRecord; environment: number }[] = []
  const manager = {
    list: () => sessions,
    get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    write: (_id: string, data: string) => writes.push(data),
    peek: (_id: string, n = 5) => ['line1', 'line2'].slice(0, n),
    getGroup: (id: string) => groups.find((g) => g.id === id) ?? null,
    emitNotice: (id: string, text: string) => notices.push({ id, text })
  }
  // ... existing `panes` object unchanged ...
  return {
    deps: {
      registry: new PaneRegistry(manager),
      grants,
      manager,
      panes,
      guard: opts?.guard,
      onGuardBlock: (record, environment) => blocks.push({ record, environment })
    },
    grants,
    writes,
    notices,
    blocks
  }
}
```

Then add these cases inside `describe('control-api router', ...)`:

```ts
it('prompt allowed by the guard writes to the pty and emits no block', async () => {
  const { deps: d, grants, writes, notices, blocks } = deps({
    guard: { check: async () => ({ allowed: true }) }
  })
  const token = grants.grant(1)
  const r = await handleRequest(d, 'POST', '/panes/a-term/prompt', token, JSON.stringify({ text: 'ls' }))
  expect(r.status).toBe(200)
  expect(writes).toEqual(['ls\r'])
  expect(notices).toEqual([])
  expect(blocks).toEqual([])
})

it('prompt denied by the guard returns 403, does not write, echoes the pane, emits a block', async () => {
  const { deps: d, grants, writes, notices, blocks } = deps({
    guard: { check: async () => ({ allowed: false, reason: 'catastrophic rm', pack: 'core.filesystem' }) }
  })
  const token = grants.grant(1)
  const r = await handleRequest(
    d,
    'POST',
    '/panes/a-term/prompt',
    token,
    JSON.stringify({ text: 'rm -rf /' })
  )
  expect(r.status).toBe(403)
  expect(r.json).toEqual({ error: 'blocked by command guard', reason: 'catastrophic rm', pack: 'core.filesystem' })
  expect(writes).toEqual([])
  expect(notices).toEqual([{ id: 'a-term', text: '\r\n⛔ lfguard blocked: catastrophic rm\r\n' }])
  expect(blocks).toEqual([
    {
      record: { ts: expect.any(Number), tag: 'a-term', command: 'rm -rf /', reason: 'catastrophic rm', pack: 'core.filesystem' },
      environment: 1
    }
  ])
})

it('prompt with no guard configured writes as before (back-compatible)', async () => {
  const { deps: d, grants, writes } = deps() // no guard injected
  const token = grants.grant(1)
  const r = await handleRequest(d, 'POST', '/panes/a-term/prompt', token, JSON.stringify({ text: 'do it' }))
  expect(r.status).toBe(200)
  expect(writes).toEqual(['do it\r'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/control-api.test.ts`
Expected: FAIL — the denied case returns 200 and writes (guard not yet consulted); type error on `guard`/`onGuardBlock`/`emitNotice` not on `ControlDeps`.

- [ ] **Step 3: Extend `ControlDeps`**

In `src/main/control-api.ts`, add the import near the top (beside the existing type imports):

```ts
import type { GuardVerdict } from './operator-guard'
import type { GuardAuditRecord } from '../shared/console'
```

Update the `manager` Pick and add the two optional deps in `interface ControlDeps`:

```ts
  manager: Pick<SessionManager, 'write' | 'peek' | 'getGroup' | 'emitNotice'>
```

```ts
  onCapture?: (capture: Capture) => void
  /** Guards operator prompt writes; when absent, writes pass straight through. */
  guard?: { check(command: string): Promise<GuardVerdict> }
  /** Called once per blocked write so the host can surface a `guard` console row. */
  onGuardBlock?: (record: GuardAuditRecord, environment: number) => void
```

- [ ] **Step 4: Enforce the guard in the `prompt` branch**

Replace the body of the `prompt` branch (`src/main/control-api.ts` ~line 215-226) — insert the guard check between the `text` validation and the write:

```ts
    if (verb === 'prompt' && method === 'POST') {
      if (session.kind !== 'terminal') return json(400, { error: 'not a terminal pane' })
      if (session.status === 'exited') return json(409, { error: 'pane exited' })
      const b = readBody()
      if (typeof b.text !== 'string') return json(400, { error: 'text required' })
      if (deps.guard) {
        const v = await deps.guard.check(b.text)
        if (!v.allowed) {
          deps.manager.emitNotice(handle, `\r\n⛔ lfguard blocked: ${v.reason}\r\n`)
          deps.onGuardBlock?.(
            { ts: Date.now(), tag: handle, command: b.text, reason: v.reason, pack: v.pack },
            environment
          )
          record('POST prompt blocked', handle, v.reason)
          return json(403, { error: 'blocked by command guard', reason: v.reason, pack: v.pack })
        }
      }
      // Attachments are referenced by path in the prompt text by the operator;
      // v1 does not re-inject them separately (screenshot() already returns a
      // path the operator embeds). Write text + submit (carriage return).
      deps.manager.write(handle, `${b.text}\r`)
      record('POST prompt', handle, b.text.slice(0, 80))
      return json(200, { ok: true })
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/control-api.test.ts`
Expected: PASS (existing prompt tests still green — they inject no guard, so writes pass straight through; new cases green).

Then: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/control-api.ts tests/unit/control-api.test.ts
git commit -m "feat: guard operator prompt writes in control-api"
```

---

### Task 4: `index.ts` — wire the guard into the control server

**Files:**
- Modify: `src/main/index.ts` (build the guard near the existing guard wiring ~line 180-187; pass into `startControlServer(...)` ~line 240-256)

**Interfaces:**
- Consumes: `makeOperatorGuard` from Task 1; `control-api`'s `guard` / `onGuardBlock` deps from Task 3; the already-present `guardBin` (line 180), `registry.getGuardPacks()` (line 187/831), `consoleBus`, and `toGuardEvent` (already imported for the audit tail at line 263).
- Produces: an active guard on the operator prompt route in the running app. (No unit test — `index.ts` is the composition root and has no unit-test harness in this repo; verified by typecheck + build.)

- [ ] **Step 1: Add the import**

In `src/main/index.ts`, beside the other `./` main imports (e.g. near the `resolveGuardBinary` import at line 19):

```ts
import { makeOperatorGuard } from './operator-guard'
```

- [ ] **Step 2: Build the guard from the already-resolved pieces**

After the existing guard setup block (`guardProvider`, ~line 187), add:

```ts
  const operatorGuard = makeOperatorGuard({
    resolveBinary: () => guardBin, // resolved once at line 180; null when none bundled
    getPacks: () => registry.getGuardPacks() // AgentRegistry — same source G2 hooks use
  })
```

- [ ] **Step 3: Pass the guard into `startControlServer`**

In the `startControlServer({ ... })` call (~line 240-256), add two properties beside `onCapture`:

```ts
    onCapture: (cap) => consoleBus.emit(toCaptureEvent(cap)),
    guard: operatorGuard,
    onGuardBlock: (r, env) => consoleBus.emit(toGuardEvent(r, env))
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: clean (no type errors; renderer + main bundles build).

Then run the full unit suite to confirm nothing regressed:
Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: activate operator guard on control server"
```

---

## Notes for the executor

- **Do not** re-implement any command tokenization/segmentation in TS — pass raw text to `lfguard`; the Rust engine owns parsing.
- **Do not** guard `session-manager.write()` broadly — that path carries interactive keystrokes and control bytes on the hot typing path; the guard belongs only on the operator `prompt` route.
- `Date.now()` is used in `control-api.ts` for the audit record `ts` — this is the Electron main process (not a workflow script), so `Date.now()` is available and correct.
- Emoji `⛔` in the pane notice and copy is intentional (matches the approved design); keep it exactly.
- Run `git rev-parse --abbrev-ref HEAD` first — implementation happens on `feat/operator-shell-guard` (already created; the spec is committed there at 6bfd209). Do not implement on `main`.
```
