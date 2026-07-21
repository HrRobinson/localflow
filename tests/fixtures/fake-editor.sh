#!/bin/sh
# Stands in for the configured external editor in e2e (via
# SAIIFE_EDITOR_BIN). Appends each launch's argv to a marker file in the
# app's userData dir — the detached spawn inherits main's env, so
# SAIIFE_USER_DATA is set — then exits immediately. The open-in-editor
# e2e polls the marker to prove the spawn happened with the session's cwd.
echo "$@" >> "$SAIIFE_USER_DATA/editor-marker"
