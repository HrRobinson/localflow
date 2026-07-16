# Codex Guard "Enforcement Not Yet Observed" Self-Verification Badge: Design Spec

**Date:** 2026-07-16
**Status:** Approved — decisions resolved, buildable. Option B (invocation-signal), bounded per-pane marker mechanism.
**Builds on:** the shipped guard-hook pipeline (`guard-hook.ts` → `codex-hooks.ts`/`hook-adapter.ts` →
`session-manager.ts` spawn), the guard audit log (`guard-audit-tail.ts` → `console-bus.ts` → `Console.tsx`),
the M2 status-adapter tiers (`docs/superpowers/specs/2026-07-07-m2-status-adapters-design.md`), and lfguard
G2 (`docs/superpowers/specs/2026-07-15-lfguard-g2-design.md`).
**Supersedes:** the earlier DRAFT (`draft-spec-codex-selfverify.md`), which spec'd the deny-only audit signal
(Option C / "1a"). That approach is REPLACED by the bounded invocation-marker mechanism below; the DRAFT's
Problem analysis, the "what is observable" investigation, and the HookEvent rule-out remain valid and are
carried forward.

---

## Problem

`buildCodexHookArgs` (`src/main/codex-hooks.ts:63-100`) unconditionally injects
`-c hooks.PreToolUse=[...]` + `--dangerously-bypass-hook-trust` whenever a guard binary is resolved, for
**both** shipped Codex tiers (`cli-args-full` and the currently-live `cli-args-notify`). The `-c`
TOML-override grammar is explicitly flagged in that file's docblock as an unverified guess — `codex` is not
installed on this machine, and there is no CI path to install it (proprietary/authenticated CLI, the same
constraint the M2 spec hit).

`session-manager.ts` already has one fail-open net: `guardOnCli` (set true only for Codex's `cli-args-*`
adapters when a guard actually resolved) gates a relaunch when the pane exits within `INSTANT_EXIT_MS`
(5000ms) of spawn — the "grammar rejected → Codex refuses to start → instant exit" case
(`session-manager.ts:369-371, 415-426`). That net does not, and cannot, catch the more dangerous case this
spec addresses:

> The `-c hooks.PreToolUse=...` flag is silently accepted by Codex's CLI parser (or silently ignored — an
> unknown `-c` key, a matcher grammar Codex doesn't recognize, a hooks-array shape it parses differently
> than assumed), the pane starts and runs completely normally, and the guard hook simply never fires for the
> life of the session. The pane is indistinguishable from a correctly-guarded one: alive, no error message,
> `guardOnCli` was true so the code *believes* protection is wired. The user runs commands all session
> believing lfguard is standing behind them. It is not.

