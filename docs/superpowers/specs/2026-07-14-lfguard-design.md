# lfguard — command guard engine (design)

An in-repo Rust command guard that intercepts destructive shell commands before
an agent runs them. localflow hosts many autonomous agent terminals at once;
lfguard is the safety layer that inspects each proposed command and blocks the
known-catastrophic ones (`rm -rf /`, `git reset --hard` on dirty state,
`gcloud ... delete`, `DROP DATABASE`, …) while staying out of the way of the
99% of commands that are fine.

The engine is our own code, inspired by the pipeline shape of
[destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard)
but not a fork or a dependency of it. It is a **pure sidecar binary** — no
napi, no WASM, no link into the Electron main process. localflow version-locks
the binary to the app and ships it via electron-builder `extraResources`.

This spec covers the whole arc so the shape is legible end to end:

- **G1** (this work) — the standalone Rust crate: engine, packs, and CLI, with
  zero coupling to the TypeScript app.
- **G2** (designed here, built after G1 review) — the localflow integration:
  hook injection per session, a decision listener, and the needs-you / approve
  cockpit loop.

## Why a separate binary (and why Rust)

- **Continuity is the product.** localflow's whole premise is many agents
  running unattended. A guard that wedges, crashes, or adds visible latency to
  every command would get disabled within a day — so the guard must be fast and
  must **fail open** (see below). A compiled binary with a hard latency budget
  is the honest way to promise that.
- **No blast radius into the app.** A guard that shares the main process's
  address space can take the whole cockpit down with it. A sidecar the app
  spawns (or that an agent hook spawns) can only ever fail locally.
- **Portable enforcement.** The same binary backs agent hooks *and* a shell
  preexec integration *and* the `lfguard test` CLI a human can run by hand. One
  decision engine, many callers.
- **Rust** buys the startup time (no runtime warmup per invocation — hooks
  spawn the binary per command), a small static binary that `extraResources`
  can ship per-platform, and a regex engine (`regex` crate, linear-time, no
  catastrophic backtracking) that makes the latency cap enforceable.

## The engine pipeline

One pass, dcg-inspired, each stage cheap before the expensive one:

1. **Parse** the agent hook JSON payload (or take a raw command string from the
   CLI) → extract the command line to inspect.
2. **Normalize** — strip absolute paths from the leading argv[0]
   (`/usr/bin/git` → `git`) so rules match on the tool name, while
   **preserving arguments verbatim** (a path *argument* to `rm` is exactly what
   we must judge). Collapse redundant whitespace. Lower-case nothing (commands
   are case-sensitive).
3. **Pre-filter** — a fast substring / literal scan that rejects the ~99% of
   commands that contain no token any pack cares about. This is the hot path:
   most commands never reach a regex. Built from the union of cheap literal
   anchors declared by the loaded packs.
4. **Match** — run the loaded regex packs. **Allow-patterns are evaluated
   before deny-patterns**: an explicit allow short-circuits to ALLOW, so a pack
   can carve safe exceptions out of a broad deny. Only if no allow matches do
   deny-patterns run; the first deny that matches decides, and it carries a
   human-readable reason.
5. **Decide** — ALLOW (exit 0) or DENY (exit 1, with pack + rule + reason).

### Inline payloads (no AST in v1)

Agents frequently smuggle a real command inside `bash -c '…'`, `sh -c "…"`, or
`python -c '…'`. v1 does **not** parse shell grammar or use tree-sitter/AST. A
lightweight **trigger-regex fallback** recognizes these wrappers and re-runs the
pipeline against the extracted inner payload, so `bash -c 'rm -rf /'` is judged
on `rm -rf /`. This covers the common exfiltration/obfuscation shape without the
cost and fragility of a shell parser. A full AST pass is explicitly a later
option, not a v1 requirement.

### Fail-open (the load-bearing decision)

On **any** of: JSON parse error, missing/oversized payload (a hard size limit),
regex timeout, pack-load failure, or an internal panic — lfguard **ALLOWs** and
logs a warning to stderr. It never blocks on its own malfunction.

