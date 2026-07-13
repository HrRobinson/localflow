#!/bin/sh
# Stands in for the claude CLI in dev/e2e. Prints its args, then echoes a
# marker for each line read from stdin AND appends to an approve-marker
# file in $PWD — the approve e2e asserts the file (works even when no
# terminal pane is mounted to render the pty's echo) and/or the terminal
# text. Exits when the pty closes (read fails), replacing the old sleep.
#
# LOCALFLOW_E2E_RESUME_DEAD_ARG (optional, groups.spec.ts's resume
# dead-end test only): when set and one of argv equals it exactly (e.g.
# "--continue" — claude's own resumeArgs, see shared/agents.ts's preset),
# exit immediately instead of reading stdin, simulating a resumed
# conversation that's gone. SessionManager.spawn's INSTANT_EXIT_MS window
# then flips the session's resumeFailed flag (only set when the dying
# spawn was itself a resume attempt), driving the "Start fresh" primary
# overlay. Unset — the default for every other spec — this is a no-op and
# the fixture behaves exactly as before.
echo "fake-claude started in $PWD with args: $@"
if [ -n "${LOCALFLOW_E2E_RESUME_DEAD_ARG:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "$LOCALFLOW_E2E_RESUME_DEAD_ARG" ]; then
      echo "fake-claude resume died instantly"
      exit 1
    fi
  done
fi
while IFS= read -r _line; do
  echo "fake-claude got input"
  echo got-input >> "$PWD/approve-marker"
done