This is worse than the instant-exit case precisely because it produces no signal at all today — a
confident-but-wrong state, not a degraded-but-honest one. It violates the codebase's own stated design
philosophy (M2 spec, Codex tier-default rationale: "none of them produce a wrong-but-confident state" was
the explicit bar for what's safe to ship).

### The one-sided-signal honesty constraint (load-bearing)

The indicator can only ever be as honest as the signal underneath it, and the signal here is **strictly
one-sided**:

- **A positive observation is airtight.** If lfguard's `check` command runs *even once* for a given pane,
  that is direct proof that Codex actually invoked the configured `-c hooks.PreToolUse=...` command, that
  `lfguard` actually ran, and therefore that the injected `-c` grammar was accepted and honored for that
  pane, this session. Nothing about the parsing-uncertainty in `codex-hooks.ts`'s docblock survives a single
  observed invocation.
- **The absence of an observation proves nothing.** A pane that has simply not run a tool-call command yet,
  and a pane whose guard hook is silently broken, look **identical** until the first command flows. There is
  no timeout at which silence becomes evidence of breakage.

Therefore the badge is **honest only in one direction**: it may say "not yet observed" (a true statement of
ignorance) and it may go quiet once observed (a true statement of proof). It must **never** claim the guard
is broken/unguarded from silence alone, and it must **never** claim the guard is "confirmed working" beyond
the single fact the signal supports (the hook fired at least once this session). This asymmetry drives every
UX decision below.

### Why the invocation marker, not the deny audit log (RESOLVED — mechanism decision)

The DRAFT proposed deriving the signal from the existing deny-only audit log (`append_audit` fires only on
`Decision::Deny`). That is **rejected as the mechanism** because it is *doubly* one-sided: it fires only when
a command is *both* run *and* denied by an active pack. For `core.filesystem`/`core.git` that is a tiny
minority of ordinary agent activity, so a correctly-guarded, well-behaved Codex pane would show "not yet
observed" for its entire life — training users to ignore the badge (alert fatigue defeats the whole point).

**RESOLVED:** the signal is a **bounded per-pane invocation marker** written on *every* `check`
evaluation (allow OR deny), so the badge clears on the pane's *first tool-call command* regardless of
verdict. This is a first-invocation signal, not a first-deny signal. The deny audit log is left **exactly
as-is** — denies still produce `source: 'guard'` console rows; allows still produce no console row. The
marker is a separate, tiny, overwrite-in-place file, described next.

---

## RESOLVED decisions (locked)

1. **Option B — clears on first observed invocation (allow OR deny), not only on deny.** RESOLVED.
2. **Mechanism = bounded per-pane invocation marker, NOT allow-logging.** lfguard's `check` path, given a
   new `--seen-dir <PATH>` flag, overwrites a tiny per-tag marker file `<seen-dir>/<audit-tag>` on every
   evaluation. Overwrite (truncate) semantics ⇒ one small file per pane, rewritten each call, no unbounded
   growth. Best-effort / fail-open: a marker-write failure never affects the guard verdict or the pane. This
   is separate from the deny audit log. RESOLVED. (Former DRAFT "DECISION NEEDED 1" — RESOLVED in favor of
   the marker over both 1a deny-only and 1b allow-logging.)
3. **Indicator = pane-header badge** in `TerminalPane.tsx`, next to the agent-id chip, driven by a new
   in-memory `SessionInfo.guardVerification` field with three states (`'unverified'` → amber badge,
   `'observed'` → renders nothing, `undefined` → n/a). Quiet-on-success. Resets to `'unverified'` on every
   respawn. RESOLVED. (Former DRAFT "DECISION NEEDED 2 & 3" — RESOLVED: quiet-on-success, pane-header only.)
4. **Marker write rides the same `check` invocation the hook already runs** — no extra process, no second
   spawn. RESOLVED.
5. **Out of scope (document, don't build):** upgrading `cli-args-notify` → `cli-args-full` and fixing the
   `-c` hook grammar itself, both blocked on a real `codex` install. Standing action item, not this feature.
   RESOLVED as out of scope.

---

## What is observable (carried forward from the DRAFT — do not re-derive)

### Ruled out: HookEvent / `applyHookEvent`

The task brief's "a PreToolUse hook event reaching `applyHookEvent`" candidate is **not usable**, for two
independent reasons — do not wire status events into the badge:

1. **`HookEventName` has no `PreToolUse` member.** `src/shared/types.ts:3` defines
   `HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'` — the three canonical *status* events.
   `applyHookEvent` (`session-manager.ts:448-453`) only acts on these three.
2. **The guard hook and the status hooks are two structurally separate `-c` overrides that never share a
   code path.** `buildCodexHookArgs` builds `guardArgs` (the `hooks.PreToolUse=[...]` override that shells
   straight to `lfguard check` via `guardHookCommand`, never touching localflow's HTTP endpoint) completely
   independently of the tier-specific `notify=[...]` / `hooks.{UserPromptSubmit,PermissionRequest,Stop}=[...]`
   overrides that *do* curl `http://127.0.0.1:<port>/event`. Codex could accept one `-c` flag and reject the
   other; a `Stop` event reaching `applyHookEvent` proves the *status* wiring fired, not the *guard* wiring.
   Treating "status colors work" as proof the guard is armed would be a **new** false-confidence bug — the
   exact failure mode this spec exists to eliminate. **Do not use HookEvent arrival as a proxy for guard
   enforcement, anywhere.** The e2e "idle pane keeps its badge" test (below) is a regression guard against a
   future refactor accidentally reintroducing this.

### The chosen signal: a per-pane invocation marker written by `lfguard check`

`lfguard check` (`guard/crates/lfguard/src/main.rs:135-177`) is the single point that runs for **every**
`PreToolUse` invocation Codex actually dispatches to the guard. It already receives `--audit-tag <paneId>`
(`guardHookCommand`, `guard-hook.ts:19-32`), where the tag is exactly the pane id. Adding a marker write
there, gated on a new `--seen-dir` flag and keyed by that same tag, yields a signal that fires on the
first tool-call command of the session — the earliest honest positive observation obtainable without a real
`codex` install or a synthetic canary.

---

## Architecture

Data path (new pieces in **bold**):

```
Codex pane runs a Bash command
  └─ Codex invokes the -c hooks.PreToolUse command  (guardHookCommand)
       └─ lfguard check --hook-exit ... --audit-tag <paneId> --seen-dir <dir>   [Rust]
            ├─ evaluate(command)  → allow/deny verdict  (UNCHANGED)
            ├─ **write_seen_marker(dir, tag)** → overwrite <dir>/<paneId>  (NEW, best-effort)
            └─ append_audit(...) only on Deny  (UNCHANGED)
  main process:
    **startGuardSeenWatch({ dir, onSeen })** [NEW watcher on <dir>]
       └─ fs.watch fires for filename <paneId>
            └─ **manager.markGuardObserved(paneId)** [NEW]
                 └─ SessionInfo.guardVerification: 'unverified' → 'observed'
                      └─ changedCbs → sessions:changed → renderer
                           └─ TerminalPane badge stops rendering  (quiet-on-success)
```

### 1. Rust: `--seen-dir` flag + `write_seen_marker` (`guard/crates/lfguard/src/main.rs`)

New field on the `Check` subcommand struct (alongside `audit_log`/`audit_tag`, lines 43-47):

```rust
/// Overwrite a per-tag invocation marker at <PATH>/<audit-tag> on EVERY
/// evaluation (allow or deny), so localflow can observe that the hook
/// actually fired for this pane. Best-effort; overwrite (truncate)
/// semantics — one small file per tag, no unbounded growth.
#[arg(long = "seen-dir", value_name = "PATH")]
seen_dir: Option<String>,
```

Thread it through `main()`'s match arm (line 66-68) and the `cmd_check` signature (line 135-140). In
`cmd_check`, write the marker immediately after `engine.evaluate` and **before** any verdict return, so the
verdict is emitted regardless of marker outcome:

```rust
let decision = engine.evaluate(&command);
if let Some(dir) = seen_dir {
    write_seen_marker(dir, audit_tag);   // best-effort; never affects the verdict
}
if let (Some(path), Decision::Deny { reason, pack, .. }) = (audit_log, &decision) {
    append_audit(path, audit_tag, &command, reason, pack);   // UNCHANGED
}
// ... existing match decision { Deny/Allow } unchanged ...
```

New helper, modeled on `append_audit` (best-effort, never panics/fails):

```rust
/// Best-effort per-tag invocation marker. Overwrites <dir>/<tag> with the
/// current epoch-ms each call — one small file per tag, rewritten in place,
/// so the directory never grows. Any error (bad dir, permissions, unusable
/// tag) is swallowed: this is observability, never enforcement, and must
/// never influence the guard verdict.
fn write_seen_marker(dir: &str, tag: Option<&str>) {
    let Some(tag) = tag else { return };
    // Defense in depth: never let a tag escape `dir`. Guard tags are pane
    // UUIDs ([A-Za-z0-9-]+); reject anything with a separator or `..`.
    if tag.is_empty() || tag.contains('/') || tag.contains('\\') || tag.contains("..") {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(std::path::Path::new(dir).join(tag), ts.to_string());
}
```

`std::fs::write` truncates-then-writes ⇒ overwrite semantics, satisfying the "no growth" requirement. Note
the marker is written for **any** agent whose guard hook runs (Claude/Gemini call `guardHookCommand` too —
see §7); that is harmless because only Codex `cli-args-*` panes carry a `guardVerification` state for the
watcher to flip (§4). Writing `ts` (not a constant) ensures the file's bytes/mtime change on every call, so
`fs.watch` reliably fires even on repeated invocations for the same pane.

### 2. TS: `ResolvedGuard` gains `seenDir` (`src/main/guard-hook.ts`)

```ts
export interface ResolvedGuard {
  bin: string
  auditLog: string
  packs: string[]
  seenDir: string   // NEW: dir under userData for per-pane invocation markers
}
```

`guardHookCommand` appends the flag when present (single-quoted like `bin`/`auditLog`, because macOS
userData paths contain spaces). The marker filename is the existing `--audit-tag` (the paneId) — no new tag
flag needed; the two flags share the same tag:

```ts
return [
  shSingleQuote(guard.bin),
  'check',
  '--hook-exit',
  ...packFlags,
  '--audit-log',
  shSingleQuote(guard.auditLog),
  '--seen-dir',              // NEW
  shSingleQuote(guard.seenDir),  // NEW
  '--audit-tag',
  paneId
].join(' ')
```

### 3. TS: the marker directory + watcher (`src/main/index.ts`, new `src/main/guard-seen-watch.ts`)

In `index.ts`, alongside `guardAuditLog` (line 186):

```ts
const guardSeenDir = join(userData, 'guard-seen')
```

Add `seenDir: guardSeenDir` to the `guardProvider` return (line 187-188). At startup (best-effort), clear
and (re)create the dir so the watcher arms on a clean slate and no stale cross-run marker can be mistaken
for a live write — mirrors `captureStore.clear()`:

```ts
try { rmSync(guardSeenDir, { recursive: true, force: true }) } catch { /* best-effort */ }
try { mkdirSync(guardSeenDir, { recursive: true }) } catch { /* best-effort */ }
```

(Clearing is hygiene, not correctness: `fs.watch` reports *changes*, never pre-existing files, so a stale
marker alone never marks a pane observed. The clear keeps the directory bounded across runs and avoids
confusion.)

New watcher module `src/main/guard-seen-watch.ts`, structured like `guard-audit-tail.ts` (best-effort,
never crashes main, poll-rearms if the watcher drops), but watching a **directory** for per-file writes
rather than tailing one append-only file:

```ts
import { watch, mkdirSync } from 'node:fs'

export interface GuardSeenWatchOptions {
  dir: string
  /** Called with the marker filename (== paneId) each time a marker is written. */
  onSeen: (tag: string) => void
}

/**
 * Watches `dir` for per-pane invocation markers written by `lfguard check
 * --seen-dir`. Fires `onSeen(<paneId>)` on each write/rename. Best-effort:
 * observability, not enforcement — all failures are swallowed and can never
 * crash the main process. Returns a stop function.
 */
export function startGuardSeenWatch(opts: GuardSeenWatchOptions): () => void {
  try { mkdirSync(opts.dir, { recursive: true }) } catch { /* best-effort */ }
  let watcher: ReturnType<typeof watch> | null = null
  const arm = (): void => {
    try {
      watcher = watch(opts.dir, (_event, filename) => {
        if (typeof filename === 'string' && filename.length > 0) opts.onSeen(filename)
      })
      watcher.on('error', () => {})   // never let an FSWatcher 'error' throw
    } catch { /* dir not present yet; interval re-arm covers it */ }
  }
  arm()
  const interval = setInterval(() => { if (!watcher) arm() }, 1000)
  return () => { clearInterval(interval); watcher?.close() }
}
```

Wire it next to `startGuardAuditTail` (index.ts:265-273), and stop it in the `before-quit` handler
(index.ts:274-276) beside `stopGuardTail()`:

```ts
const stopGuardSeenWatch = startGuardSeenWatch({
  dir: guardSeenDir,
  onSeen: (tag) => manager.markGuardObserved(tag)
})
// ... app.on('before-quit', ...): stopGuardSeenWatch()
```

`markGuardObserved` is a no-op for unknown/non-Codex/already-observed panes, so a spurious or duplicate
`fs.watch` event (macOS coalescing, a marker written for a Claude/Gemini pane) is harmless. No filename
validation is needed on the TS side: the value is used only as a Map key in `markGuardObserved`, never as a
path.

### 4. TS: `SessionInfo.guardVerification` (`src/shared/types.ts`)

Additive field on `SessionInfo` (after `resumeFailed`, line 119), mirroring the in-memory-only,
reset-on-respawn precedent of `needsYouSince`/`resumeFailed`:

```ts
/**
 * Codex cli-args-* panes only: whether lfguard's guard hook has been observed
 * firing for this pane since the current pty was spawned.
 * - 'unverified': guard configured on this launch's CLI, but no invocation
 *   observed yet (the pane may simply not have run a command — silence is not
 *   proof of breakage).
 * - 'observed': the guard hook ran at least once this session — direct proof
 *   Codex accepted and honored the injected -c hooks.PreToolUse override.
 * - undefined: not applicable (non-Codex pane, or a Codex pane with no guard
 *   binary resolved / relaunched unguarded). The renderer shows NOTHING.
 * In-memory only, never persisted; re-initialized on every spawn.
 */
guardVerification?: 'unverified' | 'observed'
```

### 5. TS: `SessionManager` — set at spawn, `markGuardObserved`, reset (`src/main/session-manager.ts`)

**Set at spawn.** `guardOnCli` is already computed at `spawn()` (line 369-371) as the exact applicability
condition — Codex `cli-args-full`/`cli-args-notify` adapter **and** a guard actually resolved. Initialize
the field from it, on the fresh `info` object built each spawn (so a respawn resets it automatically):

```ts
// in spawn(), after guardOnCli is computed (line 369-371):
if (guardOnCli) info.guardVerification = 'unverified'
// else: leave undefined — non-Codex, unguarded, or skipGuard relaunch ⇒ n/a
```

Because `info` is rebuilt every `spawn()` call (lines 300-310) and `guardOnCli` is recomputed every call
(never inherited), an `'observed'` state can never leak across a respawn — a restart is a new Codex
invocation whose `-c` args are parsed fresh, so it must re-prove enforcement. This is the same per-spawn
reset discipline `guardOnCli` itself already follows. **The `skipGuard` fail-open relaunch** (line 424)
sets `guard = null` ⇒ `guardOnCli = false` ⇒ `guardVerification` stays `undefined` — correct: that pane is
now genuinely unguarded, so no "not yet observed" badge is shown (the existing relaunch notice already tells
the user it's running unguarded).

**Clear via a new method** (placed near `setStatus`, following the `needsYouSince` idiom):

```ts
/**
 * Marks a Codex pane's guard as observed-enforcing: called once lfguard's
 * invocation marker for this pane's id has been written. No-op for an unknown
 * id, a non-Codex/undefined pane, or a pane already 'observed' (idempotent —
 * a second invocation must not re-fire changedCbs). Never un-sets: only a
 * fresh spawn resets the field back to 'unverified'.
 */
markGuardObserved(id: string): void {
  const rec = this.sessions.get(id)
  if (!rec || rec.info.guardVerification !== 'unverified') return
  rec.info.guardVerification = 'observed'
  this.changedCbs.forEach((cb) => cb())
}
```

**Restore-from-disk** (`restore()`, lines 145-180) leaves `guardVerification` unset on the `'exited'`
placeholder — correct: nothing has been observed for a pty that doesn't exist yet; it's set at the next real
`spawn()` on restart, same lifecycle as `needsYouSince`/`resumeFailed`. No code change needed there.

**No IPC change.** `guardVerification` rides along on every `SessionInfo` snapshot the renderer already
receives via `sessions:list`/`sessions:changed` (`manager.onSessionsChanged` → `sendToWindow`,
index.ts:264/347-367 region). No new channel, no preload surface change, no polling.

### 6. Renderer: pane-header badge (`src/renderer/src/components/TerminalPane.tsx`)

Render conditionally right after the existing `agentLabel` chip (line 134-136), following the
`session.status === 'needs-you'` conditional-badge precedent (line 137):

```tsx
{session.guardVerification === 'unverified' && (
  <span
    className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-px font-mono text-[10px] text-amber-300"
    title="lfguard is configured for this Codex pane, but no enforcement has been observed yet — it is armed but unproven. The badge clears the first time a command actually reaches the guard this session. It does not mean the guard is broken."
  >
    guard: not yet observed
  </span>
)}
```

- **Renders only for `'unverified'`.** `'observed'` and `undefined` both render nothing (quiet-on-success):
  a permanent "guard: verified" chip would overclaim — the signal proves only "the hook fired at least
  once," and going quiet is the honest positive statement (see the one-sided-signal constraint). No
  spawn-time gate, no timeout, no "hold the pane" behavior. Pure render off `SessionInfo`, same risk profile
  as the `agentLabel` chip beside it.
- **Applicability lives in the manager, not the renderer.** The badge keys off
  `guardVerification === 'unverified'` alone; it does *not* add its own `agentId === 'codex'` check, because
  `guardVerification` is only ever set for Codex `cli-args-*` panes with a resolved guard. One source of
  truth for "what counts as applicable."
- **The title copy is load-bearing** — it is the one place a user reads the nuance, so it must state
  "armed but unproven" and "does not mean the guard is broken," never imply either "broken" or "safe."

### 7. Note: Claude/Gemini also write markers, harmlessly

`guardHookCommand` is shared by Claude's `settings-file` adapter (`hook-settings.ts`) and Gemini's
`env-settings-file` adapter (`gemini-hooks.ts`), so adding `--seen-dir` there means those agents also write
invocation markers. This is intentional and inert: those panes never get `guardVerification` set (only
`guardOnCli` Codex panes do, §5), so `markGuardObserved` short-circuits and no badge is ever shown for them.
Keeping the marker write unconditional in `guardHookCommand` avoids branching the command builder per-agent.
Settings-file/env-file adapters also can't fail a launch on the guard the way `cli-args-*` can (they inject
via files, not argv), so the whole verification concern is Codex-specific by construction — which is exactly
why the *badge* is scoped to `cli-args-*` even though the *marker* is universal.

---

## Fail-safe guarantees

1. **Marker write never affects the guard verdict.** In Rust it is a best-effort `let _ =` write placed
   after `engine.evaluate`; the verdict (exit code / JSON) is emitted regardless. A bad dir, permission
   error, or unusable tag is swallowed. Identical discipline to the existing `append_audit`.
2. **No unbounded growth.** One overwrite-in-place file per pane (`<seen-dir>/<paneId>`), rewritten each
   call; startup clears the dir. Bounded by the number of live panes, not by activity volume.
3. **Watcher never crashes main.** `startGuardSeenWatch` swallows all `fs.watch` errors, handles the
   FSWatcher `'error'` event, and poll-re-arms — same guarantees as `startGuardAuditTail`.
4. **Badge never blocks or delays a pane.** It is a rendered `<span>` off existing `SessionInfo` state; no
   spawn gate, no timeout.
5. **`markGuardObserved` is idempotent and safe.** No-op for unknown ids, non-Codex/undefined panes, and
   already-observed panes; never un-sets. Spurious/duplicate `fs.watch` events are harmless.
6. **No false-positive path from status events.** The badge is driven exclusively by the guard-marker
   watcher; status hooks (`applyHookEvent`) are never wired into `markGuardObserved`. The e2e idle-pane test
   is a standing regression guard against this.
7. **Path-traversal safe.** The tag is validated in Rust (no separators / `..`) before being joined to
   `seen-dir`; on the TS side the filename is used only as a Map key, never as a path.

---

## Out of scope (document, don't build)

**Upgrading `cli-args-notify` → `cli-args-full`, and "fixing" the `-c` grammar itself.** These are genuine
correctness questions about what Codex's CLI actually accepts, closable only by running a real `codex`
binary — this machine has none, CI can't install one, and no passive observation from inside localflow
substitutes for that verification. This spec's badge is a **mitigation** (make the risk visible), not a fix;
it should ship *with*, not instead of, the standing action item to get `codex --help`/docs in front of a
human. If/when the grammar is confirmed, the badge's job doesn't go away — it still catches
environment-specific breakage (a user's own Codex config overriding the injected `-c` flags, a future Codex
version changing behavior) that a one-time manual verification wouldn't.

Also out of scope, matching the DRAFT and the options memo:

- **Synthetic blocking canary injected into the live pane** — intrusive, contaminates the agent's transcript
  before the user's first turn, own false-negative mode. Not this spec.
- **Probing `lfguard check` as a bare subprocess** — only re-verifies the already-well-tested Rust binary,
  not the actually-unverified Codex-side `-c` wiring. Actively misleading if shipped as "the" verification.
- **A positive "verified" chip / one-time success toast** — deliberately excluded per quiet-on-success; the
  one-sided signal cannot back a durable positive claim. May be revisited later as UX polish, not now.
- **Settings-page static "Codex guard fidelity" note** — optional complementary documentation, not required
  for correctness; not built here.

---

## Testing plan (TDD)

Follows the M2 spec's split between what's testable locally (localflow's + lfguard's own logic) and what
fundamentally requires a real `codex` binary (unchanged constraint). Each task below is written test-first.

### Rust unit/integration (`guard/crates/lfguard/tests/hook_exit.rs`, additive)

- `seen_dir_marker_written_on_allow`: run `check --hook-exit --seen-dir <dir> --audit-tag pane1` with
  `ALLOW_JSON`; assert `<dir>/pane1` exists and is non-empty. (Proves the marker fires on ALLOW — the whole
  point of Option B vs the deny-only draft.)
- `seen_dir_marker_written_on_deny`: same with `DENY_JSON`; assert `<dir>/pane1` exists **and** the deny
  audit record still lands (marker and audit log are independent).
- `seen_dir_marker_overwrites_not_appends`: run twice for the same tag; assert `<dir>/pane1` is a single
  file whose size stays that of one timestamp (no growth), and the dir contains exactly one entry.
- `seen_dir_absent_writes_nothing`: no `--seen-dir` ⇒ no marker dir/file created (backward-compatible).
- `seen_dir_without_tag_writes_nothing`: `--seen-dir` but no `--audit-tag` ⇒ no file (can't name it).
- `seen_dir_rejects_traversal_tag`: `--audit-tag ../evil` ⇒ nothing written outside `dir`.
- `seen_dir_write_failure_still_returns_verdict`: point `--seen-dir` at an unwritable path; assert the
  allow/deny exit code is still correct (fail-open, verdict unaffected).

### TS unit (`tests/unit/`)

- **New `tests/unit/guard-seen-watch.test.ts`**: writing/overwriting a file named `<tag>` in the watched dir
  fires `onSeen(tag)`; a write failure / missing dir never throws; `stop()` clears the interval and closes
  the watcher. (Use a temp dir + real `fs.watch`, or a fake, matching `guard-audit-tail.test.ts` style.)
- **`tests/unit/guard-hook.test.ts`** (existing): `guardHookCommand` includes `--seen-dir <quoted seenDir>`
  and still includes `--audit-tag <paneId>`; the seen-dir is single-quoted (path-with-spaces safe).
- **`tests/unit/session-manager.test.ts`** (existing, additive):
  - A `cli-args-notify`/`cli-args-full` spawn with a non-null guard sets
    `info.guardVerification === 'unverified'` immediately after `spawn()`.
  - A spawn with `hookAdapter` ∈ {`settings-file`, `env-settings-file`, `none`} never sets the field.
  - A Codex `cli-args-*` spawn with a **null** guard (provider returns null) never sets the field.
  - `markGuardObserved(id)` flips `'unverified'` → `'observed'` and fires `changedCbs` exactly once.
  - `markGuardObserved(id)` on an already-`'observed'` pane is a no-op (no second `changedCbs`).
  - `markGuardObserved(unknownId)` and on a non-Codex pane are silent no-ops.
  - A `restart()` → `spawn()` on a pane previously `'observed'` resets it to `'unverified'`.
  - A guard-induced instant-exit fail-open relaunch (skipGuard) leaves `guardVerification` `undefined`.

### TS integration — `index.ts` wiring

- Assert the `startGuardSeenWatch` `onSeen` callback calls `manager.markGuardObserved(tag)` (extend an
  existing main-process bootstrap test, or a focused test of the wiring lambda).

### E2E (`tests/e2e/guard.spec.ts`, extend; `tests/fixtures/fake-codex.sh`, extend)

- **Badge clears on first invocation**: launch a fake-codex-backed pane with a guard resolved; drive a
  command through the fixture that causes `lfguard check --seen-dir` to run (allow is enough — need not be a
  deny); assert the "guard: not yet observed" header badge disappears. Proves the full local chain
  spawn → marker write → watcher → `markGuardObserved` → `SessionInfo` → renderer.
- **Idle pane keeps its badge** (regression guard): a Codex pane that spawns and runs no command keeps the
  badge for the test duration — proves the badge doesn't self-clear and that no status/`Stop` event path can
  ever satisfy it. This is the guard against reintroducing the HookEvent false-confidence bug.
- Same explicit caveat the M2 spec carries: these prove localflow's + lfguard's own logic, **not** that a
  real `codex` binary invokes the `-c hooks.PreToolUse=...` command the fixture simulates. That gap is
  unclosable without a real `codex` install (see Out of scope).

### Explicitly not tested (documented, not silently skipped)

- Whether the real `codex` binary actually accepts/executes the injected `-c hooks.PreToolUse=...` command —
  unverifiable on this machine or in CI; the standing manual-verification action item, same status as the M2
  checklist.

---

## Task breakdown (TDD order)

Each task: write/adjust the failing test first, then implement.

1. **Rust: `--seen-dir` flag + `write_seen_marker`** (`guard/crates/lfguard/src/main.rs`). Add the `Check`
   struct field, thread through `main()` + `cmd_check`, add the best-effort helper; write on every eval
   before verdict return. Tests: the 7 `hook_exit.rs` cases above.
2. **TS: `ResolvedGuard.seenDir` + `guardHookCommand`** (`src/main/guard-hook.ts`). Add the field and the
   `--seen-dir` flag emission. Tests: `guard-hook.test.ts` cases.
3. **TS: `startGuardSeenWatch`** (new `src/main/guard-seen-watch.ts`). Directory watcher, fail-open,
   poll-re-arm, stop fn. Tests: new `guard-seen-watch.test.ts`.
4. **TS: `SessionInfo.guardVerification`** (`src/shared/types.ts`). Add the field + doc comment.
5. **TS: `SessionManager`** (`src/main/session-manager.ts`). Set `guardVerification` at spawn from
   `guardOnCli`; add `markGuardObserved`; confirm respawn/restore reset via the fresh-`info` path. Tests:
   `session-manager.test.ts` additive cases.
6. **TS: `index.ts` wiring** (`src/main/index.ts`). Add `guardSeenDir`, startup clear+mkdir,
   `seenDir` on `guardProvider`, `startGuardSeenWatch({ dir, onSeen: markGuardObserved })`, stop on
   `before-quit`. Test: the wiring integration assertion.
7. **Renderer: pane-header badge** (`src/renderer/src/components/TerminalPane.tsx`). Conditional amber
   `<span>` with load-bearing title copy.
8. **E2E** (`tests/e2e/guard.spec.ts` + `tests/fixtures/fake-codex.sh`). Badge-clears-on-invocation and
   idle-pane-keeps-badge cases.

**Size:** 8 tasks, all additive — no existing behavior changed (deny audit log, `guardOnCli` relaunch, and
status hooks all untouched), one small new Rust flag+helper, one new small TS watcher module, one new
`SessionInfo` field, one new manager method, one renderer conditional. Comparable to a single M-series slice.

### Branching note

The guard-crate change (Task 1) touches `guard/crates/lfguard/src/main.rs`, which the **in-flight
`feat/lfguard-wrapper-hardening` branch also edits**. To avoid churn/conflicts, land this feature's Rust
change on a branch that carries — or rebases onto — the wrapper-hardening work, rather than branching from a
stale `main`. Confirm `feat/lfguard-wrapper-hardening` is merged (or rebase onto it) before starting Task 1.

---

## Former DRAFT decisions — resolution ledger

| DRAFT item | Resolution |
| --- | --- |
| DECISION NEEDED 1 (deny-only 1a vs allow-logging 1b) | **RESOLVED — neither.** Bounded per-pane invocation marker (`--seen-dir`), overwrite semantics. Fires on first invocation (allow OR deny), no audit-log growth, deny audit log unchanged. |
| DECISION NEEDED 2 (indicator copy / three states) | **RESOLVED.** `'unverified'` → amber "guard: not yet observed"; `'observed'` → nothing (quiet-on-success); `undefined` → n/a. Load-bearing title copy specified. |
| DECISION NEEDED 3 (pane header vs prominent surface) | **RESOLVED.** Pane header only for the live signal; no modal, no required Settings note. |
| DECISION NEEDED 4 (tier upgrade / `-c` grammar) | **RESOLVED — out of scope**, tracked as the standing blocked-on-real-`codex` action item. |
