# localflow

localflow is mission control for your Claude Code sessions. It puts a grid of
real terminal panes — each one an actual `claude` CLI process — in a single
Electron window, so you can run several agents side by side and tell at a
glance which ones need you. Status colors make that glanceable: blue means a
session is working, yellow means it's waiting on you, green means it
finished, and gray means the process has exited.

## How it works

- Each pane is a real `claude` CLI process running in a PTY — no wrapping,
  no scripting of the terminal, just a normal session you can type into.
- Status comes from Claude Code's own hooks (`UserPromptSubmit`,
  `Notification`, `Stop`) POSTing events to a listener that localflow starts
  on a random local port, guarded by a secret token and bound to
  `127.0.0.1` only.
- No telemetry. Nothing leaves your machine.

## Install

Download the `.dmg` from [Releases](https://github.com/HrRobinson/localflow/releases).
Builds are currently unsigned, so on first launch you'll need to
right-click the app and choose **Open** instead of double-clicking it.

Or build from source:

```bash
git clone https://github.com/HrRobinson/localflow.git
cd localflow
npm install
npm run dev
```

Requires Node ≥ 20 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
installed.

## Usage

Click **+ New session** and pick a folder — localflow starts `claude` there
and adds a pane to the grid. Double-click a pane's header to enlarge it;
press Escape to shrink it back. If a session has exited, its **Restart**
button resumes it with `claude --continue`, so you don't lose context.

## Development

```bash
npm run dev      # run the app
npm run check    # lint + typecheck + unit tests
npm run e2e      # end-to-end tests, using a fake claude fixture (no API access needed)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions, PR
expectations, and dev setup.

## License

MIT — see [LICENSE](LICENSE).
