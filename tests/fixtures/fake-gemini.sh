#!/bin/sh
# Stands in for the gemini CLI in e2e. Reads the settings file saiife
# pointed at via GEMINI_CLI_SYSTEM_SETTINGS_PATH (see
# src/main/gemini-hooks.ts) and runs each hook's command, simulating
# BeforeAgent -> Notification(ToolPermission) -> AfterAgent once the
# SAIIFE_E2E_GO marker file appears (or after a plain delay when run
# standalone). Does NOT validate that a real `gemini` binary uses this settings
# shape or this notification field name/casing — see the manual
# verification checklist in
# docs/superpowers/plans/2026-07-07-m2-status-adapters.md.
echo "fake-gemini started in $PWD, settings: $GEMINI_CLI_SYSTEM_SETTINGS_PATH"

# Reverses JSON.stringify's one escaping pass (\\ -> \, \" -> ") on a value
# already stripped of its own wrapping quotes. Order matters: unescape \\
# to a placeholder FIRST so the following \" rule can't consume bytes a
# real \\ produced, then restore the placeholder to a literal \.
# NOTE: coupled to how src/main/gemini-hooks.ts embeds each command via
# JSON.stringify — if the generator's escaping ever changes, change this too.
unescape() {
  sed 's/\\\\/@@BKSL@@/g; s/\\"/"/g; s/@@BKSL@@/\\/g'
}

# Deterministic e2e synchronization: if SAIIFE_E2E_GO is set (the test
# sets it in the app env; SessionManager.spawn passes process env through
# to the pty), wait for that marker file to exist before starting the hook
# sequence — the test creates it only after its own must-come-first
# assertions are done, so no status-order race is possible by construction.
# Unset (running the fixture standalone), fall back to a plain delay.
wait_for_go() {
  if [ -n "${SAIIFE_E2E_GO:-}" ]; then
    until [ -f "$SAIIFE_E2E_GO" ]; do sleep 0.1; done
  else
    sleep 2.5
  fi
}

# Each hook's command sits at a fixed 5-line offset from its own key line
# in writeGeminiHookSettings's JSON.stringify(obj, null, 2) output:
#   "<Key>": [          <- grep target
#     {
#       "hooks": [
#         {
#           "type": "command",
#           "command": "..."   <- 5 lines after the key line
# Verified against real generator output (not just this sketch) before
# wiring it in here. The second grep filters on the "command": KEY, not a
# bare "command" substring — "type": "command" would otherwise also match.
extract() {
  raw=$(grep -A5 "\"$1\"" "$GEMINI_CLI_SYSTEM_SETTINGS_PATH" | grep '"command":' | head -1 | sed 's/.*"command": "\(.*\)"/\1/')
  printf '%s' "$raw" | unescape
}

before=$(extract BeforeAgent)
notif=$(extract Notification)
after=$(extract AfterAgent)

(
  wait_for_go
  # The gaps BETWEEN the fixture's own events are self-ordered (no external
  # race) — they just have to be wide enough for the test's fast attribute
  # polling, which starts before the marker is even written, to observe each
  # intermediate status (working, then needs-you) before the next event
  # overwrites it. That polling begins immediately after the marker write,
  # so 1s per gap is ample.
  [ -n "$before" ] && eval "$before"
  sleep 1
  [ -n "$notif" ] && echo '{"type":"ToolPermission"}' | eval "$notif"
  sleep 1
  [ -n "$after" ] && eval "$after"
) &
sleep 600
