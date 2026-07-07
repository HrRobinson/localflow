#!/bin/sh
# Stands in for the codex CLI in e2e. Scans argv for -c overrides embedding
# localflow's hook commands (see src/main/codex-hooks.ts) and executes them,
# simulating whichever Codex lifecycle event this invocation's tier wired
# up — here, the shipped 'notify' tier's turn-complete (Stop-mapped) hook,
# fired shortly after start to simulate a fast turn-complete. Does NOT
# validate that a real `codex` binary accepts this exact -c grammar — see
# the manual verification checklist in
# docs/superpowers/plans/2026-07-07-m2-status-adapters.md.
echo "fake-codex started in $PWD with args: $@"

# Reverses JSON.stringify's one escaping pass (\\ -> \, \" -> ") on a value
# already stripped of its own wrapping quotes. Order matters: unescape \\
# to a placeholder FIRST so the following \" rule can't consume bytes a
# real \\ produced, then restore the placeholder to a literal \.
unescape() {
  sed 's/\\\\/@@BKSL@@/g; s/\\"/"/g; s/@@BKSL@@/\\/g'
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
            # 3s (not "shortly after start") on purpose: the e2e test drives
            # a manual 'working' POST first to prove this Stop transition is
            # a real change, not just the untouched idle default — that step
            # needs to reliably land before this fires, and process spawn
            # happens well before the app's create/open UI flow even starts.
            (
              sleep 3
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
