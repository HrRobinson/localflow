# Agent-driven environment control (OpenClaw) — design

Scope decided with Jonas 2026-07-09. A **combined** milestone covering two
stacked subsystems: (A) letting an agent **operator** drive the panes in a
saiife environment, and (B) **workflow watchpoints** that capture state when
a running workflow reaches a chosen step. The reference operator is
[OpenClaw](https://github.com/openclaw/openclaw) (MIT, local-first) — it already
ships a mature `browser` tool and the **Lobster** workflow engine, so saiife
**integrates** rather than rebuilds.

## Guiding principle

**saiife is the cockpit and the control surface, not the brain.** Panes stay
a human-first product — a browser pane for a dashboard, YouTube, or a project's
`localhost`; a terminal pane for a coding agent — and everything works with **no
operator connected**. An operator (OpenClaw) is an **optional, per-environment,
revocable grant** that adds control on top; it never becomes a dependency.

The division of ownership is deliberate and fixed:

- **OpenClaw owns the brain** — its own sessions/threads (one per ticket/task),
  memory, skills, and Lobster workflows. saiife does **not** reimplement any
  of these.
- **saiife owns the surfaces** — the panes, a control API over them, the
  per-environment operator grant, and a read-only cockpit that reflects what the
  operator is doing.

We do **not** merge the two orchestration models. saiife hosts and observes;
OpenClaw executes.

## Architecture overview

Four layers, each independently testable, built in order:

1. **Pane registry + control API + operator grant** — stable per-pane handles
   scoped to an environment; a loopback control API guarded by a per-grant
   secret; terminal control (nearly free — see below). *(No OpenClaw needed to
   test this layer; a scripted client exercises it.)*
2. **Browser control** — navigate / screenshot / inspect(network, cookies) / act
   against the **existing M3.5 browser pane**, implemented over the webview's
   DevTools protocol.
3. **OpenClaw integration + cockpit** — a `saiife` skill on the OpenClaw side
   that wraps the control API; the renderer cockpit that shows operator status
   and an action log.
4. **Workflow watchpoints + state capture** — realized as a checkpoint step in a
   Lobster workflow that captures state and optionally halts for review.

## The pane control surface

A **single** interface every pane exposes; the human chrome and the operator
bridge are just two clients of it. A pane does not know who is driving it.

- **Browser panes** (`kind: 'browser'`): `navigate(url)`, `screenshot() → file`,
  `inspect.cookies()`, `inspect.network()`, `act(snapshotRef, action)`.
- **Terminal panes** (`kind: 'terminal'`): `prompt(text, attachments?)`,
  `output(maxLines)`.

Terminal control is **nearly free**: saiife already exposes `write(id, data)`
(pty input) and `peek(id, maxLines)` (cleaned output). `prompt` writes text (plus
a trailing submit) to the pty; `output` is `peek`. The genuinely new pieces are
the browser controls and the addressing/grant plumbing around all of it.

### Screenshot → terminal handoff

An operator hands an image to a coding-agent terminal by reference, not by pixels:
`screenshot()` writes the capture to a file under the target project's cwd (or a
per-environment scratch dir the terminal can read) and returns the **path**. The
operator's `prompt` then references that path (e.g. Claude Code reads the image
from disk). This is how "send the shop screenshot to the Claude Code terminal"
actually works.

## OpenClaw as a per-environment operator

### Grant

An environment has at most **one operator** (v1). The user grants it explicitly
(a per-environment toggle: "Let an operator drive this environment"). The grant
is **opt-in, consent-gated, revocable**, and always visibly indicated on the
environment. Revoking it immediately invalidates the operator's access.

On grant, saiife:

- mints a **per-grant shared secret** (bearer token) and a **loopback control-API
  endpoint** bound to that environment;
- exposes the endpoint+token to the operator (the OpenClaw `saiife` skill is
  configured with them).

### Connection

OpenClaw runs either as a saiife-managed session in the environment (saiife
already supports custom-command sessions, so launching the OpenClaw gateway is
nearly free) **or** as an external instance the user points at. Either way, the
link is the grant's endpoint+token — saiife does not care where OpenClaw runs,
only that a holder of the token drives panes in the granted environment.

### Scoping (the isolation guarantee)

Every pane has a **stable saiife handle**. The control API resolves handles
**only within the granted environment**: an operator on environment A can neither
see nor drive environment B's panes. This is the "9 customers → 9 environments"
isolation story — each environment gets its own operator (or none), fully
partitioned.

### The control API (saiife-exposed, loopback only)

Guarded by the per-grant bearer token; every route is scoped to the grant's
environment. Shape (illustrative, not final wire format):