Rationale: the failure mode of a fail-*closed* guard is "every agent in every
environment is wedged and the user's autonomous fleet is dead," which is
strictly worse than the failure mode of fail-open ("one destructive command
slipped past a broken guard"). A guard that people disable protects nothing.
Continuity wins, and the warning makes the degradation visible so it gets
fixed. A **hard latency cap** backs this: if matching exceeds the budget, the
result is ALLOW + warning, never an indefinite stall.

## Packs

A **pack** is a TOML file — metadata plus an allow-regex list and a deny-regex
list, each deny carrying a reason. At runtime packs live under localflow's
userData at `guard/packs/*.toml`; the crate also ships the canonical four as
built-in defaults so the CLI works standalone.

### Pack TOML schema

```toml
# guard/packs/core.git.toml
[pack]
id = "core.git"                 # unique; dotted "namespace.name"
name = "Core: git"              # human label
description = "Guards destructive git operations."
default_on = true               # loaded unless a profile opts out
version = 1                     # schema version for forward-compat

# Cheap literal anchors for the pre-filter. A command containing NONE of
# these skips this pack's regexes entirely. Keep these broad and cheap.
triggers = ["git"]

# Evaluated FIRST. A match here => ALLOW, short-circuiting all deny rules.
[[allow]]
pattern = '^git\s+reset\s+--hard\s+HEAD\b'   # example carve-out (illustrative)
reason  = "reset --hard to HEAD is a common, intended reset"

# Evaluated only if no allow matched. First match decides => DENY.
[[deny]]
pattern = '^git\s+reset\s+--hard\b'
reason  = "git reset --hard discards uncommitted work irreversibly"

[[deny]]
pattern = '^git\s+clean\s+-[a-z]*f'
reason  = "git clean -f deletes untracked files with no recovery"

[[deny]]
pattern = '\bgit\s+push\s+.*--force\b(?!-with-lease)'
reason  = "force-push can overwrite a shared branch's history"
```

Field rules:

- `id` unique across loaded packs; dotted `namespace.name`. Duplicate ids are a
  load error for the offending file (fail-open: that pack is skipped + warned,
  the rest load).
- `triggers` are **literal** substrings, not regexes — they feed the pre-filter.
  A pack with an empty `triggers` list is always evaluated (escape hatch, costs
  performance).
- `pattern` is a `regex`-crate regex (RE2 semantics — no backtracking, so no
  ReDoS). A pattern that fails to compile disables **that rule** with a warning,
  not the whole pack.
- `reason` is required on every `[[deny]]`; it is what the user sees when a
  command is blocked.
- `version` lets the loader reject/upgrade schemas across releases.

### The v1 packs

| Pack             | Default | Guards |
|------------------|---------|--------|
| `core.filesystem`| on      | `rm -rf /`, `rm -rf ~`, `dd` to a device, `mkfs`, `> /dev/sd*`, recursive `chmod`/`chown` on `/`, truncating redirects onto tracked files |
| `core.git`       | on      | `reset --hard`, `clean -f`, `push --force` (not `--force-with-lease`), `branch -D` on protected names, `checkout .` mass-discard |
| `cloud.gcloud`   | opt-in  | `gcloud ... delete` on projects/instances/buckets/SQL, `--quiet` destructive flags, IAM-wipe shapes |
| `db.postgres`    | opt-in  | `DROP DATABASE`/`DROP TABLE`, `TRUNCATE`, `psql -c` destructive one-liners, `DELETE`/`UPDATE` without a `WHERE` |

G1 ships the crate with **`core.git` fully implemented and wired through the
pipeline and CLI** as the vertical slice. The other three are authored as
follow-on plan tasks so the first slice stays small and reviewable.

## Configuration

Per-environment profiles live in localflow's `config.json`, hand-editable
first, GUI later:

```json
{
  "guard": {
    "3": { "packs": ["cloud.gcloud"] }
  }
}
```

- Keys are localflow environment numbers (single digit, same parser rules as
  the existing `environments` names map).
- A profile's `packs` list is **additive** to the default-on packs; a profile
  can also disable a default-on pack (`"packs": ["-core.git"]`, exact syntax
  settled in G2). Environment 3 above adds gcloud guarding on top of the
  filesystem+git defaults.
- Absent config ⇒ default-on packs only. The crate itself reads packs and an
  explicit pack list from argv/stdin; the `config.json` mapping is a **G2**
  concern (localflow resolves the environment's pack set and passes it to the
  binary) — the crate stays app-agnostic.

## Enforcement surface

Deliberately scoped — enough coverage to be useful, no fragile over-reach:

- **Agent PreToolUse-style hooks** (primary). Claude Code exposes a
  `PreToolUse` hook that receives the proposed tool call as JSON on stdin and
  can block by exit code; Codex/Gemini get the same treatment where their hook
  surface supports it. localflow auto-configures the hook per session at spawn
  (G2), pointing it at the shipped `lfguard` binary. This is the highest-signal
  point: it sees the command *before* the agent runs it, with structured
  context.
- **Opt-in shell preexec integration** (secondary) for plain Shell panes that
  have no agent hook. A `preexec` shim (zsh `preexec` / bash `DEBUG` trap) pipes
  the about-to-run command through `lfguard test` and aborts on deny. Opt-in
  because it touches the user's interactive shell.
- **CLI** (always) — `lfguard test "<cmd>"` (exit 0 allow / 1 deny) and
  `lfguard explain "<cmd>"` (full decision trace: which pack, which rule, the
  reason, and whether an allow or the pre-filter short-circuited).

### Why not binary PATH-shims

Shimming `git`, `rm`, `gcloud` etc. by shadowing them on `PATH` was considered
and **rejected**: it is fragile (breaks under absolute-path invocation, subshells,
scripts that reset `PATH`, and tools that stat their own binary), it is invisible
and surprising to the user, and it silently changes what every process on the
machine sees. Hooks and an opt-in preexec are explicit, scoped, and removable;
shims are ambient and brittle. Hooks + preexec is the best-practice surface;
shims are out.

## CLI surface (G1)

```
lfguard test "<cmd>"        # exit 0 = allow, 1 = deny; deny prints reason to stderr
lfguard explain "<cmd>"     # human decision trace to stdout, always exit 0
lfguard check               # (hook mode) read agent PreToolUse JSON on stdin,
                            #   emit the hook's block/allow response, fail open
```

`test`/`explain` take a raw command string (what a human or the preexec shim
has); `check` takes the agent hook JSON payload on stdin (what a PreToolUse hook
delivers) and speaks the hook's own allow/block protocol. All three share the
one engine.

## G2 — localflow integration (designed, built after G1 review)

Built on top of the reviewed G1 crate. Four seams into the existing app:

1. **Hook injection.** At `session:create`, for agents that support it,
   localflow writes/points the agent's PreToolUse hook config at the shipped
   `lfguard` binary with the environment's resolved pack set, and tears it down
   on session close — mirroring how the OpenClaw operator launch injects and
   revokes per session.
2. **Decision listener (cockpit loop).** lfguard POSTs each decision to
   localflow's existing token-authenticated hook listener (the same
   loopback + bearer-token surface the operator control API already uses). A
   **blocked** command flips the session to **needs-you** with a peek at the
   blocked command and an **allow-once** token; the user can approve it once
   without disabling the pack.
