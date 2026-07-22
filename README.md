<img src="assets/logo.svg" width="88" alt="saiife logo" />

# saiife

saiife is mission control for your Claude Code sessions. It puts a grid of
real terminal panes — each one an actual `claude` CLI process — in a single
Electron window, so you can run several agents side by side and tell at a
glance which ones need you. Status colors make that glanceable: blue means a
session is working, yellow means it's waiting on you, green means it
finished, and gray means the process has exited.

**Full documentation: [saiife.com/docs](https://saiife.com/docs)** — the
command guard and all 11 rule packs, flows, the 20 connectors, and the
keybinding, `config.json` and userData reference. None of that is covered
below. (The docs site ships from the `saiife.com` repo; the link resolves
once that deploy lands.)

## How it works

- Each pane is a real `claude` CLI process running in a PTY — no wrapping,
  no scripting of the terminal, just a normal session you can type into.
- Status comes from Claude Code's own hooks (`UserPromptSubmit`,
  `Notification`, `Stop`) POSTing events to a listener that saiife starts
  on a random local port, guarded by a secret token and bound to
  `127.0.0.1` only.
- No telemetry. Nothing leaves your machine.

### Status adapters

Codex and Gemini CLI sessions get real status colors too, not just the
permanent "running" fallback — each agent's own hook/notification system is
adapted onto the same three-state model, per-agent fidelity tier:

| Agent       | Mechanism                                     | Fidelity                                                                                                                        |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `--settings` file                             | Full: working / needs-you / idle                                                                                                |
| Gemini CLI  | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` env + hooks | Full: working / needs-you / idle                                                                                                |
| Codex       | inline `-c` CLI overrides (legacy `notify`)   | Conservative: turn-complete only — idle is accurate as of the last turn-complete, working/needs-you are not (yet) distinguished |
| Custom      | none                                          | Permanent "running" (unchanged)                                                                                                 |

Codex ships on the deliberately conservative tier pending manual
verification of its `-c` hook-injection grammar against a real install;
Gemini ships full three-state fidelity pending the same kind of
verification for its notification payload shape. See the
[design spec](docs/superpowers/specs/2026-07-07-m2-status-adapters-design.md)
for the full rationale and fallback tiers.

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
cd saiife
npm install
npm run dev
```

Requires Node ≥ 20 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
installed.

## Usage

Click **New session** and pick a folder — saiife starts `claude` there
and adds a pane to the grid. Double-click a pane's header to enlarge it;
press `cmd+escape` to shrink it back (bare Escape always goes to the agent).
If a session has exited, its pane offers **Resume conversation** (relaunching
with `claude --continue`, so you don't lose context) or **Start fresh**.

When a session turns yellow (needs you), you can answer it without entering
the terminal: an **approve** control appears on the pane header and on the
session's Overview row. It always shows a peek of the agent's last output
lines first — approving sends a single Enter to the session, accepting
whatever prompt the agent is showing. `cmd+u` jumps straight to the next
waiting pane (press again to cycle).

Sessions live on **environments 1–9** — one per customer or project
(always there, no setup). `cmd+1…9` switches, `ctrl+1…9` moves the active
pane, and the sidebar lists non-empty environments with a worst-status dot
— "environment 3 needs you" at a glance. Environment assignments persist in
`sessions.json`; optional names live in `config.json` as
`"environments": { "3": "backend" }`. The Overview always shows every
session across all environments.

## Browser panes

An environment isn't only terminals: pick **Browser…** in the New session
launcher and give it a URL (scheme optional — `localhost:5173` works) to put
a web page in the grid — the localhost preview of what your agent is
building, docs, a PR. Browser panes get a URL bar, back/forward/reload, and
an open-in-system-browser button; they're violet while open (no status
feed), persist across restarts at the URL you left them on, and close/reopen
like any session. Embedded pages are sandboxed hard: permission prompts are
auto-denied, navigation is confined to http(s), and popups open in your
system browser. Keyboard combos (`cmd+1…9`, `cmd+u`, …) keep working while a
page has focus.

The Overview page is intentionally minimal: your latest sessions plus a
single "New session" control. Agent detection, configured paths, and
keybindings/themes live on the **Settings** page, reachable from the
sidebar. saiife remembers the last agent you launched and preselects it
the next time you open Overview.

Sessions are durable: once created, they stay listed (named, with their
working directory) until you explicitly delete them. Closing a terminal —
the pane's **close** button, or `cmd+w` — only ends that pty; the session
itself stays in Overview and the sidebar as **exited**, ready to be resumed
(continuing the conversation) or restarted fresh. Deleting a session is a
separate, deliberate action: the row's **×** arms a **Delete**/**Cancel**
pair rather than deleting immediately, so a stray click can't lose a
session. Session names default to the project folder's name and can be
renamed inline — double-click the name, or use the pencil icon that
appears on hover — in both Overview and the sidebar; press Enter to save
or Escape to cancel.

## Grouped sessions

