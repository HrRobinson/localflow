# saiifeguard G2 — integrating the guard into saiife — design

Date: 2026-07-15. Status: approved design.
Builds on G1 (the standalone `guard/` engine + packs + CLI, merged in #66).

## Goal

Make the shipped saiifeguard engine actually protect the autonomous-development
flow: intercept and **block** destructive commands that agents (Claude, Codex,
Gemini) try to run, with global per-tool pack toggles surfaced in Settings, and
blocked commands visible in the bottom console. G1 built the engine; G2 wires it
in so it does its job.

## Key finding that drives the architecture

saiife runs each agent as a **raw pty and never inspects the bytes inside
it** (`session-manager.ts` spawns the agent binary directly; `onData` only keeps
a tail for exit messages). So the guard cannot intercept at the terminal layer.
It must plug into each agent's **native pre-tool blocking hook**. All three
agents support one (verified against their docs, 2026-07-15):

| Agent  | Event         | Shell tool         | Config delivery                                  | Deny signal honored |
| ------ | ------------- | ------------------ | ------------------------------------------------ | ------------------- |
| Claude | `PreToolUse`  | `Bash`             | `--settings <file>` (already used for status)    | exit 2 + stderr; or `permissionDecision:deny` JSON |
| Codex  | `PreToolUse`  | `Bash`             | `-c hooks.PreToolUse=…` + trust bypass (below)    | exit 2 + stderr; or same JSON as Claude |
| Gemini | `BeforeTool`  | `run_shell_command`| settings file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | exit 2 + stderr; or `{decision:"deny",reason}` JSON |

**Universal deny contract:** all three block a command when the hook **exits 2
and writes the reason to stderr**, and allow on exit 0. saiifeguard adopts that one
contract — no per-agent output formats. The `check` verb's stdin JSON parsing
(tolerant `command_from_hook_json`, already handles `tool_input.command`) is
reused unchanged; only the *output* side gains the exit-2 behavior.

**Codex trust gate:** Codex skips non-managed command hooks until a user trusts
them via `/hooks` (hash-based). A silently-skipped guard is the worst outcome,
so saiife passes **`--dangerously-bypass-hook-trust`** on the Codex spawn —
it runs saiife's own injected hook without the interactive trust step.
saiife authors the hook and controls the whole spawn, so this is safe in
context; it is documented and covered by the Codex verification task.

## Architecture

The guard is a **native pre-tool blocking hook** in each agent, invoking the
bundled `saiifeguard` binary on every shell command. Deny = exit 2 + stderr. No pty
interception, no PATH shim. Four additive layers:

- **L1** — ship the binary + Claude `PreToolUse` (the core payoff).
- **L2** — Codex + Gemini hook wiring.
- **L3** — global pack toggles (config + Settings UI).
- **L4** — surface denials in the bottom console.

### L1 — ship the binary + Claude PreToolUse

**Building & bundling.** Add a `build:guard` step (`cargo build --release` in
`guard/`) run before packaging; bundle the compiled `saiifeguard` via
electron-builder `extraResources`. Built for the shipped platform(s);
cross-platform dist is a follow-up.

**Locating it.** New `src/main/guard-binary.ts` → `resolveGuardBinary(): string
| null`:
- dev (`!app.isPackaged`): `guard/target/release/saiifeguard` (repo root).
- packaged: `join(process.resourcesPath, 'saiifeguard')`.
- Returns `null` if the file is absent. Result cached.

**Fail-open at the boundary.** If `resolveGuardBinary()` is `null`, the pre-tool
hook is simply **not injected** — the agent runs unguarded rather than broken.
This is the same fail-open posture as the engine itself.

**saiifeguard exit-2 deny mode.** saiifeguard gains a flag (e.g. `check --hook-exit`)
whose behavior is: read the tool JSON on stdin, evaluate; on **Deny** print the
reason to **stderr** and **exit 2**; on **Allow** exit 0. Any read/parse error
still fails open (exit 0). (The existing `check` JSON mode and `test` exit-0/1
mode stay for compatibility.)

**Claude wiring.** `hook-settings.ts` adds a `PreToolUse` entry (matcher
`"Bash"`) to the per-session settings file it already writes, whose command is
`<saiifeguard> check --hook-exit <--pack…>`. Claude feeds the tool JSON on stdin.

### L2 — Codex + Gemini

**Codex** (`codex-hooks.ts`): add a `PreToolUse` injection —
`-c hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command="<saiifeguard> check --hook-exit <--pack…>"}]}]`
— and add `--dangerously-bypass-hook-trust` to the Codex spawn args. The exact
`-c hooks.` grammar carries the same UNVERIFIED caveat as the existing Codex
status hooks and gets a manual verification task against a real `codex`.

**Gemini** (`gemini-hooks.ts`): add a `BeforeTool` entry (matcher
`"run_shell_command"`) to the Gemini settings file, command
`<saiifeguard> check --hook-exit <--pack…>`. Deny via exit 2 (Gemini honors it).

Both are additive to the existing status-hook injections; the reusable
safe-token validation and per-session file lifecycle are unchanged.

### L3 — global pack toggles (config + UI)

**Config.** Add `guard?: { packs: string[] }` to `AgentConfig`
(`agent-registry.ts`), mirroring `theme`/`console`: parse-at-boundary
(`parseGuardConfig`, malformed → default `{ packs: [] }`), `getGuardPacks()` /
`setGuardPacks(ids)` (setter saves), `'guard'` added to
`KNOWN_TOP_LEVEL_KEYS`. `packs` holds the **enabled opt-in** pack ids
(`core.filesystem` / `core.git` are default-on in the binary and always active;
`cloud.gcloud` / `db.postgres` appear here when toggled on).

**Resolution to flags.** At spawn time, the enabled packs become `--pack <id>`
flags baked into that pane's hook command. Because toggles are **global**, every
pane gets the same flags. Toggling affects **newly-spawned** panes; existing
panes keep their spawn-time config (documented).

**IPC + preload + api.** `guard:getPacks` (`handle`) and `guard:setPacks`
(`on`/`handle`), declared on `SaiifeApi`, implemented in preload — mirroring
the theme channels.

**UI.** A "Command guard (saiifeguard)" `<section>` in `Settings.tsx`, modeled on
the theme section: `core.filesystem` and `core.git` shown as always-on
(disabled, checked); `cloud.gcloud` and `db.postgres` as live toggles that call
`setGuardPacks`. A one-line note that changes apply to newly-launched panes.

### L4 — surface denials in the bottom console

When a command is blocked, the user should see it. Rather than teach the guard
binary to make HTTP calls (a dep it should not carry) or wrap it in fragile
shell that juggles stdin/stderr, saiifeguard writes to an **append-only audit log**
and saiife tails it.

saiifeguard gains two optional flags: `--audit-log <path>` and `--audit-tag
<paneId>`. In `--hook-exit` mode, on **Deny** it appends one JSONL record
(`{ts, tag, command, reason, pack}`) to the log **before** exiting 2. saiife
passes `<userData>/guard-audit.jsonl` and the pane's id when it builds each
pane's hook command. The main process **tails that file** (`fs.watch` +
incremental read, same additive posture as the console taps), maps each new
record to a `ConsoleEvent{ source:'guard' }`, and emits it on the
`ConsoleEventBus` — so a **`data-source="guard"`** row appears in the drawer
showing the blocked command and the pack/rule reason, expandable to detail.
`guard` is a new additive `ConsoleSource`. Audit-log write failure is ignored
(fail-open); it never affects the block.

