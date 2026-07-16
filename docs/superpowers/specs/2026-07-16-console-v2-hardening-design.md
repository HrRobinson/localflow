# Console v2 hardening — per-source renderer caps + shared cap table — design

Date: 2026-07-16. Status: **Approved 2026-07-16.**

Builds on `docs/superpowers/specs/2026-07-15-console-v2-design.md` (Console v2:
the `network` source, per-source main-bus ring caps, `emitBatch`, inline
previews). This spec is a **post-ship hardening pass** on that work, scoped
from `.../scratchpad/scope-console-v2.md` (read-only scoping report, main
@045715b). It closes exactly two correctness bugs the scoping report
confirmed and one DRY smell that caused them:

1. **M1 — renderer event starvation.** The renderer's live-append buffer is a
   single flat FIFO (`RENDERER_EVENT_CAP = 3000`) with no awareness of
   `source`, even though the main-process bus solved this exact problem with
   per-source ring caps back in the v2 design. A sustained `network` burst
   evicts `guard`/`status`/`operator` rows from the renderer's view — rows
   that are still safely retained in the main bus.
2. **Snapshot-cap-bypass.** The initial drawer-open snapshot
   (`listConsole()` → `consoleBus.snapshot()`) is written directly into
   renderer state, bypassing `appendConsoleEvents` entirely. Main-side caps
   sum to 3600 (500+500+300+300+2000), already above the renderer's own 3000
   cap — so `events.length` can be up to 3600 immediately after opening the
   drawer, silently violating the renderer's own invariant.
3. **DRY: two unsynced cap tables.** `DEFAULT_CAPS` (main,
   `console-bus.ts`) and `RENDERER_EVENT_CAP` (renderer, `console-filter.ts`)
   are independently maintained numbers with no shared constant and no
   assertion relating them. Bug (2) is a direct, undetected consequence of
   this — nobody had to notice `sum(main caps) > renderer cap` when either
   number was last touched, because there was nothing forcing them to look at
   the other one.

**Explicitly out of scope for this spec** (do not build from this doc):

- **First-load network CDP-timing gap** (scope report §2) — the highest-risk
  item in the track, touching `<webview>`/CDP debugger lifecycle timing in an
  area with a documented flakiness history (`#42`, two `console-drawer e2e`
  hardening commits). Tracked as a **separate follow-up spec**; nothing here
  changes `browser-control.ts`'s debugger-attach timing.
- `console-bus.snapshot()`'s full-sort-vs-merge micro-optimization (scope
  report task 5) — see the resolved decision below; deferred.
- Guard scope/attribution edge cases (untagged audit records, environment
  fallback-to-1) — scope report §3, pre-existing, orthogonal to the cap bugs.
- Text-filter debounce — scope report §3, low-priority polish, no evidence
  it's currently a problem.
- Guard dual-emission code comment — trivial, can land as a driveby in any
  touching PR, doesn't need a spec.

---

## Background: what exists today

- `src/main/console-bus.ts` — `ConsoleEventBus.rings: Map<ConsoleSource,
  ConsoleEvent[]>`, one ring per source, each trimmed to its own cap on
  `append()`. `DEFAULT_CAPS` (module-private): `status` 500, `operator` 500,
  `capture` 300, `guard` 300, `network` 2000. `snapshot()` merges every ring
  and full-sorts by `seq`.
- `src/shared/console.ts` — `ConsoleSource` union (`status | operator |
  capture | guard | network`), `ConsoleEvent`/`ConsoleEventInput`,
  `ConsolePrefs`/`DEFAULT_CONSOLE_PREFS`, the `to*Event` mappers. Already the
  shared home for cross-process console types and constants — both
  `console-bus.ts` and `console-filter.ts`/`Console.tsx` import from it today.
- `src/shared/console-filter.ts` — pure filter reducer (`visibleEvents`,
  `deriveConsoleScope`) plus `RENDERER_EVENT_CAP = 3000` and
  `appendConsoleEvents(prev, incoming, cap)`, a **flat** slice-by-position
  FIFO with no source awareness. This is the M1 bug.
- `src/renderer/src/components/Console.tsx` — one `useEffect` on `open`:
  fetches `listConsole()` once (→ raw `consoleBus.snapshot()`, sets it
  directly via `setEvents(snap)`, bypassing the cap) and subscribes to live
  batches via `onConsoleEvent`, appending through `appendConsoleEvents`. State
  shape is `events: ConsoleEvent[]`, rendered through `visibleEvents(events,
  filter)` in array order (relies on insertion order == `seq` order).
