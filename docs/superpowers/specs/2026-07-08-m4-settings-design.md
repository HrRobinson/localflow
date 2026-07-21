# M4 — Settings UI (design)

Scope decided with Jonas 2026-07-08: **keybindings editor + agent management
+ themes**. Provider tokens are **dropped from the roadmap entirely** — every
supported agent can authenticate in-service with its own subscription or
credit account, so saiife never stores provider secrets (the safeStorage
design in the roadmap's § M4 is void). Local-LLM support arrives implicitly
through agent management's env/args overrides; recipe docs are deferred.

Standing principles apply: config files are the source of truth, GUI edits
round-trip with hand edits; every feature serves vibe coders (GUI) and power
users (files/keyboard).

## 1. Keybindings editor

The real engineering here is live rebinding, not the form:

- **Settings section** listing every `KeyAction` (grouped: panes, environments,
  attention, app) with its current binding and a "reset" affordance per row
  plus "reset all".
- **Capture flow:** click a binding → capture mode ("press keys…", Escape
  cancels) → the pressed combo is serialized to the binding grammar
  (`cmd+shift+x`, digits by physical key) → validated with `parseBinding` +
  a conflict check against all other actions → written to `keybindings.json`.
  Conflicts are shown, not silently allowed; the file stays hand-editable
  and hand-edits win on next load.
- **Live propagation (new plumbing):** bindings are currently loaded once at
  startup in main and captured by three consumers (renderer dispatcher,
  main's webview key-forwarder, Settings display). New IPC
  `keybindings:set(action, binding)` → main validates, writes the file,
  updates its in-memory copy, and pushes `keybindings:changed` with the full
  map → renderer dispatcher re-parses; the webview policy reads bindings
  through a mutable reference so forwarding follows without re-installation.
  No app restart required.

## 2. Agent management

Extends the existing Settings agent cards:

- **Default agent** for the New session picker (persisted in `config.json`
  as `defaultAgent`; the existing lastAgent fallback chain slots below it).
- **Per-agent extra args** (string, appended at spawn) and **per-agent env
  overrides** (KEY=VALUE rows) — stored under `config.json`'s `agents`
  key, composed into `SpawnSpec` at spawn time. This is the local-LLM
  enabler (base-URL env vars against Ollama etc.) without any special
  casing; no cloud account required to use saiife.
- Path override cards stay as shipped (picker + resolution status).

## 3. Themes

- A theme is a JSON file in `userData/themes/<name>.json` mapping design
  tokens: app palette (surfaces, text, the five status colors) + xterm
  palette + font family/size. The Tailwind `@theme` CSS variables and
  xterm's theme option are already token-shaped — the renderer applies a
  theme by setting CSS variables on `:root` and passing the xterm palette
  to terminal instances. Live apply, no restart.
- `config.json`: `theme: "<name>"`; absent ⇒ built-in dark default.
- Ship presets: current dark (default), a light theme, and two popular
  terminal palettes. "Open themes folder" button for the community-sharing
  story; malformed theme files fall back to default with a visible notice,
  never a crash.
- Layout preferences (density, pane sizing) are explicitly out of scope for
  v1 — tokens only.

## Out of scope

Provider tokens (dropped permanently, see header), local-LLM recipe docs,
terminal-convenience actions (separate principle-driven work), layout
preferences, theme marketplace/import UI beyond the folder.

## Testing

Unit: binding serialization/conflict detection; config composition
(args/env/default-agent precedence); theme file parsing/validation +
fallback. e2e: capture-rebind a key and use it; default agent preselected;
theme switch changes a probe CSS variable live.
