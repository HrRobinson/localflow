---
name: localflow
description: Drive a granted localflow environment's panes — list, navigate, screenshot, inspect, act, prompt terminals, and checkpoint workflows.
metadata:
  openclaw:
    requires:
      bins: [node]
      env: [LOCALFLOW_ENDPOINT, LOCALFLOW_TOKEN]
---

# localflow operator skill

localflow exposes a loopback control API for the ONE environment this grant
covers. Every command is scoped to that environment; foreign-environment handles
return 404. Auth is the per-grant bearer token in `LOCALFLOW_TOKEN`.

Run the wrapped CLI:

    node "$SKILL_DIR/bin/localflow-control.mjs" <verb> [args...]

Verbs: `panes`, `navigate <handle> <url>`, `screenshot <handle>`,
`cookies <handle>`, `network <handle>`, `act <handle> <selector> <click|type> [text]`,
`prompt <handle> <text...>`, `output <handle> [maxLines]`,
`checkpoint <watchpointId> [--halt]`,
`create-pane browser <url> [groupId]`, `create-pane terminal <agentId> <groupId>`.

`create-pane` adds a pane to THIS environment. A browser pane's `groupId` is
optional (omit it for a standalone pane); a terminal pane's `groupId` is
required — its cwd is derived from an existing member of that group, never
supplied by the caller. An unknown/foreign-environment `groupId` is rejected.

`screenshot` returns a `{path}` on the target project's disk — reference that
path in a following `prompt` to hand the image to a coding-agent terminal.

<!-- Wiring (v1, manual): set LOCALFLOW_ENDPOINT + LOCALFLOW_TOKEN from the grant
     as process env or under skills.entries.localflow.env in
     ~/.openclaw/openclaw.json. Auto-writing that block from a managed OpenClaw
     session is planned, not shipped in v1 — see README.md. -->
