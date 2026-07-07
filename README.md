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
The prebuilt macOS artifacts are Apple Silicon (arm64) only for now; Intel
Macs should build from source below. Linux users can grab the `.AppImage`
or `.deb` from the same [Releases](https://github.com/HrRobinson/localflow/releases) page.

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
press `cmd+escape` to shrink it back (bare Escape always goes to the agent).
If a session has exited, its **Restart** button resumes it with
`claude --continue`, so you don't lose context.

## Keyboard

The Terminals view is fully keyboard-drivable: exactly one pane is always
**active** (shown with a cyan focus ring), and the bindings below move focus,
swap panes, and enlarge/shrink — all geometric (nearest pane center in the
given direction), so they work regardless of grid layout.

| Action                   | Default                                                       | Notes                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus left/down/up/right | `cmd+h` / `cmd+j` / `cmd+k` / `cmd+l`                         | moves the active pane to the nearest neighbor in that direction                                                                                                 |
| Swap left/down/up/right  | `cmd+shift+h` / `cmd+shift+j` / `cmd+shift+k` / `cmd+shift+l` | swaps the active pane's position with its neighbor, active pane unchanged                                                                                       |
| Enlarge/shrink           | `cmd+m`                                                       | toggles the active pane full-size                                                                                                                               |
| Close pane               | `cmd+w`                                                       | closes and removes the session — the agent's own conversation history survives in the project folder (e.g. `claude --continue` there starts where you left off) |
| New session              | `cmd+enter`                                                   | jumps to Overview                                                                                                                                               |
| Toggle sidebar           | `cmd+b`                                                       | hides/shows the sidebar (fullscreen-style focus mode)                                                                                                           |
| Go up                    | `cmd+escape`                                                  | shrinks an enlarged pane, else goes to Overview                                                                                                                 |

Bare `Escape`, `Enter`, arrow keys, and every unmodified keystroke always
reach the active terminal untouched — localflow only intercepts the exact
modified combos above, so the agent inside a pane never loses a keypress.

### Remapping

Bindings are stored in `keybindings.json` in localflow's userData directory,
created with the defaults above on first run:

- macOS: `~/Library/Application Support/localflow/keybindings.json`

The file is a flat JSON object mapping action name to binding string:

```json
{
  "focus-left": "cmd+h",
  "focus-down": "cmd+j",
  "focus-up": "cmd+k",
  "focus-right": "cmd+l",
  "swap-left": "cmd+shift+h",
  "swap-down": "cmd+shift+j",
  "swap-up": "cmd+shift+k",
  "swap-right": "cmd+shift+l",
  "enlarge-toggle": "cmd+m",
  "close-pane": "cmd+w",
  "new-session": "cmd+enter",
  "go-up": "cmd+escape",
  "toggle-sidebar": "cmd+b"
}
```

A binding is `[cmd+][ctrl+][alt+][shift+]<key>`, where `<key>` is a single
character or one of `enter`, `escape`, `tab`, `space`, `arrow-left`,
`arrow-right`, `arrow-up`, `arrow-down`. Unknown actions and malformed
bindings in the file are ignored (that action keeps its default), so a typo
never breaks the app. **Restart localflow after editing the file** for
changes to take effect — there's no live reload yet.

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