- `GET  /panes` → panes in this environment: `{handle, kind, title, cwd, url|status}`
- `POST /panes/{handle}/navigate` `{url}` (browser)
- `POST /panes/{handle}/screenshot` → `{path}` (browser)
- `GET  /panes/{handle}/cookies` · `GET /panes/{handle}/network` (browser; partition-scoped)
- `POST /panes/{handle}/act` `{ref, action}` (browser interaction)
- `POST /panes/{handle}/prompt` `{text, attachments?: string[]}` (terminal)
- `GET  /panes/{handle}/output` `{maxLines}` (terminal)
- `POST /watchpoints` · `GET /watchpoints` · `GET /captures/{id}` (subsystem B)

On the OpenClaw side these are wrapped by a shipped **`saiife` skill** (portable
skill format), so the operator calls `saiife.panes`, `saiife.screenshot`,
`saiife.prompt`, etc., as ordinary skills/tools.

## Browser control — reuse the M3.5 pane

There is **one browser**: the M3.5 `<webview>` pane. A human drives it with the
URL bar and clicks; the operator drives the **same** pane through the control API.
No second browser, so the plain human use cases (a `localhost`, a video) are
untouched.

Internally, browser actions are implemented over the webview's DevTools protocol
(`webContents.debugger` / `capturePage` / `session.cookies`): `navigate` loads a
URL, `screenshot` captures the page, `inspect.cookies`/`inspect.network` read the
pane's state, `act` performs an interaction. **All reads are confined to the
isolated `persist:browser-panes` partition** (M3.5): cookies and network belong to
the sandbox, never the user's real browser session.

*(Considered alternative: expose the webview as a remote-CDP endpoint that
OpenClaw's own `browser` tool drives directly. Rejected for v1 — it leaks CDP
details across the boundary and splits the grant/scoping logic; keeping one
saiife-owned control surface is cleaner. Revisit if OpenClaw's richer browser
interactions prove worth it.)*

## Workflow watchpoints + state capture

A "workflow" here is an **OpenClaw Lobster workflow**: a DAG of steps (each a skill
invocation) with a durable, built-in **halt/approve/resume** primitive — a paused
step returns a token, state is persisted, and it resumes without re-running.

A **watchpoint** lets the user say "when the workflow reaches step N, capture and
save state." It is realized idiomatically as a **checkpoint step** in the Lobster
workflow — the `saiife` skill's `checkpoint` action:

1. The user registers a watch in saiife (in-memory) against a workflow + step
   label, choosing what to capture (workflow envelope, a browser pane screenshot,
   terminal output, a memory reference).
2. When the workflow reaches that step, the `checkpoint` action runs: it reads the
   current state, POSTs it to saiife `/captures`, and **optionally halts** on
   Lobster's approve token for human review.
3. saiife stores the capture and surfaces it in the cockpit; if halted, the
   user can inspect the captured state and **resume** (via the token) or stop.

This matches the intent exactly: *write the watch → when it hits, the operator
reads and saves state.* saiife never runs Lobster (OpenClaw does, in-process);
it only registers the watch, receives the capture, and drives the review UI.

## The cockpit

A read-only view in saiife, per environment:

- **Operator status** — connected/none, which environment, current activity.
- **Action log** — a rolling record of control-API calls the operator made
  (navigated, screenshotted, prompted terminal X), so the user can watch it work.
- **Captures** — the list of watchpoint captures, each openable to inspect the
  saved state (screenshot, terminal output, workflow envelope); halted ones offer
  resume/stop.

The cockpit **reflects** OpenClaw's activity; it does not own OpenClaw's sessions.
A user who wants to intervene can always take the pane over by hand — the pane is
human-drivable regardless of the grant.

## Worked example — one operator, two shops

Environment E holds two projects (shop A, shop B); each has a Claude Code terminal
pane and a browser pane on its `localhost`. The user grants an OpenClaw operator on E.

1. A style-change ticket for shop A arrives via OpenClaw's channel → OpenClaw opens
   a session/thread for the ticket.
2. Operator: `saiife.screenshot(handle = shopA-browser)` → saiife writes the
   capture into shop A's cwd, returns the path.
3. Operator: `saiife.prompt(handle = shopA-terminal, text = ticket + path)` →
   saiife writes it to the pty; Claude Code makes the change; `localhost` reloads.
4. Operator: `saiife.screenshot(shopA-browser)` again to verify; updates the ticket.
5. Shop B is handled by the same operator on a **separate** OpenClaw thread — "2
   tickets, 2 threads, one operator" is just how OpenClaw already works.
