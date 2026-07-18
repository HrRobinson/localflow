# Operator-Readable Terminal & Working Operator Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a localflow terminal pane's on-screen content machine-readable to the operator control API, make operator prompts actually submit, keep the `needs-you` status honest, and fix two terminal render bugs — so an external operator (openclaw) can *see* and *drive* a pane reliably.

**Architecture:** Maintain a headless xterm.js terminal per pane in the main process, fed the same pty bytes as the renderer, and read the *rendered screen* from its buffer instead of regex-stripping a raw byte tail. Four smaller fixes ride along: two-write prompt submission, a `PostToolUse` transition that clears `needs-you` mid-turn, screen-replay on renderer view-return, and a terminal bottom-clipping CSS fix.

**Tech Stack:** Electron main (Node) + `@xterm/headless@6` (new dep, aligned with the renderer's `@xterm/xterm@6`); renderer `@xterm/xterm` + `@xterm/addon-fit` (already present). TypeScript throughout; vitest unit tests; playwright e2e.

## Global Constraints

- Conventional Commits, commitlint subject ≤ 50 chars. Every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- `peek`/instant-exit/`output` must be **fail-safe**: if the headless terminal ever throws, fall back to the existing ANSI-strip path — reading pane content must never crash the main process or the control API.
- Bounded memory: the headless terminal uses a modest fixed `scrollback` (1000 rows); one instance per live pane only, disposed on close.
- No behavior change to lfguard, the operator grant/auth, or the guard verdict path.
- Preserve existing pane/status semantics except the one intended `needs-you` fix.
- New dependency limited to exactly `@xterm/headless` (`translateToString(true)` yields clean text — `@xterm/addon-serialize` is NOT added).

## Toolchain commands (run from repo root `/Users/jonasrobinson/projects/localflow-termfix`)

- Run one test file: `npx vitest run tests/unit/<file>.test.ts`
- Run one test by name: `npx vitest run tests/unit/<file>.test.ts -t "<name>"`
- Full test suite: `npm run test` (alias for `vitest run`)
- Typecheck: `npm run typecheck` (`tsc --noEmit` for node + web projects)
- Lint + format check: `npm run lint` (`eslint . && prettier --check .`)
- All three (lint + typecheck + test): `npm run check`
- e2e (Task 7/8 verification): `npm run e2e` (`electron-vite build && playwright test`)

> **Note on `@xterm/headless`:** it is **not yet installed** in this worktree (only `@xterm/xterm` and `@xterm/addon-fit` are). Task 1 adds it. `npm install` for the existing deps has already been run.

> **Key implementation fact (verified against the installed `@xterm/xterm@6` core):** `Terminal.write(data)` parses synchronously via `WriteBuffer._innerWrite` for normal small chunks (it only defers to `setTimeout` when a single parse pass exceeds ~12 ms or an async parser handler is registered). So reading `terminal.buffer.active` immediately after `write()` reflects the written bytes. This is why `snapshot()` can be read synchronously in the instant-exit path and in unit tests without awaiting a flush callback.

---

## File Structure

**Created:**

- `src/main/terminal-screen.ts` — `TerminalScreen` class: a fail-safe, DOM-less `@xterm/headless` wrapper. `write`/`resize`/`snapshot`/`dispose`, every method swallows throws. One instance per live pane. (Task 1)
- `tests/unit/terminal-screen.test.ts` — unit tests for `TerminalScreen`. (Task 1)

**Modified:**

- `src/main/session-manager.ts` — `Record_` gains `screen?: TerminalScreen`; created at spawn, fed in the pty `data` handler, resized on `resize`, disposed on close; new `snapshot(id, maxLines?)` method; `peek()` delegates to it; instant-exit message uses the rendered snapshot. (Tasks 2, 3, 4)
- `src/main/control-api.ts` — `POST /panes/:handle/prompt` writes text and `\r` as two separate writes. (Task 5)
- `src/shared/types.ts` — `HookEventName` gains `'PostToolUse'`. (Task 6)
- `src/main/state-machine.ts` — `transition` maps `PostToolUse → 'working'`. (Task 6)
- `src/main/hook-settings.ts` — `EVENTS` emits `PostToolUse` (Claude). (Task 6)
- `src/main/hook-server.ts` — `EVENT_NAMES` whitelist accepts `PostToolUse`. (Task 6)
- `src/main/codex-hooks.ts` — full-tier table emits `PostToolUse` (parity). (Task 6)
- `src/main/gemini-hooks.ts` — `AfterTool` hook emits `PostToolUse` (parity). (Task 6)
- `src/main/index.ts` — `session:snapshot` IPC handler. (Task 7)
- `src/preload/index.ts` — `snapshotSession` bridge. (Task 7)
- `src/shared/api.ts` — `snapshotSession` type. (Task 7)
- `src/renderer/src/components/TerminalPane.tsx` — replay the pane's screen snapshot into the fresh terminal on (re)mount. (Task 7)
- `src/renderer/src/styles.css` — move `.term-host` padding onto `.xterm` so `FitAddon.fit()` computes rows against the true content height. (Task 8)

**Modified test files:**

- `tests/unit/session-manager.test.ts` — new screen-wiring / instant-exit-snapshot tests. (Tasks 2, 4)
- `tests/unit/control-api.test.ts` — updated write-expectation assertions (two writes). (Task 5)
- `tests/unit/state-machine.test.ts` — `PostToolUse` transitions. (Task 6)
- `tests/unit/hook-settings.test.ts` — `PostToolUse` in EVENTS. (Task 6)
- `tests/unit/hook-server.test.ts` — `PostToolUse` accepted. (Task 6)
- `tests/unit/codex-hooks.test.ts` — full-tier emits `PostToolUse`. (Task 6)
- `tests/unit/gemini-hooks.test.ts` — `AfterTool` emits `PostToolUse` (create if absent). (Task 6)

---

## Task 1: `TerminalScreen` headless emulator + dependency

**Files:**
- Create: `src/main/terminal-screen.ts`
- Create: `tests/unit/terminal-screen.test.ts`
- Modify: `package.json` (adds `@xterm/headless` to `dependencies`)

**Interfaces:**
- Consumes: `@xterm/headless` `Terminal` (constructor `{ cols, rows, scrollback, allowProposedApi }`, `.write(string)`, `.resize(cols, rows)`, `.buffer.active` with `.length` and `.getLine(i).translateToString(trimRight)`, `.dispose()`).
- Produces (relied on by Tasks 2, 3, 4, 7):
  - `class TerminalScreen`
  - `constructor(cols?: number, rows?: number)` — defaults `80`/`24`.
  - `write(data: string): void`
  - `resize(cols: number, rows: number): void`
  - `snapshot(maxLines?: number): string[]` — full rendered screen (trailing blank lines trimmed) when `maxLines` omitted; the last `maxLines` **non-empty** lines when given. Empty array on any failure.
  - `dispose(): void`

- [ ] **Step 1: Add the dependency**

Run: `npm install @xterm/headless@^6.0.0`
Expected: `package.json` `dependencies` now contains `"@xterm/headless": "^6.0.0"` (npm resolves the latest 6.x), and `node_modules/@xterm/headless` exists. `package-lock.json` updates.

Verify: `node -e "console.log(require('@xterm/headless/package.json').version)"`
Expected: prints a `6.x.y` version string.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/terminal-screen.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TerminalScreen } from '../../src/main/terminal-screen'

