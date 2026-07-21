# OpenClaw operator launch & auto-wiring — design

## Overview

The agent-driven environment control milestone shipped a per-environment,
opt-in, revocable operator control API and a portable OpenClaw `saiife`
skill. Wiring OpenClaw to a granted environment is currently **manual**: the
user grants an environment in the cockpit, copies the endpoint + token, and sets
`SAIIFE_ENDPOINT` / `SAIIFE_TOKEN` themselves.

This design closes that gap. saiife **launches OpenClaw as an operator agent**
— a pty pane like any other agent — and on launch it **auto-grants the pane's
environment and injects the credential** so OpenClaw can drive that environment
with zero manual setup. Closing the pane revokes the grant and clears the
credential. It stays fully opt-in: nothing here changes the "works with no
operator" guarantee, and every pane remains human-drivable.

**Locked principle (unchanged):** saiife is the cockpit + control surface,
not the brain. OpenClaw owns its own reasoning/sessions; saiife owns the pane,
the scoped control API, and now the launch + wiring convenience.

## Goals

- Launching OpenClaw in an environment wires it to that environment's operator
  grant automatically — no copy/paste of endpoint or token.
- The credential lives only as long as the session; closing the pane tears the
  grant down. No persistent global-config mutation in the common path.
- The already-shipped `openclaw/skills/saiife/` skill + CLI ship **unchanged**.
- Single-environment for v1, with the credential modelled so multi-environment
  is an additive follow-up, not a rewrite.

## Non-goals (v1)

- **Multi-environment from one OpenClaw** — deferred, but the credential shape is
  designed for it (see "Multi-environment: the additive path").
- **Auto-wiring an externally-run OpenClaw** — the manual env-var path already
  covers "I run my own OpenClaw"; a persistent config-file writer for that case
  is not built here.
- **Installing the saiife skill into the user's OpenClaw** — the CLI is
  shipped in this repo; pointing OpenClaw at it is a documented prerequisite.

## Architecture

### 1. OpenClaw as a launchable agent

Add an `openclaw` agent preset alongside `claude` / `codex` / `gemini`
(`src/shared/agents.ts`, `AgentId` union in `src/shared/types.ts`). It reuses the
existing `AgentRegistry` command-resolution and spawn path unchanged — so it
appears in the New-session picker and resolves/`which`es its `bin: openclaw` like
any other agent. A missing binary surfaces the existing "agent not found"
handling with no new code.

### 2. Launch flow (grant → credential → inject → track)

When a session is created with `agentId: 'openclaw'` in environment `N`, the main
process performs three steps atomically around the existing spawn:

1. **Grant** — call the existing `OperatorGrantStore.grant(N)` (idempotent;
   returns the existing token if one is already granted). Record whether *this
   launch* created the grant (grant ownership), for teardown.
2. **Inject** — compose the credential (below) into the spawned pty's
   environment.
3. **Track** — associate the grant with the session id so that when the session
   is **removed** (deleted from the session list), saiife revokes the grant
   **iff the launch created it** and clears any injected credential. Closing or
   exiting the pane keeps the session (it stays restartable), so the grant lives
   as long as the durable session does — see "Grant ownership & lifecycle".

### 3. Credential model

saiife's internal shape is a forward-compatible grant set:

```ts
interface OperatorCredential {
  endpoint: string // loopback control-API base, e.g. http://127.0.0.1:<port>
  grants: { environment: number; token: string }[] // v1: exactly one
}
```

For v1 this flattens, at injection time, to the two environment variables the
**shipped** skill already reads: `SAIIFE_ENDPOINT` and `SAIIFE_TOKEN`. The
grant set is saiife-internal; the skill/CLI contract is untouched.

### 4. Injection mechanism

Two paths, chosen by a design-time verification against OpenClaw's docs
(does OpenClaw forward the parent process env to a skill's subprocess, or only
inject `skills.entries.<name>.env`?). Both keep the credential per-session and
self-cleaning:

- **Primary — process env.** Set `SAIIFE_ENDPOINT` / `SAIIFE_TOKEN` on the
  spawned pty's environment (the spawn path already supports per-session env
  composition). Nothing is written to disk; the credential dies with the process.
