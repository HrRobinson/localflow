---
name: saiife
description: Drive a granted saiife environment's panes — list, navigate, screenshot, inspect, act, prompt terminals, and checkpoint workflows.
metadata:
  openclaw:
    requires:
      bins: [node]
      env: [SAIIFE_ENDPOINT, SAIIFE_TOKEN]
---

# saiife operator skill

saiife exposes a loopback control API for the ONE environment this grant
covers. Every command is scoped to that environment; foreign-environment handles
return 404. Auth is the per-grant bearer token in `SAIIFE_TOKEN`.

Run the wrapped CLI:

    node "$SKILL_DIR/bin/saiife-control.mjs" <verb> [args...]

Verbs: `panes`, `navigate <handle> <url>`, `screenshot <handle>`,
`cookies <handle>`, `network <handle>`, `act <handle> <selector> <click|type> [text]`,
`prompt <handle> <text...>`, `output <handle> [maxLines]`,
`checkpoint <watchpointId> [--halt]`,
`create-pane browser <url> [groupId]`, `create-pane terminal <agentId> <groupId>`.

`create-pane` adds a pane to THIS environment. A browser pane's `groupId` is
optional (omit it for a standalone pane); a terminal pane's `groupId` is
required — its cwd is derived from an existing member of that group, never
supplied by the caller. An unknown/foreign-environment `groupId` is rejected.
Terminal `agentId` is limited to `claude`/`codex`/`gemini` — agent presets
that carry their own tool-permission gates — not raw `shell` (or `openclaw`,
a raw operator-agent preset); those are rejected with `invalid pane request`.

`screenshot` returns a `{path}` on the target project's disk — reference that
path in a following `prompt` to hand the image to a coding-agent terminal.

<!-- Wiring: when ~/.openclaw/openclaw.json exists, saiife auto-writes the
     grant's credentials into skills.entries.saiife.env on grant and removes
     exactly that entry on revoke (it never creates the file or touches other
     keys). Manual fallback: set SAIIFE_ENDPOINT + SAIIFE_TOKEN yourself,
     as process env or under that same block — see README.md. -->
