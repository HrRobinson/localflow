# M1.6 — Durable Sessions: Design Spec

**Date:** 2026-07-07
**Status:** Approved (user design, binding, 2026-07-07). Builds on the M1
active-pane model (`activeId`, `order`, capture-phase keydown dispatcher) and
the M1.5 Overview/Settings split — both are unaffected in shape, only in the
handlers wired to their existing buttons.

## Goal

Fix the M1 final-review finding that `cmd+w` (and the pane close button) is
irreversibly destructive. Split the single "session" concept into two: a
durable, named **session** that survives until explicitly deleted, and an
ephemeral **terminal** (pty) attached to it that can be closed and reopened
freely. No behavior regression to hook-driven status colors, resume/fresh
semantics, or the existing e2e DOM contract.

## Model

- **Session** — durable. Identity: `id` (unchanged, `randomUUID()`). Carries
  `cwd`, `agentId`, `command` (unchanged), plus a new `name: string`.
  Persisted in `sessions.json` until the user explicitly deletes it. A
  session with no live pty is `status: 'exited'` — already a first-class,
  renderable state (`TerminalPane`'s restart-overlay), just now reachable by
  deliberate user action, not only by crash.
- **Terminal** — ephemeral. The pty process backing a session while it's
  alive. Ending a terminal never touches the session record: `cwd`,
  `agentId`, `command`, `name`, and the session's place in every list are
  untouched. Only `status` flips to `'exited'`.
- One session has at most one live terminal at a time (unchanged from
  today — `restart`/`restore` already assume this). Nothing here changes
  that; M1.6 only changes what "ending" a terminal means for the session
  record.

## `SessionInfo` gains `name`

```ts
export interface SessionInfo {
  id: string
  cwd: string
  name: string // new
  status: SessionStatus
  agentId: AgentId
  command: string
  message?: string
}
```

- Default: `path.basename(cwd)` — computed once, in the main process, at
  `create()`/`restore()` time (mirrors the renderer's existing
  `projectName()` display helper, now authoritative and independently
  editable instead of re-derived from `cwd` on every render).
- Renameable at any time via `SessionManager.rename(id, name)` (new). Empty
  or whitespace-only input is a no-op (keeps the existing name) — the
  renderer never sends one (see Rename UX below), but the backend guards
  regardless since this is a persisted field.
- Persisted in `sessions.json` (`SavedSession.name`, optional for backward
  compatibility with files written before this milestone — see
  Persistence).

## `SessionManager`: `kill()` splits in two

Today's single `kill(id)` (pty.kill() + delete the in-memory record +
notify listeners) conflates "stop the process" with "forget the session."
It becomes:

### `closeTerminal(id: string): void`

Ends the pty, keeps the record.

- No-op if the session doesn't exist, or already has no live pty
  (`status === 'exited'`) — nothing to close.
- Kills the pty (same try/catch-swallow-EBADF pattern as today).
- Transitions status to `'exited'` synchronously and does **not** attach an
  "Exited right away" message — that framing implies an unexpected crash;
  a deliberate close is neither unexpected nor worth explaining. A
  `closedByUser` flag on the record (set here, cleared the moment the pty's
  own real `onExit` fires) makes the pre-existing instant-exit/tail-message
  logic in that `onExit` handler treat this exit as already handled and
  skip its message construction, rather than racing a second transition in
  after the fact.
- Fires the existing `changedCbs` (session-list-changed) notification, same
  as every other state-changing call — harmless since none of the persisted
  fields (`cwd`/`agentId`/`command`/`name`) changed, but keeps the one
  "something happened, re-persist" signal uniform.
- Bound to: the pane header's "close" button and the `close-pane` keybinding
  (`cmd+w` by default) — i.e. exactly the two places that call `kill()`
  today.

### `deleteSession(id: string): void`

Today's `kill()` behavior, unchanged, renamed for clarity: kill the pty if
alive, remove the record from the in-memory map entirely, notify listeners
(which triggers `sessions.json` rewrite, dropping the entry).

- Bound to: the Overview "Latest sessions" row's `×` and the equivalent
  sidebar session-row delete action (new — see Rename/Delete UX). Neither
  is reachable from inside a terminal pane itself; deleting a session is
  only ever an explicit list-level action, never a side effect of closing
  its pane.

### `rename(id: string, name: string): SessionInfo | null`

- Returns `null` if the session doesn't exist.
- Trims `name`; if the trimmed result is empty, no-ops and returns the
  current (unchanged) `SessionInfo` — never persists an empty name.
