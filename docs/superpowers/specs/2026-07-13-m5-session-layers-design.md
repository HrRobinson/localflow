# M5 — Session layers (session › panes) — design

Date: 2026-07-13. Status: awaiting review.
Supersedes the M5 section of `2026-07-06-saiife-v2-roadmap.md`.

## Goal

A session becomes a parent node that owns multiple panes — the primary
scenario is **agent + companions as one unit**: an agent terminal, its
live-preview browser, maybe a shell, grouped, moving and reading as one
thing. Navigation becomes hierarchy-aware (the "staircase": each level
down adds context), without breaking any existing invariant.

Orchestrator trees (agents spawning child sessions on worktrees) are a
later milestone; this design must not preclude them, and doesn't: groups
can gain a `parentId` later while panes stay leaves.

## Data model — group layer over panes

The per-pane record (`SessionInfo`) stays exactly what it is: one pty or
webview, one grid tile, the unit of hook status. Grouping is a layer:

- New entity `SessionGroup { id: string; name: string; environment: number }`,
  owned by SessionManager, persisted in sessions.json under a new `groups`
  key beside the existing pane records.
- `SessionInfo` gains optional `groupId?: string`. Absent ⇒ solo pane,
  exactly pre-M5 behavior. A pre-M5 sessions.json therefore loads with
  zero migration code: no `groups` key, all panes solo.
- SessionManager gains `createGroup(name, environment)`, `renameGroup`,
  `assignToGroup(paneId, groupId | null)` (null = ungroup), and enforces
  the invariants below.

**Invariants**

1. A group always has ≥1 pane. Deleting a group's last pane deletes the
   group. (cmd+w never deletes — it closes the pty; dead panes keep their
   group membership and stay restorable.)
2. A group and all its panes share one environment. Moving a grouped pane
   across environments (ctrl+1-9) moves the **whole group** — the unit
   moves together. Solo panes move alone, as today.

**Vocabulary.** UI copy: the group is a "session", its children are
"panes". Code keeps `SessionInfo` as the pane record (renaming it would
churn every subsystem for no behavior); doc comments on `SessionGroup`
state the mapping. The control API already says `/panes` — unchanged.

## Status rollup

Pure shared function `rollupStatus(panes: SessionInfo[]): SessionStatus`
with attention-first priority: `needs-you > working > running > done >
exited`. Group headers, sidebar environment dots, and Overview all call
this one function, so a session shows yellow the moment any child needs
attention. Solo panes report their own status unchanged.

## Environment grid — grouped grid

One flat, glanceable grid per environment. A session's panes cluster
inside a bordered group box with a shared header: session name, rollup
dot, and a `+` (add pane). Solo panes render exactly as today. The pane
`order` reconciliation keeps group members adjacent; groups order by
their first member.

- cmd-hjkl focus movement stays spatial and unchanged.
- cmd+w closes the focused pane's pty (never destroys). Focus lands on
  the nearest live sibling **within the same group** first, else the next
  pane in the grid.
- No session-level close shortcut in v1 (smallest new grammar; can be
  added as a remappable action later).

## Enlarge — the two-step staircase

Enlarge becomes a cycle on the existing enlarge key: **grid → pane →
session → grid**, and Escape walks one step back up.

- **Pane level:** the focused pane fills the grid area. A breadcrumb bar
  shows `‹env name› › ‹session name› › ‹pane name›`. If the pane has
  group siblings, a thin sibling strip (tabs) makes companions one
  keystroke away.
- **Session level:** the session's panes side by side, breadcrumb
  `‹env name› › ‹session name›`. Reached by a second press of enlarge, or
  directly from the group header. Solo panes skip this level.
- Both levels carry a **"spin up a pane here"** affordance — the add-pane
  flow below, inheriting this session's cwd.