3. **Activity feed.** Every decision (allow-with-note / deny / allow-once
   override) streams to the activity feed, so the guard's actions are auditable
   alongside the operator action log.
4. **Per-environment toggles UI.** The `guard` config block gets a settings
   surface — enable/disable packs per environment — replacing hand-editing
   `config.json`. Defaults on for `core.filesystem` + `core.git`; gcloud and
   postgres opt-in per environment.

G2 reuses infrastructure that already exists (the loopback listener + bearer
token from the operator work, the needs-you flip, the activity feed, the
per-session inject/revoke lifecycle), so it is integration, not new machinery.

## Testing

**G1 (crate):**

- **Unit** — normalization (path strip, arg preservation, whitespace),
  pre-filter (a command with no trigger never reaches regex), pack loader
  (valid TOML, duplicate id, bad regex → rule disabled + warn, missing reason →
  reject), matcher (allow-before-deny short-circuit; first-deny-wins; the inline
  `bash -c` fallback), fail-open (bad JSON / oversize / timeout → ALLOW + warn),
  and the CLI exit codes.
- **Golden corpus** — a table of `(command, expected decision, expected pack)`
  covering each `core.git` rule and a spread of must-allow safe commands
  (`git status`, `git log`, `git commit`), asserting no false positives.
- **Acceptance (this slice):** `lfguard test "git reset --hard"` exits 1 with a
  reason; `lfguard test "git status"` exits 0; `lfguard explain "git reset
  --hard"` prints the matched pack + rule + reason.

**G2 (integration, later):** hook injected at create and removed at close;
a scripted client proving a blocked decision flips the session to needs-you
with a working allow-once token; decisions appear in the activity feed;
per-environment pack toggles take effect.

## Out of scope (v1 / YAGNI)

- Shell-grammar AST parsing (the trigger-regex fallback covers inline payloads).
- Binary PATH-shims (rejected above).
- Network calls from the crate itself (G2's localflow does the POST; the crate
  only decides and, in `check` mode, speaks the hook protocol).
- Per-command machine learning / heuristic scoring — packs are explicit regex,
  auditable and user-editable.
- Windows-specific packs (v1 targets the macOS/Linux shells localflow runs).
- Rolling back a command already executed — lfguard is strictly a *pre*-guard.

## Open questions

- **Allow-once scope (G2):** does an allow-once token cover the exact command
  string only, or a normalized shape? Exact-string is safer and is the v1 lean;
  revisit if it proves annoying.
- **Pack disable syntax:** the `"-core.git"` opt-out spelling is provisional;
  settle it when the G2 config surface is built.
- **Codex/Gemini hook fidelity:** how completely each non-Claude agent's hook
  surface matches PreToolUse (block-by-exit-code semantics) is confirmed during
  G2 planning; the crate's `check` protocol may need a per-agent adapter, the
  same shape as the existing status/hook adapters.
- **Latency budget number:** the exact millisecond cap is set empirically once
  the four packs exist and the corpus is sized; the mechanism (cap → ALLOW +
  warn) is fixed regardless.
