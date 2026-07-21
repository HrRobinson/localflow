# M1 — Keyboard Core: Design Spec

**Date:** 2026-07-07
**Status:** Approved (design agreed in session 2026-07-06; user has AeroSpace
with alt-* bound globally, so saiife mirrors its grammar on `cmd`).

## Goal

Make saiife fully keyboard-drivable in the Terminals view: one always-known
active pane, directional focus movement, pane swapping, and user-remappable
keybindings — while never stealing keys the agents themselves use.

## Active-pane model

- In the Terminals view exactly one session is **active** (when any exist).
- The active pane shows a **cyan focus ring** (`#00ffff`, mirroring the user's
  AeroSpace active-border color) rendered as an outer `box-shadow` ring so it
  never conflicts with the status-colored border.
- DOM keyboard focus follows the active pane: its xterm terminal is focused
  whenever the Terminals view is shown, after clicking a pane, after creating
  a session, and after directional moves. Typing always lands in the active
  terminal — Enter can never re-trigger a previously clicked button (all
  header/toolbar buttons blur themselves after click).
- Clicking anywhere in a pane makes it active. Creating a session makes the
  new session active. Closing the active pane activates its grid neighbor.

## Default keybindings (AeroSpace grammar on cmd)

| Action | Default | Notes |
| --- | --- | --- |
| focus-left/down/up/right | cmd+h / cmd+j / cmd+k / cmd+l | geometric: nearest pane center in that direction |
| swap-left/down/up/right | cmd+shift+h/j/k/l | swaps pane positions in the grid order |
| enlarge-toggle | cmd+m | enlarge/shrink the active pane |
| close-pane | cmd+w | closes and removes the active session — the agent's own conversation history survives in the project folder (e.g. `claude --continue` there starts where you left off) — intercepted so Electron doesn't close the window |
| new-session | cmd+enter | jumps to Overview (launcher) |
| toggle-sidebar | cmd+b | hide/show the sidebar (fullscreen-style focus; added 2026-07-07) |
| go-up | cmd+escape | shrink if enlarged, else Overview (existing behavior, now remappable) |

Bare Escape, Enter, arrows, and every unmodified key pass through to the
terminal untouched. `cmd+h` is intercepted before macOS Hide (Electron
`before-input-event` on the renderer keydown capture phase is sufficient since
the app sets no Hide accelerator; if macOS Hide still wins in practice, the
implementation may register a menu accelerator override).

## Remappable keybindings

- `keybindings.json` in the app's userData dir, created with defaults on first
  run: `{ "focus-left": "cmd+h", ... }` (action → binding string).
- Binding string grammar: `[cmd+][ctrl+][alt+][shift+]<key>` where `<key>` is a
  single character or `enter|escape|tab|space|arrow-left|arrow-right|arrow-up|arrow-down`.
- Loaded by the main process at startup, exposed read-only to the renderer via
  `saiife.getKeybindings()`. Unknown actions and malformed bindings are
  ignored (defaults win) — a broken file never breaks the app.
- Editing requires an app restart in M1 (GUI editor + live reload is M4).
- README documents the file, its location, format, and the defaults table.

## Non-goals (M1)

- Workspaces, layers, settings GUI, per-pane split layouts.
- Vim modes inside the terminal (that's the agent's/shell's domain).

## Testing

- Unit: binding parser (grammar, malformed input), keybindings file
  load/merge, directional-neighbor picker (pure geometry on rect lists),
  swap-order function.
- E2E: create two sessions, assert active ring placement, send cmd+l /
  cmd+h and assert the active pane changes, cmd+m enlarges.

## Error handling

- Corrupt keybindings.json → defaults + one console warning in main.
- Directional move with no neighbor in that direction → no-op.
- Actions on empty Terminals view → no-op.