- **Fallback — scoped config block.** If OpenClaw only reads
  `skills.entries.saiife.env`, saiife writes exactly that block into
  `~/.openclaw/openclaw.json` immediately before spawn and **removes it on pane
  close**. Unlike an externally-run OpenClaw, a launched session's block is
  transient and saiife-owned.

The mechanism is confirmed by a Task-1 verification + the e2e fixture proving the
credential actually reaches the skill.

### 5. Grant ownership & lifecycle

- **Launch created the grant** → **deleting** the session revokes it and clears
  the credential. Closing or exiting the pane keeps the session (restartable), so
  the grant persists until the session is deleted or the app exits (grants are
  in-memory). Keying revoke on deletion — not pty exit — is deliberate: a
  closed-but-not-deleted OpenClaw session can be restarted, and its grant should
  still be there when it is.
- **Env was already operator-granted** (e.g. toggled in the cockpit, or a second
  OpenClaw pane in the same env) → launch **reuses** the token and does **not**
  revoke on delete. saiife only tears down grants it created.
- **After an app restart**, a restored OpenClaw session is **not** re-wired
  (grants are in-memory and do not survive restart) — relaunch it to re-grant.
  Documented v1 limitation.
- **Revoke from the cockpit while OpenClaw is live** → the next control-API call
  gets `403` (existing hardened behavior); the pane keeps running for the human,
  it just loses drive access.
- **Injection failure** (config-block path cannot write `~/.openclaw/`) → fail
  visibly; do not launch a silently-unwired OpenClaw.

### 6. Transparency

The cockpit already renders per-environment operator status. A launched OpenClaw
pane makes its environment read "granted · connected" as soon as the skill makes
its first call — so the wiring is visible, not hidden. When the config-block
fallback is used, saiife surfaces the exact block it wrote.

## Data flow

```
New session (agentId=openclaw, env N)
  → main: grant(N) → {endpoint, token}
  → main: credential = {endpoint, grants:[{environment:N, token}]}
  → main: inject SAIIFE_ENDPOINT/SAIIFE_TOKEN into pty env (or scoped config block)
  → spawn openclaw pty in the pane
  → OpenClaw runs its saiife skill → control API (env N scoped) → drives panes
  → cockpit shows env N "granted · connected"
session deleted (removed from the session list)
  → main: if launch-created the grant → revoke(N) + clear credential/config block
  (closing/exiting the pane keeps the session + grant; delete or app-exit tears it down)
```

## What is unchanged

- `openclaw/skills/saiife/` (SKILL.md, `saiife-control.mjs`, README) — the
  v1 single-environment injection targets exactly the env vars the CLI already
  reads.
- The control API, `OperatorGrantStore`, `PaneRegistry`, and the cockpit — reused
  as-is.

## Security & isolation

- The token stays per-grant and env-scoped; a launched OpenClaw reaches only its
  own environment. Isolation is unchanged from the shipped milestone.
- Process-env injection keeps the token out of any persistent on-disk file. The
  config-block fallback is transient and removed on close.
- Grants remain opt-in and revocable; launching is an explicit user action.

## Testing

- **Unit:** launch orchestration — grant + credential-set build, the
  flatten-to-env-vars, and the revoke-on-close ownership logic (launch-created vs
  pre-existing grant).
- **e2e:** a `fake-openclaw.sh` fixture (mirroring `fake-claude.sh`) that writes
  its received env to a marker file. Launch it in env N under `SAIIFE_E2E`;
  assert the spawned env carries `SAIIFE_ENDPOINT`/`SAIIFE_TOKEN`, the
  cockpit shows env N granted, then close the pane and assert the grant is
  revoked (old token → `403`).
- **Design-time verification (Task 1):** confirm OpenClaw's process-env vs
  config-block skill-env behavior to pick the injection path.

## Multi-environment: the additive path (not built in v1)

When multi-environment is wanted, the credential set already carries multiple
`grants`. The additive changes:

- Inject a richer `SAIIFE_GRANTS` env var (a JSON `{ "<env>": "<token>" }`
  map) alongside the single-env vars.
- Extend the CLI/skill with a per-call environment selector (e.g. `--env N`, or
  resolve the environment from the handle via a `panes`-built lookup) that picks
  the matching token.
- Let a launched OpenClaw be granted on a chosen **set** of environments (each
  still opt-in and independently revocable).

None of this changes the single-environment v1 wire format.
