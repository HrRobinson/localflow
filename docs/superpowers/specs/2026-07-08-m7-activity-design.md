# M7 — Activity view + Overview stats (design)

Scope decided with Jonas 2026-07-08: a **plain-language activity feed page
per session** (the vibe-coder lens over the same hook events that drive
status colors), plus the **Overview stats strip** folded into this
milestone (same data source, same glanceability spirit). Sparklines and
flow visualization are deferred.

## Event log (main, new plumbing)

- Main keeps a per-session **in-memory ring of the last 200 events**:
  every hook event it applies (`UserPromptSubmit`, `Notification`, `Stop`),
  plus lifecycle moments it already knows (created, reopened/restarted,
  closed, exited, moved environment), each with a timestamp and the status
  it produced.
- **Not persisted in v1** — the feed starts fresh each launch, and the UI
  says so ("since localflow started"). Honest over clever; persistence is
  a follow-up if the feed proves valuable.
- Main also records `needsYouSince` per session (set on entering
  `needs-you`, cleared on leaving) — the stats strip's "oldest unattended"
  needs it and the sidebar/future features get it for free.
- IPC: `activity:get(sessionId)` returns the ring; push channel
  `activity:event` streams new entries while the view is open (mirrors the
  onStatus listener pattern).

## The feed page

- A new **Activity** view (App view union + sidebar nav item), session
  switcher inside — same navigation shape as M6's Changes view.
- Events render as plain language with relative timestamps: "you sent a
  prompt · 2m ago", "waiting for your approval · 12m ago", "turn finished",
  "process exited", "session reopened". Mapping lives in one renderer
  module so copy is reviewable and translatable in one place.
- The current pending state gets a persistent header line (e.g. "⏳ waiting
  for your approval for 12m") so the page is glanceable without reading
  history. Terminal stays one click away — an "open terminal" button per
  the roadmap's "this is a lens, not a replacement".
- Browser panes (kind `browser`) have no hook feed: they list lifecycle
  events only, and the page says so.

## Overview stats strip

- A single compact row on the Overview above "Latest sessions": counts by
  status ("2 working · 1 needs you · 3 done · 1 off"), the oldest
  unattended needs-you as "waiting 12m" (from `needsYouSince`), and
  nothing else. Numbers, not charts, per the roadmap's guard.
- Clicking the needs-you fragment behaves like `cmd+u` (jump to attention)
  — glanceable AND actionable.

## Out of scope

Sparklines, flow visualization, per-turn analytics (turns per session,
time-to-attention averages), event persistence across restarts, exporting.

## Testing

Unit: event→copy mapping, ring capping, `needsYouSince` set/clear
transitions, stats derivation (counts + oldest-wait). e2e: drive hook
events at a session (existing endpoint fixture), open Activity → the
expected plain-language lines appear in order; Overview shows the counts
and a "waiting" fragment; clicking it lands on the needs-you pane.
