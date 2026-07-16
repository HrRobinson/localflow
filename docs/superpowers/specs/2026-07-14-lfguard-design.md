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
2. **Tokenize + segment** (`lexer` module) — a real, hand-rolled shell-ish
   lexer walks the raw line **once**, resolving quoting, backslash escaping,
   adjacent-string concatenation, and command substitution into structured
   words, and splitting on top-level `&&`, `||`, `;`, `|`, a lone `&`, and
   newlines at the same time. This replaced a first-generation implementation
   that did quote-stripping and chaining-splits as two separate, ad-hoc
   *raw-text* passes (a naive `split_whitespace` "normalizer" plus a
   character scan for chaining). Two adversarial review rounds proved that
   two-pass, text-level approach bypassable:
   - An escaped quote does not close a string in real shell grammar
     (`echo "a\""` is the one-character argument `a"`, not two arguments) —
     a text-level pass that didn't track *why* a quote closed got this wrong.
   - Adjacent strings concatenate into a single argument (`"/e"tc`, `/et"c"`,
     `""/`, `/""`, `"/"//` are `/etc`, `/etc`, `/`, `/`, `///`) — splitting
     tokens has to happen *after* that resolution, or the split itself
     manufactures a bypass (e.g. hiding `rm` as `r"m"`).
   Doing quoting resolution and chaining-splits in the same single-pass scan
   fixes the ordering problem structurally rather than patching each shape as
   it's found: a separator character is only ever a real operator when the
   scan is not inside a quoted, escaped, or command-substitution region, and
   a word's *content* is only ever established once, from the same pass that
   decided the boundaries. `$(...)` and `` `...` `` command substitution is
   lexed as a single **opaque** token (never evaluated) specifically so a
   `;`/`&&`/`|` inside the parens/backticks can never be mistaken for a
   top-level separator. Every deny pattern is `^`-anchored to a single
   command, so without segmentation a destructive command chained after a
   benign one (`echo hi && rm -rf /`, `true; rm -rf ~`, `foo | rm -rf /`)
   would never be tested against any rule — the normal shape of an agent's
   shell invocations. Each segment flows through the rest of the pipeline
   independently; a deny in **any** segment denies the whole line.

   The same single pass also treats unquoted, unescaped `(`, `)`, `{`, `}`
   as segment boundaries (like `;`), strips a segment's leading `then`/`do`/
   `else`/`elif` so a compound construct's real command lands at argv[0],
   and decodes `$'...'` ANSI-C quoting — closing an adversarial-review round
   that found `( rm -rf / )`, `{ rm -rf /; }`, `if true; then rm -rf /; fi`,
   and `rm -rf $'\x2f'` all reaching argv[0]/args unrecognizable to every
   deny rule. See "Known limitations" for the exact scope of each.
3. **Unwrap transparent prefixes** (per segment, `wrappers` module, run in
   the engine right before normalization) — `command`, `env`, `nohup`,
   `nice`, `stdbuf`, `ionice`, and `sudo` merely pass their command straight
   through, so the guard judges the *effective* command (`command rm -rf /`,
   `env rm -rf /`, and `sudo -u root rm -rf /` are all judged as `rm -rf /`)
   rather than treating the wrapper as argv[0]. `sudo` used to be handled
   differently — an optional `(?:sudo\s+)?` prefix baked into each pack's
   own patterns — which only matched `sudo` immediately followed by the
   guarded command; any option in between (`sudo -u root rm -rf /`, `sudo -n
   rm -rf /`, …) bypassed every pack. `sudo` is now unwrapped structurally
   like the others, skipping its own options (boolean and arg-taking, short
   and long, space- or `=`-joined) and any leading `VAR=val` assignments to
   reach the effective command. The old regex prefixes are left in pack
   files as harmless dead weight — unwrapping is authoritative now.