- Otherwise sets `info.name`, fires `changedCbs` (persisted immediately,
  per the mandate — no "save" step beyond committing the inline edit), and
  returns the updated `SessionInfo`.

## IPC / API / renderer wiring

| Renderer call | IPC channel | Main handler |
|---|---|---|
| `window.saiife.closeTerminal(id)` | `session:closeTerminal` | `manager.closeTerminal(id)` |
| `window.saiife.deleteSession(id)` | `session:delete` | `manager.deleteSession(id)` |
| `window.saiife.renameSession(id, name)` | `session:rename` | `manager.rename(id, name)` |

`killSession`/`session:kill` are removed (renamed to `deleteSession`/
`session:delete` — single-app, no external consumers of the old name to
preserve).

- **`cmd+w` / pane close button** (`TerminalPane`'s `onClose`, `App.tsx`'s
  `close-pane` keybinding branch) → `closeTerminal`. The session stays in
  `sessions`/`order`; `TerminalPane` already renders the `alive === false`
  restart-overlay (Resume conversation / Start fresh) for any exited
  session — this path was previously only reachable via an unexpected
  crash, and needs zero new UI, only the new call target.
- Focus handoff on close is unchanged in shape: if the closed pane was
  active, focus moves to a neighbor in `order` (it can no longer receive
  keyboard input once dead), and an enlarged closed pane shrinks back to
  the grid. This logic is identical for `closeTerminal` and
  `deleteSession` (only the id's presence in `order` afterward differs —
  `deleteSession` removes it via `refresh()`'s existing `reconcileOrder`;
  `closeTerminal` leaves it in place, still selectable, still visible as
  an exited card), so `App.tsx` factors one shared post-action cleanup
  used by both.
- **Overview row `×` / sidebar delete action** → `deleteSession`, behind an
  inline confirm step (see below) — never a bare, one-click destructive
  action anymore.

## Persistence shape

`SavedSession` (in `persistence.ts`) gains `name`:

```ts
export interface SavedSession {
  id: string
  cwd: string
  agentId?: string
  command?: string
  name?: string // new; optional for files predating this milestone
}
```

- `saveSessions` call site (`main/index.ts`'s `onSessionsChanged` handler)
  maps `{ id, cwd, agentId, command, name }` from `manager.list()`.
- `loadSavedSessions` tolerates a missing/non-string `name` exactly like it
  already tolerates a missing `agentId`/`command` — the field is simply
  omitted from the parsed record, no throw.
- On `restore()`, a saved session's `name` is used verbatim if present;
  absent (pre-M1.6 `sessions.json`) or empty falls back to
  `path.basename(cwd)`, same default as a brand-new session — this is the
  entire migration story, no version field or one-time rewrite needed.
- Session status is still never persisted (unchanged from today —
  `restore()` always sets `status: 'exited'` regardless of how the app was
  quit; the pty is gone either way on relaunch).

## Rename UX

Available in both the Overview "Latest sessions" rows and the Sidebar
session list (serves both the vibe-coder path — a small pencil icon on
hover — and the power-user path — double-click, no mouse trip to an icon).

- **Enter edit mode:** double-click the session's name text, or click a
  pencil icon revealed on row hover. Replaces the static name with a text
  `<input>`, pre-filled with the current name, autofocused, text selected.
- **Enter** commits: calls `renameSession(id, value.trim())` (guarded
  client-side against empty — same as the no-op guard in `rename()` — the
  commit is skipped and the input stays open on an empty value rather than
  silently reverting, so the user sees why nothing happened) and exits edit
  mode.
- **Escape** cancels: exits edit mode, discards the typed value, no IPC
  call. This is safe by construction, not by careful workaround: per the
  standing M1 design principle, bare `Escape` is never captured by the
  app-level capture-phase keydown dispatcher (only `cmd+esc` is bound to
  `go-up`) — so pressing `Escape` while focus is inside this rename
  `<input>` never reaches `App.tsx`'s dispatcher at all, and the input's
  own `onKeyDown` handles it untouched, exactly like typing inside a
  terminal.
- **Blur** (click/tab away without pressing Enter or Escape) behaves like
  Escape — cancels, no commit. This is the conservative default: the
  mandate only specifies Enter-saves/Escape-cancels, so an incidental
  focus loss (e.g. clicking elsewhere on the row) never silently mutates a
  persisted name the user didn't explicitly confirm.
- Renaming a session while its terminal is open has no effect on the pty or
  its cwd/agent — purely a label change, reflected immediately in Overview,
  Sidebar, and the pane header's project-name label (all three already
  read from the same `SessionInfo`, now via `.name` instead of a
  `cwd`-derived string).