describe('TerminalScreen', () => {
  it('renders a redraw with SGR + cursor moves as a clean final frame', () => {
    const screen = new TerminalScreen(80, 24)
    // Clear screen, home cursor, paint a colored prompt (SGR 246), then a bold line.
    screen.write('[2J[H[38;5;246mDo you want to proceed?[0m\r\n')
    screen.write('[1m> 1. Yes[0m')
    const lines = screen.snapshot()
    const joined = lines.join('\n')
    expect(joined).toContain('Do you want to proceed?')
    expect(joined).toContain('> 1. Yes')
    // No escape fragments survive the emulator (the '246m'/ESC garbage the
    // byte-tail path leaked is gone).
    expect(joined).not.toContain('246m')
    expect(joined).not.toContain('')
  })

  it('trims trailing blank lines but keeps the painted rows', () => {
    const screen = new TerminalScreen(80, 24)
    screen.write('only one line')
    const lines = screen.snapshot()
    expect(lines).toEqual(['only one line'])
  })

  it('returns the last N non-empty lines when maxLines is given', () => {
    const screen = new TerminalScreen(80, 24)
    screen.write('a\r\nb\r\nc\r\nd\r\n')
    expect(screen.snapshot(2)).toEqual(['c', 'd'])
  })

  it('resize re-flows wrapping (a 25-char line wraps at width 20)', () => {
    const screen = new TerminalScreen(80, 24)
    screen.resize(20, 10)
    screen.write('0123456789012345678901234')
    expect(screen.snapshot().length).toBeGreaterThanOrEqual(2)
  })

  it('is throw-safe: use after dispose returns [] and never throws', () => {
    const screen = new TerminalScreen(80, 24)
    screen.write('hello')
    screen.dispose()
    expect(() => screen.write('x')).not.toThrow()
    expect(() => screen.resize(10, 10)).not.toThrow()
    expect(screen.snapshot()).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/terminal-screen.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/terminal-screen"` (module does not exist yet).

- [ ] **Step 4: Write minimal implementation**

Create `src/main/terminal-screen.ts`:

```ts
import { Terminal } from '@xterm/headless'

/**
 * A DOM-less xterm.js terminal that renders a pane's pty byte stream so the
 * operator control API can read the *screen* (clean, de-escaped text) instead
 * of a regex-stripped raw byte tail. Every public method swallows throws and
 * degrades to "unavailable" (snapshot() returns []), so a headless-emulator
 * failure can never crash the main process or the control API — callers fall
 * back to the byte-tail path. One instance per live pane; scrollback is a
 * fixed 1000 rows to bound memory.
 */
export class TerminalScreen {
  private term: Terminal
  private broken = false

  constructor(cols = 80, rows = 24) {
    this.term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  }

  write(data: string): void {
    if (this.broken) return
    try {
      this.term.write(data)
    } catch {
      this.broken = true
    }
  }

  resize(cols: number, rows: number): void {
    if (this.broken) return
    try {
      this.term.resize(cols, rows)
    } catch {
      this.broken = true
    }
  }

  /**
   * The rendered screen as plain text lines. Trailing blank lines are trimmed.
   * With `maxLines`, returns the last N non-empty lines (matching the old
   * extractPeekLines contract). Any failure yields [] so callers fall back.
   */
  snapshot(maxLines?: number): string[] {
    if (this.broken) return []
    try {
      const buf = this.term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)
        lines.push(line ? line.translateToString(true) : '')
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop()
      }
      if (maxLines != null) {
        return lines.filter((l) => l.trim().length > 0).slice(-maxLines)
      }
      return lines
    } catch {
      this.broken = true
      return []
    }
  }

  dispose(): void {
    try {
      this.term.dispose()
    } catch {
      /* already gone */
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/terminal-screen.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors (exit 0).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/main/terminal-screen.ts tests/unit/terminal-screen.test.ts
git commit -m "$(cat <<'EOF'
feat: add headless TerminalScreen emulator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire the screen into `SessionManager`

**Files:**
- Modify: `src/main/session-manager.ts` (import ~L19; `Record_` ~L71-91; `spawn` ~L288-446; `resize` ~L474-480; `closeTerminal` ~L482-504; `deleteSession` ~L507-523; `disposeAll` ~L656-666; add `snapshot` near `peek` ~L679)
- Test: `tests/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `TerminalScreen` (Task 1) — `new TerminalScreen(cols, rows)`, `.write(data)`, `.resize(cols, rows)`, `.snapshot(maxLines?)`, `.dispose()`. Existing `extractPeekLines(raw, maxLines)` from `./peek` (already imported at L19).
- Produces (relied on by Tasks 3, 4, 7):
  - `SessionManager.snapshot(id: string, maxLines?: number): string[]` — the pane's full rendered screen (or last `maxLines` non-empty lines), falling back to `extractPeekLines(rec.tail, maxLines ?? 200)` when the screen is unavailable/empty.
  - `Record_.screen?: TerminalScreen`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/session-manager.test.ts` (inside the top-level `describe('SessionManager', ...)` block, after the existing instant-exit tests):

```ts
  it('feeds pty bytes into a headless screen readable via snapshot()', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].dataCb?.('[2J[H[38;5;246mHello operator[0m\r\n')
    const joined = mgr.snapshot(info.id).join('\n')
    expect(joined).toContain('Hello operator')
    expect(joined).not.toContain('246m')
    expect(joined).not.toContain('')
  })

  it('forwards resize to the screen (a wide line wraps at the new width)', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    mgr.resize(info.id, 20, 10)
    ptys[0].dataCb?.('0123456789012345678901234')
    expect(mgr.snapshot(info.id).length).toBeGreaterThanOrEqual(2)
  })

  it('snapshot(maxLines) returns the last N non-empty rendered lines', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    ptys[0].dataCb?.('one\r\ntwo\r\nthree\r\n')
    expect(mgr.snapshot(info.id, 2)).toEqual(['two', 'three'])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/session-manager.test.ts -t "headless screen"`
Expected: FAIL — `mgr.snapshot is not a function` (method not defined yet).

- [ ] **Step 3: Add the import**

In `src/main/session-manager.ts`, change the import block near L19 from:

```ts
import { ANSI_RE, extractPeekLines } from './peek'
```

to:

```ts
import { ANSI_RE, extractPeekLines } from './peek'
import { TerminalScreen } from './terminal-screen'
```

- [ ] **Step 4: Add the `screen` field to `Record_`**

In `src/main/session-manager.ts`, in the `interface Record_` block, add the field after `tail` (currently ~L77-78):

```ts
  /** Rolling tail of recent output, used to explain instant exits. */
  tail: string
  /** Headless xterm emulator rendering this pane's screen for the operator
   * (peek/output/instant-exit). Absent on browser panes and restored
   * placeholders — callers fall back to the byte tail. Disposed on close. */
  screen?: TerminalScreen
```

- [ ] **Step 5: Create + dispose the screen in `spawn`**

In `spawn`, the first statement captures the prior record's activity (currently `const activity = this.sessions.get(id)?.activity ?? []`). Replace that single line with a version that also disposes the previous screen (a restart replaces the record — the old emulator must not leak):

```ts
    // A restart replaces the pty (and the Record_), but the durable session's
    // activity history must survive — carry the existing ring forward. Dispose
    // the previous screen so a relaunch never leaks a headless emulator.
    const prev = this.sessions.get(id)
    prev?.screen?.dispose()
    const activity = prev?.activity ?? []
```

Then, in the successful-spawn record literal (currently ~L372-380), add `screen`:

```ts
    const rec: Record_ = {
      info,
      spec,
      pty,
      spawnedAt: this.now(),
      tail: '',
      screen: new TerminalScreen(80, 24),
      activity,
      guardOnCli
    }
```

(The `catch` branch's placeholder record ~L344-352 gets **no** screen — a launch that never produced a pty has nothing to render; leave it as-is.)

- [ ] **Step 6: Feed bytes in the `data` handler**

In the `pty.onData` closure (currently ~L382-392), add the screen write next to the tail update:

```ts
    pty.onData((d) => {
      if (this.disposed) return
      if (this.sessions.get(id) !== rec) return
      // Keep a generous raw tail. Two consumers: the instant-exit message
      // (last 160 cleaned chars — a front-cut escape fragment far upstream
      // can never reach it) and the approve peek (last few cleaned lines).
      // TUI agents redraw whole frames of ANSI per keystroke, so raw chars
      // are mostly escapes — 16 KiB keeps a real screenful of visible text.
      rec.tail = (rec.tail + d).slice(-16384)
      // Also render into the headless screen — the operator's readable channel.
      rec.screen?.write(d)
      this.dataCbs.forEach((cb) => cb(id, d))
    })
```

- [ ] **Step 7: Forward resize to the screen**

Replace `resize` (currently ~L474-480):

```ts
  resize(id: string, cols: number, rows: number): void {
    const rec = this.sessions.get(id)
    try {
      rec?.pty?.resize(cols, rows)
    } catch {
      /* dead pty */
    }
    rec?.screen?.resize(cols, rows)
  }
```

- [ ] **Step 8: Dispose the screen on close / delete / quit**

In `closeTerminal` (terminal branch), after `rec.pty = null` (currently ~L500), add:

```ts
    rec.pty = null
    rec.screen?.dispose()
    rec.screen = undefined
```

In `deleteSession`, after the `rec.pty?.kill()` try/catch and before `this.sessions.delete(id)` (currently ~L515), add:

```ts
    rec.screen?.dispose()
    this.sessions.delete(id)
```

In `disposeAll`, inside the loop after `rec.pty = null` (currently ~L664), add:

```ts
      rec.pty = null
      rec.screen?.dispose()
```

- [ ] **Step 9: Add the `snapshot` method**

In `src/main/session-manager.ts`, immediately above `peek` (currently ~L678), add:

```ts
  /**
   * The pane's full rendered screen (or the last `maxLines` non-empty lines),
   * read from the headless emulator. Fail-safe: on an unavailable/empty screen
   * (browser panes, restored placeholders, or a headless throw) it falls back
   * to the ANSI-stripped byte tail — reading pane content never throws.
   */
  snapshot(id: string, maxLines?: number): string[] {
    const rec = this.sessions.get(id)
    if (!rec) return []
    const lines = rec.screen?.snapshot(maxLines) ?? []
    if (lines.length > 0) return lines
    return extractPeekLines(rec.tail, maxLines ?? 200)
  }
```

- [ ] **Step 10: Run the new tests to verify they pass**

Run: `npx vitest run tests/unit/session-manager.test.ts -t "headless screen"`
Expected: PASS.

Run the whole file to confirm no regression: `npx vitest run tests/unit/session-manager.test.ts`
Expected: all pass (the pre-existing instant-exit tests still pass — `peek`/instant-exit are unchanged in this task).

- [ ] **Step 11: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add src/main/session-manager.ts tests/unit/session-manager.test.ts
git commit -m "$(cat <<'EOF'
feat: feed pty bytes into per-pane screen

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `peek()` reads the rendered screen

**Files:**
- Modify: `src/main/session-manager.ts` (`peek` ~L679-683)
- Test: `tests/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `SessionManager.snapshot(id, maxLines?)` (Task 2).
- Produces: `SessionManager.peek(id, maxLines = 5): string[]` — now returns the rendered screen's last `maxLines` non-empty lines, falling back to the byte tail. Same signature the control-api `output` verb already calls (control-api.ts:249).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/session-manager.test.ts` (inside `describe('SessionManager', ...)`):

```ts
  it('peek returns the rendered screen, not the raw byte tail', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    // A TUI redraw whose raw bytes would leak escape fragments through the
    // old ANSI-strip path; the rendered screen is clean.
    ptys[0].dataCb?.('[2J[H[38;5;246mProceed? (y/n)[0m\r\n')
    const lines = mgr.peek(info.id, 5)
    expect(lines).toContain('Proceed? (y/n)')
    expect(lines.join('\n')).not.toContain('246m')
  })

  it('peek falls back to extractPeekLines when there is no screen', () => {
    // A restored placeholder has a byte tail but no live screen — peek must
    // still return something readable rather than [].
    const restored = mgr.restore('rid', '/p', claudeSpec)
    // Reach the record's tail the way the manager would: restored sessions
    // start with an empty tail, so peek is [] — prove the fallback path runs
    // without throwing on a screenless record.
    expect(() => mgr.peek(restored.id, 5)).not.toThrow()
    expect(mgr.peek(restored.id, 5)).toEqual([])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/session-manager.test.ts -t "peek returns the rendered"`
Expected: FAIL — `peek` still returns `extractPeekLines(rec.tail, ...)`; the redraw's raw tail contains escape fragments, so `lines` does not contain the clean `'Proceed? (y/n)'` and/or contains `246m`.

- [ ] **Step 3: Change `peek` to delegate to `snapshot`**

Replace `peek` (currently ~L678-683):

```ts
  /** Last `maxLines` cleaned output lines — the approve control's peek and the
   * operator `output` verb. Reads the rendered screen (Task 2), falling back
   * to the ANSI-stripped byte tail when the screen is unavailable/empty. */
  peek(id: string, maxLines = 5): string[] {
    return this.snapshot(id, maxLines)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/session-manager.test.ts -t "peek"`
Expected: PASS.

Run the whole file: `npx vitest run tests/unit/session-manager.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/session-manager.ts tests/unit/session-manager.test.ts
git commit -m "$(cat <<'EOF'
feat: peek reads rendered screen snapshot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Instant-exit message uses the rendered snapshot

**Files:**
- Modify: `src/main/session-manager.ts` (instant-exit block ~L431-435)
- Test: `tests/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `Record_.screen?.snapshot()` (Task 2), existing `ANSI_RE` (fallback).
- Produces: no signature change — `rec.info.message` is now derived from the rendered screen, falling back to the old byte-tail expression.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/session-manager.test.ts`:

```ts
  it('instant-exit message uses the rendered screen, not the raw byte tail', () => {
    const info = mgr.create('/p', claudeSpec, 1)
    // Redraw sequence: clear + home + SGR 246 text. The old byte-tail path
    // would leak escape fragments; the rendered screen reads cleanly.
    ptys[0].dataCb?.('[2J[H[38;5;246mSession ended by server[0m')
    ptys[0].exitCb?.()
    const msg = mgr.list().find((s) => s.id === info.id)?.message ?? ''
    expect(msg).toContain('Session ended by server')
    expect(msg).not.toContain('246')
    expect(msg).not.toContain('')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/session-manager.test.ts -t "instant-exit message uses the rendered"`
Expected: FAIL — the message still comes from `rec.tail.replace(ANSI_RE, ...)`, which on this redraw leaves a `246`-style fragment (assertion `not.toContain('246')` fails).

- [ ] **Step 3: Change the instant-exit message derivation**

In the `pty.onExit` closure, replace the instant-exit block (currently ~L431-435):

```ts
      if (!rec.info.message && this.now() - rec.spawnedAt < INSTANT_EXIT_MS) {
        const tail = rec.tail.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim().slice(-160)
        rec.info.message = tail
          ? `Exited right away — last output: “${tail}”`
          : 'Exited right away with no output.'
```

with:

```ts
      if (!rec.info.message && this.now() - rec.spawnedAt < INSTANT_EXIT_MS) {
        // Prefer the rendered screen (clean, no mid-escape truncation like the
        // old "246m" leak); fall back to the ANSI-stripped byte tail when the
        // screen is empty/unavailable.
        const rendered = (rec.screen?.snapshot() ?? []).join(' ').replace(/\s+/g, ' ').trim().slice(-160)
        const tail =
          rendered || rec.tail.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim().slice(-160)
        rec.info.message = tail
          ? `Exited right away — last output: “${tail}”`
          : 'Exited right away with no output.'
```

(Leave the following two lines — the `if (resume) rec.info.resumeFailed = true` and the closing brace — unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/session-manager.test.ts -t "instant"`
Expected: PASS (the new test plus the pre-existing instant-exit tests — the rendered screen also cleanly contains "No conversation found" etc., satisfying their assertions).

Run the whole file: `npx vitest run tests/unit/session-manager.test.ts`
Expected: all pass. (`ANSI_RE` is still imported and used in the fallback, so no unused-import lint error.)

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/session-manager.ts tests/unit/session-manager.test.ts
git commit -m "$(cat <<'EOF'
fix: instant-exit msg uses screen snapshot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Prompt submission — two separate writes

**Files:**
- Modify: `src/main/control-api.ts` (`POST /panes/:handle/prompt` ~L238-243)
- Test: `tests/unit/control-api.test.ts` (existing assertions ~L200, L236, L294; new empty-text test)

**Interfaces:**
- Consumes: `deps.manager.write(handle, data)` (unchanged signature).
- Produces: the prompt route now issues `write(handle, b.text)` then `write(handle, '\r')` (two calls) instead of one combined `write(handle, \`${b.text}\r\`)`.

- [ ] **Step 1: Update the existing assertions to expect two writes (failing)**

In `tests/unit/control-api.test.ts`, change the three write-expectation assertions:

- `expect(writes).toEqual(['do it\r'])` (in "prompt writes text plus a trailing carriage return to the pty", ~L200) → `expect(writes).toEqual(['do it', '\r'])`
- `expect(writes).toEqual(['ls\r'])` (in "prompt allowed by the guard writes to the pty and emits no block", ~L236) → `expect(writes).toEqual(['ls', '\r'])`
- `expect(writes).toEqual(['do it\r'])` (in "prompt with no guard configured writes as before (back-compatible)", ~L294) → `expect(writes).toEqual(['do it', '\r'])`

Also add a new test directly after the "prompt writes text plus a trailing carriage return" test (~L201):

```ts
  it('empty prompt text submits a lone carriage return (bare Enter)', async () => {
    const { deps: d, grants, writes } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(
      d,
      'POST',
      '/panes/a-term/prompt',
      token,
      JSON.stringify({ text: '' })
    )
    expect(r.status).toBe(200)
    expect(writes).toEqual(['', '\r'])
  })
```

Also rename the first test's title for accuracy — change `'prompt writes text plus a trailing carriage return to the pty'` to `'prompt writes text then a carriage return as two writes'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/control-api.test.ts -t "prompt"`
Expected: FAIL — the route still does a single combined write, so `writes` equals `['do it\r']` / `['ls\r']`, not the two-element arrays; the empty-text test gets `['\r']`-shaped single write mismatch.

- [ ] **Step 3: Change the prompt route to two writes**

In `src/main/control-api.ts`, replace (currently ~L238-241):

```ts
      // Attachments are referenced by path in the prompt text by the operator;
      // v1 does not re-inject them separately (screenshot() already returns a
      // path the operator embeds). Write text + submit (carriage return).
      deps.manager.write(handle, `${b.text}\r`)
```

with:

```ts
      // Attachments are referenced by path in the prompt text by the operator;
      // v1 does not re-inject them separately (screenshot() already returns a
      // path the operator embeds). Write the text, THEN the carriage return as
      // its own chunk: sent separately, Claude's TUI treats the \r as a submit
      // keypress rather than absorbing it into the pasted text. Empty text
      // still yields a lone \r = a bare Enter (submit the composer).
      deps.manager.write(handle, b.text)
      deps.manager.write(handle, '\r')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/control-api.test.ts -t "prompt"`
Expected: PASS (including the guard-block test, which still writes nothing).

Run the whole file: `npx vitest run tests/unit/control-api.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/control-api.ts tests/unit/control-api.test.ts
git commit -m "$(cat <<'EOF'
fix: submit operator prompt as two writes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `needs-you` clears when work resumes (`PostToolUse`)

**Files:**
- Modify: `src/shared/types.ts` (`HookEventName` L3)
- Modify: `src/main/state-machine.ts` (`transition` L8-17)
- Modify: `src/main/hook-settings.ts` (`EVENTS` L6)
- Modify: `src/main/hook-server.ts` (`EVENT_NAMES` L13)
- Modify: `src/main/codex-hooks.ts` (full-tier `table` ~L88-92)
- Modify: `src/main/gemini-hooks.ts` (`buildGeminiHookSettings` hooks ~L53-65)
- Test: `tests/unit/state-machine.test.ts`, `tests/unit/hook-settings.test.ts`, `tests/unit/hook-server.test.ts`, `tests/unit/codex-hooks.test.ts`, `tests/unit/gemini-hooks.test.ts`

**Interfaces:**
- Consumes: existing `HookEventName` union, `transition`, `EVENTS`, `EVENT_NAMES`, `curlCommand`.
- Produces:
  - `HookEventName` now includes `'PostToolUse'`.
  - `transition(current, 'PostToolUse')` returns `'working'` (unless `current === 'exited'`, which stays `'exited'`).
  - Claude/Codex(full)/Gemini hook injections emit a `PostToolUse` event to `/event`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/state-machine.test.ts`, add inside `describe('transition', ...)`:

```ts
  it('goes working on PostToolUse (an approved tool executing clears needs-you)', () => {
    expect(transition('needs-you', 'PostToolUse')).toBe('working')
    expect(transition('working', 'PostToolUse')).toBe('working')
    expect(transition('idle', 'PostToolUse')).toBe('working')
  })
  it('needs-you stays needs-you on a pending Notification', () => {
    expect(transition('needs-you', 'Notification')).toBe('needs-you')
  })
  it('exited stays exited on PostToolUse (late event ignored)', () => {
    expect(transition('exited', 'PostToolUse')).toBe('exited')
  })
```

In `tests/unit/hook-settings.test.ts`, replace the loop array in the "creates a curl hook for each of the three events" test — change its title to `'creates a curl hook for each emitted event'` and the loop to include PostToolUse:

```ts
    for (const name of ['UserPromptSubmit', 'Notification', 'Stop', 'PostToolUse']) {
```

In `tests/unit/hook-server.test.ts`, add a test asserting `PostToolUse` is accepted by `parseHookBody` (follow the existing style in that file — it imports `parseHookBody`). Add:

```ts
  it('accepts PostToolUse as a valid event', () => {
    expect(parseHookBody(JSON.stringify({ paneId: 'p1', event: 'PostToolUse' }))).toEqual({
      paneId: 'p1',
      event: 'PostToolUse'
    })
  })
```

(If `parseHookBody` is not already imported in that file, add it to the import from `'../../src/main/hook-server'`.)

In `tests/unit/codex-hooks.test.ts`, add inside the full-tier `describe`/test area (the "tier 'full'" test builds the args and joins them; mirror its style):

```ts
  it("tier 'full' emits a PostToolUse event for parity", () => {
    const args = buildCodexHookArgs('p1', 4242, 'tok', 'full', null)
    const joined = args.join(' ')
    expect(joined).toContain('\\"event\\":\\"PostToolUse\\"')
  })
```

In `tests/unit/gemini-hooks.test.ts` (create the file if it does not exist), add:

```ts
import { describe, it, expect } from 'vitest'
import { buildGeminiHookSettings } from '../../src/main/gemini-hooks'

describe('buildGeminiHookSettings PostToolUse parity', () => {
  it('emits a PostToolUse event via an AfterTool hook', () => {
    const s = buildGeminiHookSettings('p1', 4242, 'tok', null) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const cmd = s.hooks.AfterTool[0].hooks[0].command
    expect(cmd).toContain('"event":"PostToolUse"')
    expect(cmd).toContain('http://127.0.0.1:4242/event')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/state-machine.test.ts tests/unit/hook-settings.test.ts tests/unit/hook-server.test.ts tests/unit/codex-hooks.test.ts tests/unit/gemini-hooks.test.ts`
Expected: FAIL — TypeScript will also flag `'PostToolUse'` as not assignable to `HookEventName` in some tests; the state-machine test fails because `transition` returns `undefined` for `PostToolUse`; hook-settings/hook-server/codex/gemini tests fail because the event is not emitted/whitelisted.

- [ ] **Step 3: Add `PostToolUse` to `HookEventName`**

In `src/shared/types.ts`, replace L3:

```ts
export type HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'
```

with:

```ts
export type HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop' | 'PostToolUse'
```

- [ ] **Step 4: Add the `PostToolUse → working` transition**

In `src/main/state-machine.ts`, add a case to the `switch` (after `case 'UserPromptSubmit':`):

```ts
    case 'UserPromptSubmit':
      return 'working'
    case 'PostToolUse':
      // An approved tool actually executing = working again — clears a
      // mid-turn needs-you that Notification set. A pending tool (Notification,
      // not yet run) stays needs-you. Harmless (redundant) on auto-approved
      // tools, which already went working via UserPromptSubmit.
      return 'working'
    case 'Notification':
      return 'needs-you'
```

(Adding the `PostToolUse` case is required for exhaustiveness now that the union grew — without it `transition` can return `undefined` and `tsc` errors.)

- [ ] **Step 5: Emit `PostToolUse` from Claude hooks**

In `src/main/hook-settings.ts`, replace L6:

```ts
const EVENTS: HookEventName[] = ['UserPromptSubmit', 'Notification', 'Stop']
```

with:

```ts
const EVENTS: HookEventName[] = ['UserPromptSubmit', 'Notification', 'Stop', 'PostToolUse']
```

- [ ] **Step 6: Whitelist `PostToolUse` on the hook server**

In `src/main/hook-server.ts`, replace L13:

```ts
const EVENT_NAMES = ['UserPromptSubmit', 'Notification', 'Stop'] as const
```

with:

```ts
const EVENT_NAMES = ['UserPromptSubmit', 'Notification', 'Stop', 'PostToolUse'] as const
```

- [ ] **Step 7: Emit `PostToolUse` from Codex full-tier (parity)**

In `src/main/codex-hooks.ts`, replace the full-tier `table` (currently ~L88-92):

```ts
  const table: [string, HookEventName][] = [
    ['UserPromptSubmit', 'UserPromptSubmit'],
    ['PermissionRequest', 'Notification'],
    ['Stop', 'Stop']
  ]
```

with:

```ts
  // PostToolUse rides along for parity with Claude (needs-you clears mid-turn).
  // UNVERIFIED like the rest of this grammar: if Codex has no 'PostToolUse'
  // hook name it simply never fires (silent degradation), never on the wrong
  // condition — same "never wrong-but-confident" contract as the module doc.
  const table: [string, HookEventName][] = [
    ['UserPromptSubmit', 'UserPromptSubmit'],
    ['PermissionRequest', 'Notification'],
    ['PostToolUse', 'PostToolUse'],
    ['Stop', 'Stop']
  ]
```

- [ ] **Step 8: Emit `PostToolUse` from Gemini (parity)**

In `src/main/gemini-hooks.ts`, in `buildGeminiHookSettings`, add an `AfterTool` entry to the `hooks` object (currently ~L53-65). Insert it after the `AfterAgent` entry:

```ts
    AfterAgent: [
      { hooks: [{ type: 'command', command: curlCommand(paneId, port, token, 'Stop') }] }
    ],
    // Parity with Claude's PostToolUse: an executed tool = working again,
    // clearing a mid-turn needs-you. UNVERIFIED Gemini hook name (degrades to
    // no signal if wrong, never fires on the wrong condition).
    AfterTool: [
      { hooks: [{ type: 'command', command: curlCommand(paneId, port, token, 'PostToolUse') }] }
    ]
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run tests/unit/state-machine.test.ts tests/unit/hook-settings.test.ts tests/unit/hook-server.test.ts tests/unit/codex-hooks.test.ts tests/unit/gemini-hooks.test.ts`
Expected: all pass.

- [ ] **Step 10: Typecheck + full suite (guards against fallout elsewhere)**

Run: `npm run typecheck`
Expected: no errors (the new union member is handled everywhere it is switched on).

Run: `npm run test`
Expected: all pass (activity-feed / applyHookEvent paths accept the new kind — `ActivityEventKind` includes `HookEventName`, so no further change needed).

- [ ] **Step 11: Commit**

```bash
git add src/shared/types.ts src/main/state-machine.ts src/main/hook-settings.ts src/main/hook-server.ts src/main/codex-hooks.ts src/main/gemini-hooks.ts tests/unit/state-machine.test.ts tests/unit/hook-settings.test.ts tests/unit/hook-server.test.ts tests/unit/codex-hooks.test.ts tests/unit/gemini-hooks.test.ts
git commit -m "$(cat <<'EOF'
fix: clear needs-you on PostToolUse

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

**Manual verification checklist (post-merge, against real agents):**
- Claude Code: approve a tool mid-turn → pane goes yellow (needs-you) then back to green (working) as the tool runs, without waiting for turn-end. Confirms `PostToolUse` fires and the transition clears needs-you.
- Codex `full` tier: confirm the actual Codex hook name for post-tool execution; if it differs from `PostToolUse`, the mapping simply never fires (correct the codex event name string when verified).
- Gemini: confirm the actual `AfterTool` hook name; correct if Gemini uses a different name.

---

## Task 7: Replay the pane's screen on renderer view-return

**Component-7 resolution (read from `src/renderer/src/App.tsx`):** In `App.tsx` the environment grid — and therefore every `TerminalPane` — is rendered inside a conditional branch: `{showEnvironment ? (<grid/>) : view === 'changes' ? ... : ...}` (App.tsx:827-956). `showEnvironment = view === 'environment' && sessions.some(...)` (App.tsx:681-682). When the user switches to Settings / Cockpit / Changes / Activity / Home, `showEnvironment` becomes false and the grid subtree is **unmounted** — each `TerminalPane`'s cleanup runs `term.dispose()` (TerminalPane.tsx:71). On return, a **fresh, empty** xterm is created (TerminalPane.tsx:44-75) whose `onData` only receives *new* pty bytes, so the pane is blank until a keystroke provokes a redraw. This is the **UNMOUNTED** branch of the spec: on (re)mount, replay the pane's current rendered screen (from the headless emulator, exposed via a new IPC read) into the fresh terminal, then fit + refresh.

**Files:**
- Modify: `src/main/index.ts` (add `session:snapshot` handler near the `session:peek` handler ~L687-691)
- Modify: `src/preload/index.ts` (add `snapshotSession` near `peekSession` ~L40)
- Modify: `src/shared/api.ts` (add `snapshotSession` near `peekSession` ~L87)
- Modify: `src/renderer/src/components/TerminalPane.tsx` (mount effect ~L44-75)
- Verification: `npm run e2e` / manual (visual/paint behavior)

**Interfaces:**
- Consumes: `SessionManager.snapshot(id)` (Task 2, full screen with byte-tail fallback).
- Produces:
  - IPC channel `session:snapshot` → `manager.snapshot(id)` (returns `string[]`).
  - `window.localflow.snapshotSession(id: string): Promise<string[]>` (preload + `LocalflowApi` type).

- [ ] **Step 1: Add the main-process IPC handler**

In `src/main/index.ts`, immediately after the `session:peek` handler (currently ~L687-691), add:

```ts
  ipcMain.handle('session:snapshot', (_e, id: string) => manager.snapshot(id))
```

- [ ] **Step 2: Add the preload bridge**

In `src/preload/index.ts`, after the `peekSession` line (currently ~L40), add:

```ts
  snapshotSession: (id: string) => ipcRenderer.invoke('session:snapshot', id),
```

- [ ] **Step 3: Add the API type**

In `src/shared/api.ts`, after the `peekSession` declaration (currently ~L87), add:

```ts
  /** The pane's full rendered screen — replayed into a fresh xterm on
   *  view-return so the pane isn't blank until the next keystroke. */
  snapshotSession(id: string): Promise<string[]>
```

- [ ] **Step 4: Replay the snapshot on (re)mount**

In `src/renderer/src/components/TerminalPane.tsx`, replace the mount effect (currently L44-75):

```tsx
  useEffect(() => {
    if (!alive || !hostRef.current) return
    const term = new Terminal({
      fontSize: terminalTheme.fontSize,
      fontFamily: terminalTheme.fontFamily,
      theme: terminalTheme.theme
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    window.localflow.resize(session.id, term.cols, term.rows)
    const offData = window.localflow.onData((id, data) => {
      if (id === session.id) term.write(data)
    })
    const onInput = term.onData((d) => window.localflow.write(session.id, d))
    const ro = new ResizeObserver(() => {
      fit.fit()
      window.localflow.resize(session.id, term.cols, term.rows)
    })
    ro.observe(hostRef.current)
    return () => {
      offData()
      onInput.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [session.id, alive])
```

with:

```tsx
  useEffect(() => {
    if (!alive || !hostRef.current) return
    const term = new Terminal({
      fontSize: terminalTheme.fontSize,
      fontFamily: terminalTheme.fontFamily,
      theme: terminalTheme.theme
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    window.localflow.resize(session.id, term.cols, term.rows)
    // Switching views unmounts the grid (App.tsx), so returning creates a
    // FRESH xterm whose onData only sees NEW pty bytes — the pane would be
    // blank until a keystroke provokes a redraw. Replay the pane's current
    // rendered screen (from the headless emulator in main) so it paints its
    // last frame immediately. Guarded against a mount that already tore down.
    let cancelled = false
    void window.localflow.snapshotSession(session.id).then((lines) => {
      if (cancelled || termRef.current !== term) return
      if (lines.length > 0) term.write(lines.join('\r\n'))
      term.refresh(0, term.rows - 1)
    })
    const offData = window.localflow.onData((id, data) => {
      if (id === session.id) term.write(data)
    })
    const onInput = term.onData((d) => window.localflow.write(session.id, d))
    const ro = new ResizeObserver(() => {
      fit.fit()
      window.localflow.resize(session.id, term.cols, term.rows)
    })
    ro.observe(hostRef.current)
    return () => {
      cancelled = true
      offData()
      onInput.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [session.id, alive])
```

- [ ] **Step 5: Typecheck (covers IPC/preload/api wiring)**

Run: `npm run typecheck`
Expected: no errors — `snapshotSession` is declared on `LocalflowApi`, implemented in preload, and consumed in `TerminalPane` with matching `Promise<string[]>` shape.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Verify behavior (build + manual/e2e — this is a paint behavior)**

Automated wiring is covered by `SessionManager.snapshot` unit tests (Task 2) and typecheck. The replay itself is a render/paint behavior, so verify it live:

Run: `npm run build`
Expected: build succeeds.

Manual check (or extend an existing playwright e2e that navigates views):
1. Launch the app, create/open a pane with visible content (e.g. run a command so the screen has text).
2. Switch to the Settings view (sidebar), then back to the environment view.
3. **Expected:** the pane immediately shows its last screen content — no blank pane, no keystroke needed.

If adding to `npm run e2e`: assert that after toggling to Settings and back, the pane's `.xterm-rows` text content is non-empty without sending any key. Mark this step done once the manual check passes (paint behavior — no pure-unit assertion is meaningful).

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/shared/api.ts src/renderer/src/components/TerminalPane.tsx
git commit -m "$(cat <<'EOF'
fix: replay screen on pane view-return

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Terminal bottom-row clipping

**Component-8 root cause (read from `styles.css` + FitAddon):** `.term-host` carries `padding: 4px` (styles.css:284-288) and xterm's `.xterm` element is opened directly into it with **no** padding of its own. `FitAddon.fit()` computes rows from the parent's height minus the `.xterm` element's *own* padding (which is zero here) — so it over-computes by the host's 8px vertical padding. The `.xterm` box is then inset 4px inside the host but sized for the full height, pushing its last row(s) past the host's padding box, where the pane's `overflow-hidden` (TerminalPane.tsx:102) clips them and the colored status border appears not to reach the bottom. Fix: move the inset onto the `.xterm` element so `FitAddon` subtracts it and rows fit exactly.

**Files:**
- Modify: `src/renderer/src/styles.css` (`.term-host` rule L284-288)
- Verification: `npm run e2e` / manual (layout/paint behavior)

**Interfaces:**
- Consumes: existing `.term-host` host `<div>` and xterm's injected `.xterm` element.
- Produces: no code interface change — a CSS sizing correction.

- [ ] **Step 1: Change the host padding to element padding**

In `src/renderer/src/styles.css`, replace the `.term-host` rule (L284-288):

```css
/* xterm sizing */
.term-host {
  flex: 1;
  min-height: 0;
  padding: 4px;
}
```

with:

```css
/* xterm sizing. Put the 4px inset on the .xterm element itself, not the host:
   FitAddon subtracts the terminal element's own padding when computing rows,
   so this keeps the visual inset while making the row count fit the true
   content height (no clipped last row, and the status border reaches the
   bottom edge). */
.term-host {
  flex: 1;
  min-height: 0;
}
.term-host .xterm {
  box-sizing: border-box;
  height: 100%;
  padding: 4px;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Verify behavior (manual/e2e — layout/paint behavior)**

This is a layout/paint behavior with no meaningful pure-unit assertion. Verify live:
1. Launch the app and open a terminal pane with enough output to fill it.
2. **Expected:** the final terminal row is fully visible (not clipped at the bottom), and the pane's colored status border reaches the bottom edge on all four sides.
3. Resize the window and re-check — no persistent partial bottom row after a fit.

If adding to `npm run e2e`: assert the `.xterm-screen` bottom does not exceed the `.pane` content box (its `getBoundingClientRect().bottom` is within the pane's inner bottom). Mark done once the manual check passes.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/styles.css
git commit -m "$(cat <<'EOF'
fix: terminal bottom-row clipping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all tasks)

- [ ] Run the full gate: `npm run check`
Expected: lint clean, typecheck clean, all vitest suites pass.

- [ ] Build once more: `npm run build`
Expected: success.

- [ ] Manual smoke of the operator loop (Tasks 3, 5, 6, 7, 8 together): with an operator granted on an environment, drive a Claude pane via the control API — `GET /panes/:handle/output` returns readable rendered dialog (not `246m` garbage); `POST /panes/:handle/prompt` submits (the composer sends); approving a tool mid-turn clears `needs-you`; switching views and back shows the pane's screen immediately; the last row is fully visible.

---

## Self-Review notes (author checklist, completed)

- **Spec coverage:** Components 1-8 map to Tasks 1, 2, 3, 4, 5, 6, 7, 8 respectively. Global Constraints (fail-safe fallback, scrollback:1000, one-per-pane, dispose-on-close, single new dep, commitlint) are enforced in Tasks 1-4 (fail-safe in `TerminalScreen` + `snapshot`/`peek`/instant-exit fallbacks) and Task 1 (dep). The `needs-you` fix is the only intended status change (Task 6).
- **Fail-safe rule:** `TerminalScreen` swallows every throw and returns `[]`; `SessionManager.snapshot` (and thus `peek`, `output`, and the instant-exit message) falls back to `extractPeekLines`/`ANSI_RE` on empty/unavailable screen. Tested in Task 1 (throw-safe) and Task 3 (screenless fallback).
- **Type consistency:** `snapshot(id, maxLines?)` / `TerminalScreen.snapshot(maxLines?)` / `snapshotSession(id)` / `peek(id, maxLines)` signatures are used identically across Tasks 2, 3, 4, 7. `HookEventName` gains `'PostToolUse'` once (Task 6, Step 3) and every switch/whitelist that consumes it is updated in the same task.
- **Hidden-vs-unmounted (Component 7):** resolved to **unmounted** from `App.tsx:681-682, 827-956`; the pinned fix is the replay-on-mount branch.
