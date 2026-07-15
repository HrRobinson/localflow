# Console v2 — hardening + `network` source + inline previews — design

Date: 2026-07-15. Status: approved design.
Builds on Console v1 (the bottom console shipped in #70): a main-process
`ConsoleEventBus`, three taps (`status`/`operator`/`capture`), `console:list` /
`console:event` IPC, a pure filter reducer, and a drawer toggled with `Cmd+/`.

## Goal

Make the bottom console a surface you can *live in* while agents and the
operator work — and harden the v1 that shipped. Two phases in one spec:

- **Phase 1 — hardening.** Close the robustness gaps in the shipped console:
  a bad subscriber can't take down the bus, the renderer's event array is
  bounded, drawer scope persists, and a re-run against a vanished watchpoint
  gives feedback instead of silence.
- **Phase 2 — the live console.** Light up the reserved `network` source from
  the browser pane's CDP stream (full fidelity — everything, filtered in the
  UI), render inline screenshot previews, and keep the high-volume network
  stream from starving the other sources or melting the IPC channel.

Both phases are additive: no persisted-schema break (a `ConsolePrefs` without
the new field loads fine), no change to the three existing taps' behavior, and
the single-event `subscribe()` contract stays intact for low-volume sources.

## Background: what v1 shipped

- `src/main/console-bus.ts` — `ConsoleEventBus`: one shared ring,
  `DEFAULT_CAP = 500`, `emit()` appends + evicts oldest, fans each event to
  every subscriber synchronously, `snapshot()` returns a copy, `subscribe()`.
- `src/shared/console.ts` — `ConsoleSource` (`status`|`operator`|`capture`|
  `network`, the last reserved but never produced), `ConsoleEvent`,
  `ConsoleDetail` union, `toStatusEvent`/`toOperatorEvent`/`toCaptureEvent`
  mappers, `ConsolePrefs` (`height`, `open`, `sources`, `text` persisted).
- `src/main/index.ts` — the three taps: event source → mapper →
  `consoleBus.emit(...)`; one `consoleBus.subscribe((e) => sendToWindow(
  'console:event', e))` fans every event to the renderer as an individual IPC
  message; `new ConsoleEventBus()` runs on the 500 default.
- `src/main/browser-control.ts` — `WebviewBrowserControl` already attaches
  `wc.debugger`, calls `Network.enable`, listens to `Network.requestWillBeSent`
  / `Network.responseReceived`, and keeps a per-handle `netBuffers` (cap 200,
  request/response coalesced by a URL-match heuristic) for the on-demand
  `network(handle)` IPC probe. Phase 2 builds its tap on this **existing**
  debugger attach — it does not add a second one.
- `src/renderer/src/components/Console.tsx` — rows with an expand-on-click JSON
  detail block and row actions; `setEvents((prev) => [...prev, e])` on each live
  event (**unbounded** — a pre-existing leak, fixed in Phase 1).
- `src/renderer/index.html` — CSP `default-src 'self'; style-src 'self'
  'unsafe-inline'`; no `img-src` directive (Phase 2 adds `data:`).
- `src/main/capture-store.ts` — screenshots under `userData/captures/env-<N>/
  shot-<uuid>.png`; `pruneScreenshot` already implements a path-traversal guard
  (`relative(baseDir, resolve(path))` must not escape) — the precedent Phase 2
  reuses for safely serving a client-supplied screenshot path.

---

## Phase 1 — hardening

### P1.1 — exception-safe bus fan-out

`emit()` currently loops `for (const sub of this.subs) sub(event)`. A single
subscriber that throws aborts the loop, so later subscribers miss the event and
the caller of `emit()` sees the throw. Wrap each `sub(event)` in try/catch;
swallow (or `console.error`) a throwing subscriber so one bad tap can neither
break `emit()` nor starve the other subscribers. The bus is a shared primitive;
no producer should be able to crash it.

### P1.2 — bound the renderer event array

