#!/bin/sh
# Stands in for the claude CLI in dev/e2e. Prints its args, then echoes a
# marker for each line read from stdin AND appends to an approve-marker
# file in $PWD — the approve e2e asserts the file (works even when no
# terminal pane is mounted to render the pty's echo) and/or the terminal
# text. Exits when the pty closes (read fails), replacing the old sleep.
echo "fake-claude started in $PWD with args: $@"
while IFS= read -r _line; do
  echo "fake-claude got input"
  echo got-input >> "$PWD/approve-marker"
done