Panes don't have to stand alone: a **session** in the grid is a group of
panes (one or more) that share a header and a worst-status rollup dot —
useful for pairing a terminal with the browser pane previewing its work, or
running two agents against the same checkout side by side. The naming is
deliberate: a **session** holds **panes**.

- **Form one** — press `cmd+t` on the active pane, or click a session's `+`
  in its header, and pick an agent or a browser URL from the picker. A solo
  pane wraps itself into a fresh session named after it the first time you
  add a companion; picking from an already-grouped pane's `+` just adds
  another pane alongside it.
- **Move a pane between sessions** — `cmd+g` opens a picker of the other
  sessions on the same environment (plus "New session…"); `cmd+shift+g`
  pulls the active pane back out on its own.
- **Closing** a pane in a session moves focus to its nearest sibling first,
  falling back to the nearest pane overall only once the session is empty.
- **Enlarge** (`cmd+m`) cycles through a staircase instead of a flat
  toggle when the active pane is grouped: grid → that one pane full-size →
  the whole session, every member staircased side by side → back to grid.
  A solo pane's enlarge has just the one step, same as always. `cmd+escape`
  walks back down one level at a time (session → pane → grid) instead of
  jumping straight to Overview.
- **Templates** — `config.json`'s `sessionTemplates` key defines named
  presets that launch a whole session in one shot from the New session
  picker:

  ```json
  {
    "sessionTemplates": [
      {
        "name": "pair review",
        "panes": [
          { "kind": "terminal", "agentId": "claude" },
          { "kind": "browser", "url": "localhost:5173" }
        ]
      }
    ]
  }
  ```

  Each pane is `{ "kind": "terminal", "agentId": "claude" | "codex" |
"gemini" | "openclaw" | "shell" }` (agentId defaults to `claude`) or
  `{ "kind": "browser", "url": "..." }`. A template pane whose agent binary
  isn't found is skipped rather than failing the whole template; if every
  pane turns out unlaunchable, nothing is created.

## Changes / diff review

