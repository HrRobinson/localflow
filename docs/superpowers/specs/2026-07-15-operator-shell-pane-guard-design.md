# Operator Shell-Pane Guard — Design

**Date:** 2026-07-15
**Status:** Approved (design), pending spec review
**Feature:** Close lfguard G2's one coverage gap — raw operator bytes written to a
pane via the control API bypass every agent hook and reach the pty unguarded.

## Problem

lfguard G2 wired the command guard into all three agents (Claude / Codex / Gemini)
as native pre-tool blocking hooks. That covers commands an *agent* decides to run.
It does **not** cover the operator control-API path:

`POST /panes/:handle/prompt` → `deps.manager.write(handle, `${text}\r`)` → pty

The operator can drive any terminal pane by POSTing prompt text, which is written to
the pty verbatim followed by a carriage return (submitting it). For agent panes this
text is a prompt (the agent's own PreToolUse hook still guards anything the agent
then runs). But for shell / custom panes (`hookAdapter: 'none'`) the text **is** the
command line being submitted to a raw shell — with no hook in front of it. That is
the gap.

## Decision: guard every operator prompt write

The guard check runs on **every** operator prompt write, regardless of pane type
(defense-in-depth), not only on unguarded shell/custom panes. Rationale:

- The false-positive cost is low. lfguard denies *specific catastrophic command
  shapes*, not prose. Ordinary prompt prose ("delete the old migrations") tokenizes
  to a harmless argv and passes; only text that literally *is* a destructive command
  is stopped — which is acceptable even when the target is an agent.
- It is the simplest rule (no pane-type branching on the write path) and the most
  defensible security posture: the operator control API is a remote-drive surface,
  so every write through it is checked.
- The real cost is one subprocess per prompt write, bounded by a fail-open timeout
  (below). This is acceptable — prompt writes are human-paced, not a hot loop.

Browser panes are excluded by construction: the `prompt` route already returns 400
for `session.kind !== 'terminal'`, so only terminal panes reach the guard.

## Architecture

The guard logic lives in a dedicated, injectable unit; the control-API handler owns
the side effects; `index.ts` wires the binary + pack config; the console `guard`
source and `toGuardEvent` mapper from G2 are reused unchanged.

```
POST /panes/:handle/prompt (control-api.ts)
  ├─ existing checks: kind==terminal, status!=exited, typeof text==string
  ├─ deps.guard.check(text)  ──►  operator-guard.ts
  │                                  spawn: lfguard test <text> --pack <ids…>
  │                                  (argv array, NO shell — text is one argv elem)
  │                                  exit 1 → deny (parse stderr)  |  exit 0 → allow
  │                                  missing bin / spawn err / timeout / other → allow
  ├─ allow  → deps.manager.write(handle, `${text}\r`)   (unchanged)
  └─ deny   → three signals:
       • deps.manager.emitNotice(handle, "⛔ lfguard blocked: <reason>")
       • deps.onGuardBlock(record, environment)  → consoleBus.emit(toGuardEvent(...))
       • return 403 { error, reason, pack }
```

### Why a shell is never involved

`operator-guard.check` spawns the binary directly with an **argv array**
(`['test', text, '--pack', id, …]`), not through a shell. Consequences:

- The operator's text is passed as a single argv element. No quoting, escaping, or
  injection concerns on *our* side.
- Multi-line / pasted / chained text passes through verbatim. lfguard's own
  hand-rolled tokenizer segments it (`;`, `&&`, `|`, newlines, `$(…)`, `bash -c`) —
  which is exactly what the engine is built for. We do **not** pre-split the text.

### The deny signal is the exit code; stderr is enrichment

`lfguard test <cmd>` (see `guard/crates/lfguard/src/main.rs`):
- **exit 0** = allow.
- **exit 1** = deny, and prints to stderr exactly:
  `lfguard: BLOCKED by <pack>: <reason>[ (inline: <i>)]`
- `--pack <id>` is a global flag (repeatable), additively enabling opt-in packs on
  top of the always-on `core.*` packs.

The parser matches the last `lfguard: BLOCKED by (<pack>): (<reason>)` line to
populate `pack` and `reason`. If the parse misses (format drift, prefix noise), we
**still deny** with `reason: 'blocked by command guard', pack: 'unknown'` — the exit
code is authoritative, stderr is best-effort enrichment.

