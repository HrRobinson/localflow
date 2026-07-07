#!/bin/sh
# Stands in for the codex CLI in e2e. Scans argv for -c overrides embedding
# localflow's hook commands (see src/main/codex-hooks.ts) and executes them,
# simulating whichever Codex lifecycle event this invocation's tier wired
# up — here, the shipped 'notify' tier's turn-complete (Stop-mapped) hook,
# fired once the LOCALFLOW_E2E_GO marker file appears (or after a plain
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

# Deterministic e2e synchronization: if LOCALFLOW_E2E_GO is set (the test
# sets it in the app env; SessionManager.spawn passes process env through
# to the pty), wait for that marker file to exist before firing — the test
# creates it only after its own must-come-first POSTs/assertions are done,
# so no status-order race is possible by construction. Unset (running the
# fixture standalone), fall back to a plain delay.
wait_for_go() {
  if [ -n "${LOCALFLOW_E2E_GO:-}" ]; then
    until [ -f "$LOCALFLOW_E2E_GO" ]; do sleep 0.1; done
  else
    sleep 3
  fi
}

prev=""
for arg in "$@"; do
  case "$prev" in
    -c)
      case "$arg" in
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
            (
              wait_for_go
              eval "$cmd"
            ) &
          fi
          ;;
      esac
      ;;
  esac
  prev="$arg"
done
sleep 600
