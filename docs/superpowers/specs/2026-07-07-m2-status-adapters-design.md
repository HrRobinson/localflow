# M2 — Status Adapters for Codex & Gemini: Design Spec

**Date:** 2026-07-07
**Status:** Draft, for review. Builds on the shipped Claude Code hook
pipeline (`hook-settings.ts` → `hook-server.ts` → `SessionManager.applyHookEvent`
→ `state-machine.ts`) and the M1.6 durable-sessions `SpawnSpec`/`SessionInfo`
shape. No change to `HookEventName`, the state machine, or the listener's
token/port validation — this milestone is purely about how each agent gets
our canonical event onto that same listener.

## Goal

Give Codex and Gemini sessions real status colors (working/needs-you/idle),
matching Claude Code today, instead of the permanent violet `running`
fallback. Research (2026-07-06, summarized in the v2 roadmap's M2 section)
confirmed both CLIs have Claude-like hook systems, but with real, named
uncertainty about exactly how much of each can be injected per-invocation
(no on-disk config edits — localflow never touches the user's own
`~/.codex/config.toml` or `~/.gemini/settings.json`). This spec's job is to
turn that uncertainty into an explicit, testable set of fallback tiers
rather than a single "hope it works" implementation.

## Model: one adapter per agent, one wire format

Every agent's hook command — however it gets injected — POSTs the same
`{paneId, event}` JSON body to the existing `hook-server.ts` listener, with
the same `X-Localflow-Token` header. `hook-server.ts`, `parseHookBody`,
`SessionManager.applyHookEvent`, and `state-machine.ts`'s `transition()` are
**unchanged by this milestone** — they already only know about the three
canonical `HookEventName`s (`UserPromptSubmit`, `Notification`, `Stop`).
What differs per agent is:

1. **How the hook command is injected** (a file path flag, an env var, or
   raw CLI args) — the *mechanism*.
2. **Which of the agent's native hook events exist at all, and which of
   *those* localflow can actually reach programmatically** — the
   *fidelity*, expressed as a per-agent tier.
3. **The mapping from the agent's native event name (or payload shape) to
   our canonical `HookEventName`** — baked into the generated hook command
   itself, so every downstream piece of code only ever sees
   `UserPromptSubmit` / `Notification` / `Stop`, never a native name.

```
AgentPreset.hookAdapter (HookAdapterKind)
        │
        ▼
buildHookInjection(kind, dir, paneId, port, token) → { args: string[], env: Record<string,string> }
        │
        ▼
SessionManager.spawn() appends args, merges env, same as today's
`--settings <file>` for Claude
        │
        ▼
agent CLI runs, its own hook mechanism fires the embedded curl command
        │
        ▼
hook-server.ts (unchanged) → SessionManager.applyHookEvent (unchanged) →
transition() (unchanged) → SessionInfo.status → pane border color
```

## `HookAdapterKind` (replaces `SpawnSpec.useHooks: boolean`)

```ts
// src/shared/agents.ts
export type HookAdapterKind =
  | 'settings-file' // claude: --settings <file> (today, unchanged)
  | 'env-settings-file' // gemini: GEMINI_CLI_SYSTEM_SETTINGS_PATH env var
  | 'cli-args-full' // codex tier 1: full per-event hook table via -c
  | 'cli-args-notify' // codex tier 2: legacy `notify` (turn-complete) only
  | 'none' // no adapter — violet 'running' fallback (custom, or an
  // agent/tier that failed verification)
```

`useHooks: boolean` was a yes/no switch; `HookAdapterKind` is a *dispatch
key* — `SessionManager` no longer special-cases "is this Claude," it calls
one dispatcher (`buildHookInjection`, new `src/main/hook-adapter.ts`) that
switches on the kind. `hasHookAdapter(kind) = kind !== 'none'` replaces the
old boolean everywhere a yes/no answer is still needed (initial status,
`AgentInfo.hasStatusFeed`).

## Per-agent adapters

### Claude — `settings-file` (unchanged)

`src/main/hook-settings.ts`'s `buildHookSettings`/`writeHookSettings` stay
exactly as they are today: a `--settings <file>` flag pointing at a
generated JSON file with `hooks.UserPromptSubmit`/`Notification`/`Stop`,
each a `curl` command embedding `{paneId, event}`. No mapping needed —
Claude's native hook names *are* our canonical `HookEventName`s (the type
was modeled on them first). This is the reference implementation the other
two adapters are built to match in spirit (same curl command shape, same
0600 file permissions, same `assertSafeToken`/`assertValidPort` input
validation) but not in mechanism.

### Gemini — `env-settings-file`, one generator, two live tiers