## Data flow (a blocked command)

1. Agent decides to run `rm -rf /` → fires its pre-tool hook with the tool JSON.
2. Hook runs `<saiifeguard> check --hook-exit --pack … --audit-log <path> --audit-tag <paneId>`.
3. saiifeguard tokenizes, evaluates against active packs → **Deny**.
4. saiifeguard appends a deny record (`{ts, tag, command, reason, pack}`) to the
   audit log, then exits 2 with the reason on stderr.
5. The agent blocks the command and surfaces the reason to the model/user.
6. saiife's audit-log tail reads the new record → `ConsoleEvent{source:'guard'}`
   → bus → a row in the bottom console.

Allow path: exit 0, no audit record, command runs.

## Error handling

- **Missing binary** → hook not injected → agent runs unguarded (fail-open).
- **saiifeguard internal error / unparseable stdin** → exit 0 (allow) — the engine's
  existing fail-open guarantee.
- **Audit-log write failure** (unwritable path, race) → ignored; the block still
  happens. Observability is best-effort, enforcement is not.
- **Enforce-only.** A deny hard-blocks; there is no observe/audit-only mode in
  v1 (YAGNI).

## Out of scope (v1)

- **Operator raw-write to a shell pane.** Agent panes — including
  operator-driven ones — are fully covered because the guard lives in the
  agent's own hook. Raw command bytes written to a **shell** pane via
  `POST /panes/:handle/prompt` bypass agent hooks. Operators cannot create shell
  panes, so this needs a user-made shell pane in a granted environment — a
  narrow gap. A main-process `saiifeguard` check before writing to a shell pane is a
  straightforward follow-up.
- **Per-environment pack toggles** — global only in v1; per-env can layer on.
- **Cross-platform binary dist** — build for the shipped platform(s) first.
- **Observe/audit-only mode**, and **richer per-agent deny JSON** (the uniform
  exit-2 contract is enough).

## Testing

**Unit**
- Hook-config builders: Claude `PreToolUse` settings entry, Codex `-c
  hooks.PreToolUse` args **including `--dangerously-bypass-hook-trust`**, Gemini
  `BeforeTool` settings entry — each carries the resolved `--pack` flags and the
  correct matcher/tool name.
- `resolveGuardBinary`: dev path, packaged path, null when absent (cached).
- `guard.packs` config round-trip: default `{packs:[]}` when missing, set→reload
  persists, malformed→default, other keys preserved.
- The console `guard` source: mapper produces the right `ConsoleEvent`.

**Rust**
- `check --hook-exit`: deny → exit 2 + stderr reason; allow → exit 0; malformed
  stdin → exit 0 (fail-open).
- `--audit-log`/`--audit-tag`: on deny, one JSONL record (`{ts, tag, command,
  reason, pack}`) is appended; on allow, nothing is written; an unwritable
  audit path does not change the exit code.

**e2e**
- With the real/fixture binary: spawn a Claude pane, drive a `PreToolUse` event
  with `rm -rf /` → command blocked (hook exit 2); a benign command → allowed.
- Assert Codex and Gemini panes spawn with the guard hook wired (and Codex with
  `--dangerously-bypass-hook-trust`).
- Toggle `cloud.gcloud` in Settings → a newly-spawned pane's hook command
  includes `--pack cloud.gcloud`; toggle off → it does not.
- A blocked command produces a `data-source="guard"` row in the bottom console.

## Compatibility & rollout

- Additive: new binary bundling + one hook entry per agent + a config field +
  a Settings section + a console source. No existing stream, view, or persisted
  schema changes; a `config.json` without `guard` loads normally.
- Fail-open everywhere means shipping the binary or a broken guard can never
  break an agent — the worst case is "unguarded", never "unusable".