## Components

### 1. `src/main/operator-guard.ts` (new)

Pure, injectable, no Electron/HTTP dependencies. Unit-testable with an injected
spawn.

```ts
export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; pack: string }

export interface OperatorGuardOptions {
  resolveBinary: () => string | null   // resolveGuardBinary()
  getPacks: () => string[]             // config registry getGuardPacks()
  spawn?: SpawnFn                       // injected in tests; defaults to child_process.spawn
  timeoutMs?: number                    // default 2000
}

export interface OperatorGuard {
  check(command: string): Promise<GuardVerdict>
}

export function makeOperatorGuard(opts: OperatorGuardOptions): OperatorGuard
```

`check(command)` behavior:

1. If `command.trim() === ''` → resolve `{ allowed: true }` (no spawn).
2. If `resolveBinary()` returns null → resolve `{ allowed: true }` (fail-open; no
   binary bundled, same as G2's fail-open when the binary is absent).
3. Spawn `binary` with argv `['test', command, ...packs.flatMap(p => ['--pack', p])]`.
4. Race the child against `timeoutMs` (default **2000**):
   - **exit code 1** → parse stderr; resolve `{ allowed: false, reason, pack }`.
   - **exit code 0** → resolve `{ allowed: true }`.
   - **any other exit code** → resolve `{ allowed: true }` (fail-open).
   - **spawn 'error' event** (e.g. ENOENT) → resolve `{ allowed: true }` (fail-open).
   - **timeout** → kill the child, resolve `{ allowed: true }` (fail-open).
5. Resolve exactly once (guard against double-resolve across error/exit/timeout).

**Fail-open is absolute.** Any failure mode of the guard itself results in the write
being allowed. The guard must never make a legitimate prompt write impossible — worst
case is unguarded, never stuck. (Matches lfguard's project-wide invariant.)

### 2. `src/main/control-api.ts` (modify)

`ControlDeps` additions:

```ts
  manager: Pick<SessionManager, 'write' | 'peek' | 'getGroup' | 'emitNotice'>
  guard?: { check(command: string): Promise<GuardVerdict> }
  onGuardBlock?: (record: GuardAuditRecord, environment: number) => void
```

In the `prompt` branch, after the existing `kind` / `exited` / `text` validation and
before `deps.manager.write`:

```ts
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
deps.manager.write(handle, `${b.text}\r`)
record('POST prompt', handle, b.text.slice(0, 80))
return json(200, { ok: true })
```

`guard` is optional so the control server (and its tests) work unchanged when no
guard is wired.

### 3. `src/main/session-manager.ts` (modify)

Add a small public method that reuses the existing `dataCbs` renderer fan-out — the
same mechanism as the instant-exit message and the Task-11 relaunch notice:

```ts
/** Push a synthetic line to the pane's renderer WITHOUT writing to the pty. */
emitNotice(id: string, text: string): void {
  this.dataCbs.forEach((cb) => cb(id, text))
}
```

Renderer-only: it never touches the pty, so a shell prompt line isn't disturbed. On a
full-screen TUI agent pane the notice may be redrawn over — acceptable, since the 403
response and the console `guard` row are the durable signals; the pane echo is
best-effort visibility.

### 4. `src/main/index.ts` (modify)

Build the guard from the pieces already in scope — `index.ts` already resolves the
binary once into `guardBin` (line 180) and holds the `AgentRegistry` as `registry`
(which owns `getGuardPacks()`, used at line 187 and 831). Reuse both; do **not**
re-resolve the binary:

```ts
const operatorGuard = makeOperatorGuard({
  resolveBinary: () => guardBin,               // already resolved above; null when absent
  getPacks: () => registry.getGuardPacks()     // AgentRegistry, same source as G2 hooks
})
// …in startControlServer({ … }):
  guard: operatorGuard,
  onGuardBlock: (r, env) => consoleBus.emit(toGuardEvent(r, env)),
```

`toGuardEvent` and the console `guard` source already exist (G2, Task 8). No new
console plumbing, no new console source, no new dependency.

## Data flow (deny path, end to end)

1. Operator `POST /panes/pane-7/prompt { text: "rm -rf /" }`.
2. Handler validates, calls `deps.guard.check("rm -rf /")`.
3. `operator-guard` spawns `lfguard test "rm -rf /"` → exit 1, stderr
   `lfguard: BLOCKED by core.filesystem: catastrophic recursive delete of /`.
4. Parsed → `{ allowed: false, reason: "catastrophic recursive delete of /",
   pack: "core.filesystem" }`.
5. Handler: `emitNotice("pane-7", "\r\n⛔ lfguard blocked: catastrophic recursive
   delete of /\r\n")` → renderer shows the line in pane-7.
6. Handler: `onGuardBlock({ ts, tag: "pane-7", command: "rm -rf /", reason, pack },
   env)` → `consoleBus.emit(toGuardEvent(...))` → bottom-console `guard` row.
7. Handler returns `403 { error: "blocked by command guard", reason, pack }`.
8. `manager.write` is **never** called — nothing reaches the pty.

## Error handling / invariants

- **Fail-open, everywhere.** Missing binary, spawn error, timeout, or any non-0/1
  exit code → the write is allowed. A broken guard never blocks a legitimate write.
- **Synchronous enforcement.** The check is `await`ed before the write, so it cannot
  be bypassed by racing the write ahead of the verdict.
- **Every deny yields all three signals** (403 response, console `guard` row, pane
  echo). No silent blocks.
- **Bounded latency.** One subprocess per prompt write, capped at 2000ms. The
  expected latency is ~2–5ms, dominated by OS process-spawn overhead (`fork`/`exec`),
  NOT by the guard logic — the Rust engine's tokenize-and-match runs in microseconds
  and is a rounding error inside the spawn cost. The 2000ms cap is a catastrophe
  backstop (wedged process / stuck FS), never the normal path; nothing legitimate
  approaches it. Prompt writes are human-paced, so this is imperceptible. It is the
  same per-command spawn cost G2's agent hooks already pay.
- **Back-compatible.** `guard` / `onGuardBlock` are optional deps; omitting them
  restores the prior behavior exactly (write straight through).

## Testing

### `tests/unit/operator-guard.test.ts` (new)

Injected `spawn` returning a controllable fake child (fires `stderr` data,
`close`/`exit` with a chosen code, or an `error` event); injected/short `timeoutMs`.

- deny: exit 1 + stderr `lfguard: BLOCKED by core.filesystem: catastrophic rm` →
  `{ allowed: false, reason: 'catastrophic rm', pack: 'core.filesystem' }`.
- allow: exit 0 → `{ allowed: true }`.
- unparseable stderr but exit 1 → still `allowed:false`, `reason:'blocked by command
  guard'`, `pack:'unknown'`.
- fail-open on spawn `error` (ENOENT) → `{ allowed: true }`.
- fail-open on timeout (child never exits) → `{ allowed: true }`, child killed.
- fail-open on other exit code (e.g. 2) → `{ allowed: true }`.
- empty / whitespace command → `{ allowed: true }`, spawn NOT called.
- null binary (`resolveBinary` returns null) → `{ allowed: true }`, spawn NOT called.
- packs forwarded: `getPacks` returns `['cloud.gcloud','db.postgres']` → spawn argv
  contains `--pack cloud.gcloud --pack db.postgres`.
- resolves exactly once (fire exit AND error → single resolution).

### `tests/unit/control-api.test.ts` (extend)

Stub `deps.guard.check` and spy `manager.write` / `manager.emitNotice` /
`onGuardBlock`.

- deny verdict → 403 with `{ error, reason, pack }`; `emitNotice` called with the
  reason; `onGuardBlock` called with a record carrying `tag: handle` and the command;
  `manager.write` NOT called.
- allow verdict → `manager.write` called with `${text}\r`; `emitNotice` /
  `onGuardBlock` NOT called; 200.
- `guard` undefined → `manager.write` called; back-compatible; 200.

## Out of scope (YAGNI)

- No observe/audit-only mode — enforcement only, consistent with G2.
- No per-pane guard on/off — the global pack toggles (Settings, G2 Task 7) already
  govern which packs are active; this path reuses them via `getGuardPacks()`.
- No re-implementation of tokenization/segmentation in JS — the Rust engine owns it;
  we pass raw text.
- No guarding of raw interactive keystrokes / `session-manager.write()` at large —
  that path carries control bytes on the hot typing path and is the wrong layer.
```
