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

<!-- Wiring: when ~/.openclaw/openclaw.json exists, localflow auto-writes the
     grant's credentials into skills.entries.localflow.env on grant and removes
     exactly that entry on revoke (it never creates the file or touches other
     keys). Manual fallback: set LOCALFLOW_ENDPOINT + LOCALFLOW_TOKEN yourself,
     as process env or under that same block — see README.md. -->
