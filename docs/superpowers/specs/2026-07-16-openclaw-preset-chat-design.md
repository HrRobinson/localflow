# OpenClaw preset: default to `openclaw chat` on fresh launch — Design Spec

**Date:** 2026-07-16
**Status:** Draft, for review. Small, additive change to the M4 agent-preset
/ spawn-spec plumbing (`src/shared/agents.ts`, `src/main/agent-registry.ts`,
`src/main/session-manager.ts`, `src/main/index.ts`). No change to hook
adapters, resume behavior, or any other preset.

## Problem

Choosing "OpenClaw" in the New-session picker spawns the bare `openclaw`
binary with no args on a fresh (non-resume) launch. `openclaw` with no
subcommand just prints its help text and exits — the pane opens, shows the
help output, and the process is already dead. There is no way to get a
working OpenClaw operator TUI from the picker today; a user has to already
know to type `openclaw chat` into a custom/shell session.

## Root cause

Tracing a fresh launch end to end:

- `src/main/index.ts`'s `specFor()` builds every `SpawnSpec` with
  `resumeArgs: registry.argsFor(agentId, true)` — note the hardcoded
  `true`. This is the set of args to use *if* a later restart resumes a
  dead session in the same folder.
- `AgentRegistry.argsFor(agentId, resume)` today only ever returns
  something for `resume === true` (the preset's `resumeArgs`); for
  `resume === false` it unconditionally returns `[]`. That branch is
  reachable but never actually called anywhere in the app — it exists only
  as a documented "no args on fresh launch" default and is covered by one
  unit test.
- The actual fresh-vs-resume decision happens later, at spawn time, in
  `SessionManager`'s pty-launch path (`session-manager.ts` ~L324):
  `const resumeArgs = resume ? spec.resumeArgs : []`. The `resume` boolean
  here is a real runtime flag (is this reviving a previously-dead session
  in the same folder), not the registry's `argsFor` parameter.

So a fresh OpenClaw session's arg list is `[]` — bare `openclaw` — by
construction, and the preset table has no field to express "these args
belong on every fresh launch, not just resumes."

## Design

Add one new optional field to the shared preset shape and thread it through
the same two seams that already carry `resumeArgs`.

1. **`src/shared/agents.ts`** — `AgentPreset` gets an optional
   `startArgs?: string[]`: "args appended on a fresh (non-resume) launch,
   before any user-configured Settings extra args." Every existing preset
   (`claude`, `codex`, `gemini`, `shell`) omits it, so `startArgs` is
   implicitly `[]` for them — no behavior change. The `openclaw` preset
   sets `startArgs: ['chat']`.

2. **`src/main/agent-registry.ts`** — `argsFor(agentId, resume)` changes its
   `false` branch from an unconditional `[]` to `presetFor(agentId)
   ?.startArgs ?? []`. The `true` branch (resume → `resumeArgs`) is
   unchanged. This is the minimal change that gives the already-dead
   `resume === false` branch a real, testable meaning instead of leaving it
   an inert placeholder.

3. **`src/main/index.ts`**'s `specFor()` adds one more field to the
   `SpawnSpec` literal: `startArgs: registry.argsFor(agentId, false)`,
   alongside the existing `resumeArgs: registry.argsFor(agentId, true)`.
   Both are computed once, up front, the same way.

4. **`src/main/session-manager.ts`** — `SpawnSpec` gets a matching optional
   `startArgs?: string[]` (optional so the many hand-built `SpawnSpec`
   literals in tests that predate this change keep compiling unchanged).
   In the pty-launch path, the arg selection becomes:
   `resume ? spec.resumeArgs : (spec.startArgs ?? [])`. Everything
   downstream is untouched: the composed arg list stays
   `[...injection.args, ...(resume ? spec.resumeArgs : spec.startArgs ??
   []), ...(spec.extraArgs ?? [])]`, so a user's Settings "Extra args" for
   OpenClaw still land *after* the default `chat`, e.g. `openclaw chat
   --verbose`.

## Why not other shapes

- **Bake `chat` into `bin`** (e.g. `bin: 'openclaw chat'`) — rejected:
  `commandFor`/spawn treat `bin` as a single executable, not a shell
  string; splitting it back apart would need its own parser and would
  break `agentPaths` override (`.setPath`) which stores an absolute binary
  path.
- **Special-case `agentId === 'openclaw'` in `session-manager.ts`** —
  rejected: every other per-agent behavior difference already lives in the
  preset table + registry, not as an `if (agentId === ...)` in the spawn
  path. `startArgs` keeps that convention and is directly reusable if a
  future preset needs the same treatment.
- **Fold into `resumeArgs`** (always send `['chat']` on both resume and
  fresh launch) — rejected: conflates two different lifecycles for no
  reason, and would be wrong the moment OpenClaw grows a distinct resume
  subcommand.

## Testing

Unit tests (`tests/unit/agent-registry.test.ts`, matching its existing
`AgentRegistry` describe block and helpers):

- `reg.argsFor('openclaw', false)` returns `['chat']`.
- `reg.argsFor('openclaw', true)` still returns `[]` (openclaw's
  `resumeArgs` is unchanged — resuming a dead OpenClaw session is out of
  scope here).
- `reg.argsFor('claude'|'codex'|'gemini'|'shell'|'custom', false)` all
  still return `[]` — no other preset is affected.

No e2e change: the OpenClaw e2e fixture spawns a fake binary and does not
assert on args today; adding `chat` assertions there is out of scope for
this fix.