Research: `settings.json` hooks `BeforeAgent`, `Notification`
(`ToolPermission` sub-type → needs-you), `AfterAgent`, injectable via the
`GEMINI_CLI_SYSTEM_SETTINGS_PATH` env var pointing at a localflow-managed
file. This is *structurally* the same mechanism as Claude's — a full
hooks-table JSON file — just pointed at via an environment variable instead
of a CLI flag, which is why it's the higher-confidence of the two new
adapters (unlike Codex, there's no "legacy vs. full" mechanism split; there
is exactly one file shape).

Mapping (native → canonical):

| Gemini hook | Canonical event | Status |
|---|---|---|
| `BeforeAgent` | `UserPromptSubmit` | working |
| `Notification` (payload's notification kind is `ToolPermission`) | `Notification` | needs-you |
| `Notification` (any other kind) | *(none — command exits 0 silently)* | unchanged |
| `AfterAgent` | `Stop` | idle |

`src/main/gemini-hooks.ts` (new) exports `buildGeminiHookSettings` /
`writeGeminiHookSettings`, mirroring `hook-settings.ts`'s shape exactly
(same validation, same 0600 write, same curl-command builder), except the
`Notification` hook's command is not a bare `curl` — it must first inspect
its own stdin (the hook payload Gemini feeds it) to decide whether this
notification is a `ToolPermission` approval prompt before POSTing, since a
`Notification` hook can fire for other notification kinds that are *not*
needs-you moments (e.g., a background progress ping) and localflow must
not paint the pane yellow for those.

```sh
sh -c 'body=$(cat); case "$body" in
  *"\"type\":\"ToolPermission\""*|*"\"type\": \"ToolPermission\""*)
    curl -s -m 3 -X POST http://127.0.0.1:<port>/event \
      -H "Content-Type: application/json" -H "X-Localflow-Token: <token>" \
      -d '"'"'{"paneId":"<id>","event":"Notification"}'"'"' ;;
esac'
```

**Uncertainty flag (research-confirmed gap):** the exact stdin JSON field
name/casing Gemini uses to identify a `ToolPermission` notification is
*unverified* — the roadmap's research established the hook points exist
and are injectable, not their payload schema. The command above greps for
both a compact and a space-after-colon JSON encoding of `"type":
"ToolPermission"`; if Gemini's real field is named differently (e.g.
`kind` or `notificationType`), the grep simply never matches.

**Fidelity, honestly stated:** this produces a *single* generator (`buildGeminiHookSettings` always emits all three hooks), with a **silent, self-limiting degradation** rather than a coded tier switch:

- **If the `ToolPermission` grep matches reality:** full fidelity —
  working/needs-you/idle all live, identical to Claude.
- **If it doesn't:** `BeforeAgent`/`AfterAgent` still work (working/idle
  stay accurate throughout), and `Notification` hooks simply never fire —
  needs-you approval prompts never turn the pane yellow. The user sees
  exactly what they'd see today (glance at the terminal to notice a
  pending prompt) for *that one moment only*; every other transition stays
  correct. This is a strictly smaller, more contained failure mode than
  Codex's (below), because the payload-matching risk is isolated to one
  of three hooks, not the whole mechanism.

No code branch is needed for this because both outcomes use the *same*
generated settings file — "partial" isn't a `HookAdapterKind`, it's an
accepted, documented possible outcome of `env-settings-file` in production.

### Codex — `cli-args-full` / `cli-args-notify`, two real tiers, one mechanism-level fork

Research: `hooks.json` events `UserPromptSubmit`, `PermissionRequest`
(→ needs-you), `Stop`, injectable per-invocation via `-c key=value` /
`--profile`. This is the **higher-uncertainty** adapter: unlike Gemini,
where the mechanism (a settings file) is solid and only a payload field is
in question, Codex's open question is the *mechanism itself* — whether
`-c` overrides can express a nested hook table (an array of command
objects per event) at all, versus only ever having supported the older,
simpler `notify` override (a single external program invoked on
turn-complete — Codex's long-standing "ping me when done" mechanism,
predating any hooks.json-style event table). That is a qualitative
difference, not a payload-shape nuance, so it gets two distinct
`HookAdapterKind`s rather than one generator with silent degradation:

Mapping (native → canonical), tier `cli-args-full`:

| Codex hook | Canonical event | Status |
|---|---|---|
| `UserPromptSubmit` | `UserPromptSubmit` | working |
| `PermissionRequest` | `Notification` | needs-you |
| `Stop` | `Stop` | idle |

Mapping, tier `cli-args-notify`:

| Codex mechanism | Canonical event | Status |
|---|---|---|
| legacy `notify` (fires once, on turn-complete) | `Stop` | idle |
| *(no equivalent exists)* | `UserPromptSubmit` | *(never sent — see limitation below)* |
| *(no equivalent exists)* | `Notification` | *(never sent — see limitation below)* |

