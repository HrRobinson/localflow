# localflow v2 — Roadmap

Direction agreed 2026-07-06: localflow evolves from "Claude session grid" into a
keyboard-driven workspace manager for AI agent terminals, with GitHub
Desktop-grade UI. Each milestone is its own spec → plan → PR cycle.

## Shipped ahead of schedule

- Agent-neutral core: presets (Claude Code / Codex / Gemini / custom), binary
  detection with path override, per-agent resume, violet `running` state for
  agents without a status feed.
- Home overview: sessions table (project, agent, status, resume/fresh/remove),
  agent launcher cards, app shell with sidebar navigation.
- `cmd-esc` = go up (shrink → home); bare Escape never captured (agents own it).

## M1 — Keyboard core

- Active-pane model with cyan focus ring (mirrors the user's AeroSpace border),
  distinct from the status-colored border.
- AeroSpace grammar on `cmd` (AeroSpace itself owns `alt-*` globally):
  `cmd-hjkl` directional focus, `cmd-shift-hjkl` swap panes, `cmd-enter` new
  session, `cmd-m` enlarge toggle, `cmd-w` close pane.
- `keybindings.json` in userData — every binding remappable (GUI editor in M4).
- Focus correctness: keyboard input always lands in the active terminal (fixes
  Enter re-triggering buttons).

## M2 — Status adapters for Codex & Gemini

Research (2026-07-06) confirmed both have Claude-like hooks systems:

- Codex: `hooks.json` events incl. `UserPromptSubmit`, `PermissionRequest`
  (→ needs-you), `Stop`; injectable per-invocation via `-c key=value` /
  `--profile`. Resume: `codex resume --last`.
- Gemini: `settings.json` hooks incl. `BeforeAgent`, `Notification`
  (`ToolPermission` → needs-you), `AfterAgent`; injectable via
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` env pointing at a localflow-managed file.
  Resume: `--resume latest`.
- Adapter layer maps each agent's events onto the existing
  working/needs-you/idle state machine and localhost listener.

## M3 — Workspaces

- AeroSpace-style workspaces 1–9: `cmd-1…9` switch, `cmd-shift-1…9` move pane.
- Sidebar workspace list with status-rollup dots (see "workspace 3 needs you"
  at a glance). Sessions persist with workspace assignment.

## M4 — Settings UI

- Keybindings editor (click binding, press keys).
- Agent management (paths, extra args, default agent).
- **Themes** (added 2026-07-07): app + terminal color themes, switchable in
  settings. Theme = a JSON/CSS-token file (the Tailwind `@theme` tokens and
  xterm palette make this natural), so the community can develop and share
  themes; ship a handful of presets (dark default, light, popular terminal
  palettes). Layout preferences (density, pane sizing) belong here too —
  customization is a first-class feature, not an afterthought.

## M7 — Abstract activity view (for non-technical "vibe coders")

- An alternative to raw terminals: a plain-language activity feed / flow
  visualization per session ("editing 3 files", "running tests", "waiting for
  your approval") derived from the same hook events that drive status colors.
- Glanceable shapes: activity sparkline per session, big needs-you cues.
- Terminal stays one click away — this is a lens, not a replacement.

## M5 — Session layers (nested sessions + breadcrumbs)

- A session can open child sessions (e.g. an orchestrator agent with subagents
  on branches/worktrees) — sessions form a tree, max depth configurable.
- Breadcrumb trail of active layers (`workspace › project › branch-session`)
  when drilling in; status rolls up the tree.

## M6 — Changes / diff review

- Per-session Changes view (GitHub Desktop-style): git status file list of the
  session's cwd, syntax-highlighted diffs, `j/k` file/hunk navigation.
- Escape hatches: "open lazygit/vim here", "open in editor".

## Platform & tooling

- Tailwind CSS v4 migration (own PR; design tokens stay as CSS variables).
- Linux release artifacts (AppImage/deb + release-workflow job); works from
  source already.
- Windows support: needs `where.exe` detection + PowerShell-safe hook command
  quoting (node-pty uses ConPTY). Do when a Windows test machine is available.
- Install paths once artifacts exist: brew cask, curl install script.
