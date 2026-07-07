# M1.5 — Simplified Overview + Settings: Design Spec

**Date:** 2026-07-07
**Status:** Approved (design agreed in session 2026-07-07, binding). Builds
immediately after M1 — both rewrite `App.tsx`/`Landing.tsx`, sequenced to
avoid conflicts; this spec assumes M1's active-pane model (`activeId`,
`order`, capture-phase keydown dispatcher) and `keybindings.json` already
exist and are unaffected by this work.

## Goal

Split today's single, cluttered Overview (sessions table + full agent
detection/config UI) into two views: a minimal, centered **Overview** for
"see recent sessions, start a new one" and a **Settings** page for
agent configuration (and, later, keybindings + themes in M4). No behavior
regressions to session creation, resume, or the existing e2e DOM contract.

## Overview page (minimal, centered)

- Content column is centered and narrower than today's full-width table
  (`max-w-[720px]`, `mx-auto`), not a dense data grid.
- Zero-sessions state: the existing ghost-grid hero animation is unchanged
  (three animated ghost panes cycling idle→working→needs-you→idle).
- **Latest sessions**: up to 5 most recently created sessions, most recent
  first (`sessions.slice(-5).reverse()` — sessions arrive from
  `listSessions()` in creation order, oldest first; no new timestamp field
  needed for this milestone). Each row is bigger than today's compact table
  row and shows: project name (folder basename) + full cwd, an agent chip,
  a status dot/label, and actions — `open` for live sessions, `resume`/
  `fresh` for exited ones, plus a small `×` remove control carried over from
  today's table for parity.
- The full session list is still reachable at all times via the existing
  Sidebar session list (unchanged) — Overview's "latest" list is a digest,
  not the only way to reach older sessions.
- **New session**: one primary button, always visible regardless of session
  count, using the default/last-used agent. A small agent `<select>` sits
  beside it (all presets + "Custom command…"); picking "Custom" reveals a
  compact command input next to it. No agent detection cards, "Set path…",
  or persistent custom-command box on this page anymore — that is all
  Settings now.
  - The button is disabled when the selected agent isn't resolvable (preset
    not found on this machine, or "Custom" selected with an empty command).
    When disabled for a missing preset, a one-line hint appears: "`<Agent>`
    not found on this machine. **Configure in Settings**" — a link-styled
    button that jumps straight to the Settings page (Overview stays free of
    the configuration UI itself, but never strands the user).

## New session default (last-used agent)

- On mount, Overview fetches `listAgents()` and `getLastAgent()` in
  parallel and picks the picker's initial value:
  1. `lastAgent.agentId` if it's `'custom'` or still present in the agents
     list (presets don't change at runtime, so in practice this is always
     true unless the config file was hand-edited).
  2. Otherwise the first agent with a `resolvedPath`.
  3. Otherwise the first preset (`AGENT_PRESETS[0].id`), shown disabled with
     the "not found" hint.
  - If the restored last agent was `'custom'`, its remembered
    `customCommand` prefills the command input.
- Selecting a different agent in the picker only changes what the button
  will launch next — it does **not** write to disk. Persistence happens
  once, in the main process, the moment a session is actually created (see
  below), so `lastAgent` always reflects the agent that was really last
  used to launch a session, not merely hovered over in the dropdown.

## Settings page

- New sidebar nav item "Settings", always enabled (unlike "Terminals",
  which is disabled with zero sessions), reachable at any time.
