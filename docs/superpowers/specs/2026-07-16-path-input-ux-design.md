# Typed path input UX (design)

Status: **Draft — implementing directly per task, flagged items below need
Jonas's confirmation.**
Scope: one focused PR closing a dogfooding-friction gap — localflow forces a
native Finder dialog for every path (agent binary location, new-session
working directory) with no way to type/paste, which is painful for dotfolder
binaries (`~/.volta/bin/openclaw`) and blocks even trivial shell sessions on
a dialog round-trip.
Grounded against: `src/renderer/src/components/Settings.tsx` (agent
"Set path…" row), `src/renderer/src/components/Landing.tsx` (new-session
launcher), `src/main/index.ts` (`agents:setPath`, `session:create`,
`templates:create` — all three currently gate on `dialog.showOpenDialog`),
`src/main/agent-registry.ts` (`AgentConfig`, `AgentRegistry.setPath`,
`loadAgentConfig`/`saveAgentConfig`), `src/shared/api.ts` (`LocalflowApi`),
`src/shared/urls.ts` (the existing pure-validator pattern this design
copies), `src/main/session-manager.ts` (`list()` returns sessions in
creation order — a `Map`'s insertion order — confirmed by Landing's own
`sessions.slice(-5).reverse()` "Latest sessions" list).

---

## 1. Problem statement

Two friction points from real dogfooding:

1. **Settings → Agents → "Set path…"** opens `dialog.showOpenDialog` with no
   text-entry fallback. Typing/pasting a path (e.g. a Volta-installed binary
   under `~/.volta/bin/openclaw`, a dotfolder Finder hides by default) is not
   possible at all.
2. **Landing → New session** always calls `session:create` with `cwd`
   `undefined` in production, and `main/index.ts` responds by hard-blocking
   on the same Finder dialog before any session — including a raw `shell`
   session, which conceptually needs no folder choice at all — can start.

## 2. Goals / non-goals

**Goals**
- A global, default-off `allowTypedPaths` setting that adds a typed-path
  input *alongside* (never instead of) every existing Finder picker.
- New sessions get a sensible default working directory without forcing the
  dialog open; the picker stays available as an explicit, optional action.

**Non-goals (kept out to hold scope)**
- `templates:create`'s own folder-picker block (`main/index.ts:526-544`) is
  structurally identical to `session:create`'s but templates are a separate,
  less-hit path (dogfooding friction was about the primary New-session flow
  and Settings, not templates). Left untouched.
- No change to how `custom` agent commands are entered (already a text
  input, no picker involved).
- No filesystem existence check on typed agent-binary paths — the registry
  already resolves lazily (`AgentRegistry.resolve` / `list()`) and shows
  "not found" for a bad path exactly as it does today for a bad picker
  result overwritten by hand-editing config.json.

## 3. Where the toggle lives

New `AgentConfig.allowTypedPaths?: boolean` (default `false` when absent),
persisted in the same `config.json` as every other setting here
(`agentPaths`, `theme`, `guard`, …), via the existing
`loadAgentConfig`/`saveAgentConfig` round-trip in `agent-registry.ts`. Added
to `KNOWN_TOP_LEVEL_KEYS` so it round-trips instead of falling into `extra`.

`AgentRegistry` gets `getAllowTypedPaths()` / `setAllowTypedPaths(bool)`,
mirroring the existing `getGuardPacks`/`setGuardPacks` pair exactly (same
IPC shape too: `handle` for the getter, fire-and-forget `on` for the
setter, matching `guard:getPacks` / `guard:setPacks`).

**UI home for the toggle:** a new small "Paths" section in `Settings.tsx`,
placed before the "Agents" section since it governs both Settings' own
agent rows and Landing's new-session row. A single checkbox: *"Allow typing
paths, in addition to the Finder picker."* Flagging for review: an
alternative would be folding this into the existing Agents section intro
instead of a standalone section — went with standalone because it also
governs Landing, a separate screen, and a dedicated section makes that scope
clear.