## Delete UX (visually distinct from close, with confirm)

The `×` action (Overview row, sidebar row) is no longer a single destructive
click:

- First click arms it: the `×` is replaced in place by a small
  confirm/cancel pair ("Delete" in a warning color / "Cancel"), scoped to
  that one row only (one row armed at a time — arming a second row's delete
  disarms the first).
- Clicking "Delete" calls `deleteSession(id)` and the row disappears (live
  session) from that list on the next refresh, exactly like today's
  behavior when the id drops out of `sessions`.
- Clicking "Cancel", or clicking anywhere else in the app while armed,
  disarms back to the plain `×` — no IPC call, no state change.
- This is deliberately a lightweight, same-page inline confirm rather than
  a native `dialog.showMessageBox` (keeps it Playwright-testable without
  spawning an OS-level modal, and keeps focus/keyboard handling inside the
  existing React tree) and deliberately not a silent undo-toast (a
  confirm-before over an undo-after is simpler to reason about and test,
  and matches the existing pattern of "resume"/"fresh" being two distinct,
  clearly-labeled buttons rather than one overloaded action).

## Non-goals

- No session-tree/nesting, no workspaces — that's M5/M3.
- No "recently deleted" recovery/undo list — confirm-before is the only
  safety net this milestone ships; a trash/undo view is a future
  enhancement if confirm proves insufficient in practice.
- No change to hook-driven status transitions (`state-machine.ts`) or the
  `working`/`needs-you`/`idle`/`running` semantics — `closeTerminal` only
  adds a `'exited'` transition path that already existed for crashes.
- No multi-terminal-per-session (e.g. split panes within one session) —
  still exactly one pty per session, as today.
- No rename validation beyond non-empty-after-trim (no length cap, no
  uniqueness requirement across sessions — two sessions may share a name,
  same as two folders with the same basename in different parents today).

## Testing

- Unit (`tests/unit/session-manager.test.ts`, TDD): `closeTerminal` kills
  the pty, keeps the record in `list()`, sets `status: 'exited'`, attaches
  no instant-exit message even when closed within `INSTANT_EXIT_MS` of
  spawn; a late real `onExit` firing after `closeTerminal` is a no-op
  (doesn't overwrite status/message a second time). `deleteSession` matches
  every existing `kill()` test (renamed). `rename` updates `name`, returns
  the updated `SessionInfo`, no-ops on empty/whitespace input, returns
  `null` for an unknown id. `restore()` keeps a saved `name` when present
  and falls back to `basename(cwd)` when absent.
- Unit (`tests/unit/persistence.test.ts`): round-trips `name`; tolerates
  its absence in an existing fixture-shaped file (no `name` key at all).
- E2E (`tests/e2e/smoke.spec.ts`), new coverage:
  - **Close-vs-delete:** create a session, open it, close its terminal via
    the pane's close button (or `cmd+w`) — assert the pane is still present
    (`data-pane-id` still in the DOM) with `data-status="exited"` and the
    restart-overlay's "Resume conversation"/"Start fresh" buttons visible,
    and the session's Overview row is still present. Then delete it from
    Overview (arm + confirm the `×`) — assert the row is gone and the pane
    no longer renders in the terminals grid.
  - **Rename persists across relaunch:** rename a session from Overview
    (double-click name, type, Enter), assert the new name renders
    immediately in both Overview and the sidebar, close and relaunch
    Electron against the same `SAIIFE_USER_DATA` dir, assert the
    renamed session still shows the new name (proves the write landed in
    `sessions.json`, not just React state).

## Error handling

- `closeTerminal`/`deleteSession`/`rename` on an id that no longer exists
  (raced with another close/delete from a second code path, e.g. a
  double-click before React re-renders the disabled state) — all three
  are no-ops (`rename` returns `null`, the other two return `void`
  regardless); never throws.
- pty `.kill()` on an already-dead fd — same swallow-and-continue pattern
  already used by `write`/`resize`/today's `kill()`.
- Corrupt/hand-edited `sessions.json` — unchanged: `loadSavedSessions`
  already catches parse errors and returns `[]`; a malformed individual
  entry's `name` is simply treated as absent (falls back to
  `basename(cwd)`), it does not invalidate the whole file or that entry's
  `id`/`cwd`.
- Renaming to whitespace-only — no-op, not an error; the input stays open
  so the user notices nothing happened rather than the name silently
  reverting.
