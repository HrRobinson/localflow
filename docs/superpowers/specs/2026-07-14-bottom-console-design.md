# Bottom console — a filterable activity drawer — design

Date: 2026-07-14. Status: approved design.
Supersedes the draft `2026-07-14-bottom-console-draft.md` (PR #65).

## Goal

An integrated, toggleable **bottom drawer** that unifies the app's existing
event streams — status events, operator actions, watchpoint captures — onto
one filterable, live timeline you watch while you keep working above it. It
answers "what just happened?" without navigating to a different view per
source. It adds no new capture plumbing; it is a lens over streams the app
already produces.

## Decisions (locked in brainstorm, 2026-07-14)

- **Complements** the M7 Activity view — both coexist. Activity stays the
  simple per-session lens; the console is the cross-source power lens. No
  rework of Activity or its e2e.
- **v1 sources: status events, operator actions, captures.** Network
  (browser-pane CDP) requests are **deferred to v2** — the `source` enum
  reserves the slot so adding it is purely additive.
- **In-memory, since-launch** — the timeline is a capped ring that resets on
  restart, matching M7's "since localflow started" model. No new persistent
  store. Capture rows open their already-on-disk detail on demand.
- **Scope follows location by default; an explicit chip pin sticks** until
  cleared back to auto.
- **Newest-at-bottom, auto-scroll** to latest unless the user has scrolled
  up (terminal-like, matching the xterm panes above).
- **Drag-resizable; remembers open/closed + height + last filter** across
  launches (config-as-code).

## Architecture — a main-process event bus that taps existing emit points

One new main-process unit: **`ConsoleEventBus`** (`src/main/console-bus.ts`),
an in-memory capped ring (cap ~500, "since launch") plus a subscribe/emit
interface. It does **not** replace any existing stream — it taps the emit
points the current producers already fire, so Activity and Cockpit keep
working unchanged (this is the "complement" decision made concrete):

| Console source   | Existing emit point tapped (verified)                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| status events    | `SessionManager.onActivity` (already wired to `activity:event`, index.ts:304)      |
| operator actions | the `pushActivity` / `operator:activity` stream (index.ts:212, 234)                |
| captures         | `CaptureStore.ingest` (capture-store.ts:34) — emit after a capture is stored       |

Each tap maps its native payload to a normalized event and calls
`bus.emit(event)`. The tap is **additive** at each site: the existing
`sendToWindow('activity:event', …)` / `operator:activity` / capture handling
stays; a `bus.emit(…)` line is added beside it. No producer's current
behavior changes.

### The normalized event

```ts
// src/shared/console.ts
export type ConsoleSource = 'status' | 'operator' | 'capture' // 'network' reserved for v2
export interface ConsoleEvent {
  id: string
  ts: number              // epoch ms, main-process clock
  source: ConsoleSource
  environment: number     // 1-9; every event belongs to an environment
  sessionId?: string      // present for status (and capture rows tied to a session); absent for env-scoped operator actions
  label: string           // one-line human summary rendered in the row
  detail: ConsoleDetail   // source-specific expandable payload (discriminated union)
}
```

`ConsoleDetail` is a discriminated union keyed by `source`: status →
`{ kind: ActivityEventKind; status: SessionStatus }`; operator →
`{ action: string; args?: string }`; capture → `{ watchpointId; captureId;
halted: boolean; screenshotPath?: string; output?: string[] }`. Capture
detail carries only references/handles — the on-disk screenshot is loaded by
the existing captures IPC when a row expands, not duplicated into the ring.

### IPC surface

- `console:list () → ConsoleEvent[]` — snapshot of the current ring, sent on
  drawer open.
- push `console:event (event: ConsoleEvent)` — one event as it's emitted.
- Reuses existing detail-loading IPC for expansion (e.g. `operator:captures`
  / capture screenshot path) — the console does not re-implement capture
  reads.

Main stays "dumb": it emits normalized events and answers the snapshot. All
filtering/scoping is renderer-side.

## Filtering — a pure renderer-side reducer

`src/shared/console-filter.ts`:

```ts
export interface ConsoleFilter {
  sources: Set<ConsoleSource>   // empty = all sources
  scope: ConsoleScope           // resolved, not the raw chip
  text: string                  // substring, case-insensitive, over label
}
export type ConsoleScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'environment'; environment: number }
  | { kind: 'everywhere' }

export function visibleEvents(events: ConsoleEvent[], f: ConsoleFilter): ConsoleEvent[]
```

- **source** chips OR-combine (empty set = all).
- **scope** single-select: `session` matches `sessionId`; `environment`
  matches `environment`; `everywhere` matches all.
- **text** narrows by case-insensitive substring on `label`.
- All three AND together. Pure function, no I/O, fully unit-testable.

### Scope resolution (follow-location + pin)

The drawer holds a `scopeMode: 'auto' | ConsoleScope`. In `auto`, the scope
is **derived from the current M5 focus**: enlarged into a pane/session →
`{ kind: 'session', sessionId }`; on an environment grid →
`{ kind: 'environment', environment }`; on home/overview →
`{ kind: 'everywhere' }`. Clicking a SCOPE chip sets `scopeMode` to that
explicit scope (pinned); a "follow" affordance clears it back to `auto`. The
derivation is a pure function of the existing App view/enlarged/environment
state — no new source of truth for "where am I."

## The drawer (UX)

`src/renderer/src/components/Console.tsx`, mounted at the bottom of the app
shell, outside the view switch so it overlays every view.

- **Toggle**: new remappable keybinding `console-toggle` (default `cmd+/`).
  `cmd+j` is already taken by `focus-down` in `DEFAULT_BINDINGS`; `cmd+/` is
  free and reserved for this.
- **Resize**: a drag handle on the top edge sets height; height + open/closed
  + last filter persist to config (config-as-code, same posture as theme /
  keybindings). Closed by default on first launch.
- **Layout**: a filter bar (SOURCE chips, SCOPE chips + follow toggle, text
  input) atop a reverse-chronological list, **newest at bottom**,
  auto-scrolls to the latest row unless the user has scrolled up (a
  scrolled-up state suppresses auto-scroll until they return to the bottom).
- **Rows**: one event each — timestamp, a source glyph/color, the `label`,
  and (when relevant) the environment/session it belongs to. A row **expands
  in place** to show its `detail` (status transition; operator action + args;
  capture output + screenshot preview loaded on demand). No navigation away.
- **Row actions (show-not-author, reflect-and-replay only)**:
  - capture rows: **re-run this watchpoint** (re-arm via existing operator
    watchpoint IPC) and **open source view** (jump to the cockpit capture).
  - status/operator rows: **open source view** (focus the session / open the
    cockpit). No request composition, no test authoring, no "copy as curl"
    (network is v2).
- Keyboard-navigable and clickable throughout (both audiences).

## Out of scope (v1)

- **Network-request source** (browser-pane CDP) — v2; enum slot reserved.
- **Persistence of the timeline** — in-memory, since-launch only.
- **Request composition / test authoring / schema-check building** — the
  show-not-author boundary; localflow is the cockpit, not the brain.
- **A query DSL / regex** — chips + substring text only.
- **Cross-environment analytics dashboards** — `everywhere` is a filter, not
  a separate surface.
- **Replacing the M7 Activity view** — explicitly kept as a complement.

## Testing

**Unit**

- `visibleEvents`: source OR-combine (incl. empty=all); scope session/env/
  everywhere matching; text case-insensitive substring; the three AND-ing.
- Scope derivation from App focus: enlarged→session, grid→environment,
  home→everywhere; pin overrides derivation; clear returns to auto.
- `ConsoleEventBus`: cap/ring eviction; emit fans out to subscribers; snapshot
  returns oldest→newest.
- Row-action guards: re-run-watchpoint only on capture rows; open-source
  mapping per source.

**e2e**

- Toggle drawer with `cmd+/` and with a remapped key.
- Drive a hook event → a **status** row appears; fire an operator action via
  the control API → an **operator** row appears; register + trigger a
  watchpoint → a **capture** row appears and expands to its output.
- Apply SOURCE + SCOPE + text filters and assert the visible set.
- Enlarge into a session → assert scope-follows-location narrowed the
  timeline; pin `everywhere` → assert it stays while navigating; clear → auto
  resumes.
- Resize the drawer and relaunch → height + open state remembered.

## Compatibility & rollout

- Purely additive: new bus + IPC + component + one keybinding + config keys.
  No existing stream, view, or persisted file schema changes.
- `console-toggle` default `cmd+/` must not collide with existing bindings;
  remappable like all others.
- Config additions (drawer height, open state, last filter) are optional with
  defaults — a config.json lacking them loads normally.
- v2 network source drops in behind the reserved enum value with its own tap
  (browser-pane CDP) and a `copy as curl` row action.
