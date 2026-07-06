#!/bin/sh
# Stands in for the claude CLI in dev/e2e. Prints its args and stays alive.
echo "fake-claude started in $PWD with args: $@"
sleep 600
