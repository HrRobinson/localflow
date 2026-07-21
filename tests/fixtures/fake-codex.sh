#!/bin/sh
# Stands in for the codex CLI in e2e. Scans argv for -c overrides embedding
# saiife's hook commands (see src/main/codex-hooks.ts) and executes them,
# simulating whichever Codex lifecycle event this invocation's tier wired
# up — here, the shipped 'notify' tier's turn-complete (Stop-mapped) hook,
# fired once the SAIIFE_E2E_GO marker file appears (or after a plain
# delay when run standalone), simulating a turn-complete. Does NOT
# validate that a real `codex` binary accepts this exact -c grammar — see
# the manual verification checklist in
# docs/superpowers/plans/2026-07-07-m2-status-adapters.md.
echo "fake-codex started in $PWD with args: $@"

# Reverses JSON.stringify's one escaping pass (\\ -> \, \" -> ") on a value
# already stripped of its own wrapping quotes. Order matters: unescape \\
# to a placeholder FIRST so the following \" rule can't consume bytes a
# real \\ produced, then restore the placeholder to a literal \.
# NOTE: coupled to how src/main/codex-hooks.ts embeds the command via
# JSON.stringify — if the generator's escaping ever changes, change this too.
unescape() {
  sed 's/\\\\/@@BKSL@@/g; s/\\"/"/g; s/@@BKSL@@/\\/g'
}

# Deterministic e2e synchronization: if SAIIFE_E2E_GO is set (the test
# sets it in the app env; SessionManager.spawn passes process env through
# to the pty), wait for that marker file to exist before firing — the test
# creates it only after its own must-come-first POSTs/assertions are done,
# so no status-order race is possible by construction. Unset (running the
# fixture standalone), fall back to a plain delay.
wait_for_go() {
  if [ -n "${SAIIFE_E2E_GO:-}" ]; then
    until [ -f "$SAIIFE_E2E_GO" ]; do sleep 0.1; done
  else
    sleep 3
  fi
}

# Separate gate for the guard PreToolUse invocation below: it fires ONLY once
# SAIIFE_E2E_GUARD_GO's file appears (the badge-clears test touches it).
# When the var is unset, or the file never appears, the guard is never run —
# so the idle-pane regression test keeps its "guard: not yet observed" badge.
# Returns non-zero (never run) when the gate isn't configured.
guard_wait_for_go() {
  if [ -n "${SAIIFE_E2E_GUARD_GO:-}" ]; then
    until [ -f "$SAIIFE_E2E_GUARD_GO" ]; do sleep 0.1; done
    return 0
  fi
  return 1
}

# A PreToolUse payload for an ALLOW command — running the guard on it writes the
# per-pane seen-dir marker (allow OR deny clears the badge), without a deny row.
GUARD_PAYLOAD='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"}}'

prev=""
for arg in "$@"; do
  case "$prev" in
    -c)
      case "$arg" in
        *hooks.PreToolUse*)
          # The guard -c override embeds `saiifeguard check ... --seen-dir <dir>
          # --audit-tag <paneId>` as a JSON.stringify'd command. That command
          # uses single-quoted paths (no inner double-quotes), so JSON.stringify
          # wraps it in "..." with NO escaping — extract it back out directly.
          # Run it with a PreToolUse payload on stdin, exactly as real Codex
          # would dispatch a Bash tool-call to the guard, so saiifeguard writes the
          # invocation marker saiife's guard-seen watcher observes.
          gcmd=$(echo "$arg" | sed -n 's/.*,command="\(.*\)"}]}]$/\1/p')
          if [ -n "$gcmd" ]; then
            (
              if guard_wait_for_go; then
                printf '%s' "$GUARD_PAYLOAD" | sh -c "$gcmd"
              fi
            ) &
          fi
          ;;
        *curl*)
          # $arg looks like: notify=["sh","-c","curl ... -d '{\"paneId\":...}'"]
          # Pull out the JSON.stringify-escaped sh -c payload (the quoted
          # string following the second "sh","-c", token), strip its
          # wrapping quotes, then unescape it. A strip-outer-quotes-only
          # extraction (no unescape) leaves literal backslash-quote pairs
          # INSIDE the -d flag's single-quoted JSON body — POSIX shell does
          # NOT interpret backslash specially inside single quotes, so
          # those pairs would reach curl verbatim and hook-server.ts's
          # JSON.parse would reject the resulting malformed body.
          quoted=$(echo "$arg" | sed -n 's/.*"sh","-c",\(".*"\)\].*/\1/p')
          stripped=$(echo "$quoted" | sed 's/^"//;s/"$//')
          cmd=$(printf '%s' "$stripped" | unescape)
          if [ -n "$cmd" ]; then
            # The e2e test drives a manual 'working' POST first, to prove
            # the Stop transition below is a real change rather than the
            # untouched idle default — wait_for_go guarantees that POST
            # (and its assertion) happened before this hook ever fires.
            #
            # $cmd is now a `case "$0$1" in *agent-turn-complete*) curl
            # ...;; esac` guard (src/main/codex-hooks.ts's notify tier),
            # so it can no longer be `eval`'d bare in this shell's own
            # context — that would inspect fake-codex.sh's OWN $0/$1, not
            # a notification payload, and the guard would never match.
            # Real Codex invokes the configured `["sh","-c",script]`
            # program array with the notification JSON appended as a
            # single extra argv element, which POSIX assigns to `$0`
            # (verified in tests/unit/codex-hooks.test.ts's executing
            # tests) — so reproduce that exact invocation shape here via
            # a real nested `sh -c` with a realistic agent-turn-complete
            # payload as the one extra arg, rather than eval'ing in-place.
            (
              wait_for_go
              sh -c "$cmd" '{"type":"agent-turn-complete","turn_id":"e2e"}'
            ) &
          fi
          ;;
      esac
      ;;
  esac
  prev="$arg"
done
sleep 600