- `tests/unit/console-bus.test.ts` / `tests/unit/console-filter.test.ts` —
  existing unit coverage for both modules; both are pure/DI-friendly
  (`ConsoleEventBus` takes cap overrides + an injectable clock;
  `console-filter.ts` is all pure functions), which is why the v2 design doc
  called this area "low-conceptual-risk" to extend.

---

## Proposed architecture

### H1 — one shared per-source cap table, in `src/shared/console.ts`

> **RESOLVED — where does the shared cap table live?**
> **Decision: `src/shared/console.ts`**, as a new exported constant
> `CONSOLE_SOURCE_CAPS: Record<ConsoleSource, number>`, placed next to
> `ConsoleSource` and `DEFAULT_CONSOLE_PREFS`.
> Rejected alternative: a new file `src/shared/console-caps.ts` (raised as an
> option in the scoping report). Rejected because `console.ts` is already the
> established shared home for cross-process console constants
> (`DEFAULT_CONSOLE_PREFS` lives there today) — a second shared-constants file
> for one more table adds an import path to remember without buying
> isolation; `console.ts` has no dependency-graph reason to avoid holding it
> (it's leaf-level: types + pure mapper functions, no bus/renderer imports).

```ts
// src/shared/console.ts
export const CONSOLE_SOURCE_CAPS: Record<ConsoleSource, number> = {
  status: 500,
  operator: 500,
  capture: 300,
  guard: 300,
  network: 2000
}
```

`console-bus.ts` drops its private `DEFAULT_CAPS` and imports this instead:

```ts
// src/main/console-bus.ts
import { CONSOLE_SOURCE_CAPS } from '../shared/console'
// ...
this.caps = { ...CONSOLE_SOURCE_CAPS, ...caps }
```

No behavior change on the main side — same five numbers, same override
mechanism (`new ConsoleEventBus({ network: 2 })` in tests keeps working
unchanged).

> **RESOLVED — what values does the renderer use?**
> **Decision: mirror `CONSOLE_SOURCE_CAPS` exactly (sum = 3600), not a
> smaller renderer-tuned set.**
> The alternative (scope report's option) is a second, smaller cap table for
> the renderer on the theory that the UI only needs "recently visible" depth
> since reopening the drawer re-pulls a fresh snapshot anyway. Rejected:
> that reintroduces exactly the two-tables-to-keep-in-sync problem this spec
> exists to close, for a memory saving the v2 design doc already measured as
> "low single-digit MB worst case" at the full 3600-row depth. There is no
> stated product requirement for a shorter renderer window, and a second
> table is one more place for the next per-source cap change to be applied
> in only one of the two places — the same failure mode as bug (2). One
> table, two consumers, is the simplest thing that removes the DRY hazard.

### H2 — renderer live buffer becomes per-source, merged only at render/derive time

Replace the renderer's flat `ConsoleEvent[]` live buffer with a per-source
structure, capped independently per source on every append — the same shape
the bus already uses one process over, just expressed as a plain `Record`
(not a `Map`) for easier React-state equality/debugging and because
`ConsoleSource` is a small closed union (no need for `Map`'s dynamic-key
ergonomics).

```ts
// src/shared/console-filter.ts
import { CONSOLE_SOURCE_CAPS, type ConsoleEvent, type ConsoleSource } from './console'

export type ConsoleRings = Record<ConsoleSource, ConsoleEvent[]>

export function emptyConsoleRings(): ConsoleRings {
  return { status: [], operator: [], capture: [], guard: [], network: [] }
}

/** Renderer live-append: bucket incoming events by source, trim each
 *  touched ring to its own cap. Replaces the flat appendConsoleEvents. */
export function appendConsoleEvents(
  prev: ConsoleRings,
  incoming: ConsoleEvent[],
  caps: Record<ConsoleSource, number> = CONSOLE_SOURCE_CAPS
): ConsoleRings {
  if (incoming.length === 0) return prev
  const next = { ...prev }
  const touched = new Set<ConsoleSource>()
  for (const e of incoming) {
    if (!touched.has(e.source)) {
      next[e.source] = [...next[e.source]]
      touched.add(e.source)
    }
    next[e.source].push(e)
  }
  for (const source of touched) {
    const cap = caps[source]
    const ring = next[source]
    if (ring.length > cap) next[source] = ring.slice(ring.length - cap)
  }
  return next
}

/** Initial-snapshot ingestion: buckets a flat main-side snapshot by source
 *  and applies the SAME per-source caps, closing the snapshot-cap-bypass
 *  bug even if a future change ever lets main and renderer caps drift. */
export function ringsFromSnapshot(
  snapshot: ConsoleEvent[],
  caps: Record<ConsoleSource, number> = CONSOLE_SOURCE_CAPS
): ConsoleRings {
  return appendConsoleEvents(emptyConsoleRings(), snapshot, caps)
}

/** Flatten rings back into one seq-ordered array for filtering/rendering.
 *  Each ring is already seq-ordered internally (append-only), so this is a
 *  5-way merge — same asymptotic shape as the bus's own snapshot(), sized
 *  small enough (≤3600 rows) that a plain sort is fine here too. */
export function mergeConsoleRings(rings: ConsoleRings): ConsoleEvent[] {
  const all: ConsoleEvent[] = []
  for (const source of Object.keys(rings) as ConsoleSource[]) all.push(...rings[source])
  return all.sort((a, b) => a.seq - b.seq)
}
```

`RENDERER_EVENT_CAP` is removed (its role is now per-source `CONSOLE_SOURCE_CAPS`,
imported from `console.ts`). Both existing exported names change signature
(`appendConsoleEvents` now takes/returns `ConsoleRings`, not `ConsoleEvent[]`)
— this is a breaking change to `console-filter.ts`'s public shape, contained
entirely to this module and its one caller (`Console.tsx`).

### H3 — `Console.tsx`: state becomes rings, flatten once per render via `useMemo`

```ts
// src/renderer/src/components/Console.tsx
const [eventRings, setEventRings] = useState<ConsoleRings>(emptyConsoleRings())

useEffect(() => {
  if (!open) return
  let alive = true
  void window.localflow.listConsole().then((snap) => {
    if (alive) setEventRings(ringsFromSnapshot(snap))
  })
  const off = window.localflow.onConsoleEvent((e) =>
    setEventRings((prev) => appendConsoleEvents(prev, Array.isArray(e) ? e : [e]))
  )
  return () => {
    alive = false
    off()
  }
}, [open])

const events = useMemo(() => mergeConsoleRings(eventRings), [eventRings])
```

Everything downstream of `events` (`visibleEvents`, the `rows.map(...)`
render, the auto-scroll effect, the thumbnail-preview effect keyed off
`events`) is **unchanged** — they only ever consumed a flat, seq-ordered
`ConsoleEvent[]`, which `mergeConsoleRings` still produces. The diff is
contained to: the two `useState`/`useEffect` lines above, one new `useMemo`,
and the two-line rename of `events` → `eventRings` at the state-declaration
site.

### Why this fixes both bugs together

- **M1 (starvation):** a `network` flood now only trims the `network` ring
  (cap 2000). `guard`/`status`/`operator`/`capture` rows are untouched by
  network volume, exactly mirroring the bus's own guarantee one process over.
- **Snapshot bypass:** `ringsFromSnapshot` runs every snapshot — including
  the initial one — through the identical per-source cap logic as live
  append. Because renderer caps now equal main caps by construction (H1),
  today's snapshot (3600 rows total, ≤ its own source's cap in every ring
  simultaneously) passes through unchanged in the common case; the function
  is not a no-op though — it's the thing that makes "renderer caps must stay
  ≥ sum of main caps or the snapshot silently overflows" no longer an
  invariant anyone has to remember, because both numbers now come from one
  constant.

---

## Data flow

**Drawer open (cold):**
1. `Console.tsx` mounts effect on `open → true`.
2. `listConsole()` IPC → main `consoleBus.snapshot()` → flat, seq-sorted
   `ConsoleEvent[]` (≤3600 today, bounded by `CONSOLE_SOURCE_CAPS` sum).
3. `ringsFromSnapshot(snap)` buckets by source, trims each bucket to its
   `CONSOLE_SOURCE_CAPS[source]` — a no-op today given main/renderer caps
   match, but load-bearing if they're ever allowed to drift, and it's what
   actually enforces the renderer's own invariant rather than trusting main's.
4. `setEventRings(...)` → `useMemo` flattens → `mergeConsoleRings` → `events`
   → `visibleEvents(events, filter)` → rendered rows.

**Live batch (hot, e.g. a `network` burst mid page-load):**
1. Main `NetworkTap` flushes ≤50 rows every ~120ms via `consoleBus.emitBatch`.
2. Bus appends to its own `network` ring (cap 2000, unaffected by this spec),
   fans the batch out over IPC as one `console:event` message.
3. Renderer's `onConsoleEvent` handler calls `appendConsoleEvents(prev,
   batch)` → only `prev.network` is spread/trimmed; `prev.status`,
   `prev.operator`, `prev.capture`, `prev.guard` are referentially unchanged
   (same array reference carried into `next`), so a burst of 1000 `network`
   rows costs one array copy of the network ring, not five.
4. `useMemo` recomputes `events` (depends on the whole `eventRings` object
   identity, which did change), flattening all five rings — bounded by
   `CONSOLE_SOURCE_CAPS` sum regardless of burst size or duration.

---

## Testing

All of this is pure-function/DI-friendly (per the existing pattern in
`console-bus.test.ts`/`console-filter.test.ts`), so it's unit-test-first, no
e2e needed for H1–H3 (there's no Electron/CDP timing involved — that's
exactly why this slice was chosen as the safe one).

**`tests/unit/console-filter.test.ts` (extend/replace `appendConsoleEvents`
tests, add new ones):**

- *Starvation fix, the actual regression test for M1:* flood `network` with
  more than `CONSOLE_SOURCE_CAPS.network` events via repeated
  `appendConsoleEvents` calls (or one big batch) while a single `status`
  event was appended once, earlier; assert the `status` event is still
  present in `mergeConsoleRings(result)` afterward, and that `network`'s own
  ring is trimmed to its cap. This is the direct behavioral proof that a
  noisy source no longer evicts a quiet source's rows — the bug's own repro,
  inverted into an assertion.
- Each source ring is capped independently: flood two different sources past
  their respective caps in one test; assert both are trimmed to their own
  (different) cap values and neither affected the other.
- `appendConsoleEvents` on an empty incoming batch is a no-op (returns the
  same `prev` reference, or at least an equal one) — guards the referential-
  stability claim in the data-flow section above (cheap, prevents an
  unnecessary `useMemo` recompute).
- `ringsFromSnapshot`: given a flat array where one source's count exceeds
  its cap (simulating a future main/renderer cap mismatch, not today's
  actual data), asserts the result still respects the per-source cap — this
  is the direct regression test for the snapshot-bypass bug, independent of
  whether main and renderer caps happen to currently agree.
- `ringsFromSnapshot` on today's real shape (a snapshot at exactly
  `CONSOLE_SOURCE_CAPS` sum, evenly distributed) round-trips with no rows
  dropped — proves the fix doesn't regress the common case.
- `mergeConsoleRings`: given rings populated out of `seq` order (e.g. built
  via out-of-order `appendConsoleEvents` calls across sources), returns a
  single array sorted by `seq` — the property the rest of `Console.tsx`
  (auto-scroll, row order) depends on.

**`tests/unit/console-bus.test.ts` (add one):**

- `new ConsoleEventBus()` with no override uses `CONSOLE_SOURCE_CAPS` values
  (assert e.g. flooding `network` past 2000 without an explicit override
  still evicts at exactly 2000) — a cheap guard that the bus's default caps
  and the shared constant haven't silently diverged after the H1 refactor
  (this test would have caught bug (3) if it existed before this spec).

**Renderer component test (if `Console.tsx` has existing RTL/similar
coverage — confirm during implementation):**

- Simulate opening the drawer with a snapshot whose per-source counts already
  exceed caps (defensive case) → assert rendered row count is bounded by
  `CONSOLE_SOURCE_CAPS` sum, not the raw snapshot length.
- Simulate a live `network` batch arriving after a `guard` row was already
  present → assert the `guard` row is still rendered after the batch.

**No e2e additions needed for this spec** — H1–H3 are renderer-state-shape
and pure-function changes with no new Electron surface, IPC contract change,
or timing dependency. (The scope report's task-4 item, which *does* need
e2e, is explicitly out of scope here.)

---

## TDD task breakdown

1. **Add `CONSOLE_SOURCE_CAPS` to `src/shared/console.ts`; point
   `console-bus.ts`'s `DEFAULT_CAPS` at it.** Write the "bus default caps
   match the shared constant" test first (console-bus.test.ts), confirm it
   fails against today's private `DEFAULT_CAPS` duplication conceptually
   (i.e. would silently pass either way today since both are 500/500/300/
   300/2000 — the point is it *pins* the values going forward), then wire
   the import and remove the private constant. *Small.*
2. **Rewrite `console-filter.ts`: `ConsoleRings` type, `emptyConsoleRings`,
   new `appendConsoleEvents` (rings-shaped), `ringsFromSnapshot`,
   `mergeConsoleRings`.** Remove `RENDERER_EVENT_CAP`. TDD: write the
   starvation-regression test and the per-source-independent-cap test first
   against the new signature, then implement. *Medium* (the flat→rings
   signature change is the biggest single diff in this spec).
3. **Update `tests/unit/console-filter.test.ts`** for the new
   `appendConsoleEvents`/`ringsFromSnapshot`/`mergeConsoleRings` signatures;
   port the two existing `appendConsoleEvents` cases (cap-trim,
   below-cap-untrimmed) to the rings shape rather than deleting the
   coverage. *Small*, bundled with task 2.
4. **`Console.tsx`: swap `events` state for `eventRings` + derive `events`
   via `useMemo(mergeConsoleRings, ...)`.** Depends on tasks 1–3 landing
   first (needs the final module shape). Manual smoke check: open drawer,
   confirm existing filter/scope/mute/expand behavior is visually unchanged
   (this task changes internal state shape only, zero intended UI/behavior
   diff outside the two bug fixes). *Small.*
5. **(Optional, bundle with 4 if an RTL/component-test harness already
   exists for `Console.tsx`; skip if none does and it's not worth
   introducing one just for this)** renderer-level regression tests per the
   Testing section's last bullet group. *Small if the harness exists,
   otherwise judgment call — don't introduce a new test harness just for
   this spec.*

**Estimate: 4-5 tasks, all small-to-medium, no Electron/CDP/e2e surface.**
Consistent with the scope report's read that tasks 1/2/3 (its numbering) are
low-risk and TDD-friendly since the bus and filter modules are already pure.
Rough total: **under a day**, including test-writing.

---

## Decisions (resolved 2026-07-16 — see inline callouts above for full reasoning)

1. **Shared cap table location.** Decided: `src/shared/console.ts` (existing
   shared-constants home) over a new `console-caps.ts` file.
2. **Renderer cap values.** Decided: mirror `CONSOLE_SOURCE_CAPS` exactly
   (sum 3600) rather than a smaller renderer-tuned table — one table, no
   second number to keep in sync.
3. **`console-bus.snapshot()` sort-vs-merge optimization (scope report task
   5): do it now or defer?** Decided: **defer**. It's an independent,
   low-priority micro-optimization on the main side (the v2 design doc
   already measured the current full-sort as "sub-millisecond, negligible"
   at ~3300 elements) with no dependency from this spec's fixes — H2 above
   needs its *own* renderer-side merge (`mergeConsoleRings`) regardless of
   what `console-bus.ts` does internally, so bundling the bus-side
   optimization here would widen this PR's diff without making the two
   correctness fixes any safer or easier to review. Ship it later as a
   standalone, easy-to-review pure refactor (scope report already frames it
   that way).

## Compatibility & rollout

- `ConsolePrefs` and the `console:list`/`console:event` IPC contract are
  **unchanged** — this spec is entirely renderer-internal state shape plus
  one shared constant extraction. No persisted-schema migration.
- `console-filter.ts`'s public API changes shape
  (`appendConsoleEvents`'s signature, removal of `RENDERER_EVENT_CAP`, new
  exports) — a breaking change to that module, but its only consumer is
  `Console.tsx` (confirmed via the existing test file and component), so
  this is a same-PR, coordinated change, not a staged/back-compat rollout.
- `console-bus.ts`'s public behavior (default caps, override mechanism,
  `snapshot()`/`emit()`/`emitBatch()`/`subscribe()` signatures) is
  **unchanged** — only where the default cap *values* are sourced from
  changes internally.
- No new IPC handlers, no CSP changes, no Electron API surface touched —
  this is the reason the task breakdown above needs no e2e coverage and no
  webview-timing verification.