**Escape semantics (folds in a standing backlog item).** Escape is the
staircase walk-up only when the terminal itself doesn't consume it.
Terminals keep Escape for the running program (Claude's interrupt); the
staircase walk-up binds to a remappable action whose default does NOT
shadow plain Escape inside a focused terminal (exact default chosen at
implementation against the current keybindings map; documented in
keybindings.json defaults).

## Creation flows

Four doors into grouping, one underlying model:

1. **Add-pane from within.** On a focused session (grid header `+`,
   keybinding, or the enlarged-view affordance): mini picker — terminal
   (agent choice), browser, shell. The new pane inherits the session's
   cwd and environment and joins the group. Invoked on a **solo** pane,
   the action first wraps it into a new group (named after the pane),
   then adds the companion — grouping starts organically.
2. **Group/ungroup existing panes.** Remappable actions: "move pane into
   session…" (picker: current environment's groups + "new group…") and
   "remove pane from session". Mirrors how ctrl+1-9 moves across
   environments.
3. **Templates.** config.json gains
   `sessionTemplates: [{ name, panes: [{ kind, agentId?, url? }] }]` —
   hand-editable file first (config-as-code; file is source of truth).
   The New-session picker renders each template as a one-click combo
   ("Claude + preview"). A built-in **Shell** preset ships here (standing
   backlog item), realized as a new agent preset (bin = the user's shell,
   hookAdapter none) so it works in templates, the picker, and add-pane
   alike. Malformed template entries are skipped with a notice, never
   fatal.
4. **Operator route.** One new env-scoped control-API endpoint:
   `POST /panes`, body `{ kind: 'terminal' | 'browser', agentId?, url?,
   groupId? }`. Confined to the caller's granted environment; a `groupId`
   from another environment is a 400. Activity-logged like every operator
   action, visible in Cockpit. This is a single narrow route ("add a pane
   in your own environment"), not a general pane-management API.

## Resume dead-end UX

When a resume attempt fails immediately (pty exits within a short window
with a recognizable "No conversation found"-class failure), the dead-pane
overlay flips its hierarchy: **Start fresh** becomes the primary action,
with one line explaining why resume can't work. No looping re-resume as
the default. (Roadmap M5 item, unchanged.)

## Out of scope (v1)

- Orchestrator trees / nested sessions beyond one group level
  (`parentId` on `SessionGroup` is the designed extension point).
- Session-level close shortcut.
- Template editor UI (file-first; GUI later like themes/keybindings).
- General pane-management operator API (only `POST /panes` ships).
- Configurable max tree depth (meaningless until trees exist).

## Testing

**Unit**

- `rollupStatus` priority ordering, empty/solo edge cases.
- Group CRUD + invariants: last-pane-delete deletes group; env
  consistency; whole-group environment move; ungroup of last member.
- Persistence round-trip with groups; pre-M5 file (no `groups` key)
  loads all-solo.
- Template parsing: valid combos, malformed entries skipped non-fatally.
- `POST /panes` routing: happy path, cross-env groupId 400, bad kind 400,
  unauthenticated 403 (following existing control-api test patterns).

**e2e**

- Template create → grouped panes appear with shared header + rollup dot.
- Add-pane from a solo pane → group forms, cwd inherited.
- cmd+w on a grouped pane → focus lands on sibling.
- Enlarge staircase: pane → session → grid; breadcrumb text asserted at
  each step; Escape walks up.
- Operator `POST /panes` creates a grouped pane in its environment; 403
  with a foreign/revoked token.
- Resume dead-end: instant-fail resume shows Start fresh as primary.

## Compatibility & rollout

- sessions.json: additive (`groups` key, optional `groupId`); old files
  load unchanged; files written by M5 and read by pre-M5 builds would
  drop grouping only (acceptable — dev-channel concern).
- keybindings.json: new actions get defaults that conflict with no
  existing binding; all remappable.
- Atomic sessions.json writes (standing backlog item) land inside this
  milestone since it rewrites persistence anyway.
