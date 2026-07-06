# localflow — Design Spec

**Date:** 2026-07-06
**Status:** Approved for planning

## Overview

localflow is a macOS desktop app that acts as mission control for multiple
Claude Code sessions. Instead of juggling separate terminal windows, the user
gets one window with a grid of live terminal panes, each running a real
`claude` CLI session. Colored pane borders show at a glance which session
needs attention. The project will be published as an open-source repo
(GitHub, MIT license) with downloadable macOS builds.

## Goals

- Run many Claude Code sessions in one window, each in a real terminal pane.
- Instant visual status per session: who is working, who needs me, who is done.
- Spawn new sessions from the app (folder picker), restart or resume dead ones.
- Publishable quality: strict TypeScript, tests, CI, contributor standards.

## Non-goals (v1)

- Attaching to terminals opened outside the app.
- Windows/Linux builds, auto-update, signed/notarized binaries.
- Custom chat-style rendering of Claude output (panes are real terminals).
- Drag-to-rearrange grid layouts.

## Architecture

Three cleanly separated pieces:

### 1. Electron main process (backend)

- Spawns one PTY per session via `node-pty`, running the `claude` CLI in the
  user-chosen working directory.
- Owns the session registry: `{ id, cwd, ptyHandle, status, title }`.
- Runs a hook listener: a localhost-only HTTP server on a random port with a
  per-run secret token, receiving status events from Claude Code hooks.
- Persists open sessions (cwd list) to app storage; on relaunch offers to
  resume each via `claude --continue`.

### 2. Renderer (UI)

- React + TypeScript + Vite (electron-vite scaffold).
- Each pane is an xterm.js terminal bound to its PTY through typed IPC.
- Grid layout of panes; click to focus; double-click or keyboard shortcut to
  enlarge one pane to full window and back.
- Pane border + status dot colored by session state.
- "+ New session" button → native folder picker → spawns a session.
- Exited panes show a Restart button (offers `claude --continue`).

### 3. Status via Claude Code hooks

When spawning a session, the app injects hook settings (via `--settings`)
so Claude Code itself reports state. Each hook is a one-line `curl` POST of
`{ sessionId, event }` to the localhost listener (with the secret token).

State machine per session:

| Event                  | New state | Color  |
| ---------------------- | --------- | ------ |
| `UserPromptSubmit`     | working   | blue   |
| `Notification`         | needs-you | yellow |
| `Stop`                 | done/idle | green  |
| PTY exit               | exited    | gray   |

No screen-scraping or output-guessing: status is exact because Claude
reports it.

## Error handling

- `claude` binary not found → friendly setup message in the pane.
- Session crash/exit → gray pane with Restart (resume) button.
- Hook listener port conflict → impossible by construction: a random free
  port is chosen at startup and injected into hook settings.
- Hook POST with bad/missing token → rejected and logged.

## Security

- Electron hardening: `contextIsolation: true`, `nodeIntegration: false`,
  single typed preload bridge as the only IPC surface.
- Hook listener bound to `127.0.0.1` only, per-run secret token.
- No telemetry.

## Testing

- **Unit (Vitest):** session state machine transitions; hook event parsing
  and token validation.
- **E2E smoke (Playwright + Electron):** launch app, open a pane, POST a
  status event to the listener, assert the pane color changes.

## Repo & publishing

- Public GitHub repo `localflow`, MIT license.
- README with demo GIF and quickstart; CONTRIBUTING.md; PR template.
- Structure: `src/main`, `src/renderer`, `src/shared`.
- TypeScript strict mode; ESLint + Prettier.
- `npm run check` aggregates lint + typecheck + unit tests (the same gate CI
  runs), so contributors can verify locally with one command.

## Contribution standards (enforced from first commit)

- **Conventional Commits**, subject line max 50 characters, imperative mood,
  "why" over implementation detail.
- Enforced by **commitlint** as a husky git hook locally AND as a hard CI
  failure on every PR (commits and PR title — squash merges use the title).
- CONTRIBUTING.md recommends AI-assisted contributors install
  [caveman](https://github.com/juliusbrussee/caveman) and use
  `/caveman-commit` to produce compliant messages; the requirement itself is
  tool-agnostic.
- PR template checklist: what/why, tests added, `npm run check` passes.

## CI/CD (GitHub Actions)

Each a separate status check on every PR:

1. **commitlint** — hard fail on non-conventional commits or PR title.
2. **lint** — ESLint + Prettier check.
3. **typecheck** — `tsc --noEmit`.
4. **unit** — Vitest.
5. **e2e** — Playwright on a macOS runner; path-filtered to `src/**`
   (skipped for docs-only PRs).
6. **build** — `electron-builder --dir` packaging check.
7. **CodeQL** — GitHub security scanning.

Plus:

- **Dependabot** for dependency update PRs.
- **release-please** maintains a release PR (CHANGELOG + semver bump derived
  from feat/fix commit types). Merging it tags a release; the **release
  workflow** builds unsigned macOS `.dmg`/`.zip` artifacts and publishes a
  GitHub Release.

## Open questions

None — all decisions above were made with the user during brainstorming.
