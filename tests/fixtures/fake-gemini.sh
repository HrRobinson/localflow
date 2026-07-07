#!/bin/sh
# Stands in for the gemini CLI in e2e. Reads the settings file localflow
# pointed at via GEMINI_CLI_SYSTEM_SETTINGS_PATH (see
# src/main/gemini-hooks.ts) and runs each hook's command, simulating
# BeforeAgent -> Notification(ToolPermission) -> AfterAgent shortly after
# start. Does NOT validate that a real `gemini` binary uses this settings
# shape or this notification field name/casing — see the manual
# verification checklist in
# docs/superpowers/plans/2026-07-07-m2-status-adapters.md.
echo "fake-gemini started in $PWD, settings: $GEMINI_CLI_SYSTEM_SETTINGS_PATH"

# Reverses JSON.stringify's one escaping pass (\\ -> \, \" -> ") on a value
# already stripped of its own wrapping quotes. Order matters: unescape \\
# to a placeholder FIRST so the following \" rule can't consume bytes a
# real \\ produced, then restore the placeholder to a literal \.
unescape() {
  sed 's/\\\\/@@BKSL@@/g; s/\\"/"/g; s/@@BKSL@@/\\/g'
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
  # Delays are generous (not "shortly after start") on purpose: the e2e test
  # must observe each intermediate status (working, then needs-you) before
  # the next transition happens, and process spawn happens well before the
  # test's pane is even visible/polling — too tight a delay here races the
  # app's own create/open UI flow and silently collapses straight to the
  # final idle state without ever having "shown" working/needs-you.
  sleep 2.5
  [ -n "$before" ] && eval "$before"
  sleep 2
  [ -n "$notif" ] && echo '{"type":"ToolPermission"}' | eval "$notif"
  sleep 2
  [ -n "$after" ] && eval "$after"
) &
sleep 600
