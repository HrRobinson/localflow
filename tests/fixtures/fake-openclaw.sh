#!/bin/sh
# Stands in for the `openclaw` binary in e2e. Writes the operator credential it
# received via env to a marker file the test reads, then stays alive reading
# stdin (like fake-claude.sh) until the pty closes.
printf 'endpoint=%s\ntoken=%s\n' "$LOCALFLOW_ENDPOINT" "$LOCALFLOW_TOKEN" > "$PWD/openclaw-env-marker"
echo "fake-openclaw started"
while IFS= read -r _line; do
  echo "fake-openclaw got input"
done