`src/main/codex-hooks.ts` (new) exports `buildCodexHookArgs(paneId, port,
token, tier)`, returning the `-c ...` argv pairs for either tier (or `[]`
for tier `'none'`, kept only so callers can treat all three tiers
uniformly). Same `assertSafeToken`/`assertValidPort` guards as
`hook-settings.ts`. **The exact `-c` value grammar in this file is
UNVERIFIED** (TOML-override-style key/value vs. something else entirely —
Codex's own `--help`/docs must settle this) and is explicitly called out
in a code comment as "confirm/correct against a real `codex` binary before
trusting this in production." What *is* testable today, independent of
that grammar: which tier is selected, that `paneId`/`port`/`token` are
correctly embedded and escaped in whatever string is produced, and that
each tier emits exactly the events its mapping table claims and no others.

**Fidelity, honestly stated — the naive design this spec explicitly rejects:**
a naive implementation would assume tier `cli-args-full` and map `Stop`
into a resting `idle` state, expecting a later `UserPromptSubmit` to flip
the pane back to `working` when the user queues another turn. In tier
`cli-args-notify`, that `UserPromptSubmit`-equivalent **does not exist** —
there is no signal at all for "the agent started working again." The
honest resolution, not a workaround:

- Tier `cli-args-notify` never fabricates `working` or `needs-you` — it
  only ever POSTs the `Stop`-mapped event, and only when a turn actually
  completes.
- The pane's resting color is `idle` (green) whenever a `Stop` has fired
  since spawn, and `idle` initially at spawn (same uniform rule as every
  other real adapter — see `SessionManager` changes below).
- **Known, documented limitation:** between the user submitting a new
  prompt and the next `Stop` firing, the pane keeps showing `idle` even
  though the agent is actually mid-turn — there is no event that could
  ever tell localflow otherwise in this tier. This is *stale-but-honest*,
  not silently wrong: it is exactly as accurate as the last real signal,
  never fabricated. It is still a net improvement over permanent violet
  `running`, because `idle`↔`exited` (crash/quit) remain fully accurate
  throughout, and `idle` genuinely does mean "a turn just completed" at
  the moment it's asserted — the gap is a *staleness window*, not a false
  claim.
- If a future verification pass shows even legacy `notify` isn't
  injectable per-invocation, tier drops to `'none'` — the original,
  fully-honest violet fallback, a strict superset of today's behavior,
  never a regression.

## Which tier ships by default

Because this milestone changes the *shipped* default for the `codex` and
`gemini` presets (the task explicitly calls for "presets flip codex/gemini
to hooked... custom stays running"), and because neither CLI is installed
on this development machine (nor in CI), the default tier choice is a
judgment call made *now*, to be corrected by the manual verification step
(see Testing) before or shortly after release:

| Agent | Default `hookAdapter` | Why |
|---|---|---|
| `claude` | `settings-file` | Unchanged, already shipped and verified. |
| `gemini` | `env-settings-file` | Single mechanism, high-confidence per research; worst case is a silently-missing needs-you color, never a stuck/misleading one. |
| `codex` | `cli-args-notify` | The *safe* tier, not the optimistic one. Shipping `cli-args-full` unverified risks the worse failure mode: if `-c` silently drops/ignores an unsupported nested hook table, the pane would sit at `idle` (which we can no longer distinguish from "genuinely done") **forever**, which actively misleads more than the honest "unknown" violet it replaces. `cli-args-notify`'s only failure mode if wrong is falling back to no signal at all (tier `'none'`) — never a wrong-but-confident one. |
| `custom` | *(no preset — `AgentRegistry.hookAdapter` returns `'none'` for any agent id without a preset)* | Unchanged — a hand-typed command has no known hook mechanism to target. |

This means Codex ships hooked (idle/exited real, working/needs-you not
claimed) rather than either the risky optimistic tier or the previous
"still violet" tier. Upgrading Codex to `cli-args-full` is a one-line
preset change (`hookAdapter: 'cli-args-full'`) gated on the manual
verification step below actually confirming the nested-table `-c` syntax
against a real `codex` binary — this spec ships the generator for that
tier now (fully unit-testable in isolation) so the upgrade, once verified,
requires no new code, only flipping the preset and re-running the existing
test suite.

## `SpawnSpec` / `SessionManager` changes

```ts
// src/main/session-manager.ts
export interface SpawnSpec {
  agentId: AgentId
  command: string
  resumeArgs: string[]
  hookAdapter: HookAdapterKind // replaces useHooks: boolean
}
```

```ts
// src/main/hook-adapter.ts (new) — the one dispatch point SessionManager calls
export interface HookInjection {
  args: string[]
  env: Record<string, string>
}

export function buildHookInjection(
  kind: HookAdapterKind,
  dir: string,
  paneId: string,
  port: number,
  token: string
): HookInjection
```

`SessionManager.spawn()`:

- Initial `status`: `hasHookAdapter(spec.hookAdapter) ? 'idle' : 'running'`
  — replaces today's `spec.useHooks ? 'idle' : 'running'`. This is the
  *only* place tier fidelity and initial state interact, and it's
  deliberately uniform across every real adapter (full or degraded):
  "idle" at spawn means "ready, nothing has happened yet," which is
  equally true whether or not the adapter can later detect `working`.
- Replaces the `hookArgs = spec.useHooks ? [...] : []` conditional with a
  single `buildHookInjection(spec.hookAdapter, this.opts.settingsDir, id,
  this.opts.port, this.opts.token)` call; its `args` are spread ahead of
  `resumeArgs` exactly where `hookArgs` was, and its `env` is merged into
  the spawned process's `env: { ...process.env, ...injection.env }`
  (today's `env: process.env` passthrough, additively).
- `'none'` produces `{ args: [], env: {} }` — a no-op, so calling
  `buildHookInjection` unconditionally (rather than branching before the
  call) costs nothing extra for `custom` sessions.

`AgentPreset`/`AgentRegistry`:

- `AgentPreset.useHooks: boolean` → `AgentPreset.hookAdapter: HookAdapterKind`.
- `AgentRegistry.useHooks(agentId)` → `AgentRegistry.hookAdapter(agentId):
  HookAdapterKind`, returning `presetFor(agentId)?.hookAdapter ?? 'none'`
  (unchanged fallback semantics for `custom`).
- `AgentInfo.hasStatusFeed` computed as `hasHookAdapter(preset.hookAdapter)`
  instead of `preset.useHooks` directly — same boolean surface for the
  renderer (agent launcher cards), no renderer changes needed.

## Non-goals

- No auto-detection/probing of the real CLI's hook capabilities at
  runtime (e.g., spawning `codex --help` and grep-parsing it to pick a
  tier automatically). Tier selection is a static preset value, corrected
  by a human running the manual verification checklist — a runtime probe
  would add its own failure modes (parsing a `--help` text is at least as
  fragile as the hook mechanism itself) for a one-time decision that
  doesn't need to be dynamic.
- No change to `HookEventName`, `hook-server.ts`, `state-machine.ts`, or
  the listener's token/port validation — this milestone is entirely about
  generating the injected command/file/env, never about the receiving
  side.
- No support for a user's own pre-existing `~/.codex/hooks.json` or
  `~/.gemini/settings.json` merging with localflow's injected ones —
  `-c`/env-var injection is chosen specifically because it's additive at
  the process-invocation level and never touches the user's on-disk
  config; if a user's own `GEMINI_CLI_SYSTEM_SETTINGS_PATH` is already
  set in their shell profile, localflow's spawn-time override wins for
  that session (documented limitation, not solved this milestone — no
  known way to merge two settings files short of reading and re-writing
  the user's own file, which localflow deliberately never does).
- No UI change beyond the pane border color already driven by
  `SessionStatus` — `working`/`needs-you`/`idle`/`exited`/`running` colors
  and the state machine's transitions are all pre-existing.

## Testing strategy (elaborated in the plan)

Neither `codex` nor `gemini` is installed on this development machine, and
CI has no way to install proprietary/authenticated CLIs — so real-CLI
testing cannot be automated. The split:

- **Unit tests** (`codex-hooks.test.ts`, `gemini-hooks.test.ts`,
  `hook-adapter.test.ts`): pure generator output — correct tier selection,
  correct event→canonical mapping, correct embedded `paneId`/`port`/
  `token`, input validation (same injection-safety assertions as
  `hook-settings.test.ts` today), 0600 file permissions for the two
  file-writing adapters. These test **localflow's own logic**, not
  whether Codex/Gemini would actually accept the generated string — that
  question is explicitly out of unit-test scope.
- **E2E fixture scripts** (`tests/fixtures/fake-codex.sh`,
  `fake-gemini.sh`, alongside the existing `fake-claude.sh`): stand-ins
  that *simulate the CLI's own hook-firing behavior* by executing whatever
  command localflow's adapter placed in argv/env, at a scripted moment
  (e.g., immediately after start, to simulate a fast turn). This proves
  the full local chain — `SpawnSpec` → `buildHookInjection` → argv/env →
  process spawn → command execution → `hook-server.ts` → `SessionManager`
  → pane color — works correctly, **assuming** the real CLI would invoke
  an equivalent command the same way. It deliberately does not, and
  cannot, prove that assumption itself.
- **Manual verification checklist** (documented in the plan, run by a
  developer with `codex`/`gemini` actually installed, before flipping any
  preset away from a lower/safer tier): confirms the real `-c`
  grammar for Codex and the real notification payload field for Gemini.
  Until performed, the shipped defaults are the tiers with the smallest,
  most self-contained failure modes (see table above) — never a tier
  whose only evidence is "the roadmap's research notes said so."
</content>