6. A watchpoint on the workflow's "verify" step captures `{screenshot, terminal
   output, envelope}` and halts for the user's sign-off in the cockpit.

saiife supplied the panes, the control surface, and the cockpit. OpenClaw
supplied the brain.

## Components / file structure

**Main (saiife):**

- `pane-registry` — assigns stable handles; resolves a handle only within a given
  environment (the scoping guarantee).
- `operator-grant` — per-environment grant state, secret minting, revocation.
- `control-api` — loopback HTTP server, bearer-token auth, environment-scoped routes.
- `browser-control` — webview DevTools ops: navigate, screenshot, cookies, network,
  act; partition-confined.
- `terminal-control` — thin wrappers over existing `write`/`peek`.
- `capture-store` — writes screenshots and watchpoint captures to disk; returns paths/ids.
- `watchpoints` — registry of watches; receives captures from the `checkpoint` action.

**Renderer (saiife):**

- Grant toggle UI on the environment (consent + visible indicator).
- Cockpit view — operator status, action log, captures browser (with resume/stop).
- Watchpoint UI — register/list watches on a workflow + step.

**OpenClaw side:**

- A shipped **`saiife` skill** wrapping the control API (`panes`, `navigate`,
  `screenshot`, `cookies`, `network`, `act`, `prompt`, `output`, `checkpoint`).

## Error handling

- **No grant / revoked mid-op** → control API returns 403; the operator skill
  surfaces "operator access denied/revoked." Revocation takes effect immediately.
- **Unknown/closed handle** → 404; the skill handles it gracefully (pane may have
  been closed by the human).
- **Browser CDP detach/failure** → the action returns an error; browser control
  degrades to "unavailable," never crashes the pane.
- **Terminal write to a dead pty** → error surfaced; no silent drop.
- **Watchpoint never reached** → no capture; cockpit shows the watch as "pending /
  not hit," honestly.
- **Capture-store disk failure** → error surfaced to the operator and cockpit; no
  silent loss.
- **Operator not running / unlinked** → the grant UI shows "no operator connected";
  the environment stays fully human-operable.

## Security & isolation

- **Opt-in, per-environment, revocable** grant; never ambient. A visible indicator
  whenever an environment has an operator.
- **Environment-scoped** — an operator can only see/drive panes in its own
  environment (enforced in `pane-registry`, not just the UI).
- **Loopback + per-grant bearer token** control API (mirrors OpenClaw's own
  control-API security model). No token / no grant → denied.
- **Partition-confined reads** — cookies and network come from the isolated
  `persist:browser-panes` partition, not the user's real browser.
- **Auditable** — the cockpit's action log records what the operator did.
- **Human override** — the pane is always human-drivable; the user can take over
  or revoke at any moment.

## Out of scope (v1, YAGNI)

- Building our own browser automation (we reuse the webview + its DevTools protocol).
- Reimplementing OpenClaw's sessions, memory, skills, or Lobster in saiife.
- More than **one operator per environment**, or cross-environment control.
- Non-OpenClaw operators — the control API is generic, but v1 targets OpenClaw and
  ships only the OpenClaw `saiife` skill.
- Persisting the saiife activity feed across restarts (separate concern).
- Rich browser interaction beyond navigate/screenshot/inspect/basic-act (defer the
  snapshot-ref interaction model unless it proves necessary).

## Build order (layers)

Even as one spec, the implementation plan builds in the four layers above:
registry+grant+control-API+terminal → browser control → OpenClaw skill + cockpit →
watchpoints. Each layer is shippable and testable before the next.

## Testing

- **Unit:** handle scoping (operator on env A cannot resolve an env-B handle);
  control-API auth (no token / wrong token / revoked → denied); terminal
  prompt/output wrappers; capture-store path/id handling; watchpoint registry and
  capture ingestion.
- **Integration / e2e:** grant an operator on an environment; drive a **scripted
  control-API client** (no real OpenClaw needed) through
  navigate → screenshot → prompt → output against real panes; assert a foreign-env
  handle is rejected; register a watchpoint, fire the `checkpoint` action, and
  verify the capture appears in the cockpit and (if halted) resumes via token.
- **Security probes:** without a grant the API denies; an operator on env A cannot
  touch env B panes; cookie/network reads are confined to the browser-panes
  partition.

## Open questions / integration seams

These are OpenClaw-facing details to confirm during planning; the saiife design
above is stable regardless of their resolution:

- Exact OpenClaw skill packaging/config for pointing the `saiife` skill at a
  grant's endpoint+token.
- Whether the `checkpoint` watchpoint is authored directly in the Lobster workflow
  or injected/registered declaratively by saiife at a labeled step.
- Whether browser control stays fully saiife-implemented (v1 choice) or later
  also offers the webview as a remote-CDP target for OpenClaw's native `browser`
  tool.
