# Bottom console — a filterable activity drawer (DRAFT proposal for review)

Date: 2026-07-14. Status: **DRAFT for review + brainstorm — not a spec, no
code implied.** This captures a discussed direction so the user can react to
it. Everything under "Open questions for the user" is deliberately left
undecided.

## Motivation

Running agent workflows, the thing you keep wanting is a live answer to
"what just happened?" — what data an agent fetched, which endpoint it hit,
whether a schema check passed, what a watchpoint captured. Today those
answers exist but are scattered: activity rings on sessions (M7), the
operator action log in the cockpit, watchpoint captures (env-scoped, with
screenshots/output), and browser-pane network requests. You navigate to a
different view for each, and none of them share a timeline or a filter.

The proposal: an integrated, **toggleable bottom drawer** — the shape VS
Code's terminal/output panel and Postman's expanded request/response logs
have trained everyone to expect — that **unifies these existing streams onto
one filterable timeline** while you keep working above it. It doesn't add a
new data source; it's a lens that composes the ones the app already produces.

## The drawer (UX)

- A drawer docked to the **bottom** of the app, toggled with **cmd+j**
  (default; remappable like every localflow binding). It shares the screen
  with the grid/enlarged view rather than replacing a view — you watch the
  timeline while the work stays visible.
- Closed by default; toggling restores the last state. When open it shows a
  reverse-chronological timeline of rows, newest at the bottom (or top — see
  open questions), each row a single event: a fetched request, a status
  transition, an operator action, a capture.
- Keyboard-first but clickable: the filter chips and rows are focusable and
  navigable from the keyboard, and also respond to the mouse — serving both
  localflow audiences (vibe coders + power users) per the standing design
  principle.
- A row expands in place to show its detail (payload/headers/output/capture
  preview) without leaving the drawer.

## Filter model — source × scope × text

Two facet dimensions plus free text, all combinable:

- **SOURCE** (facet chips, what kind of event):
  - **operator actions** — the cockpit action log (what an OpenClaw/Lobster
    operator did in a granted environment).
  - **status events** — session lifecycle + hook transitions (the same
    stream that drives status colors and the M7 activity ring).
  - **network requests** — requests observed in a browser pane.
  - **captures** — watchpoint captures (schema-check result, screenshot,
    terminal output, envelope).
- **SCOPE** (facet chips, how wide): **this environment** / **this session**
  / **everywhere**.
- **Free-text filter** — substring/keyword match across the visible rows
  (URL, action name, capture label). The user's framing: "a filter, where
  one can filter on actions."

Chips are toggles; multiple source chips OR together, scope is single-select,
text narrows further. The default scope is **scope-follows-location** (see
M5 synergy below).

## Show, don't author (the load-bearing boundary)

The console **SHOWS what agents did**; it does not become a request editor or
a test-authoring tool. That's the agent's / the Lobster workflow's job.
localflow is the cockpit + control surface, **not the brain** (locked project
principle). So:

- A network-request row shows what was fetched and returned. It is **not** a
  Postman-grade composer — you don't build a request here.
- A capture row shows a schema-check result a workflow produced. You don't
  author the schema check here.

The middle ground is **light, non-authoring row actions** — reflect-and-
replay, not compose:

- "re-run this watchpoint" (re-arm an existing watch),
- "copy as curl" (export what already happened),
- "open the source view" (jump to the cockpit capture / the pane / the
  session that produced the row).

Anything that would let you *compose* a new request or *define* a new test
belongs to the agent/workflow, not here.

## Data-source inventory (each maps to an existing subsystem)

The console invents no new capture path — it subscribes to what's already
produced:

| Console source    | Existing subsystem it reads from                         |
| ----------------- | -------------------------------------------------------- |
| status events     | M7 per-session in-memory event ring + hook status stream |
| operator actions  | Cockpit operator action log (control-API activity)       |
| captures          | Watchpoint captures (env-scoped; screenshots/output)     |
| network requests  | Browser-pane network requests (CDP, via the control API) |

This is the argument that it *fits*: the streams exist and today live in
separate views. The console is the unification layer, not new plumbing.
(Whether the underlying stores need to become queryable/persistent to back a
unified timeline is an open question, below.)

## M5 synergy — scope-follows-location

M5 (just shipped) gave sessions a layered staircase and a breadcrumb of where
you are: **env › session › pane**. That breadcrumb is exactly the console's
natural default scope: the drawer can **scope to wherever you're focused** —
enlarge into a session and the console narrows to that session; drop back to
the environment grid and it widens to the environment. The SCOPE chips let
you override the follow-behavior explicitly (pin to "everywhere", etc.). The
staircase and the console read from the same sense of "where am I," so they
stay in sync for free.

## Out of scope (v1)

- **Request composition / test authoring** — the show-not-author boundary;
  no request editor, no schema-check builder.
- **A general query language** — v1 is chips + substring text, not a
  DSL/regex console.
- **Export/reporting** beyond the per-row "copy as curl" convenience.
- **Cross-environment aggregation dashboards** — scope tops out at
  "everywhere" as a filter, not a separate analytics surface.
- **New capture types** — the console only surfaces streams the app already
  produces.
- Anything under the "Open questions" that the user resolves toward "later".

## Testing sketch

- **Unit** — filter reducer: source chips OR-combine; scope single-select
  narrows correctly; text filter substring match; scope-follows-location
  derivation from the M5 breadcrumb; row→source-view mapping. Row-action
  guards: "copy as curl" only on network rows, "re-run watchpoint" only on
  capture rows.
- **e2e** — toggle drawer with cmd+j (and a remapped key); drive a hook event
  → a status row appears; fire an operator action via the control API → an
  operator-action row appears; register + trigger a watchpoint → a capture
  row appears and expands; open a browser pane that makes a request → a
  network row appears; apply source + scope + text filters and assert the
  visible set; enlarge into a session and assert scope-follows-location
  narrowed the timeline.

## Open questions for the user

These are the genuine decisions a brainstorm should resolve. Listed, not
answered.

1. **Replace or complement the Activity view?** Does the console subsume the
   M7 Activity view (one becomes the other), or do both coexist (Activity as
   the per-session vibe-coder lens, console as the cross-source power lens)?
2. **Per-environment or global?** Is there one console scoped by the SCOPE
   chips, or a genuinely per-environment console instance? (Affects whether
   "everywhere" is even offered.)
3. **Persistence.** Does the timeline survive restart, or is it in-memory and
   fresh-per-launch like the M7 activity rings ("since localflow started")?
   Different sources may differ — captures are already on disk; status/network
   may be ephemeral. Do we accept a mixed-durability timeline?
4. **Resizable height + remembered state.** Is the drawer a fixed height or
   drag-resizable, and does it remember height + open/closed + last filter
   across launches (and per environment/session)?
5. **Network rows: live-only or historical?** Do network-request rows require
   an active browser pane (live CDP stream only), or do we retain and show
   historical requests after the pane closes? (Ties directly to persistence.)
6. **v1 minimum source if we cut scope.** If v1 ships one source first, which
   is the highest-value slice — status events (already ringed), operator
   actions, captures, or network requests? What's the smallest useful
   console?
7. **Row-order + newest position.** Newest-at-bottom (terminal-like) or
   newest-at-top (feed-like)? Auto-scroll/pin-to-latest behavior?
8. **Scope override vs. follow.** Should scope-follows-location be the sticky
   default, or should an explicit SCOPE-chip choice pin until cleared? What
   happens to a pinned scope when you navigate elsewhere?
