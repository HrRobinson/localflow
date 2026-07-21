# saiifeguard — wrapper-unwrapping hardening (design)

Status: **Approved 2026-07-16.**
Scope: the first slice of the "saiifeguard pack expansion" track — closing the
transparent-wrapper bypass gap the tokenizer documents but does not yet cover.
Grounded against: `guard/crates/saiifeguard/src/{wrappers,engine,payload,subst,lexer,normalize}.rs`,
`tests/corpus_sudo_and_substitution.rs`, `packs/*.toml`,
`docs/superpowers/specs/2026-07-14-saiifeguard-design.md` (G1), and the scope report
`scratchpad/scope-saiifeguard-packs.md` (§3). Baseline `cargo test -p saiifeguard` is
green as of this draft.

---

## 1. Problem statement — and why now

saiifeguard peels a fixed set of *transparent* wrapper commands off the front of
each segment before matching, so packs judge the **effective** command rather
than the wrapper. Today that set is
(`wrappers.rs:31-32`):

```
TRANSPARENT_PREFIXES = ["command", "env", "nohup", "nice", "stdbuf", "ionice", "sudo"]
```

The module doc (`wrappers.rs:20-23`) explicitly lists seven wrappers it does
**not** unwrap: `xargs`, `timeout`, `watch`, `time`, `chroot`, `su -c`,
`flock`. Every one of these sits at `argv[0]` in place of the real command, so
a destructive command wrapped in one **bypasses every pack, silently**:

| Bypass that ALLOWs today | Wrapper |
|---|---|
| `timeout 300 rm -rf /` | timeout |
| `time rm -rf /` | time |
| `su -c 'rm -rf /'` | su -c |
| `flock /tmp/lock rm -rf /` | flock |
| `chroot /mnt/root rm -rf /` | chroot |
| `watch -n5 rm -rf /` | watch |
| `find / -print0 \| xargs -0 rm -rf` | xargs |