- Hosts an **Agents** section for M1.5: one row per preset (Claude Code /
  Codex / Gemini CLI) showing label, live-status badge (unchanged concept
  from today's cards), resolved path or "not found (`<bin>`)", and a
  "Set path…" / "Change path…" button — always available here (today's
  Overview only showed the button when unresolved; Settings is a config
  page, so editing an already-resolved path is allowed too). A small
  "last used" badge marks whichever agent is the current `lastAgent`.
  `'custom'` has no preset/detection row — its command is entered per
  launch on Overview, so Settings just notes that in a line of copy under
  the section heading.
- Two more sections exist as **structural placeholders** for M4:
  "Keybindings" (points at editing `keybindings.json` by hand for now, per
  M1) and "Themes" (no controls yet). They render as muted, non-interactive
  cards so the page's shape is already right when M4 fills them in — no
  new IPC or state for either in this milestone.

## Persistence: `lastAgent` in config.json

- Extends the existing `userData/config.json` (already home to
  `agentPaths`, owned by `agent-registry.ts`) with an optional `lastAgent`
  field:

  ```json
  {
    "agentPaths": { "codex": "/opt/bin/codex" },
    "lastAgent": { "agentId": "claude" }
  }
  ```

  For a custom command:

  ```json
  { "agentPaths": {}, "lastAgent": { "agentId": "custom", "customCommand": "aider" } }
  ```

- Shape: `{ agentId: AgentId; customCommand?: string }` — `customCommand`
  is only ever present when `agentId === 'custom'`.
- Written once per successful session creation, by the main process, in
  the same handler that already validates and spawns the session — the
  renderer never writes this file directly. `AgentRegistry` gains
  `getLastAgent()` (read) and `recordLastAgent(agentId, customCommand?)`
  (write + persist), mirroring the existing `setPath()` pattern.
- Read by the renderer through a new read-only IPC call, `getLastAgent()`
  on `window.localflow`, analogous to `getKeybindings()`.

## DOM contract (preserved)

- `.new-session` — exactly one instance exists at any time (the single
  Overview primary button; Settings has no session-creation UI at all).
- `.row-open` — present on the "open" action for each live session row in
  the Latest sessions list, same semantics as today's table.
- `data-session-id` — present on each Latest-sessions row wrapper.
- Nothing added here changes `data-pane-id`, `data-status`, or any
  attribute the Terminals view/keyboard e2e coverage depends on.

## Non-goals (M1.5)

- Keybindings editor, theme switching, layout/density preferences — M4
  fills the placeholder sections this milestone leaves in Settings.
- Overview stats strip (sessions-by-status counts, oldest needs-you) —
  separate roadmap item, not part of this simplification.
- True "recency" via timestamps/activity — "latest sessions" uses creation
  order for now; a real `createdAt`/`lastActiveAt` field is future work if
  the simple ordering proves insufficient.
- Any change to workspaces, session layers, or the active-pane/keyboard
  model — those are M1/M3/M5 and are untouched here beyond adding the
  `'settings'` view alongside `'home'`/`'terminals'`.

## Testing

- Unit (TDD, pure logic): `agent-registry.ts`'s `loadAgentConfig` /
  `saveAgentConfig` / `AgentRegistry.getLastAgent` /
  `AgentRegistry.recordLastAgent` — round-trip for preset and `'custom'`
  agents, and rejection of malformed `lastAgent` shapes (missing/invalid
  `agentId`, `'custom'` without a non-empty `customCommand`), matching the
  existing tolerance style for `agentPaths`.
- No new component-level unit tests: this codebase has no React
  testing-library/jsdom setup, and UI components (`Landing`/`Overview`,
  `Sidebar`, the new `Settings`) are covered by Playwright e2e today, same
  as `TerminalPane`.
- E2E: sidebar "Settings" nav navigates to a page with the Agents section
  visible; `.new-session` remains exactly one element and toggles disabled
  when the picker selects an unresolved agent, with the "Configure in
  Settings" hint appearing; a full app restart against the same
  `userData` dir shows `getLastAgent()` reflecting the agent that was
  actually launched.

## Error handling

- Corrupt or hand-edited `config.json` → `loadAgentConfig` catches parse
  errors and malformed `lastAgent` shapes exactly like it already does for
  `agentPaths`: drop the invalid field, keep the rest, never throw.
- `setAgentPath` dialog cancelled (Settings) → IPC returns `null`, page
  makes no state change (same behavior the current Overview relies on).
- No agents resolved and no custom command typed → "New session" stays
  disabled with the "Configure in Settings" hint; never a dead click.
- `listAgents()` / `getLastAgent()` IPC failure → out of scope for this
  milestone, same as today's Overview (no retry/backoff logic exists for
  `listAgents()` either).
