# M6 — Changes / diff review (design)

Scope decided with Jonas 2026-07-08: **read-only** review of what an agent
changed, with escape hatches to real tools. No staging, no committing, no
write operations against the user's repository in v1.

## The view

- A new **Changes** view (App view union + sidebar nav item), scoped to one
  session at a time: entered from an overview row's "changes" action or the
  sidebar; a session switcher inside the view for moving between sessions.
- Left: the file list from `git status --porcelain=v1` in the session's
  cwd — staged/unstaged/untracked badged distinctly, GitHub-Desktop-style.
- Right: the selected file's diff (`git diff` / `git diff --cached` merged
  view; untracked files shown as full-file additions). **Diff-level
  coloring only in v1** — added/removed/hunk-header tinting via the
  existing token palette; full language syntax highlighting is explicitly
  deferred (honest scope; no highlighting dependency added).
- Keyboard: `j`/`k` move through the file list; the diff pane scrolls with
  the normal keys. Bindings ship as remappable actions where they collide
  with nothing (bare letters are view-local, not global combos).
- Sessions whose cwd is not a git repository (or git is absent) show a
  plain explanatory empty state, never an error dialog.

## Escape hatches

- **"Open lazygit here"**: spawns a custom-command terminal session
  (`lazygit`) in the same cwd on the current environment — reuses the
  existing custom-agent plumbing wholesale; button disabled with a hint if
  lazygit isn't on PATH (same resolution helper agents use).
- **"Open in editor"**: runs the configured editor command (`config.json`:
  `editorCommand`, default `code`) with the cwd as argument, via the
  existing external-process conventions. Not a pane — the external app.

## Main-process surface

- `git:status(sessionId)` and `git:diff(sessionId, path, staged)` IPC —
  main resolves the session's cwd (never trusts a renderer-supplied path),
  runs git via `execFile` with args arrays (no shell), read-only commands
  only, output size-capped with a "diff too large" fallback message.
- No watching in v1: the view refreshes on entry, on session switch, and
  via a manual refresh action (plus a cheap poll while the view is visible,
  matching the app's existing 1s session poll rhythm).

## Out of scope

Staging/unstaged toggling, committing, discarding, branch operations, file
tree (flat list v1), language syntax highlighting, hunk-level j/k
navigation (files only), non-git VCS.

## Testing

Unit: porcelain parser, diff size-cap logic, editor/lazygit availability
gating. e2e: a scripted git repo fixture (init, modify files) → the view
lists the files, shows a colored diff, j/k moves selection; non-repo cwd
shows the empty state.
