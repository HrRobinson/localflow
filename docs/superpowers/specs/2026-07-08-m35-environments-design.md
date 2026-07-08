# M3.5 — Environments & browser panes (design)

Decided with Jonas 2026-07-08 (supersedes the roadmap's § M3.5 sketch where
they differ — notably: "environment" renames the *switchable container*
formerly called workspace, not the grid view label alone, and embedding uses
the `<webview>` tag, not `WebContentsView`).

## Why

An **environment** is the container a user switches between — one per
customer or project ("I run 9 customers → 9 environments"). Each environment
holds the panes for that piece of work: agent terminals, and now **browser
panes** — the localhost preview of what the agent is building, docs, PR
pages. This milestone does the vocabulary pass and ships the first
non-terminal pane type.

## 1. The rename: workspace → environment (everywhere)

M3 is unreleased (the release PR is still accumulating), so the rename has
zero migration cost. It is total — code, file formats, keys, copy:

- Keybinding actions: `environment-1…9` (default `cmd+1…9`),
  `move-to-environment-1…9` (default `ctrl+1…9`). Old `workspace-*` action
  names cease to exist; `mergeBindings` validation follows automatically.
- `sessions.json`: field `environment` (absent ⇒ 1, clamped 1–9).
- `config.json`: optional names key `environments` (`{"3": "acme-corp"}`,
  canonical single-digit keys only — same parser rules as M3 shipped).
- Shared module: `src/shared/environment.ts` (`clampEnvironment`,
  `visibleEnvironments`, `worstStatus`, `ENVIRONMENT_MIN/MAX`), replacing
  `src/shared/workspace.ts`. `src/main/workspace-names.ts` becomes
  `src/main/environment-names.ts`.
- IPC: `session:setEnvironment`, `environments:getNames`; the
  `session:create` environment argument keeps its position.
- Renderer: App state/props, Sidebar section header **"Environments"**, nav
  item **"Environment"** (was "Terminals" — it shows the current
  environment's grid), DOM hook `data-nav-environment`.
- Docs: README (table, example, prose), roadmap § M3/M3.5 amended.

`SessionInfo.workspace` → `SessionInfo.environment`. Internal view-state key
`'terminals'` → `'environment'`.

## 2. Data model: browser panes are sessions

`SessionInfo` gains:

- `kind: 'terminal' | 'browser'` — persisted; absent in old files ⇒
  `'terminal'`.
- `url?: string` — present iff `kind === 'browser'`; persisted and **updated
  as the user browses** (main listens to the embedded page's navigation and
  saves the latest http(s) URL), so relaunch restores where they actually
  were.

Browser panes are ordinary sessions: named (default = URL host), renameable,
deletable, ordered in the grid, assigned to an environment, listed in
sidebar/overview. They have **no pty**: `SessionManager` holds them as
process-less records —

- create → status `running` (violet; no status feed, honest color per the
  existing convention for feed-less panes),
- closeTerminal → `exited` (gray; webview unmounts),
- restart → `running` (remount at the stored URL; `fresh` is meaningless
  and treated identically),
- write/resize → no-ops; hook events never target them; they never turn
  `needs-you`, so `cmd+u` skips them by construction.

`agentId` is not extended — no fake "browser" agent enters the `AgentId`
union consumed by the registry/launcher. Browser records store inert filler
(`agentId: 'custom'`, `command: ''`); every UI surface branches on `kind`,
so the chip reads "browser" and no agent-path logic ever runs for them.

## 3. Embedding: `<webview>` tag, strict policy

**Deviation from the roadmap sketch (WebContentsView), with rationale:** the
`<webview>` tag participates in DOM layout, so the existing grid, enlarge,
focus ring, and overlay behaviors work unchanged; `WebContentsView` floats in
main-process window coordinates and would require continuous bounds-syncing
and z-order workarounds around enlarged panes and popovers. localflow is not
multi-frame-perf-sensitive; webview's known drawbacks don't bite here.

Security posture — **stricter than the app window**:

- `webviewTag: true` on the main window's webPreferences (documented
  judgment call alongside the existing `sandbox: false` note).
- Every webview: isolated `partition="persist:browser-panes"`, no preload,
  no `nodeintegration`, no `allowpopups`.
- Main process, `app.on('web-contents-created')`, for webview contents:
  - `setPermissionRequestHandler` → deny all (camera, mic, notifications,
    geolocation, …).
  - `will-navigate` → allow only `http:`/`https:` targets; deny others.
  - `setWindowOpenHandler` → `shell.openExternal` for `http:`/`https:`,
    deny everything else. New tabs/popups never open inside localflow.
- URL validation at every boundary that accepts a URL (create, navigate,
  persist): `http:`/`https:` only, parsed with `new URL`; scheme-less input
  is normalized to `https://` at the UI layer before validation.

## 4. Browser pane chrome (full mini-browser, per Jonas)

Header, left to right: status dot · name · **editable URL bar** ·
back · forward · reload · open-in-system-browser · enlarge · close.

- URL bar: shows the current URL (live-updated on navigation); Enter
  navigates (normalized + validated); Escape restores the displayed URL and
  returns focus to the page. It is the one control exempt from the
  pane-header `preventDefault` mousedown discipline (it must take focus);
  while it is focused, plain keystrokes must not reach other panes — the
  global dispatcher only claims bound combos, which continue to work.
- Back/forward: enabled/disabled from the webview's nav state; reload
  reloads; open-external hands the current URL to the system browser.
- Activating the pane focuses the webview (parallel to xterm focus rules).
- Load failures render Chromium's native error page — no custom error UI.

## 5. Creation flow

Overview → New session: the picker gains a **"Browser…"** entry (rendered
with the agent presets but not an `AgentId`). Selecting it swaps the
custom-command input for a URL field; "New session" creates a browser pane
on the current environment. Empty/invalid URL disables the button, same
pattern as the custom-command gate. Missing scheme ⇒ `https://` prefix.

## 6. Testing

- **Unit:** URL normalization/validation helpers; SessionManager browser
  lifecycle (create/close/restart/no-pty invariants, url update, persistence
  fields); environment-rename fallout is covered by the existing (renamed)
  suites.
- **e2e:** the test spins a local `http.createServer` (no external network,
  no flake) and drives: create browser pane via the Landing UI path where
  headless-safe (else API with explicit args, honestly commented), webview
  mounts with the right `src`, URL bar reflects it, close → exited →
  reopen restores, `kind`/`url`/`environment` survive a relaunch, renamed
  labels present ("Environments" header, "Environment" nav).

## 7. Out of scope (v1)

DRM sites (Spotify web needs Widevine — absent from stock Electron),
devtools toggle, per-pane zoom, favicon/page-title auto-naming, editable
URL history/omnibox suggestions, browser panes as M5 tree children (grid
siblings for now), any native-app embedding (impossible on macOS;
X11-only/dead and Wayland-forbidden on Linux — see roadmap § M3.5).