## 4. Validation rule

New pure module `src/shared/paths.ts` (same shape as `src/shared/urls.ts`'s
`normalizeHttpUrl`/`isHttpUrl` split):

- `looksLikeTypedPath(input): boolean` — cheap syntactic check used by
  renderer components to enable/disable submit affordances and flag invalid
  input as the user types: trimmed, non-empty, and starts with `/` or `~`.
- `expandTypedPath(input, home): string | null` — the authoritative check.
  Expands a leading `~` or `~/...` to `home`, then requires the result to
  start with `/`; returns `null` otherwise (empty input, a bare relative
  path, anything not resolvable to absolute). Takes `home` as a parameter
  instead of calling `node:os` itself, so it stays a pure function usable
  from both `main` (real `homedir()`) and unit tests (a fixture string) —
  same reason `resolveDefaultCwd` below takes `home` as a parameter too.

Tilde expansion is the one deliberate design decision beyond "must be an
absolute path": the motivating example in the task
(`~/.volta/bin/openclaw`) is not itself absolute, so a strict
absolute-only rule would reintroduce exactly the friction this PR exists to
remove. Flagging for review in case a stricter "must already be absolute,
no `~` support" rule was intended.

Renderer-side, both Settings' per-agent typed-path input and Landing's cwd
input use `looksLikeTypedPath` to gate the "Use"/"New session" affordance;
`main/index.ts` re-validates with `expandTypedPath` at the IPC boundary
before writing to config or spawning (never trusts renderer validation
alone — same posture as every other IPC handler in this file, e.g.
`session:create`'s `VALID_AGENTS.includes` check).

## 5. Default-cwd source

New pure helper `resolveDefaultCwd(sessions, home): string` in
`src/shared/paths.ts`: scans `sessions` (as returned by
`SessionManager.list()` / the `session:list` IPC) from the end (most
recently created) for the first non-browser session with a non-empty `cwd`,
and returns it; falls back to `home` if there is none (fresh install, or
every existing session is a browser pane).

This "most-recent" reuses the same array-order assumption Landing's own
"Latest sessions" list already depends on (`sessions.slice(-5).reverse()`)
and that `SessionManager.list()` guarantees (`[...this.sessions.values()]`
over an insertion-ordered `Map`). It also mirrors the existing companion-pane
default in `pane-ops.ts:67` (`source.cwd || homedir()`), just generalized to
"most recent session" instead of "this session's source".

New `session:defaultCwd` IPC handler (main) computes this from
`manager.list()` + `homedir()` on each call — cheap, no caching needed.
Landing fetches it once on mount to seed the cwd field, same pattern as its
existing `listAgents`/`getLastAgent` effect.

**Flagging for review:** "most-recent" here means *any* terminal session's
cwd, not scoped to the current environment (1-9). Scoping to the active
environment would arguably be the more useful default (a user working in
environment 3's project probably wants environment 3's directory, not
whatever was last touched in environment 1) — went with the simpler
unscoped version for this first pass since `SessionManager.list()` doesn't
currently expose an easy "most recent in environment N" query and the task
says "sensible default," not "environment-aware default." Easy follow-up if
it turns out to matter.

## 6. Picker stays optional, not removed

`session:create`'s cwd handling changes from:

```
let dir = process.env['LOCALFLOW_E2E'] === '1' ? cwd : undefined
if (!dir) { /* always open dialog in production */ }
```

to: honor `cwd` whenever it's a non-empty string that survives
`expandTypedPath(cwd, homedir())`, regardless of `LOCALFLOW_E2E`; only fall
back to the dialog if `cwd` is absent/invalid. This is a real (narrow)
change to a previously-documented trust boundary — the `LocalflowApi`
doc-comment said "the `cwd` parameter is honored only under
`LOCALFLOW_E2E=1`; production always opens the folder picker" — because
Landing will now *always* send a resolved cwd (default or user-edited), so
the dialog becomes a defensive fallback rather than the only path. This is
safe under the same reasoning every other IPC boundary in this file already
uses (single local user, own app, no cross-principal trust boundary — e.g.
`agentId`/`customCommand` are similarly renderer-supplied and only
shape-validated, not treated as adversarial). **Flagging for review** since
it's the one place this PR touches an explicit prior trust-model comment
rather than just adding new surface area.

`agents:setPath` (Finder picker) is untouched; a new `agents:setPathTyped`
handler is added alongside it for the typed-input path, and a new
`session:chooseFolder` handler exposes the same
`dialog.showOpenDialog({properties:['openDirectory','createDirectory']})`
call `session:create` and `templates:create` already use, so Landing's
"Choose folder…" button can invoke it directly without going through
`session:create`'s implicit fallback.

## 7. New session (Landing.tsx) UX

For non-browser agent selections, a new "Working directory" row appears
under the agent/custom-command row:
- Always: a "Choose folder…" button (Finder picker via
  `session:chooseFolder`), same visual weight as Settings' existing
  "Change path…" button.
- When `allowTypedPaths` is on: the path becomes an editable text input
  (validated live with `looksLikeTypedPath`, red border/hint on invalid)
  instead of a read-only label.
- When off (default): a read-only mono-font label showing the resolved
  default cwd, matching Settings' existing `resolvedPath` label styling.

`create()` passes the resolved `cwd` through to `onCreate`, which now takes
a third `cwd?: string` argument threaded through `App.tsx`'s `createSession`
into `window.localflow.createSession(agentId, cwd, customCommand,
environment)`. The "New session" button stays disabled if cwd fails
`looksLikeTypedPath` (only reachable when `allowTypedPaths` is on and the
user has hand-edited it into an invalid state).

## 8. Settings.tsx per-agent typed path

Each agent card gets, only when `allowTypedPaths` is on, a second row below
the existing path label + "Set/Change path…" button: a text input
(controlled, per-agent state) + a "Use path" button, disabled until
`looksLikeTypedPath` passes. On click, calls the new
`setAgentPathTyped(agentId, path)` IPC, which re-validates with
`expandTypedPath` and, on success, calls the existing
`AgentRegistry.setPath` (unchanged) and returns the refreshed agent list —
exactly the same return contract `agents:setPath` already has, so
`Settings.tsx` reuses its existing `setAgents(updated)` handling.

## 9. Test plan

Unit-testable (pure, `tests/unit/`):
- `src/shared/paths.ts`: `looksLikeTypedPath`, `expandTypedPath` (tilde
  expansion, rejection of relative/empty input),
  `resolveDefaultCwd` (most-recent non-browser session, browser-only list
  falls back to home, empty list falls back to home).
- `agent-registry.test.ts`: `allowTypedPaths` round-trip through
  `loadAgentConfig`/`saveAgentConfig` (default absent ⇒ false, explicit
  true/false persists, malformed value dropped) — same shape as the
  existing `lastAgent`/`guard` round-trip tests in that file.

Not unit-tested — manual/e2e note only (renderer interaction, Electron
dialog, IPC wiring):
- Settings "Paths" toggle actually shows/hides the per-agent typed input.
- Typed agent path round-trips into `resolvedPath` after a save.
- Landing's "Working directory" row: default-populated, "Choose folder…"
  still opens the native dialog, typed input (when enabled) blocks "New
  session" on invalid values.
- `shell` session launches without ever opening a dialog when a default cwd
  resolves.

These are called out rather than faked because they need a running
Electron window (or Playwright) to observe — matching this repo's existing
split between `tests/unit` (pure logic) and `tests/e2e` (Playwright,
already present for `smoke.spec.ts`, `guard.spec.ts`, etc.). No new e2e spec
is added in this PR to keep scope tight; the existing e2e suite continues to
pass unmodified since it always sends an already-valid absolute `cwd`.
