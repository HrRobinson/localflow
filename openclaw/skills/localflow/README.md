# localflow OpenClaw skill

Lets an OpenClaw agent drive the ONE localflow environment it has been
granted: list panes, create a browser or terminal pane, navigate/
screenshot/inspect a browser pane, act on it, prompt a terminal pane, read
its output, and record a watchpoint checkpoint.

## Files

- `SKILL.md` — the OpenClaw skill manifest. Frontmatter follows the documented
  shape: `name`, `description`, and `metadata.openclaw.requires` (`bins`,
  `env`) — see docs.openclaw.ai.
- `bin/localflow-control.mjs` — the CLI wrapper. Maps a verb to one control-API
  HTTP request and prints the JSON response to stdout.

## Wiring it up

1. In localflow, grant operator access to an environment. This mints an
   endpoint (`LOCALFLOW_ENDPOINT`, the loopback control-API base URL) and a
   bearer token (`LOCALFLOW_TOKEN`) scoped to that one environment.
2. Make both available to the OpenClaw agent process (v1 is manual): copy the
   endpoint and token from the grant and set `LOCALFLOW_ENDPOINT` /
   `LOCALFLOW_TOKEN` yourself, either as process env or under
   `skills.entries.localflow.env` in `~/.openclaw/openclaw.json` (the config
   block documented for per-skill env at docs.openclaw.ai).

   > Planned (not in v1): when localflow launches a managed OpenClaw session it
   > will auto-write that `skills.entries.localflow.env` block for you and show
   > exactly what it wrote. Until then, use the manual step above.

3. The skill declares both env vars as required in `SKILL.md`'s
   `metadata.openclaw.requires.env`, and `node` in `requires.bins`.

Revoking the grant in localflow invalidates the token immediately — the CLI
will start getting 403s from every route.

## Using the CLI directly

    node bin/localflow-control.mjs <verb> [args...]

See `SKILL.md` for the full verb list. Every response is the control API's
JSON body, printed to stdout; a non-2xx response also sets a non-zero exit
code.

## Checkpoints in Lobster workflows

There is no separate checkpoint-authoring API. A checkpoint is just a
`command` step in the user's Lobster workflow YAML that calls this CLI's
`checkpoint` verb directly, e.g.:

```yaml
- command: node "$SKILL_DIR/bin/localflow-control.mjs" checkpoint wp1 --halt
```

`--halt` marks the capture as halted; omit it for a non-halting checkpoint.
The `watchpointId` (`wp1` above) must already exist — it comes from
localflow's watchpoint registration, not from this skill.