**Why now:** saiifeguard now actually ships (release CI was just fixed, and the G2
saiife integration wires it into every session's PreToolUse hook). A guard
that is *installed and trusted* but silently ALLOWs `timeout 300 rm -rf /` is
worse than one that isn't installed — the operator believes they are covered.
This is a single, pipeline-wide, engine-level fix: there is exactly one call
site (`engine.rs:143`, `unwrap_transparent_prefix(&seg)`), so closing these
gaps benefits **every existing and future pack with zero pack-file changes**.
It is the highest-value / lowest-risk item in the whole expansion track
(scope report §3, §5).

### The hard constraint

saiifeguard's absolute requirement is **zero false positives** (`core.filesystem.toml:3-7`;
G1 "precision-over-coverage… fail open on the long tail rather than risk false
positives that would get the guard disabled"). These seven wrappers are **not**
uniformly transparent like `sudo`/`env`/`nice`. Each has its own argument
grammar — its own options, some of which take values, and (for several) one or
more positional arguments that come *before* the wrapped command. A naive
"treat it like sudo and skip to the first non-flag word" is wrong for most of
them and dangerous for one (`su`).

### The load-bearing safety insight (drives the whole design)

**A leading-token *skip* cannot, by itself, manufacture a false positive.**
Unwrapping only ever *removes* leading tokens; it never fabricates a command.

- Skip **too few** → a wrapper name (`timeout`, `flock`, …) or a wrapper option
  is left at `argv[0]`. No pack's `^`-anchored deny rule matches a wrapper
  name, so the command **fails open (ALLOW)**. A missed catch, never a false
  block.
- Skip **too many** → a benign leftover token (a duration `300`, a lockfile
  path `/tmp/lock`, a username) is left at `argv[0]`. It is not a guarded
  command name, so again **ALLOW**.
- A deny fires **only** when the genuine wrapped command that remains is itself
  catastrophic — i.e. exactly when it should.

So for the *skip-based* wrappers, imperfect option/positional tables cost us
**recall (missed catches), never precision (false blocks)**. The only ways to
introduce a real false positive are:

1. Treating a **non-transparent** wrapper as transparent, so a wrapper
   *operand* is misread as a command — this is precisely the `su username`
   trap (`su root` must never be read as "run `root`", and `su -c 'ls'` must
   be recursed, not skipped-to). **Mitigation: `su` is handled via the inline
   `-c` payload path, NOT added to `TRANSPARENT_PREFIXES`.**
2. Re-lexing/recursing into an extracted payload that then matches — but this
   reuses the *already-proven* `bash -c` recursion, which is FP-safe by
   construction (a benign inner resolves to ALLOW; only a guarded/destructive
   inner denies — see `engine.rs:303-345`, `corpus_sudo_and_substitution.rs`).

This asymmetry is why the slice is low-risk: we can be aggressive about
*skipping* and conservative only where we *recurse*.

---

## 2. What to unwrap in v1, and what to defer

| Wrapper | v1? | Mechanism | FP risk | Recall risk |
|---|---|---|---|---|
| `time` | **INCLUDE** | transparent prefix (skip `-p` + GNU value-opts) | none | very low |
| `timeout` | **INCLUDE** | option-skip + one duration positional | none | low |
| `chroot` | **INCLUDE** | option-skip + one NEWROOT positional | none* | low |
| `flock` (prefix form) | **INCLUDE** | option-skip (some value-taking) + one lockfile positional | none | low-med |
| `su -c` | **INCLUDE** | inline `-c` payload recursion (reuse `bash -c` path) | low | low |
| `watch` | **INCLUDE** | join remaining args, recurse (faithful to watch's `sh -c`) | low | low |
| `xargs` | **DEFER** | — | — | — |
| `flock … -c 'STRING'` sub-form | **DEFER** | (would be inline `-c` payload) | — | — |

\* `chroot` carries a semantic caveat, not an implementation FP — see DECISION 5.

### Why defer `xargs`

`xargs` is **fundamentally different** from a prefix wrapper and delivers little
value while adding real complexity and FP surface:

- It reads items from **stdin** and **appends** them to the command, so the
  catastrophic operand is usually **not in the static command line at all**:
  `find / -print0 | xargs -0 rm -rf` has `rm -rf` with *no target token* — the
  `/` comes from `find`, invisible to any static scan. Even if we unwrap
  `xargs -0 rm -rf` → `rm -rf`, `core.filesystem`'s rm rule **requires a
  catastrophic target token** and would (correctly) ALLOW `rm -rf` on its own.
  So unwrapping xargs catches almost nothing the pack can act on.
- Finding `xargs`'s COMMAND means threading its large value-taking option
  surface (`-n N`, `-I R`, `-P N`, `-d D`, `-L N`, `-a FILE`, `-E EOF`,
  `-s SIZE`, …) — the most error-prone parse of the seven, for the least payoff.
- `find . -name '*.tmp' | xargs rm` (benign cleanup) is extremely common; xargs
  belongs to a later slice, if ever.

**Recommendation:** document `xargs` as a known, accepted limitation (its danger
is a property of the *stdin producer*, which the guard already can't see), and
revisit only if a concrete need appears. This matches the scope report's read.

### Why defer `flock … -c 'STRING'`

`flock` has three usage forms; v1 ships the dominant one
(`flock [opts] LOCKFILE COMMAND…`). The `-c` form (`flock /tmp/lock -c 'rm -rf /'`,
runs the string via `sh -c`) interleaves an option *after* the positional and
needs inline-payload handling that would double-book with the positional-skip
path. It is rarer than the bare form. **Recommendation:** ship the prefix form
in v1, document the `-c` form as a known gap, and fold it into a follow-up
(it is a one-line addition once we decide the interleave rule — DECISION 4).

---

## 3. Per-wrapper parsing rules (the careful part)

Notation: "value-taking option" = consumes the following token as its value
(or an attached `--opt=val` / `-oval` form). "positional" = a non-`-` operand
that precedes the wrapped command.

### 3.1 `time` — transparent prefix (simplest)

- **Shell-builtin form** (`bash`/`zsh`): `time [-p] COMMAND …`. The only option
  is `-p`. Pure prefix — the command follows directly.
- **GNU `/usr/bin/time` form**: `/usr/bin/time [OPTIONS] COMMAND …` with
  value-taking `-o FILE`/`--output=FILE`, `-f FMT`/`--format=FMT`, and boolean
  `-a`/`--append`, `-v`/`--verbose`, `-p`/`--portability`.
  - `argv[0]` is already directory-stripped and case-folded upstream
    (`normalize::build_argv`), so `/usr/bin/time` arrives as `time`.
- **Rule:** skip leading `-`-prefixed flags; for the two GNU value-taking short
  options (`-o`, `-f`) given in separate-token form, also skip their value;
  `--output`/`--format` separate-token forms likewise. Attached forms
  (`-oout.txt`, `--output=out.txt`) are one token, skipped generically.
- **Traps:** none that cause an FP. Mishandling `-o`/`-f` value-skip only risks
  a missed catch (leftover `out.txt` at `argv[0]` → ALLOW).
- **Shape:** straight prefix-skip — closest to the existing `command`/`stdbuf`
  handler plus a tiny value-taking set. **Straight prefix-skip.**
- Deny examples: `time rm -rf /`, `time -p rm -rf /`, `/usr/bin/time -v rm -rf /`,
  `/usr/bin/time -o out.txt rm -rf /`.
- Benign examples (must ALLOW): `time ls`, `time -p make`,
  `/usr/bin/time -v ./build.sh`.

### 3.2 `timeout` — options + one duration positional

- **Grammar:** `timeout [OPTIONS] DURATION COMMAND [ARG]…`. DURATION is
  **mandatory** and precedes the command. Options: value-taking `-s SIGNAL`/
  `--signal=SIGNAL`, `-k DURATION`/`--kill-after=DURATION`; boolean
  `--preserve-status`, `--foreground`, `-v`/`--verbose`.
- **Rule:** (1) skip options, consuming the value of `-s`/`-k` (and long
  separate-token `--signal`/`--kill-after`); (2) skip **exactly one** positional
  — the duration; (3) the remainder is the effective command.
- **DECISION 6 (duration-shape guard) — RESOLVED: YES.** The one skipped
  positional is accepted only if it *looks like a duration* — `^\d+(\.\d+)?[smhd]?$`
  (GNU accepts a float with optional `s`/`m`/`h`/`d` suffix). If the first
  non-option token is not duration-shaped (malformed input like `timeout rm`),
  do **not** skip it. Rationale: prevents the (contrived) case of skipping a
  real command word and, one token later, surfacing a catastrophic remainder —
  the *only* theoretical FP path for a positional-skip wrapper. Costs nothing on
  valid input.
- **Traps:** `-s`/`-k` value-skip (mishandling → missed catch only). `timeout`
  alone or `timeout 300` alone (no command) must fail open without panicking.
- **Shape:** option-skip + one duration positional. **New positional-skip
  sub-case.**
- Deny: `timeout 300 rm -rf /`, `timeout 5s rm -rf /`, `timeout -s KILL 10 rm -rf /`,
  `timeout --signal=KILL 10 rm -rf /`, `timeout -k 5 10 rm -rf /`.
- Benign (ALLOW): `timeout 5 ls`, `timeout 300 make`, `timeout 10 curl https://x`,
  `timeout 300` (no command → ALLOW), `timeout` (→ ALLOW).

### 3.3 `chroot` — options + one NEWROOT positional

- **Grammar:** `chroot [OPTIONS] NEWROOT [COMMAND [ARG]…]`. GNU chroot's options
  are all **attached long form**: `--userspec=USER:GROUP`, `--groups=G,…`,
  `--skip-chdir` — none take a *separate* value token. NEWROOT is mandatory; if
  COMMAND is omitted chroot runs `${SHELL} -i` (nothing static to judge).
- **Rule:** (1) skip leading `-`-prefixed flags (all attached, one token each);
  (2) skip **exactly one** positional (NEWROOT); (3) remainder is the command.
- **Traps:** none causing an FP. If NEWROOT is the only operand, remainder is
  empty → ALLOW.
- **DECISION 5 (semantic caveat, not an implementation FP) — RESOLVED: YES
  (block).** In `chroot /mnt/root rm -rf /`, the `/` is the *chroot's* root, not
  the host's. Blocking it may surprise a user deliberately resetting a container
  rootfs. We **still block** — a recursive wipe of *any* filesystem root is the
  catastrophe class saiifeguard exists to stop, and the wrapper's presence does not
  make the intent safe. The nuance is documented in the limitations note so it
  is a conscious choice, not an accident.
- **Shape:** option-skip + one positional. **New positional-skip sub-case**
  (shares the helper with `timeout`/`flock`).
- Deny: `chroot /mnt/root rm -rf /`, `chroot --userspec=root:root /mnt rm -rf /etc`.
- Benign (ALLOW): `chroot /mnt/root ls`, `chroot /mnt` (no command → ALLOW).

### 3.4 `flock` (prefix form) — options (some value-taking) + one lockfile positional

- **Grammar (v1 form):** `flock [OPTIONS] <LOCKFILE|DIR|FD> COMMAND [ARG]…`.
  Options: value-taking `-w SECONDS`/`--timeout`, `-E CODE`/`--conflict-exit-code`;
  boolean `-s`/`--shared`, `-x`/`--exclusive`, `-u`/`--unlock`, `-n`/`--nonblock`,
  `-o`/`--close`, `-F`/`--no-fork`, `-v`/`--verbose`.
- **Rule:** (1) skip options, consuming the value of `-w`/`-E` (and long
  separate-token forms); (2) skip **exactly one** positional (the lock target —
  a path or an fd number; both are treated identically); (3) remainder is the
  command.
- **Traps:**
  - `-w 5` / `-E 1` value-skip (mishandling → missed catch only).
  - Form-2 usage `flock -n 9` (fd, no command): after skipping the fd
    positional there is no remainder → ALLOW. Correct.
  - The `-c 'STRING'` form is **deferred** (DECISION 4) — v1 does not attempt it;
    `flock /tmp/lock -c 'rm -rf /'` remains a documented gap.
- **Shape:** option-skip + one positional. **New positional-skip sub-case.**
- Deny: `flock /tmp/lock rm -rf /`, `flock -w 5 /tmp/lock rm -rf /`,
  `flock -n /var/lock/x rm -rf ~`.
- Benign (ALLOW): `flock /tmp/lock ls`, `flock /tmp/lock echo hi`,
  `flock -n 9`.

### 3.5 `su -c` — inline payload recursion (NOT a transparent prefix)

- **Grammar:** `su [OPTIONS] [-c COMMAND] [-] [USER [ARG]…]`. The wrapped command
  is the **single string argument to `-c`** (run via the target user's shell);
  `su USER` with no `-c` opens an interactive shell (nothing static to judge).
  Options: `-l`/`--login`, `-`, `-s SHELL`/`--shell`, `-g GROUP`/`--group`,
  `-p`/`--preserve-environment`, `-m`, and a username positional.
- **Why NOT a transparent prefix:** `su`'s first operand is a **username**, not a
  command — `su root` means "become root", not "run `root`". Adding `su` to
  `TRANSPARENT_PREFIXES` would misread the username as `argv[0]` — the one shape
  that *can* create a real false positive/negative confusion. The wrapped
  command is only ever behind `-c`, as a whole string that the shell re-parses —
  i.e. **exactly the `bash -c '…'` shape already handled**.
- **Rule (DECISION 2 — RESOLVED: YES):** add `su` to
  `payload::INLINE_INTERPRETERS`. `inline_payload` already does
  `argv.iter().position(|a| a == "-c")` then takes the next token, which
  correctly locates the command string regardless of where `su`'s username /
  options sit (`su root -c 'X'`, `su - -c 'X'`, `su -l root -c 'X'` all put the
  real string right after `-c`). The engine then recurses into it via the same
  proven, FP-safe path (`engine.rs:309-345`). `su` with no `-c` → `inline_payload`
  returns `None` → `argv[0]="su"` matches no pack → ALLOW. `su` is added to
  `INLINE_INTERPRETERS`, **NOT** to `TRANSPARENT_PREFIXES`, precisely because
  its first operand is a username.
- **Traps:** `su rm` (no `-c`) must **not** be read as running `rm` — verified by
  a regression test asserting `su rm` ALLOWs. `su -c 'ls'` must recurse to a
  benign ALLOW, not be skipped.
- **Shape:** inline `-c` payload. **Reuses existing recursion; new only in the
  interpreter list.**
- Deny: `su -c 'rm -rf /'`, `su root -c 'rm -rf /'`, `su - -c 'rm -rf /'`,
  `su -l root -c 'git reset --hard'`.
- Benign (ALLOW): `su root` (interactive, no command), `su -c 'ls'`,
  `su - postgres -c 'psql -c "SELECT 1"'`.
- Regression (must ALLOW, proves `su` is not a blind prefix): `su rm`, `su root`.

### 3.6 `watch` — join remaining args and recurse

- **Grammar:** `watch [OPTIONS] COMMAND [ARG]…`. watch joins its remaining
  arguments with spaces and runs the result via `sh -c` (unless `-x`/`--exec`,
  which does not change the *tokens*). So both `watch rm -rf /` (multi-token)
  and `watch 'rm -rf /'` (single quoted string) mean the same thing to watch.
  Options: value-taking `-n SECONDS`/`--interval`; boolean `-d`/`--differences`,
  `-t`/`--no-title`, `-b`/`--beep`, `-e`/`--errexit`, `-g`/`--chgexit`,
  `-c`/`--color`, `-x`/`--exec`, `-p`/`--precise`.
- **Rule (DECISION 3 — RESOLVED: YES):** (1) skip options, consuming the value of
  `-n`/`--interval` (attached `-n5`/`--interval=5` are one token); (2) **join the
  remaining resolved words with single spaces** and **recurse** into that string
  via the engine's inline re-entry (same depth cap + budget). This is *faithful*
  to watch's real behavior (it literally hands the joined string to `sh -c`), and
  it uniformly handles both the multi-token and single-quoted-string forms.
- **Traps:** joining-then-re-lexing loses word boundaries for a quoted argument
  that itself contains spaces (`watch grep 'a b' file` → `grep a b file`) — but
  this only changes an *unguarded* command's argv, and can only ever surface a
  catastrophic remainder if catastrophic content was already present, so it is
  FP-safe by the §1 argument. `-n` value-skip mishandling → missed catch only.
- **Shape:** option-skip + join-and-recurse. **Genuinely new sub-case** (a small
  `watch_payload(argv) -> Option<String>` in `payload.rs`, wired into the engine
  re-entry beside `inline_payload`).
- Deny: `watch rm -rf /`, `watch -n 5 rm -rf /`, `watch -n5 rm -rf /`,
  `watch 'rm -rf /'`.
- Benign (ALLOW): `watch -n 5 ls`, `watch df -h`, `watch 'git status'`.

### 3.7 `xargs` — DEFERRED (see §2). Known-limitation only; no code in v1.

---

## 4. Architecture — where the change lives

One engine-level slice, no pack TOML changes, no pack version bumps. Three
touch points, mirroring the mechanisms each wrapper reduces to:

1. **`src/wrappers.rs` — the skip-based wrappers** (`time`, `timeout`, `chroot`,
   `flock`). These all reduce to "return a sub-slice of the same segment
   starting at the effective command", which is exactly
   `unwrap_transparent_prefix`'s existing `&[Word] -> &[Word]` contract.
   - Add `time`, `timeout`, `chroot`, `flock` to the dispatch in
     `unwrap_transparent_prefix` (the `match name.as_str()` at
     `wrappers.rs:71-102`). `time` joins `TRANSPARENT_PREFIXES`-style handling;
     the other three route to a new helper.
   - Add a generic helper
     `skip_options_then_positionals(rest, value_opts: &[&str], value_shorts: &[char], positionals: usize, positional_shape: Option<fn(&str)->bool>) -> &[Word]`
     that: skips `-`-prefixed options (consuming a separate value token for the
     listed value-taking options), then skips up to `positionals` non-option
     tokens (each gated by the optional shape predicate — used for `timeout`'s
     duration). This is the "skip exactly one positional" sub-case the scope
     report flags as genuinely new (the lockfile / newroot / duration slot that
     no existing wrapper has).
   - Because unwrapping happens once at `engine.rs:143`, everything downstream
     (command-position substitution detection, the guarded-argument fail-safe,
     `inline_payload`, pack matching) automatically sees the effective command.
     **Composition falls out for free**: `timeout 5 rm -rf $(x)` unwraps to
     `rm -rf $(x)`, which the existing guarded-argument fail-safe
     (`engine.rs:272-285`) then denies; `sudo timeout 5 rm -rf /` composes
     because the outer loop peels wrappers repeatedly (`wrappers.rs:60-70`).

2. **`src/payload.rs` — the recursion-based wrappers** (`su -c`, `watch`).
   - `su`: add to `INLINE_INTERPRETERS` (`payload.rs:67-69`). No other change —
     `inline_payload` already extracts the `-c` token and the engine already
     recurses.
   - `watch`: add `pub fn watch_payload(argv: &[String]) -> Option<String>` that
     returns `None` unless `argv[0] == "watch"`, else skips watch's options
     (with `-n`/`--interval` value-skip) and returns the remaining words joined
     by spaces (or `None` if empty).

3. **`src/engine.rs` — wire in `watch_payload`.** In the structural re-entry
   block (`engine.rs:309-345`, currently `inline_payload`), also try
   `watch_payload(&argv)` under the same `depth < MAX_INLINE_DEPTH` gate, budget
   check, and recurse-and-propagate logic. `su` needs no engine change (it flows
   through the existing `inline_payload` branch). No change to the depth cap
   (`MAX_INLINE_DEPTH = 8`) or budget (`DEFAULT_BUDGET = 50ms`) — the new
   re-entries are bounded by both, exactly like `bash -c`.

**Latency:** every addition is O(segment length) leading-token work plus at most
one bounded recursion per wrapper occurrence — same class as the existing
`sudo`/`bash -c` handling. The existing 5000-segment latency test
(`corpus_sudo_and_substitution.rs:157-173`) is extended to a wrapper case to
prove no quadratic blowup.

**No versioning churn:** this is engine behavior, not pack content — no
`packs/*.toml` edits, no `version =` bump, no `builtins.rs` registration
(DECISION 8). The `guard.packs` public config surface is untouched.

---

## 5. Adversarial test plan

New golden corpus file **`tests/corpus_wrappers2.rs`**, mirroring
`corpus_sudo_and_substitution.rs` (module doc naming the closed bypasses;
`default_engine()` / `gcloud_engine()` helpers). For **each** included wrapper,
two paired blocks — a bypass that is now CAUGHT, and benign uses that stay
ALLOWED (the zero-FP guard). Plus composition, latency, depth, and the `su`
non-prefix regression. Unit tests also go in `wrappers.rs` / `payload.rs`
alongside the existing ones.

### Deny corpus (each is a bypass that ALLOWs today, must DENY after)

- **time:** `time rm -rf /`, `time -p rm -rf /`, `/usr/bin/time -v rm -rf /`,
  `/usr/bin/time -o out.txt rm -rf /`.
- **timeout:** `timeout 300 rm -rf /`, `timeout 5s rm -rf /`,
  `timeout -s KILL 10 rm -rf /`, `timeout --signal=KILL 10 rm -rf /`,
  `timeout -k 5 10 rm -rf /`.
- **chroot:** `chroot /mnt/root rm -rf /`, `chroot --userspec=root:root /mnt rm -rf /etc`.
- **flock:** `flock /tmp/lock rm -rf /`, `flock -w 5 /tmp/lock rm -rf /`,
  `flock -n /var/lock/x rm -rf ~`.
- **su -c:** `su -c 'rm -rf /'`, `su root -c 'rm -rf /'`, `su - -c 'rm -rf /'`,
  `su -l root -c 'git reset --hard'` (with `core.git` default-on).
- **watch:** `watch rm -rf /`, `watch -n 5 rm -rf /`, `watch -n5 rm -rf /`,
  `watch 'rm -rf /'`.
- **cross-pack (gcloud_engine):** `timeout 60 gcloud projects delete p`,
  `su -c 'gcloud projects delete p'` — proves the fix is pack-agnostic.
- **composition:** `sudo timeout 5 rm -rf /` (wrapper stacking),
  `timeout 5 rm -rf $(x)` (unwrap then guarded-arg fail-safe),
  `timeout 5 $(rm -rf /)` (unwrap then command-position substitution),
  `bash -c 'timeout 5 rm -rf /'` (inline payload then unwrap).

### Benign corpus (must stay ALLOW — the zero-FP guard)

- **time:** `time ls`, `time -p make`, `/usr/bin/time -v ./build.sh`.
- **timeout:** `timeout 5 ls`, `timeout 300 make`, `timeout 10 curl https://x`,
  `timeout 300` (no command), `timeout` (bare).
- **chroot:** `chroot /mnt/root ls`, `chroot /mnt`.
- **flock:** `flock /tmp/lock ls`, `flock /tmp/lock echo hi`, `flock -n 9`.
- **su:** `su root` (interactive), `su -c 'ls'`,
  `su - postgres -c 'psql -c "SELECT 1"'`, and the **non-prefix regression**
  `su rm` (must NOT be read as running `rm`).
- **watch:** `watch -n 5 ls`, `watch df -h`, `watch 'git status'`.
- **xargs (deferred, documents the known gap):** `find . -name '*.tmp' | xargs rm`
  stays ALLOW (as today) — a comment records that the stdin-driven catastrophic
  case remains an accepted limitation.

### Structural tests

- **Latency:** extend the 5000-segment chain test with a trailing
  `timeout 5 rm -rf /` (and one with `su -c 'rm -rf /'`) — must DENY well under
  the 50 ms budget, proving linearity.
- **Depth/termination:** deeply nested `watch 'watch '…'…'` and
  `su -c 'su -c '…'…'` past `MAX_INLINE_DEPTH` must fail open, not overflow.
- **No-regression:** re-run the full existing suite (`corpus_*`, `wrappers.rs`
  unit tests) unchanged — the new handlers must not alter any current verdict.

### Per-wrapper unit tests (in `wrappers.rs` / `payload.rs`)

Mirror the existing `unwrap_*` table tests: assert the *unwrapped slice* for
each wrapper (`timeout 300 rm -rf /` → `["rm","-rf","/"]`; `flock -w 5 /tmp/lock rm -rf /`
→ `["rm","-rf","/"]`; `chroot /mnt x` → `["x"]`; value-skip and attached-form
variants), plus `watch_payload` / `su`-via-`inline_payload` string-extraction
tests and the `su rm` → not-a-payload case.

---

## 6. Task breakdown

Sized as one spec → plan → build cycle. Each task is independently testable.

1. **`wrappers.rs`: generic `skip_options_then_positionals` helper** + unit
   tests (option-skip with value-taking set, N-positional skip, shape predicate).
2. **`time`** handling in `unwrap_transparent_prefix` + unit tests.
3. **`timeout`** (value-taking `-s`/`-k`, one duration-shaped positional) + unit
   tests, incl. bare/no-command fail-open.
4. **`chroot`** (attached long options, one NEWROOT positional) + unit tests.
5. **`flock`** prefix form (value-taking `-w`/`-E`, one lockfile positional) +
   unit tests; code comment marking the `-c` sub-form deferred.
6. **`su`** → add to `INLINE_INTERPRETERS` + unit tests, incl. the `su rm`
   non-prefix regression and `su root -c`/`su - -c` extraction.
7. **`watch_payload`** in `payload.rs` + wire into `engine.rs` re-entry + unit
   tests (multi-token and single-string forms, `-n` value-skip).
8. **`tests/corpus_wrappers2.rs`** — full deny + benign + cross-pack +
   composition + latency + depth corpus (§5).
9. **Docs:** update `wrappers.rs` module doc (move the six out of the gap list;
   keep `xargs` + `flock -c` listed as remaining gaps) and add a
   "Known limitations" note to the G1 design doc.
10. **Adversarial review pass** + full `cargo test -p saiifeguard` green; sanity-run
    a handful of the deny/benign lines through the `saiifeguard test` CLI.

---

## 7. Decisions (maintainer sign-off — all RESOLVED 2026-07-16)

1. **Defer `xargs`? — RESOLVED: YES (defer).** Stdin-append means the
   catastrophic operand isn't in the static command line; unwrapping catches
   little and adds the most parse/FP surface of the seven. Documented as an
   accepted limitation.
2. **Handle `su -c` via the inline-payload path (add `su` to
   `INLINE_INTERPRETERS`), and explicitly NOT via `TRANSPARENT_PREFIXES`? —
   RESOLVED: YES.** `su`'s first operand is a username, so a blind prefix-skip
   would misread it; the real command is always behind `-c`, i.e. the proven
   `bash -c` shape. This is the single most important safety decision here.
3. **`watch` via "join remaining args and recurse"? — RESOLVED: YES.** It is
   faithful to watch's actual `sh -c` behavior and uniformly covers both the
   multi-token and single-quoted-string forms. The alternative (defer watch)
   leaves a realistic vector open for little saved effort.
4. **`flock … -c 'STRING'` sub-form: v1 or defer? — RESOLVED: DEFER.** Ship the
   dominant `flock LOCKFILE COMMAND` form now; the `-c` interleave is a small
   follow-up once we pick the rule (treat `-c`'s next token as an inline payload,
   scanned after the positional skip).
5. **`chroot`: block `rm -rf /` even though `/` is the chroot's root? —
   RESOLVED: YES (block).** A recursive root wipe is the catastrophe class
   saiifeguard exists for; the wrapper doesn't make it safe. Documented the nuance so
   it's a conscious choice.
6. **`timeout` duration-shape guard** (only skip the positional if it matches
   `^\d+(\.\d+)?[smhd]?$`)? — **RESOLVED: YES.** Closes the sole theoretical FP
   path for positional-skip wrappers at zero cost on valid input.
7. **Scope/versioning:** confirm this is an **engine-level** change only —
   `wrappers.rs`/`payload.rs`/`engine.rs`, no `packs/*.toml`, no pack
   `version` bump, no `builtins.rs` change, no `guard.packs` config surface
   change. — **RESOLVED: YES** (keeps the public config surface stable).
8. **Corpus file name / convention:** new `tests/corpus_wrappers2.rs` (following
   the per-round `corpus_*` precedent), vs. folding into the existing
   `corpus_sudo_and_substitution.rs`. — **RESOLVED: new file** for a clean,
   self-documenting round boundary, matching how each prior hardening round got
   its own corpus.

---

## 8. Out of scope for this slice

- `xargs` unwrapping (§2) and `flock … -c` (DECISION 4) — deferred, documented.
- The runner-up tokenizer items from the scope report (`${…}` nested `$(…)`;
  chmod/chown flag/target order; `case`/`until`/process-substitution) — separate
  slices.
- Any new pack (terraform/aws/docker/k8s/sql) — separate track.
- Reading files during evaluation (e.g. `psql -f script.sql`) — explicitly not
  introduced here; the fail-open, in-memory posture is preserved.
