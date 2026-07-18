# Operator-Readable Terminal & Working Operator Loop — Design

**Goal:** Make a localflow terminal pane's on-screen content machine-readable to the operator control API, make operator prompts actually submit, keep the `needs-you` status honest, and fix two terminal render bugs — so an external operator (openclaw) can *see* and *drive* a pane reliably.

**Architecture:** The root problem is that the operator's only content channel — `peek()` / the `output` control-API verb — regex-strips ANSI off a raw byte tail, which cannot resolve a redrawing TUI (it returns garbage like `246m`). We fix this by maintaining a **headless xterm.js terminal per pane in the main process**, fed the same pty bytes, and reading the *rendered screen* from its buffer. Four smaller fixes ride along: prompt submission, status honesty, and two renderer repaint/sizing bugs.

**Tech stack:** Electron main (Node) + `@xterm/headless@6` (new dep, aligned with the renderer's `@xterm/xterm@6`); renderer `@xterm/xterm` + `@xterm/addon-fit` (already present). TypeScript throughout; vitest unit tests.

## Global Constraints

- Conventional Commits, commitlint subject ≤ 50 chars.
- `peek`/instant-exit/`output` must be **fail-safe**: if the headless terminal ever throws, fall back to the existing ANSI-strip path — reading pane content must never crash the main process or the control API.
- Bounded memory: the headless terminal uses a modest fixed `scrollback` (1000 rows); one instance per live pane only.
- No behavior change to lfguard, the operator grant/auth, or the guard verdict path.
- Preserve existing pane/status semantics except the one intended `needs-you` fix.

---

## Component 1 — `terminal-screen.ts` (new, main)

A thin wrapper around a DOM-less `@xterm/headless` `Terminal`.

- **Consumes:** pty output chunks (`string`), and pane size (`cols`, `rows`) from the existing resize path.
- **Produces:**
  - `write(data: string): void` — feed a pty chunk into the emulator.
  - `resize(cols, rows): void` — keep the emulator sized to the pane.
  - `snapshot(maxLines?: number): string[]` — the **rendered screen** as plain text lines, read via `terminal.buffer.active.getLine(i).translateToString(true)` (already de-escaped by the emulator), trailing blank lines trimmed, last `maxLines` non-empty lines when `maxLines` given.
  - `dispose(): void`.
- Created with `new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })`. No renderer, no addon needed — `translateToString(true)` yields clean text, so `@xterm/addon-serialize` is **not** required (one dep, not two).
- Every public method is wrapped so a throw is swallowed and surfaced to callers as "unavailable" (callers fall back). Unit-testable in isolation: feed a redraw sequence (cursor moves + SGR like `[246m`), assert `snapshot()` returns the clean final frame with no escape fragments.

## Component 2 — session-manager wiring

- Each session record gains `screen: TerminalScreen` (created at spawn, sized from the pty, disposed on pane close).
- In the pty `data` handler (currently `rec.tail = (rec.tail + d).slice(-16384)` near session-manager.ts:390), **also** `rec.screen.write(d)`. `rec.tail` is retained unchanged as the fail-safe fallback source.
- On resize, call `rec.screen.resize(cols, rows)` alongside the existing pty resize.

## Component 3 — `peek()` reads the rendered screen

- `peek(id, maxLines = 5)` (session-manager.ts:679) returns `rec.screen.snapshot(maxLines)`; on any failure or empty result, fall back to `extractPeekLines(rec.tail, maxLines)`.
- This is the operator's content channel (the `output` control-API verb calls `peek`), so it now returns the readable rendered dialog instead of stripped bytes. `extractPeekLines`/`ANSI_RE` in `peek.ts` stay as the fallback.

## Component 4 — instant-exit message (session-manager.ts:432)

- Replace `rec.tail.replace(ANSI_RE, '')…slice(-160)` with the rendered snapshot: join `rec.screen.snapshot()` last lines, collapse whitespace, `slice(-160)`; fall back to the old expression if the screen is empty/unavailable. Fixes the same `246m` mid-escape truncation that motivated this.

## Component 5 — prompt submission fix (control-api)

- In the `POST /panes/:handle/prompt` route (control-api.ts:241), replace the single `manager.write(handle, `${b.text}\r`)` with **two separate writes**: `manager.write(handle, b.text)` then `manager.write(handle, '\r')`. Sending the carriage-return as its own chunk makes Claude's TUI treat it as a submit keypress rather than absorbing it into the pasted text. Guard/audit/response behavior is unchanged. (An empty `b.text` still results in a lone `\r` = a bare Enter, preserving the "submit the composer" use.)

## Component 6 — `needs-you` clears when work resumes

- Root cause: transition table (`state-machine.ts`) only leaves `needs-you` on `Stop` (→idle) or `UserPromptSubmit` (→working); after a *mid-turn* approval Claude fires neither until the whole turn ends, so the pane stays `needs-you` while actively working.
- **Fix:** add `PostToolUse` to the emitted hook events (`hook-settings.ts` `EVENTS`, and the codex/gemini adapters for parity) and a transition `PostToolUse → 'working'`. An approved tool actually executing = working again, which correctly clears `needs-you`; a *pending* prompt (Notification, tool not yet run) stays `needs-you`. `Notification→needs-you` and `Stop→idle` are unchanged.
- Validate against the real Claude hook order; `PostToolUse` firing on auto-approved tools too is harmless (redundant with `UserPromptSubmit→working`).

## Component 7 — renderer repaint on view-return (blank-until-keystroke)

- Symptom: leaving the environment view and returning shows a blank pane until a keystroke.
- Investigate whether `TerminalPane` **unmounts** on view switch or is **hidden**:
  - If hidden: add a visibility-triggered `fitRef.current.fit()` + `term.refresh(0, term.rows - 1)` so the existing buffer repaints without input.
  - If unmounted (new empty xterm on return): on (re)mount, replay the pane's current screen by writing `rec.screen`'s rendered snapshot (exposed via a new IPC/control read) into the fresh terminal, then fit+refresh.
- The plan phase resolves which by reading `App.tsx`'s view switching; the deliverable is: returning to a pane shows its last screen immediately, no keystroke.

## Component 8 — bottom clipping

- Symptom: the pane's colored status border doesn't reach the bottom and the last terminal row(s) are clipped.
- Fix the `TerminalPane` host sizing so the xterm content box fills the pane's content area exactly and `FitAddon.fit()` computes rows against the true height (no off-by-rows). Deliverable: the final row is fully visible and the status border reaches the bottom edge.

---

## Data flow

pty bytes → session-manager `data` handler → (`rec.tail` fallback **and** `rec.screen.write`) → operator calls `output` → control-api → `peek` → `rec.screen.snapshot()` → rendered dialog text the operator can read → operator decides → `POST prompt` (text write, then `\r` write) → pane submits.

## Error handling

- Headless-terminal failure anywhere → fall back to the byte-tail path; never throw into the control API or main loop.
- `snapshot()` on an empty buffer → empty array → caller uses fallback.
- Memory bounded by `scrollback: 1000` and one instance per live pane, disposed on close.

## Testing

- **Unit (`terminal-screen`):** redraw/cursor/SGR sequences → clean final frame; no `246m`-style fragments; `maxLines` trimming; throw-safety returns empty not crash.
- **Unit (peek):** `peek` returns the rendered snapshot; falls back to `extractPeekLines` when the screen is empty.
- **Unit (control-api prompt):** asserts two writes (`text`, then `\r`); empty text → single `\r`.
- **Unit (state-machine):** `needs-you` + `PostToolUse` → `working`; `needs-you` + `Notification` stays `needs-you`; `Stop` → `idle`.
- **Render bugs (7, 8):** covered by an e2e/manual check (view-switch repaint; last-row visibility) — noted in the plan as the verification step, since they're layout/paint behaviors.