Every session can show what its agent changed — pick **Changes** in the sidebar
(or the "changes" action on an overview row) to review one session's repo,
read-only. The left column is the `git status` file list with **staged**,
**unstaged**, and **untracked** badges; the right pane shows the selected file's
diff (staged and worktree changes merged; new files as full additions), tinted
at the diff level — additions green, deletions red, hunks blue. `j`/`k` walk the
file list. It never writes to your repo. When you want to actually stage or
commit, two escape hatches take you to real tools: **Open lazygit here** opens
lazygit as a terminal pane in that folder, and **Open in editor** opens the
folder in your editor (`config.json`'s `editorCommand`, default `code`). Both
disable themselves with a hint when the tool isn't on your PATH. A session whose
folder isn't a git repository just shows a plain "not a git repository" note.

## Editors

Two ways to pair an editor with your agents:

- **Open in editor** — every terminal pane's header has an **editor** button
  (also `cmd+e` for the focused pane, and the Changes view's button) that opens
  the session's folder in your editor as an external app. The command comes
  from `config.json`'s `editorCommand` (default `code`) with the folder
  appended, so `"editorCommand": "subl -n"` runs `subl -n <folder>`. The button
  disables itself with a hint when the binary isn't on your PATH.
- **An editor pane beside your agent** — terminal editors are already
  first-class panes: create a session with the **Custom** command set to
  `nvim`, `hx`, or `emacs -nw` in the same folder as your agent, and you get an
  editor living in the grid next to it — focusable, swappable, and enlargeable
  like any other pane.

## Settings

Open **Settings** from the sidebar.

- **Keybindings** — click any shortcut and press a new combination; it applies
  instantly (no restart) and round-trips with `keybindings.json`. Conflicts are
  shown, not silently accepted; Escape cancels a capture; "reset" restores one
  binding and "Reset all" restores every default. Hand edits to the file win on
  the next launch.
- **Agents** — set the **default agent** for the New session launcher, and give
  any agent **extra CLI args** and **env overrides** (`KEY=VALUE` per line).
  Env overrides are the local-LLM enabler: point an agent at Ollama or a
  compatible base URL without saiife storing any credentials. Overrides live
  under `config.json`'s `agents` key.
- **Themes** — app and terminal colors are JSON token files in
  `userData/themes/<name>.json`; pick one in Settings, or click **Open themes
  folder** to add your own. Changes apply live. A malformed theme falls back to
  the built-in dark default with a visible notice. Shipped presets: dark
  (default), light, solarized-dark, nord.

saiife never stores provider secrets — every supported agent authenticates
in its own service.

## Activity & Overview stats

Every session has an **Activity** view (sidebar nav): a plain-language feed of
what happened — "you sent a prompt", "waiting for your approval · 12m ago",
"turn finished", "process exited", "session reopened" — over the same hook
events that drive the status colors. A persistent header line ("⏳ waiting for
your approval for 12m") keeps it glanceable, and the terminal is one click away
via **open terminal**. Browser panes list lifecycle events only (they have no
status feed). The feed is in-memory and honest about it: it starts fresh each
launch ("since saiife started"), keeping the last 200 events per session.

The **Overview** carries a compact stats strip above Latest sessions — counts
by status ("2 working · 1 needs you · 3 done · 1 off") and the oldest unattended
session as "waiting 12m". Clicking that chip jumps to attention exactly like
`cmd+u`. Numbers only — no charts.

## Keyboard

The Environment view is fully keyboard-drivable: exactly one pane is always
**active** (shown with a cyan focus ring), and the bindings below move focus,
swap panes, and enlarge/shrink — all geometric (nearest pane center in the
given direction), so they work regardless of grid layout.

| Action                   | Default                                                       | Notes                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus left/down/up/right | `cmd+h` / `cmd+j` / `cmd+k` / `cmd+l`                         | moves the active pane to the nearest neighbor in that direction                                                                                                 |
| Swap left/down/up/right  | `cmd+shift+h` / `cmd+shift+j` / `cmd+shift+k` / `cmd+shift+l` | swaps the active pane's position with its neighbor, active pane unchanged                                                                                       |
| Enlarge/shrink           | `cmd+m`                                                       | cycles grid → pane → session (only when the active pane is grouped) → grid; a solo pane just toggles full-size                                                  |
| Close pane               | `cmd+w`                                                       | closes and removes the session — the agent's own conversation history survives in the project folder (e.g. `claude --continue` there starts where you left off) |
| Add pane                 | `cmd+t`                                                       | opens the picker to add a companion pane next to the active one, grouping them into a session (see [Grouped sessions](#grouped-sessions))                       |
| Group pane               | `cmd+g`                                                       | moves the active pane into another session (or a new one) via a picker                                                                                          |
| Ungroup pane             | `cmd+shift+g`                                                 | pulls the active pane out of its session, back to solo                                                                                                          |
| Open in editor           | `cmd+e`                                                       | opens the active pane's folder in your configured editor (`config.json`'s `editorCommand`, default `code`) as an external app                                   |
| New session              | `cmd+enter`                                                   | jumps to Overview                                                                                                                                               |
| Toggle sidebar           | `cmd+b`                                                       | hides/shows the sidebar (fullscreen-style focus mode)                                                                                                           |
| Go up                    | `cmd+escape`                                                  | walks the enlarge staircase back down one level at a time (session → pane → grid), then goes to Overview                                                        |
| Jump to attention        | `cmd+u`                                                       | focuses + enlarges the next pane that needs you; press again to cycle through all waiting panes                                                                 |
| Switch environment       | `cmd+1` … `cmd+9`                                             | shows that environment's grid (environments 1–9 always exist)                                                                                                   |
| Move pane to environment | `ctrl+1` … `ctrl+9`                                           | sends the active pane to that environment; focus stays behind                                                                                                   |

Bare `Escape`, `Enter`, arrow keys, and every unmodified keystroke always
reach the active terminal untouched — saiife only intercepts the exact
modified combos above, so the agent inside a pane never loses a keypress.

### Remapping

Bindings are stored in `keybindings.json` in saiife's userData directory,
created with the defaults above on first run:

- macOS: `~/Library/Application Support/saiife/keybindings.json`

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
  "add-pane": "cmd+t",
  "group-pane": "cmd+g",
  "ungroup-pane": "cmd+shift+g",
  "open-editor": "cmd+e",
  "new-session": "cmd+enter",
  "go-up": "cmd+escape",
  "toggle-sidebar": "cmd+b",
  "focus-needs-you": "cmd+u",
  "environment-1": "cmd+1",
  "environment-2": "cmd+2",
  "environment-3": "cmd+3",
  "environment-4": "cmd+4",
  "environment-5": "cmd+5",
  "environment-6": "cmd+6",
  "environment-7": "cmd+7",
  "environment-8": "cmd+8",
  "environment-9": "cmd+9",
  "move-to-environment-1": "ctrl+1",
  "move-to-environment-2": "ctrl+2",
  "move-to-environment-3": "ctrl+3",
  "move-to-environment-4": "ctrl+4",
  "move-to-environment-5": "ctrl+5",
  "move-to-environment-6": "ctrl+6",
  "move-to-environment-7": "ctrl+7",
  "move-to-environment-8": "ctrl+8",
  "move-to-environment-9": "ctrl+9"
}
```

The default `ctrl+1…9` move bindings intercept those combos before the
terminal sees them (ctrl+3 would otherwise send ESC) — remap them in
`keybindings.json` if an agent you use relies on ctrl+digit control
characters.

A binding is `[cmd+][ctrl+][alt+][shift+]<key>`, where `<key>` is a single
character or one of `enter`, `escape`, `tab`, `space`, `arrow-left`,
`arrow-right`, `arrow-up`, `arrow-down`. Unknown actions and malformed
bindings in the file are ignored (that action keeps its default), so a typo
never breaks the app. **Restart saiife after editing the file** for
changes to take effect — there's no live reload yet.

## Development

```bash
npm run dev      # run the app
npm run check    # lint + typecheck + unit tests
npm run e2e      # end-to-end tests, using fake claude/codex/gemini fixtures (no API access needed)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions, PR
expectations, and dev setup.

## License

MIT — see [LICENSE](LICENSE).