`Console.tsx`'s live handler appends every event to React state forever. With
only three low-volume sources this is a slow leak; with `network` (Phase 2) it
becomes acute (thousands of rows, each re-triggering the `visibleEvents()`
filter on every filter-box keystroke). Cap the renderer-side `events` array to
the last **3000** (mirrors the bus's total budget), applied in the live-append
path, independent of Phase 2's batching.

### P1.3 — persist drawer scope

`ConsolePrefs` persists `sources` and `text` but not the scope mode
(everywhere / pin-here / follow), so scope resets on every launch. Add
`scope: 'auto' | ConsoleScope` to `ConsolePrefs` (default `'auto'`), seed it in
the hydrate effect, and include it in the debounce-persist. `DEFAULT_CONSOLE_PREFS`
gains the field; a persisted prefs blob without it falls back to `'auto'`.

### P1.4 — watchpoint-gone toast

A `capture` row's "rerun watchpoint" action re-arms the row's watchpoint. If
that watchpoint no longer exists (deleted, environment torn down), the rerun
currently fails silently. Surface a lightweight, transient toast ("watchpoint
`<id>` no longer exists") when the rerun target is gone, so the action gives
feedback instead of nothing. Uses the app's existing toast/notice mechanism if
one exists; otherwise a minimal inline transient notice in the console drawer.

### P1.5 — per-source mute

v1's source chips are *inclusive* (empty set = all; selecting some = show only
those), so silencing one noisy source means selecting all the others. With
`network` in the mix, the common want is "everything **except** network." Add a
per-source **mute** — an exclusion set persisted alongside `sources` — so a
source can be quieted without deselecting the rest. Muting is display-only: a
muted source's events still flow into the bus and count toward its ring; mute
only hides its rows in the drawer. (The v1 "pin here" scope already covers
per-scope pinning, so no separate per-source pin is added — YAGNI.)

---

## Phase 2 — the live `network` source + inline previews

### P2.1 — retention: per-source ring caps

The product decision is **surface everything** from the network stream and
filter in the UI. A single shared 500-ring can't hold that without evicting the
other sources' history within one page load. So `ConsoleEventBus` moves from one
`ConsoleEvent[]` to `rings: Map<ConsoleSource, ConsoleEvent[]>`, each trimmed to
its own cap:

| source   | cap  | rationale |
|----------|------|-----------|
| status   | 500  | unchanged — low volume (session lifecycle) |
| operator | 500  | unchanged — low volume (route calls) |
| capture  | 300  | unchanged in spirit — user/watchpoint-triggered, never bursty |
| network  | 2000 | coalesced rows run ~100–300/page load → ~7–15 loads of scrollback |

`emit()` looks up the ring for `input.source`, appends, trims **that ring
only**. `snapshot()` merges all rings and sorts by a stable global order key.
To make ordering unambiguous without parsing the `id` string, expose the bus's
existing monotonic counter as a plain `seq: number` field on `ConsoleEvent`
(assigned in `emit`/`emitBatch` the same way `id` is today); `snapshot()` sorts
by `seq`. The constructor takes an optional `Partial<Record<ConsoleSource,
number>>` of cap overrides defaulting to the table above, so `new
ConsoleEventBus()` in `index.ts` keeps working unchanged.

`subscribe()` and the per-event live fan-out are **untouched** — `emit()` still
calls every subscriber once per event, so the three existing taps and
`Console.tsx`'s live-append path need no change from this section. Memory bound:
≈3300 events resident, low single-digit MB worst case. Snapshot merge/sort of
~3300 elements happens once per drawer-open (not per event) — sub-millisecond.

**Rejected:** one bigger shared ring (network still dominates any single cap —
delays starvation, doesn't bound it); pull-on-demand from `netBuffers` (breaks
the live unified timeline the product decision requires, and `netBuffers`'
URL-match coalescing is too fragile as a system of record).

### P2.2 — the `network` tap: coalesce per request + flush incomplete

A page load fires ~450 raw CDP Network messages (≈150 requests ×
requestWillBeSent + responseReceived + loadingFinished). Emitting a row per raw
message would triple the volume and smear each request across three rows. So the
tap **coalesces per `requestId`** and emits **one** row when the request
completes.

The network tap (new, in main — built on `browser-control.ts`'s existing
debugger attach, not a second one) keeps a `Map<requestId, PartialNetworkDetail>`
updated on `requestWillBeSent` (method, url, type, start timestamp) and
`responseReceived` (status, fromCache, response timestamp), and emits one
finished `ConsoleEvent` on `loadingFinished` (adds `sizeBytes` from
`encodedDataLength`, derives `durationMs`) or `loadingFailed` (sets `failed` +
`errorText`). This keeps the bus's append-only, immutable-event model intact —
no `update(id, patch)` API, no row-mutation IPC, no patch logic in the renderer.

**Flush-incomplete (the critical correctness rule).** Coalesce-on-completion
would silently drop a request that never finishes — pane navigates away, webview
destroyed, request hangs — which violates "surface everything." So the tap
flushes every still-pending buffer entry as an explicit **`incomplete`** row at
lifecycle boundaries: the existing `wc.once('destroyed', …)` handler, a new
main-frame navigation-commit listener, and a defensive per-request timeout
(30s). Nothing in-flight vanishes without at least a row saying it never
finished.

**`ConsoleDetail` variant for `network`:**

```ts
| {
    source: 'network'
    requestId: string
    method: string
    url: string
    status?: number
    type?: string          // CDP resourceType (Document/Script/XHR/Image/…)
    durationMs?: number
    sizeBytes?: number      // encodedDataLength
    fromCache?: boolean
    failed?: boolean
    errorText?: string
    incomplete?: boolean    // flushed at a lifecycle boundary before completing
  }
```

`label` follows the existing convention:
`` `${method} ${status ?? (incomplete ? '⏳' : 'ERR')} · ${url}` ``, URL
truncated when long. A `toNetworkEvent(...)` mapper joins the others in
`src/shared/console.ts`. Deliberately excluded from the row (fetch lazily via
CDP on expand if ever needed, never eagerly stored): full headers, bodies,
initiator stack.

### P2.3 — backpressure: batch network emissions

Even coalesced, a page-load burst is tens–100+ completed requests/sec. Batching
belongs in the **tap, not the bus** (status/operator/capture stay low-volume and
unbatched — no reason to change their path). The tap feeds completed rows into a
small outgoing queue that a `setInterval` flushes every **~120ms (~8Hz)** — live
enough for a human, with a hard ceiling on IPC rate regardless of page
burstiness.

This adds one method to `ConsoleEventBus`: `emitBatch(inputs:
ConsoleEventInput[])` — appends all to the (network) ring and does **one**
subscriber fan-out carrying the whole array, so the renderer gets one
`console:event` IPC per flush tick instead of ~100/sec. `Console.tsx`'s live
handler normalizes to an array before appending
(`setEvents(prev => [...prev, ...batch].slice(-3000))`, folding in P1.2's cap);
the other three taps keep calling singular `emit()` — the IPC payload supports
either shape. Cap batch size per flush at 50 as a payload-size safety valve
(rarely hit given P2.2's coalescing; no "+N more" UI needed for Phase 2).

### P2.4 — inline screenshot previews

`capture` events carry a `screenshotPath`; today it renders as plain text. Add
an inline thumbnail, rendered **lazily on row-expand only** (never eagerly for
the visible row list — hundreds of rows must not trigger hundreds of decodes).

A new IPC handler `console:readScreenshot` takes a path, applies the **same
path-traversal guard `capture-store.ts` already uses** (serve only files under
the capture store's own dir), reads the PNG, and returns a
`data:image/png;base64,<…>` URI. CSP gains `img-src 'self' data:`.
`Console.tsx` fetches it only when a row with a `screenshotPath` is expanded
(extends the existing `{expanded === e.id && …}` gate that already gates the
JSON block), and caches the result in a `Map<path, dataUri>` in component state
so re-expanding doesn't re-fetch.

**Rejected:** raw `file://` src (needs a blanket `img-src file:` grant
whitelisting every OS-readable file, plus URL-encoding quirks); a custom
protocol (correct at scale — avoids base64 inflation — but a new privileged
surface, over-engineered for occasional single-PNG previews; the follow-up to
reach for if preview volume/size grows, e.g. video capture).

## Data flow (a network request during operator work)

1. Operator drives the browser pane; the page issues a request.
2. `browser-control.ts`'s existing CDP listener sees `requestWillBeSent` →
   network tap records `{requestId, method, url, type, tStart}`.
3. `responseReceived` → tap adds `status`, `fromCache`, `tResp`.
4. `loadingFinished` → tap assembles the full detail (`sizeBytes`, `durationMs`)
   and enqueues one `ConsoleEventInput{source:'network'}`.
5. Every ~120ms the tap flushes the queue via `consoleBus.emitBatch(...)` →
   appends to the network ring → one `console:event` IPC array → renderer
   appends (capped at 3000) → rows appear, filterable, in the unified timeline.
6. If the pane navigates/destroys with requests still pending, those flush as
   `incomplete` rows so nothing is lost.

Allow-path for previews: expanding a `capture` row triggers one
`console:readScreenshot` → data URI → inline thumbnail; collapsing/re-expanding
uses the cached URI.

## Error handling

- **Throwing subscriber** → caught in `emit`/`emitBatch`; other subscribers and
  the caller are unaffected (P1.1).
- **Screenshot read failure / path outside the guard** → handler returns no URI;
  the row shows its JSON detail without a thumbnail (never throws to the
  renderer).
- **Debugger detach / navigation / hung request** → pending network entries
  flush as `incomplete` rows (P2.2); never silently dropped.
- **Persisted prefs missing the new fields** (`scope`, mute set) → fall back to
  defaults (`'auto'`, empty).
- **Fail-safe volume ceiling** → per-source ring caps + the 8Hz/50-per-flush
  batch cap bound memory and IPC regardless of page behavior.

## Out of scope (v2)

- **Header/body-level network detail** — row-level only; lazy CDP
  `getResponseBody` on expand is a future enhancement.
- **`Network.dataReceived` streamed-byte accounting** — `sizeBytes` from
  `encodedDataLength` at completion is enough; accurate mid-stream byte counts
  for SSE/large downloads can layer on later.
- **Custom-protocol preview serving / video previews** — the `data:` URI path is
  enough for today's PNGs.
- **Per-environment or per-pane network filtering** beyond the existing scope
  control — global unified timeline in v2.
- **Live "pending" network rows** — coalesce-on-completion + flush-incomplete is
  the chosen model; no in-place row mutation.

## Testing

**Unit (bus):**
- Per-source ring caps: flooding `network` past 2000 evicts only network; a
  single `status`/`operator`/`capture` event survives the flood.
- `snapshot()` returns all rings merged and sorted by `seq`.
- `emitBatch()` appends all inputs to the ring and fans out **once** with the
  array; `emit()` still fans one event.
- Exception-safe fan-out: a subscriber that throws does not prevent a second
  subscriber from receiving the event, and `emit`/`emitBatch` do not throw.

**Unit (mapper / shared):**
- `toNetworkEvent` produces the right `ConsoleDetail` and label for finished,
  failed, and incomplete requests.
- `ConsolePrefs` round-trip: `scope` + mute set persist and reload; a blob
  missing them falls back to defaults.

**Unit (network tap):**
- request/response/finished coalesce into one finished row with correct
  `status`/`durationMs`/`sizeBytes`.
- `loadingFailed` → one `failed` row with `errorText`.
- pending entries flush as `incomplete` on destroy / navigation / timeout.
- the queue flushes on the interval as a batch; batch size caps at 50.

**Unit (renderer):**
- live-append caps `events` at 3000.
- expanding a `capture` row with a `screenshotPath` requests the data URI once
  and caches it; a read failure renders detail without a thumbnail.
- muted source's rows are hidden while its events remain in the snapshot.

**e2e:**
- Drive a browser pane through a page load → `data-source="network"` rows appear
  in the drawer; a failed request shows a `failed`/error row.
- Navigate away mid-load → at least one `incomplete` row is present.
- Expand a capture row → an inline `<img>` thumbnail renders.
- Mute `network` → network rows hide while status/operator/capture remain;
  scope selection survives a reload.

## Compatibility & rollout

Additive throughout: new bus internals behind the same public methods (`emit`,
`snapshot`, `subscribe`) plus one new `emitBatch`; one new tap; new optional
`ConsolePrefs` fields with safe fallbacks; one new IPC handler; a `data:`
addition to CSP; the `network` `ConsoleDetail` variant that was already reserved.
No existing stream, view, or persisted schema is broken — a v1 `config`/prefs
loads unchanged, and the three existing taps behave exactly as before.
