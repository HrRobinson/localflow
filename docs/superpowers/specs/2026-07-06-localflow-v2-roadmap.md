# localflow v2 — Roadmap

Direction agreed 2026-07-06: localflow evolves from "Claude session grid" into a
keyboard-driven workspace manager for AI agent terminals, with GitHub
Desktop-grade UI. Each milestone is its own spec → plan → PR cycle.

## Design principles (standing, 2026-07-07)

1. **Two audiences, one product.** Every feature must serve both non-technical
   "vibe coders" (glanceable, forgiving, GUI-first) and technical power users
   (keyboard-first, scriptable, inspectable). When designing, ask: what's the
   vibe-coder path AND the power-user path?
2. **Config as code underneath, GUI on top.** All configuration lives in
   plain, hand-editable, documented files in userData (`config.json`,
   `keybindings.json`, theme files) — dotfile-able and version-controllable,
   vim-style. Settings GUIs read and write those same files; the file is the
   source of truth, never a hidden database. GUI edits must round-trip
   cleanly with hand edits.

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

## M1.6 — Durable sessions (user design 2026-07-07)

- Sessions and terminals become distinct: a SESSION is a durable, named,
  renameable entry (project path, agent, kept in the sessions list until
  explicitly deleted); a TERMINAL is an ephemeral process attached to it.
- Closing a terminal (button or cmd+w) never deletes the session — it goes
  back to the list as closed/exited with its path saved, reopenable via
  resume/fresh. Deleting a session is a separate explicit action.
- Rename sessions inline in the sidebar/overview list.
- Fixes the M1 final-review finding that cmd+w is irreversibly destructive.

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

## M2.5 — Needs-you quick actions (user request 2026-07-07)

- Jump-to-attention: keybinding (default `cmd+u`) focuses + enlarges the next
  needs-you pane; press again to cycle through all waiting panes.
- Approve from outside: on yellow panes (header) and overview rows, an
  "Approve" action writes the confirm keystroke (Enter) to that session's pty
  — answering the agent's pending prompt without entering the terminal.
- Safety: never blind-approve — show a peek of the pending question (last few
  terminal lines) beside the approve control. Requires the per-session output
  ring buffer in main (already a planned follow-up; this is its first real
  consumer).

## M3 — Workspaces

- AeroSpace-style workspaces 1–9: `cmd-1…9` switch, `cmd-shift-1…9` move pane.
- Sidebar workspace list with status-rollup dots (see "workspace 3 needs you"
  at a glance). Sessions persist with workspace assignment.

## M1.5 — Simplified Overview + Settings page (user request 2026-07-07)

- Overview goes minimal and centered: "latest sessions" (recent few, big
  rows: project, agent, status, open/resume) + one primary "New session"
  action (default/last-used agent, small agent picker beside it).
- All agent configuration (detection cards, Set path…, custom command
  default) moves to a Settings page reachable from the sidebar — the same
  page that later hosts keybindings (M4) and themes.
- Build immediately after M1 (both rewrite App.tsx; sequenced to avoid
  conflicts).

## M4 — Settings UI

- Keybindings editor (click binding, press keys).
- Agent management (paths, extra args, default agent).
- **Provider tokens (user request 2026-07-07):** connect agents via API
  tokens/keys per provider (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY,
  GEMINI_API_KEY) configured in Settings and injected into that agent's
  spawn env. Storage MUST use the OS keychain via Electron `safeStorage` —
  never plain-text config.json. Config-as-code story: the config file keeps
  a reference/alias, the secret itself lives in the keychain.
- **Local LLMs (user request 2026-07-07):** first-class support for agents
  running against local models — per-agent env can point at local endpoints
  (e.g. Ollama's OpenAI-compatible API via base-URL overrides), and the
  agent presets/docs show a "local model" recipe (aider/opencode/custom
  against localhost). No cloud account required to use localflow.
- **Themes** (added 2026-07-07): app + terminal color themes, switchable in
  settings. Theme = a JSON/CSS-token file (the Tailwind `@theme` tokens and
  xterm palette make this natural), so the community can develop and share
  themes; ship a handful of presets (dark default, light, popular terminal
  palettes). Layout preferences (density, pane sizing) belong here too —
  customization is a first-class feature, not an afterthought.

## Overview stats (fold into M7 or ship earlier as a small PR)

- Stat strip on the Overview page: sessions by status (working / needs you /
  done / dead), oldest unattended needs-you ("waiting 12m"), sessions per
  project/agent.
- Later, once hook events are logged per session: turns per session, average
  time-to-attention, busiest projects — the "how did my agents do today" view.
- Keep it glanceable numbers, not charts, until there's real demand.

## M7 — Abstract activity view (for non-technical "vibe coders")

- An alternative to raw terminals: a plain-language activity feed / flow
  visualization per session ("editing 3 files", "running tests", "waiting for
  your approval") derived from the same hook events that drive status colors.
- Glanceable shapes: activity sparkline per session, big needs-you cues.
- Terminal stays one click away — this is a lens, not a replacement.

## M5 — Session layers (nested sessions + breadcrumbs)

- **The staircase (user framing, 2026-07-07): each level down adds context.**
  Overview → Terminals grid → an ENLARGED pane is an *environment*, not just
  a bigger view: it shows a breadcrumb of where you are
  (`Overview › project-name`) and offers "spin up a terminal here" — a new
  session/shell in the same cwd, becoming a sibling/child of that pane.
- A session can open child sessions (e.g. an orchestrator agent with subagents
  on branches/worktrees) — sessions form a tree, max depth configurable.
- Breadcrumb trail of active layers (`workspace › project › branch-session`)
  when drilling in; status rolls up the tree. Entry point: the enlarged-pane
  breadcrumb bar ships first (possibly with M3 workspaces).

## M6 — Changes / diff review

- Per-session Changes view (GitHub Desktop-style): git status file list of the
  session's cwd, syntax-highlighted diffs, `j/k` file/hunk navigation.
- Escape hatches: "open lazygit/vim here", "open in editor".

## M8 — Editor panes (user request 2026-07-07)

- Terminal editors (nvim/helix/emacs -nw) already work via Custom command —
  document this as a first-class pattern ("add an editor pane beside your
  agent").
- "Open in editor" per session: button + keybinding launching `code <cwd>`
  (configurable editor command) in the external app. Near-term, cheap.
- Web-IDE pane (later): embed code-server/openvscode in a webview pane inside
  the grid. Feasible (localflow is Chromium); real embedding of native VS Code
  windows is impossible on macOS — don't promise it.

## Platform & tooling

- Tailwind CSS v4 migration (own PR; design tokens stay as CSS variables).
- Linux release artifacts (AppImage/deb + release-workflow job); works from
  source already.
- Windows support: needs `where.exe` detection + PowerShell-safe hook command
  quoting (node-pty uses ConPTY). Do when a Windows test machine is available.
- Install paths once artifacts exist: brew cask, curl install script.
