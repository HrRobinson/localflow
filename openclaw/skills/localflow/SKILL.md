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
`checkpoint <watchpointId> [--halt]`.

`screenshot` returns a `{path}` on the target project's disk — reference that
path in a following `prompt` to hand the image to a coding-agent terminal.

<!-- Wiring: localflow injects LOCALFLOW_ENDPOINT + LOCALFLOW_TOKEN via
     skills.entries.localflow.env in ~/.openclaw/openclaw.json, auto-written when
     it launches a managed OpenClaw session (and shown to the user). -->