4. **Substitution recursion — command position, then every remaining
   position** (per segment, `subst` and `lexer` modules, run in the engine
   right after unwrapping) — a real shell evaluates `$(...)`/`` `...` ``
   *eagerly*, before anything about "is this a guarded command" is decided,
   regardless of where in the line it sits. Two passes handle this:
   - **Command-position** (`subst::command_position_substitution`): when a
     substitution fills the *whole* command position — the entire
     (unwrapped) segment is one substitution (`$(rm -rf /)`, `` `rm -rf /`
     ``), or it is the value of a leading `NAME=$(...)` assignment word,
     itself possibly behind further plain `NAME=val` assignment words
     (`FOO=$(rm -rf /)`, `FOO=bar BAZ=$(rm -rf /)`) — there is no argv[0]
     for any pack's `^`-anchored regex to match. Recognized narrowly (a
     substitution must fill the *whole* word, not merely be concatenated
     into it), because this pass alone can't safely guess what a shell
     would do with a mixed word — that's what the second pass now handles.
   - **Every other position** (`lexer::find_all_substitutions`, called from
     the engine for each word in the segment): once command position is
     handled, every remaining `$(...)`/`` `...` `` found *anywhere else* in
     the segment — an argument to a guarded or unguarded command, quoted or
     bare, and even one merely concatenated into a larger word
     (`$(cmd)suffix`, `pre$(cmd)post`) — is extracted and judged too. This
     closes what used to be the last unjudged shape: a substitution
     argument to a command no pack guards (`echo $(rm -rf /)`, `cat $(rm
     -rf /)`, `foo $(rm -rf /) bar`) previously reached `build_argv` with
     no fail-safe applicable (that fail-safe, step 6 below, is scoped to
     already-guarded commands only) and the substitution's contents were
     never looked at again — a full, silent bypass, since bash runs `rm -rf
     /` regardless of what (if anything) consumes the substitution's
     output. Scanned over the *original*, pre-unwrap segment specifically
     so a substitution hiding in a word a wrapper's unwrapping would
     otherwise consume (e.g. `env`'s own leading `FOO=$(...)` assignment,
     skipped past when finding `env`'s effective command) is not missed
     either.

   Both passes re-run the extracted inner text through the whole pipeline
   (re-tokenized, re-segmented, re-matched), exactly like the inline
   `bash -c '...'` re-entry below, sharing its depth cap and latency
   budget — so nested substitutions (`$( $(rm -rf /) )`, `$( ( rm -rf / )
   )`) resolve for free (each layer/occurrence is a fresh recursive call)
   and adversarial nesting still fails open past the cap rather than
   overflowing the stack or stalling. A benign inner (`echo $(date)`,
   `echo "$(uname -a)"`, `grep $(cat patterns) file`) still resolves to
   ALLOW — only a guarded/destructive inner denies, so this adds no new
   false positives on commands nothing else flags.
5. **Normalize** (per segment, `normalize` module) — now a small, purely
   semantic step over the already-resolved argv (the ad-hoc quote handling
   that used to live here moved into the lexer, step 2): case-fold `argv[0]`
   only (`RM` → `rm`, `Git` → `git` — macOS's case-insensitive filesystem
   resolves `RM` to the same binary as `rm`, so matching case-sensitively on
   the command name was a real bypass; **arguments are left exactly as
   lexed**, since they can be matching-sensitive, e.g. SQL text); strip a
   leading directory from `argv[0]` (`/usr/bin/git` → `git`) so rules match
   on the tool name; collapse a run of leading slashes on every other token
   to one (`rm -rf //` → `rm -rf /`), so packs don't have to spell out every
   repeated-slash variant of a catastrophic path. The per-segment argv is
   then joined with single spaces into the "matching line" pack regexes run
   against — this is what "matching rules against argv structure, not raw
   text" means in practice: the string a rule sees is reconstructed from
   real, resolved tokens, not sliced out of the original quoting.
6. **Guarded-command-substitution check** (per segment, in the engine) — a
   fail-safe policy that falls straight out of tokenizing: if a segment's
   `argv[0]` is a command an active pack has a deny rule for (a "guarded"
   command — `rm`, `git`, `gcloud`, `gsutil`, …) and any of its *argument*
   tokens (never `argv[0]` itself) contains an opaque command-substitution
   region, the segment is **denied** — the guard cannot see what `$(...)`
   or `` `...` `` expands to, so it cannot prove the resulting command is
   safe, and it fails safe rather than guessing (`rm -rf $(some-cmd)` is
   denied on this basis alone, independent of whatever `some-cmd` is).
   Scoped deliberately narrowly — to *already-guarded* commands only — so it
   adds no new scrutiny to commands no pack cares about (`echo $(date)`,
   `echo "$(date)"` still ALLOW). This check is independent of, and runs in
   addition to, step 4's argument-position recursion above: recursion asks
   "is the substitution's *inner command* itself destructive" (catches
   `rm -rf $(rm -rf /tmp)`, but would *allow* `rm -rf $(echo /)` on its
   own, since `echo` isn't guarded); this fail-safe instead asks "is the
   *target* of an already-guarded command unknowable at all," which is true
   no matter how benign the substitution's own command is — the guard never
   evaluates what a substitution actually outputs, so it has no way to know
   whether `$(echo /)` resolves to a harmless path or a catastrophic one.
   `rm -rf $(echo /)` is therefore still denied here even though recursing
   into `echo /` on its own resolves to ALLOW.
7. **Pre-filter** — a fast substring / literal scan that rejects the ~99% of
   commands that contain no token any pack cares about. This is the hot path:
   most commands never reach a regex. Built from the union of cheap literal
   anchors declared by the loaded packs, and run against each segment's
   already-tokenized matching line (never the raw pre-lex text — a trigger
   substring can be *created* by concatenation resolution, e.g. `r"m"` only
   contains `rm` after the lexer resolves it, so pre-filtering before
   tokenization would be unsafe), then again per pack per segment.
8. **Match** — run the loaded regex packs against each segment's matching
   line. **Allow-patterns are evaluated before deny-patterns**: an explicit
   allow short-circuits that segment to ALLOW, so a pack can carve safe
   exceptions out of a broad deny. Only if no allow matches do deny-patterns
   run; the first deny that matches decides, and it carries a human-readable
   reason. Because the `regex` crate has no lookaround, a rule that must fire
   regardless of argument order (e.g. `rm -rf /etc` and `rm /etc -rf`) is
   expressed as two ordered alternatives rather than one lookahead-based
   pattern.
9. **Decide** — ALLOW (exit 0) or DENY (exit 1, with pack + rule + reason).
   DENY wins over ALLOW across segments: if any segment denies, the command
   denies, even if an earlier or later segment matched an allow rule.

### Known limitations (honest, not aspirational)

- The lexer is a real, hand-rolled tokenizer for the shapes this spec lists
  (quoting, escaping, concatenation, operator splitting, opaque command
  substitution, grouping/compound-keyword boundaries, transparent-prefix
  unwrapping, `$'...'` ANSI-C quoting) — it is still **not a shell parser**:
  no variable expansion (`$VAR`, `${VAR}` are recognized just far enough to
  keep `${...}` from being mistaken for a grouping brace, but never
  evaluated), no glob expansion, no here-docs, no arithmetic expansion, and
  `$(...)`/`` `...` `` command substitution is never evaluated, only
  recognized as an opaque region so its contents can't be mistaken for a
  top-level separator or hide a bypass by letter-splitting. The guard
  reasons about **static token structure only** — it does not know or guess
  what a variable or a glob would actually expand to at run time, and it
  never *executes* a substitution to see its output. That said, a
  substitution's own inner *command* is always judged, wherever the
  substitution sits: (1) a substitution argument to an *already-guarded*
  command (`rm`, `git`, `gcloud`, `gsutil`, …) is additionally denied
  fail-safe regardless of what its inner command judges to, because the
  guard cannot know what the substitution will *output* even once it knows
  the inner command isn't itself destructive — an unknowable dynamic target
  is denied on that basis alone (see pipeline step 6 above); (2) a
  substitution *anywhere else* — command position, or an argument to a
  guarded or unguarded command, quoted or bare, or merely concatenated into
  a larger word — is **recursed into and judged** the same way `bash -c
  '...'` payloads are: the substitution's raw inner text is re-run through
  the whole pipeline, and a destructive inner command denies (`echo $(rm -rf
  /)`, `cat $(rm -rf /)`, `` echo `rm -rf /` ``) while a benign one still
  ALLOWs (`echo $(date)`, `echo "$(uname -a)"`, `grep $(cat patterns)
  file`) — see pipeline step 4 above. An unterminated quote still leaves the
  remainder of the line as a single unsplit word/segment (the conservative,
  fail-open-safe fallback — worst case it misses a split, it never
  manufactures one that hides a match that would otherwise have fired).
- **Grouping/compound-keyword handling is a boundary heuristic, not
  compound-statement parsing.** Unquoted, unescaped `(`, `)`, `{`, `}` end
  the current segment exactly like `;` does, and a segment's leading `then`/
  `do`/`else`/`elif` is stripped so the guarded command lands at argv[0]
  (`( rm -rf / )`, `{ rm -rf /; }`, `if true; then rm -rf /; fi`, `for i in
  1; do rm -rf /; done`, `while true; do rm -rf /; done` are all caught).
  `${...}` parameter-expansion syntax is carved out so `${HOME}` stays one
  literal token rather than being split at its `{`/`}`. This is deliberately
  the safe-leaning direction: because grouping chars are treated as a
  boundary **regardless of adjacent whitespace** (same as every other
  operator in this lexer), a shape a real shell would parse differently —
  e.g. brace expansion glued directly onto a word, `rm -rf /{a,b}` — is
  judged more conservatively than real bash would execute it (as if `/`
  were its own target), which can over-deny but never manufactures a
  bypass. `if`/`for`/`while`/`until`/`case` themselves are not parsed as
  compound-command grammar — only their `then`/`do` continuations are
  recognized — so exotic constructs outside this shape (`case`/`esac`
  branches, `until`, nested subshells combined with process substitution
  `<(...)`/`>(...)`) are not specifically modeled, though `(`/`)` still
  segment-bound them structurally.
- **Transparent-prefix unwrapping covers a named, non-exhaustive set.**
  `command`, `env` (skipping leading `VAR=val` assignments and flags),
  `nohup`, `nice` (skipping an optional `-n VALUE`/`-VALUE` niceness flag),
  `stdbuf`, `ionice` (skipping leading `-`-prefixed flags), and now `sudo`
  (skipping leading `VAR=val` assignments and its own options — boolean and
  arg-taking, short and long, space- or `=`-joined) are unwrapped
  structurally so the guard judges the effective command, not the wrapper
  (`command rm -rf /`, `env rm -rf /`, `nohup rm -rf /`, `nice rm -rf /`,
  `sudo -u root rm -rf /`, `sudo --user=root rm -rf /` are all caught).
  `sudo` used to be handled the older way — an optional `(?:sudo\s+)?`
  prefix baked into each pack's own deny patterns — which only matched a
  bare `sudo <cmd>`; any option in between bypassed every pack (fixed by
  this unwrapping; the old regex prefixes remain in pack files as harmless
  dead weight). **Update (2026-07-16 wrapper-hardening slice):** `time`,
  `timeout`, `chroot`, and `flock` (prefix form) are now unwrapped too — via
  a shared option-skip-plus-N-positional helper — and `su -c '…'` and
  `watch …` are recursed through the inline-payload path (`su` deliberately
  is *not* a transparent prefix: its first operand is a username, so
  `su rm`/`su root` stay ALLOW; the wrapped command is only ever the `-c`
  string). Full-path invocations (`/usr/bin/time`) are recognized. So
  `timeout 300 rm -rf /`, `time rm -rf /`, `chroot /mnt rm -rf /`,
  `flock /tmp/lock rm -rf /`, `su -c 'rm -rf /'`, and `watch rm -rf /` are
  all caught now. See `docs/superpowers/specs/2026-07-16-lfguard-wrapper-hardening-design.md`.
  **Still not unwrapped, accepted limitations:** `xargs` (its catastrophic
  operand arrives on stdin from the producer — `find / | xargs rm -rf` — and
  is invisible to any static scan; unwrapping it would catch almost nothing
  the packs can act on) and the `flock … -c 'STRING'` sub-form (rarer; the
  `-c` interleaves after the positional and is a small follow-up). A
  destructive command hidden in one of those two still evades every rule.
- **Substitution recursion now covers every `$(...)`/`` `...` `` the lexer
  recognizes as one, in any position — not just the shapes a real shell
  evaluates eagerly on their own in command position.** Originally (G1
  BLOCKER 2 fix) only `$(rm -rf /)`, `` `rm -rf /` ``, and `NAME=$(rm -rf
  /)` in *command* position were detected and recursed into; a substitution
  in *argument* position to a command no pack guards (`echo $(rm -rf /)`,
  `cat $(rm -rf /)`, `foo $(rm -rf /) bar`) reached `build_argv` with no
  fail-safe applicable and its contents were never looked at again — a full,
  silent bypass, since bash runs the substitution's command regardless of
  what (if anything) consumes its output. `lexer::find_all_substitutions`
  closes this: every `$(...)`/`` `...` `` found anywhere in a segment's
  words — command or argument position, guarded or unguarded command,
  quoted or bare — is now extracted and recursed into. Two shapes
  previously documented here as explicitly **not** detected are closed as a
  side effect of scanning the *original*, pre-unwrap segment rather than
  only a "pure command position" word: a substitution *concatenated* into a
  larger word (`$(rm -rf /)suffix` now denies — the embedded region is
  found and judged even though it isn't the whole word) and a substitution
  embedded in a `VAR=$(...)` assignment consumed by `env`'s own
  leading-assignment skip (`env FOO=$(rm -rf /) cmd` now denies — the raw
  segment is scanned before `env`'s effective-command unwrapping discards
  that word). Verified directly against the built binary; see
  `tests/corpus_subst_arg_position.rs`.

  **What is still not detected**, genuinely out of scope for this fix: a
  `$(...)` nested *inside* `${...}` parameter-expansion syntax (`echo
  ${VAR:-$(rm -rf /)}` still ALLOWs) — `scan_brace_balanced` (the lexer's
  `${...}` scanner) copies its body as inert text without recognizing a
  nested `$(` the way the top-level and `"..."`/`$(...)` scanners do, so
  the resulting word's `has_substitution` flag is never set and the new
  recursion — which is deliberately gated on that flag rather than
  re-scanning every word's raw text unconditionally — never sees it. That
  gate is not merely a performance shortcut: it is what keeps a backtick or
  `$(` sequence that survived quote resolution from *single-quoted* text
  (where real bash treats it as inert, e.g. `` git commit -m 'run `rm -rf
  /` in prod' `` must stay ALLOW, and does) from being misread as a live
  substitution — removing it to chase the `${...}` case would reintroduce
  exactly that false positive. Fixing the `${...}` gap properly belongs in
  the lexer's brace scanner, not the engine's recursion, and is deferred as
  a narrow, separate follow-up.
- **`$'...'` ANSI-C quoting decodes the common escapes, not the full bash
  set.** `\n \t \r \a \b \f \v \\ \'`, `\xHH` (up to two hex digits), and
  `\0NNN` (up to three octal digits) are decoded, so `$'/'` and `$'\x2f'`
  both resolve to the argument `/`. Escapes this lexer doesn't know —
  `\uXXXX`, `\UXXXXXXXX`, `\cX` (control-char), `\eE`/`\E` (escape char) —
  are kept literally (backslash + character) rather than guessed at; a
  target smuggled exclusively through one of those is not decoded and could
  evade a rule that depends on seeing the real character.
- The flag/target-order-independent treatment applied to the catastrophic
  `rm` rule (I3) has **not** been generalized to the recursive `chmod`/`chown`
  root rules in `core.filesystem`, which still require the flag before the
  target (`chmod -R 777 /etc -fr` order variants are not covered). Deferred.
- The `cloud.gcloud` catch-all (`gcloud ... delete`) is anchored to `delete`
  as its own token, not a substring, but it is still a broad "any resource +
  delete verb" rule; it does not distinguish `--quiet`/non-interactive flags
  and makes no attempt to. Prefer adding a resource-specific rule (as done
  for projects/SQL/compute/buckets/KMS) when a class of destructive command
  is common enough to name explicitly in the reason.
- `db.postgres` does **not** guard `UPDATE` without a `WHERE` clause (or
  `DELETE`/`UPDATE` inside multi-statement `psql -c "...; ..."` payloads,
  or statements spread across a `-f script.sql` file). Deferred to **G2** —
  see the pack table below.

### Inline payloads (no AST in v1)

Agents frequently smuggle a real command inside `bash -c '…'`, `sh -c "…"`, or
`python -c '…'`. This is handled **structurally**, not with a text-level
regex fallback: once a segment's argv is built (step 5 above), if `argv[0]`
(case-folded) is a known interpreter and the argv contains a `-c` flag, the
token immediately after `-c` — a single, already quote/escape-resolved
string, however it was originally quoted — is re-run through the whole
pipeline (re-tokenized, re-segmented, re-matched) as its own command line.
This is strictly more correct than a regex over raw text: it works
identically regardless of the outer quoting style, and — critically — it is
**not gated behind the outer segment's pre-filter check**, because an outer
layer of quoting can hide a trigger word from the outer scan that only
resolves once the inner string is lexed on its own (e.g. an outer
single-quoted argument `'g"it" reset --hard'` never contains the contiguous
substring `git` at the outer level; only re-lexing the extracted inner
string on its own resolves the nested double quote and reveals it). A
depth cap (8) bounds the recursion so adversarially nested `-c` wrapping
can't be used to stall the guard past its latency budget. This covers the
common exfiltration/obfuscation shape without the cost and fragility of a
full shell-grammar/AST parser, which remains explicitly a later option, not
a v1 requirement. The same depth cap and re-entry shape is shared by
command-position substitution recursion (step 4 above) — `$( $(rm -rf /) )`
resolves the same way a nested `bash -c 'bash -c "…"'` would.

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
| `core.filesystem`| on      | recursive `rm` of a filesystem root/home/system directory — any quoting, repeated-slash spelling, or flag/target order (`rm -rf /etc`, `rm -rf "/"`, `rm -rf //`, `rm /etc -rf` all denied); `rm --no-preserve-root`; `dd`/`truncate`/`>` writes to a raw block device (`/dev/*`); `mkfs`; recursive `chmod`/`chown` on a root or system directory |
| `core.git`       | on      | `reset --hard`, `clean -f`, `push --force` (not `--force-with-lease`), `branch -D` (any branch, not only ones flagged as protected — v1 has no protected-branch concept), `checkout .` / `checkout -- .` mass-discard |
| `cloud.gcloud`   | opt-in  | `gcloud ... delete` on projects/instances/buckets/SQL/KMS keys, `gcloud storage rm` / `gsutil rm` recursive object deletion, `gsutil rb` bucket removal, IAM policy-binding removal at project/org/folder scope, plus a generic `gcloud ... delete` catch-all (verb-token-anchored, not a substring match) for resource types without a dedicated rule |
| `db.postgres`    | opt-in  | `DROP DATABASE`/`DROP SCHEMA`/`DROP TABLE`, `TRUNCATE`, `DELETE` without a `WHERE`, `dropdb`; matches raw SQL and `psql -c "..."` one-liners. **Not** guarded: `UPDATE` without a `WHERE` — deferred to G2 (see Known Limitations above) |

G1 ships **all four packs**, each wired through the pipeline and CLI with a
golden corpus (denies + must-allow safe commands, no false positives). The two
default-on packs (`core.filesystem`, `core.git`) load under the default profile;
the two opt-in packs (`cloud.gcloud`, `db.postgres`) stay inactive until enabled
(crate: `profile::select_active`; CLI: `--pack <id>`; localflow later resolves
the per-environment `guard.packs` list). The packs follow a **precision-over-
coverage** posture: they block the irrecoverable footguns and fail open on the
long tail rather than risk false positives that would get the guard disabled.

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

- **Unit** — the lexer (single/double quoting including the escaped-quote-
  does-not-close-the-string case, backslash escapes both in and out of
  double quotes, adjacent-string concatenation, operator splitting with and
  without surrounding whitespace, opaque `$(...)`/backtick substitution not
  splitting on separators inside it, unterminated-quote fallback),
  normalization (argv[0] case-fold, path strip, argument preservation,
  repeated-slash collapsing), pre-filter (a command with no trigger never
  reaches regex), pack loader (valid TOML, duplicate id, bad regex → rule
  disabled + warn, missing reason → reject), matcher (allow-before-deny
  short-circuit; first-deny-wins; per-segment independent judging — a deny
  in any segment of a chained command denies the whole line; the structural
  inline `bash -c` re-entry, including recursion not gated behind the outer
  pre-filter), fail-open (bad JSON / oversize / timeout → ALLOW + warn), and
  the CLI exit codes.
- **Golden corpus** — a table of `(command, expected decision, expected pack)`
  per pack, plus a dedicated command-chaining corpus (`echo hi && rm -rf /`,
  `true; rm -rf ~`, `ls | rm -rf /` all deny; `cd foo && ls` allows; a
  separator inside quotes does not split), a dedicated tokenizer-hardening
  corpus (`tests/corpus_tokenizer.rs` — every adversarial shape from the
  first two review rounds: escaped-quote-non-closing, adjacent-string
  concatenation, case-folded argv[0], command substitution in a guarded
  position, plus a 3000-segment pathological-chain latency check), and a
  dedicated grouping/wrapper/ANSI-C-quoting corpus (`tests/corpus_grouping.rs`
  — the third review round: `( rm -rf / )`, `{ rm -rf /; }`, `if …; then rm
  -rf /; fi`, `for …; do rm -rf /; done`, `while …; do rm -rf /; done`,
  `command`/`env`/`nohup`/`nice`/`stdbuf`/`ionice` wrapping, and `rm -rf
  $'/'`/`rm -rf $'\x2f'`, plus the matching benign spread and composition
  with grouping/chaining), asserting no false positives; a dedicated
  sudo-unwrapping-plus-command-position-substitution corpus
  (`tests/corpus_sudo_and_substitution.rs` — the fourth review round); and a
  dedicated argument-position-substitution corpus
  (`tests/corpus_subst_arg_position.rs` — the fifth review round: `echo
  $(rm -rf /)`, `cat $(rm -rf /)`, `foo $(rm -rf /) bar`, `` echo `rm -rf
  /` ``, a substitution wrapping a grouped subshell, and the gcloud-pack
  equivalent all deny; the matching benign spread — `echo "$(date)"`,
  `echo $(git rev-parse HEAD)`, `grep $(cat patterns) file`, `x=$(date) &&
  echo $x`, `find / -name $(echo x)` — all allow; the previously-documented
  `env FOO=$(...) cmd` and `$(...)suffix` residuals are asserted closed;
  plus latency checks for many substitutions in one segment and many
  segments each carrying one), asserting no false positives.
- **Acceptance (this slice):** `lfguard test "git reset --hard"` exits 1 with a
  reason; `lfguard test "git status"` exits 0; `lfguard explain "git reset
  --hard"` prints the matched pack + rule + reason.

**G2 (integration, later):** hook injected at create and removed at close;
a scripted client proving a blocked decision flips the session to needs-you
with a working allow-once token; decisions appear in the activity feed;
per-environment pack toggles take effect.

## Out of scope (v1 / YAGNI)

- Shell-grammar AST parsing (the lexer covers quoting/escaping/concatenation/
  operator-splitting/opaque-substitution — real shell grammar, structural
  inline-payload re-entry, covers `bash -c '…'`-style payloads — but stops
  short of a full AST: no variable expansion, no glob expansion, no here-docs,
  no evaluating what a substitution actually resolves to).
- Binary PATH-shims (rejected above).
- Network calls from the crate itself (G2's localflow does the POST; the crate
  only decides and, in `check` mode, speaks the hook protocol).
- Per-command machine learning / heuristic scoring — packs are explicit regex,
  auditable and user-editable.
- Windows-specific packs (v1 targets the macOS/Linux shells localflow runs).
- Rolling back a command already executed — lfguard is strictly a *pre*-guard.
- SQL `UPDATE` without a `WHERE` clause — regex on SQL text is a poor fit for
  reliably distinguishing a real `WHERE` clause from one that's commented out,
  spans multiple statements, or is inside a string literal; deferred to G2,
  which can consider a real SQL parser instead of extending the regex
  approach. See "Known limitations" above.

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
