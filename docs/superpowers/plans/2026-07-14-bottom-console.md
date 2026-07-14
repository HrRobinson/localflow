# Bottom Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable bottom drawer that unifies the app's existing status, operator, and capture event streams onto one filterable, live, in-memory timeline.

**Architecture:** A main-process `ConsoleEventBus` (capped ring, since-launch) taps three existing emit points additively, mapping each native payload to a normalized `ConsoleEvent`. Events reach the renderer via `console:list` (snapshot) + `console:event` (push). All filtering and scope resolution are renderer-side pure functions. The drawer is a React component mounted outside the view switch.

**Tech Stack:** Electron (main + preload + React renderer), TypeScript, Vitest (unit), Playwright (e2e), Tailwind classes.

## Global Constraints

- **Purely additive.** Every existing emit point keeps its current behavior; a `bus.emit(…)` line is *added beside* it. No existing stream, view, IPC channel, or persisted-file schema changes.
- **v1 sources are exactly `status | operator | capture`.** `'network'` is reserved in the enum for v2 but MUST NOT be produced or handled in v1.
- **In-memory, since-launch only.** Ring cap ~500, resets on restart. No new persistent event store. Capture rows reference on-disk detail; they never duplicate screenshot pixels into the ring.
- **Main stays dumb.** Main emits normalized events and answers the snapshot. ALL filtering/scoping is renderer-side.
- **Console toggle default is `cmd+/`** (`cmd+j` is already `focus-down`). Remappable like every other binding.
- **Config additions are optional with defaults.** A `config.json` lacking the console fields loads normally.
- Follow existing patterns exactly: `sendToWindow` for pushes, `ipcMain.handle` for request/response, preload methods declared on `LocalflowApi` in `src/shared/api.ts`, unit tests in `tests/unit/*.test.ts`, e2e in `tests/e2e/*.spec.ts`.
- Commit after each task with a Conventional Commits subject **≤50 characters**.

---

### Task 1: Normalized event types, mappers, and ConsoleEventBus

**Files:**
- Create: `src/shared/console.ts`
- Create: `src/main/console-bus.ts`
- Test: `tests/unit/console.test.ts`, `tests/unit/console-bus.test.ts`

**Interfaces:**
- Consumes: `ActivityEntry`, `ActivityEventKind`, `SessionStatus` from `src/shared/types.ts`; `ActivityEntry as OperatorActivityEntry`, `Capture` from `src/shared/operator.ts`.
- Produces: `ConsoleSource`, `ConsoleDetail`, `ConsoleEvent`, `ConsoleEventInput`, `toStatusEvent`, `toOperatorEvent`, `toCaptureEvent` (from `console.ts`); `ConsoleEventBus` class with `emit(input): ConsoleEvent`, `snapshot(): ConsoleEvent[]`, `subscribe(cb): () => void` (from `console-bus.ts`).

- [ ] **Step 1: Write the failing test for the mappers**

Create `tests/unit/console.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toStatusEvent, toOperatorEvent, toCaptureEvent } from '../../src/shared/console'
import type { ActivityEntry } from '../../src/shared/types'
import type { ActivityEntry as OperatorActivityEntry, Capture } from '../../src/shared/operator'

describe('console mappers', () => {
  it('maps a status entry to a status console event input', () => {
    const entry: ActivityEntry = { timestamp: 1, kind: 'Stop', status: 'idle' }
    const e = toStatusEvent('sess-1', 3, entry)
    expect(e.source).toBe('status')
    expect(e.environment).toBe(3)
    expect(e.sessionId).toBe('sess-1')
    expect(e.label.toLowerCase()).toContain('idle')
    expect(e.detail).toEqual({ source: 'status', kind: 'Stop', status: 'idle' })
  })

  it('maps an operator entry, carrying handle as sessionId and detail as args', () => {
    const entry: OperatorActivityEntry = { at: 1, route: 'operator:resume', handle: 'sess-9', detail: 'cap approve' }
    const e = toOperatorEvent(2, entry)
    expect(e.source).toBe('operator')
    expect(e.environment).toBe(2)
    expect(e.sessionId).toBe('sess-9')
    expect(e.detail).toEqual({ source: 'operator', action: 'operator:resume', args: 'cap approve' })
  })

  it('maps a capture to a capture console event with references only', () => {
    const cap: Capture = {
      id: 'cap-1', environment: 4, watchpointId: 'wp-1', createdAt: 1,
      halted: true, screenshotPath: '/x/shot.png', output: ['line']
    }
    const e = toCaptureEvent(cap)
    expect(e.source).toBe('capture')
    expect(e.environment).toBe(4)
    expect(e.sessionId).toBeUndefined()
    expect(e.detail).toEqual({
      source: 'capture', watchpointId: 'wp-1', captureId: 'cap-1',
      halted: true, screenshotPath: '/x/shot.png', output: ['line']
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- console.test`
Expected: FAIL — cannot resolve `../../src/shared/console`.

- [ ] **Step 3: Create `src/shared/console.ts`**

```ts
import type { ActivityEntry, ActivityEventKind, SessionStatus } from './types'
import type { ActivityEntry as OperatorActivityEntry, Capture } from './operator'

// 'network' is reserved for v2 (browser-pane CDP). Do NOT produce it in v1.
export type ConsoleSource = 'status' | 'operator' | 'capture' | 'network'

export type ConsoleDetail =
  | { source: 'status'; kind: ActivityEventKind; status: SessionStatus }
  | { source: 'operator'; action: string; args?: string }
  | {
      source: 'capture'
      watchpointId: string
      captureId: string
      halted: boolean
      screenshotPath?: string
      output?: string[]
    }

export interface ConsoleEvent {
  id: string
  ts: number
  source: ConsoleSource
  environment: number
  sessionId?: string
  label: string
  detail: ConsoleDetail
}

/** What a mapper returns; the bus assigns id + ts (main-process authority). */
export type ConsoleEventInput = Omit<ConsoleEvent, 'id' | 'ts'>

export function toStatusEvent(
  sessionId: string,
  environment: number,
  entry: ActivityEntry
): ConsoleEventInput {
  return {
    source: 'status',
    environment,
    sessionId,
    label: `${entry.kind} · ${entry.status}`,
    detail: { source: 'status', kind: entry.kind, status: entry.status }
  }
}

export function toOperatorEvent(
  environment: number,
  entry: OperatorActivityEntry
): ConsoleEventInput {
  return {
    source: 'operator',
    environment,
    sessionId: entry.handle,
    label: entry.detail ? `${entry.route} · ${entry.detail}` : entry.route,
    detail: { source: 'operator', action: entry.route, args: entry.detail }
  }
}

export function toCaptureEvent(capture: Capture): ConsoleEventInput {
  return {
    source: 'capture',
    environment: capture.environment,
    label: capture.halted
      ? `capture ${capture.watchpointId} · halted`
      : `capture ${capture.watchpointId}`,
    detail: {
      source: 'capture',
      watchpointId: capture.watchpointId,
      captureId: capture.id,
      halted: capture.halted,
      screenshotPath: capture.screenshotPath,
      output: capture.output
    }
  }
}
```

- [ ] **Step 4: Run mapper test to verify it passes**

Run: `npm test -- console.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for the bus**

Create `tests/unit/console-bus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ConsoleEventBus } from '../../src/main/console-bus'
import type { ConsoleEventInput } from '../../src/shared/console'

function input(label: string): ConsoleEventInput {
  return { source: 'status', environment: 1, label, detail: { source: 'status', kind: 'Stop', status: 'idle' } }
}

describe('ConsoleEventBus', () => {
  it('assigns unique ids and a timestamp on emit', () => {
    let now = 100
    const bus = new ConsoleEventBus(500, () => now)
    const a = bus.emit(input('a'))
    now = 200
    const b = bus.emit(input('b'))
    expect(a.id).not.toBe(b.id)
    expect(a.ts).toBe(100)
    expect(b.ts).toBe(200)
  })

  it('snapshot returns oldest-to-newest', () => {
    const bus = new ConsoleEventBus()
    bus.emit(input('first'))
    bus.emit(input('second'))
    expect(bus.snapshot().map((e) => e.label)).toEqual(['first', 'second'])
  })

  it('evicts oldest beyond the cap', () => {
    const bus = new ConsoleEventBus(2)
    bus.emit(input('a'))
    bus.emit(input('b'))
    bus.emit(input('c'))
    expect(bus.snapshot().map((e) => e.label)).toEqual(['b', 'c'])
  })

  it('fans out each emit to subscribers and unsubscribes cleanly', () => {
    const bus = new ConsoleEventBus()
    const seen: string[] = []
    const off = bus.subscribe((e) => seen.push(e.label))
    bus.emit(input('a'))
    off()
    bus.emit(input('b'))
    expect(seen).toEqual(['a'])
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- console-bus.test`
Expected: FAIL — cannot resolve `../../src/main/console-bus`.

- [ ] **Step 7: Create `src/main/console-bus.ts`**

```ts
import type { ConsoleEvent, ConsoleEventInput } from '../shared/console'

const DEFAULT_CAP = 500

export class ConsoleEventBus {
  private ring: ConsoleEvent[] = []
  private subs = new Set<(e: ConsoleEvent) => void>()
  private seq = 0

  constructor(
    private readonly cap: number = DEFAULT_CAP,
    private readonly now: () => number = Date.now
  ) {}

  emit(input: ConsoleEventInput): ConsoleEvent {
    const event: ConsoleEvent = { ...input, id: `ce-${++this.seq}`, ts: this.now() }
    this.ring.push(event)
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap)
    for (const sub of this.subs) sub(event)
    return event
  }

  snapshot(): ConsoleEvent[] {
    return [...this.ring]
  }

  subscribe(cb: (e: ConsoleEvent) => void): () => void {
    this.subs.add(cb)
    return () => {
      this.subs.delete(cb)
    }
  }
}
```

- [ ] **Step 8: Run all new tests + typecheck**

Run: `npm test -- console` then `npm run typecheck`
Expected: all PASS; no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/shared/console.ts src/main/console-bus.ts tests/unit/console.test.ts tests/unit/console-bus.test.ts
git commit -m "feat: console event bus and mappers"
```

---

### Task 2: Filter reducer and scope derivation

**Files:**
- Create: `src/shared/console-filter.ts`
- Test: `tests/unit/console-filter.test.ts`

**Interfaces:**
- Consumes: `ConsoleEvent`, `ConsoleSource` from `src/shared/console.ts`.
- Produces: `ConsoleScope`, `ConsoleFilter`, `ConsoleFocus`, `visibleEvents(events, f)`, `deriveConsoleScope(focus)`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  visibleEvents,
  deriveConsoleScope,
  type ConsoleFilter,
  type ConsoleScope
} from '../../src/shared/console-filter'
import type { ConsoleEvent, ConsoleSource } from '../../src/shared/console'

let seq = 0
function ev(source: ConsoleSource, environment: number, label: string, sessionId?: string): ConsoleEvent {
  return {
    id: `e${++seq}`, ts: seq, source, environment, sessionId, label,
    detail: { source: 'operator', action: label } as ConsoleEvent['detail']
  }
}

const ALL = new Set<ConsoleSource>()
const everywhere: ConsoleScope = { kind: 'everywhere' }
function filter(over: Partial<ConsoleFilter> = {}): ConsoleFilter {
  return { sources: ALL, scope: everywhere, text: '', ...over }
}

describe('visibleEvents', () => {
  const events = [
    ev('status', 1, 'Stop idle', 'a'),
    ev('operator', 1, 'POST panes', undefined),
    ev('capture', 2, 'capture wp-1', undefined)
  ]

  it('empty source set means all sources', () => {
    expect(visibleEvents(events, filter()).length).toBe(3)
  })

  it('source chips OR-combine', () => {
    const f = filter({ sources: new Set<ConsoleSource>(['status', 'capture']) })
    expect(visibleEvents(events, f).map((e) => e.source)).toEqual(['status', 'capture'])
  })

  it('environment scope matches by environment', () => {
    const f = filter({ scope: { kind: 'environment', environment: 2 } })
    expect(visibleEvents(events, f).map((e) => e.label)).toEqual(['capture wp-1'])
  })

  it('session scope matches by sessionId', () => {
    const f = filter({ scope: { kind: 'session', sessionId: 'a' } })
    expect(visibleEvents(events, f).map((e) => e.label)).toEqual(['Stop idle'])
  })

  it('text is a case-insensitive substring over label', () => {
    expect(visibleEvents(events, filter({ text: 'PANES' })).map((e) => e.label)).toEqual(['POST panes'])
  })

  it('source, scope, and text AND together', () => {
    const f = filter({
      sources: new Set<ConsoleSource>(['status']),
      scope: { kind: 'environment', environment: 1 },
      text: 'stop'
    })
    expect(visibleEvents(events, f).map((e) => e.label)).toEqual(['Stop idle'])
  })
})

describe('deriveConsoleScope', () => {
  it('enlarged into a session yields session scope', () => {
    expect(deriveConsoleScope({ view: 'environment', enlarged: { id: 's5', level: 'pane' }, environment: 3 }))
      .toEqual({ kind: 'session', sessionId: 's5' })
  })

  it('an environment grid yields environment scope', () => {
    expect(deriveConsoleScope({ view: 'environment', enlarged: null, environment: 3 }))
      .toEqual({ kind: 'environment', environment: 3 })
  })

  it('home yields everywhere', () => {
    expect(deriveConsoleScope({ view: 'home', enlarged: null, environment: 1 }))
      .toEqual({ kind: 'everywhere' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- console-filter`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Create `src/shared/console-filter.ts`**

```ts
import type { ConsoleEvent, ConsoleSource } from './console'

export type ConsoleScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'environment'; environment: number }
  | { kind: 'everywhere' }

export interface ConsoleFilter {
  sources: Set<ConsoleSource> // empty = all sources
  scope: ConsoleScope
  text: string
}

export function visibleEvents(events: ConsoleEvent[], f: ConsoleFilter): ConsoleEvent[] {
  const text = f.text.trim().toLowerCase()
  return events.filter((e) => {
    if (f.sources.size > 0 && !f.sources.has(e.source)) return false
    if (!matchesScope(e, f.scope)) return false
    if (text && !e.label.toLowerCase().includes(text)) return false
    return true
  })
}

function matchesScope(e: ConsoleEvent, scope: ConsoleScope): boolean {
  switch (scope.kind) {
    case 'everywhere':
      return true
    case 'environment':
      return e.environment === scope.environment
    case 'session':
      return e.sessionId === scope.sessionId
  }
}

export interface ConsoleFocus {
  view: 'home' | 'environment' | 'settings' | 'changes' | 'activity' | 'cockpit'
  enlarged: { id: string; level: 'pane' | 'session' } | null
  environment: number
}

/** Pure derivation of the auto scope from the current M5 focus. */
export function deriveConsoleScope(focus: ConsoleFocus): ConsoleScope {
  if (focus.enlarged) return { kind: 'session', sessionId: focus.enlarged.id }
  if (focus.view === 'environment') return { kind: 'environment', environment: focus.environment }
  return { kind: 'everywhere' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- console-filter`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/shared/console-filter.ts tests/unit/console-filter.test.ts
git commit -m "feat: console filter reducer and scope"
```

---

### Task 3: Main-process taps and IPC surface

**Files:**
- Modify: `src/main/index.ts` (instantiate bus; tap status ~line 304 and operator `pushActivity` ~line 207; add `console:list` handler + `console:event` push subscription)
- Modify: `src/main/control-api.ts` (add optional `onCapture` dep, ~line 15 interface and ~line 194 after successful ingest)
- Modify: `src/preload/index.ts` (add `listConsole`, `onConsoleEvent`)
- Modify: `src/shared/api.ts` (declare both on `LocalflowApi`)

**Interfaces:**
- Consumes: `ConsoleEventBus` (Task 1), `toStatusEvent`/`toOperatorEvent`/`toCaptureEvent` (Task 1), `ConsoleEvent` type.
- Produces: IPC channel `console:list` → `ConsoleEvent[]`; push `console:event` → `ConsoleEvent`; preload `listConsole(): Promise<ConsoleEvent[]>`, `onConsoleEvent(cb: (e: ConsoleEvent) => void): () => void`.

- [ ] **Step 1: Add the `onCapture` dependency to control-api**

In `src/main/control-api.ts`, add to the `ControlDeps` interface (near the existing `onActivity?` at line 27):

```ts
  onCapture?: (capture: Capture) => void
```

Ensure `Capture` is imported from `../shared/operator` (add to the existing import if absent). Then at the successful-ingest site (currently line 193-194), fire the callback after the null-guard:

```ts
    const cap = await deps.captures.ingest(environment, b, deps.watchpoints)
    if (!cap) return json(400, { error: 'invalid capture' })
    deps.onCapture?.(cap)
    record('POST /captures', undefined, cap.watchpointId)
    return json(201, { id: cap.id })
```

- [ ] **Step 2: Instantiate the bus and wire all three taps in `index.ts`**

Add the import near the other main imports:

```ts
import { ConsoleEventBus } from './console-bus'
import { toStatusEvent, toOperatorEvent, toCaptureEvent } from '../shared/console'
```

Instantiate the bus beside the other singletons (e.g. near the `activity` map at line ~202):

```ts
const consoleBus = new ConsoleEventBus()
```

**Status tap** — replace the one-line `manager.onActivity` at line 304 with:

```ts
manager.onActivity((id, entry) => {
  sendToWindow('activity:event', id, entry)
  const env = manager.list().find((s) => s.id === id)?.environment ?? 1
  consoleBus.emit(toStatusEvent(id, env, entry))
})
```

**Operator tap** — inside `pushActivity` (lines 207-213), after the existing `sendToWindow('operator:activity', env, entry)` line, add:

```ts
    consoleBus.emit(toOperatorEvent(env, entry))
```

**Capture tap** — where the control server is constructed with its deps (the object that already passes `onActivity: pushActivity`), add:

```ts
    onCapture: (cap) => consoleBus.emit(toCaptureEvent(cap)),
```

- [ ] **Step 3: Add the IPC surface in `index.ts`**

Add the snapshot handler beside the other `ipcMain.handle` registrations (e.g. near `operator:captures` at line 686):

```ts
ipcMain.handle('console:list', () => consoleBus.snapshot())
```

Add the push subscription where the window/singletons are set up (after `consoleBus` exists and `sendToWindow` is defined). Subscribe once at startup:

```ts
consoleBus.subscribe((event) => sendToWindow('console:event', event))
```

- [ ] **Step 4: Declare the methods on `LocalflowApi`**

In `src/shared/api.ts`, add (near `listCaptures` line 132 and `onOperatorActivity` line 145). Import `ConsoleEvent` from `./console` at the top:

```ts
  listConsole(): Promise<ConsoleEvent[]>
  onConsoleEvent(cb: (event: ConsoleEvent) => void): () => void
```

- [ ] **Step 5: Implement the preload bridge methods**

In `src/preload/index.ts`, add to the `api` object (mirror `listCaptures` line 86 and `onOperatorActivity` lines 96-104). Import `ConsoleEvent` type:

```ts
  listConsole: () => ipcRenderer.invoke('console:list'),
  onConsoleEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: ConsoleEvent): void => cb(event)
    ipcRenderer.on('console:event', listener)
    return () => ipcRenderer.removeListener('console:event', listener)
  },
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck`
Expected: no errors (proves the bus, mappers, IPC, preload, and api types line up).

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/control-api.ts src/preload/index.ts src/shared/api.ts
git commit -m "feat: tap streams into console bus + IPC"
```

---

### Task 4: console-toggle keybinding and empty drawer shell

**Files:**
- Modify: `src/shared/keybindings.ts` (add `'console-toggle'` to `KeyAction` union line 1-37 and `DEFAULT_BINDINGS` line 39-76)
- Modify: `src/renderer/src/components/KeybindingsEditor.tsx` (add `LABELS` entry line 11 and a `GROUPS` placement line 50)
- Create: `src/renderer/src/components/Console.tsx` (skeleton: a drawer that shows/hides on `open`, with a `data-console` root and a close button)
- Modify: `src/renderer/src/App.tsx` (add `consoleOpen` state; mount `<Console>`; add `console-toggle` dispatch in `runAction`)
- Test: `tests/unit/keybindings.test.ts` (extend existing to assert the new default)

**Interfaces:**
- Consumes: `KeyAction`, `DEFAULT_BINDINGS` (keybindings.ts), the `runAction` dispatcher and `liveRef` (App.tsx).
- Produces: `console-toggle` action bound to `cmd+/`; `Console` component with props `{ open: boolean; onClose: () => void }`.

- [ ] **Step 1: Extend the keybindings unit test**

In `tests/unit/keybindings.test.ts`, add:

```ts
it('binds console-toggle to cmd+/ by default', () => {
  expect(DEFAULT_BINDINGS['console-toggle']).toBe('cmd+/')
})
```

(If `DEFAULT_BINDINGS` is not already imported in that file, import it from `../../src/shared/keybindings`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- keybindings`
Expected: FAIL — `console-toggle` missing / typecheck error.

- [ ] **Step 3: Add the action to `keybindings.ts`**

Add `| 'console-toggle'` to the `KeyAction` union (line 1-37), and add to `DEFAULT_BINDINGS` (line 39-76):

```ts
  'console-toggle': 'cmd+/',
```

- [ ] **Step 4: Add label + group in `KeybindingsEditor.tsx`**

Add to `LABELS` (line 11):

```ts
  'console-toggle': 'Toggle console',
```

Place `'console-toggle'` in an appropriate `GROUPS` section (line 50) — the same group as `toggle-sidebar` / global view toggles.

- [ ] **Step 5: Run keybindings test + typecheck**

Run: `npm test -- keybindings` then `npm run typecheck`
Expected: PASS; the exhaustive `LABELS`/`GROUPS` typecheck is satisfied.

- [ ] **Step 6: Create the drawer skeleton `src/renderer/src/components/Console.tsx`**

```tsx
import React from 'react'

interface ConsoleProps {
  open: boolean
  onClose: () => void
}

export function Console({ open, onClose }: ConsoleProps): React.JSX.Element | null {
  if (!open) return null
  return (
    <div
      data-console
      className="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-white/10 bg-black/80 backdrop-blur"
      style={{ height: 240 }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 text-[12px] text-white/70">
        <span>Console</span>
        <button
          data-console-close
          className="cursor-pointer border-0 bg-transparent text-white/50 hover:text-white"
          onClick={onClose}
          onMouseDown={(e) => e.preventDefault()}
        >
          close
        </button>
      </div>
      <div data-console-list className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" />
    </div>
  )
}
```

- [ ] **Step 7: Mount the drawer and wire the toggle in `App.tsx`**

Add state near the other view state (line ~85):

```ts
const [consoleOpen, setConsoleOpen] = useState(false)
```

Mount `<Console>` just before the final closing `</div>` of the App return (line ~696 region), so it overlays every view:

```tsx
      <Console open={consoleOpen} onClose={() => setConsoleOpen(false)} />
```

Import it at the top: `import { Console } from './components/Console'`.

In `runAction` (line 480), add the toggle **above** the `live.view !== 'environment'` guard at line 529 so it works from any view:

```ts
if (action === 'console-toggle') {
  setConsoleOpen((v) => !v)
  return
}
```

- [ ] **Step 8: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/shared/keybindings.ts src/renderer/src/components/KeybindingsEditor.tsx src/renderer/src/components/Console.tsx src/renderer/src/App.tsx tests/unit/keybindings.test.ts
git commit -m "feat: console-toggle binding + drawer shell"
```

---

### Task 5: Console content — subscription, filter bar, list, expand

**Files:**
- Modify: `src/renderer/src/components/Console.tsx` (full content: subscribe to `console:list`/`console:event`, filter bar, list newest-at-bottom + auto-scroll, expand-in-place)
- Modify: `src/renderer/src/App.tsx` (pass focus props for scope derivation to `<Console>`)

**Interfaces:**
- Consumes: `window.localflow.listConsole` / `onConsoleEvent` (Task 3); `visibleEvents`, `deriveConsoleScope`, `ConsoleFilter`, `ConsoleScope`, `ConsoleFocus` (Task 2); `ConsoleEvent`, `ConsoleSource` (Task 1).
- Produces: `Console` component now takes `{ open, onClose, focus: ConsoleFocus }`.

- [ ] **Step 1: Extend the Console props to receive focus**

In `App.tsx`, pass a derived focus object to the drawer:

```tsx
      <Console
        open={consoleOpen}
        onClose={() => setConsoleOpen(false)}
        focus={{ view, enlarged, environment }}
      />
```

- [ ] **Step 2: Implement the full drawer**

Replace `src/renderer/src/components/Console.tsx` with:

```tsx
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConsoleEvent, ConsoleSource } from '../../../shared/console'
import {
  visibleEvents,
  deriveConsoleScope,
  type ConsoleFilter,
  type ConsoleScope,
  type ConsoleFocus
} from '../../../shared/console-filter'

const SOURCES: ConsoleSource[] = ['status', 'operator', 'capture']

interface ConsoleProps {
  open: boolean
  onClose: () => void
  focus: ConsoleFocus
}

export function Console({ open, onClose, focus }: ConsoleProps): React.JSX.Element | null {
  const [events, setEvents] = useState<ConsoleEvent[]>([])
  const [sources, setSources] = useState<Set<ConsoleSource>>(new Set())
  const [scopeMode, setScopeMode] = useState<'auto' | ConsoleScope>('auto')
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // Snapshot on open + live subscription while mounted.
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.localflow.listConsole().then((snap) => {
      if (alive) setEvents(snap)
    })
    const off = window.localflow.onConsoleEvent((e) =>
      setEvents((prev) => [...prev, e])
    )
    return () => {
      alive = false
      off()
    }
  }, [open])

  const scope: ConsoleScope = scopeMode === 'auto' ? deriveConsoleScope(focus) : scopeMode
  const filter: ConsoleFilter = { sources, scope, text }
  const rows = visibleEvents(events, filter)

  // Auto-scroll to newest unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [rows.length, open])

  function onScroll(): void {
    const el = listRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  function toggleSource(s: ConsoleSource): void {
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  if (!open) return null

  return (
    <div
      data-console
      className="fixed right-0 bottom-0 left-0 z-40 flex flex-col border-t border-white/10 bg-black/80 text-white/80 backdrop-blur"
      style={{ height: 240 }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <div className="flex gap-1">
          {SOURCES.map((s) => (
            <button
              key={s}
              data-console-source={s}
              data-active={sources.size === 0 || sources.has(s)}
              className={`cursor-pointer rounded border px-1.5 py-0.5 ${
                sources.size === 0 || sources.has(s)
                  ? 'border-white/40 text-white'
                  : 'border-white/10 text-white/40'
              }`}
              onClick={() => toggleSource(s)}
              onMouseDown={(e) => e.preventDefault()}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            data-console-scope="everywhere"
            className="cursor-pointer rounded border border-white/20 px-1.5 py-0.5"
            onClick={() => setScopeMode({ kind: 'everywhere' })}
            onMouseDown={(e) => e.preventDefault()}
          >
            everywhere
          </button>
          {scopeMode !== 'auto' && (
            <button
              data-console-follow
              className="cursor-pointer rounded border border-white/20 px-1.5 py-0.5"
              onClick={() => setScopeMode('auto')}
              onMouseDown={(e) => e.preventDefault()}
            >
              follow
            </button>
          )}
        </div>
        <input
          data-console-text
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="filter…"
          className="min-w-0 flex-1 rounded border border-white/10 bg-transparent px-2 py-0.5 outline-none"
        />
        <button
          data-console-close
          className="cursor-pointer border-0 bg-transparent text-white/50 hover:text-white"
          onClick={onClose}
          onMouseDown={(e) => e.preventDefault()}
        >
          close
        </button>
      </div>
      <div
        ref={listRef}
        data-console-list
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 font-mono text-[12px]"
      >
        {rows.map((e) => (
          <div key={e.id} data-console-row data-source={e.source}>
            <button
              className="flex w-full cursor-pointer items-baseline gap-2 border-0 bg-transparent py-0.5 text-left text-white/80 hover:text-white"
              onClick={() => setExpanded((cur) => (cur === e.id ? null : e.id))}
              onMouseDown={(ev) => ev.preventDefault()}
            >
              <span className="text-white/40">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="text-white/50">env{e.environment}</span>
              <span className="flex-1">{e.label}</span>
            </button>
            {expanded === e.id && (
              <pre data-console-detail className="overflow-x-auto py-1 pl-16 text-white/60">
                {JSON.stringify(e.detail, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Console.tsx src/renderer/src/App.tsx
git commit -m "feat: console filter bar, live list, expand"
```

---

### Task 6: Persistence (height, open, last filter) and drag-resize

**Files:**
- Modify: `src/main/agent-registry.ts` (add `console?` field to `AgentConfig`, `KNOWN_TOP_LEVEL_KEYS`, parse in `loadAgentConfig`, getter/setter mirroring `theme`)
- Modify: `src/main/index.ts` (add `console:getPrefs` / `console:setPrefs` IPC mirroring `theme:get`/`theme:set`)
- Modify: `src/preload/index.ts` + `src/shared/api.ts` (`getConsolePrefs`, `setConsolePrefs`)
- Modify: `src/renderer/src/components/Console.tsx` (load prefs on mount; persist height/open/filter; real drag handle)
- Test: `tests/unit/agent-registry.test.ts` (or the existing config test) — round-trip of the console prefs

**Interfaces:**
- Consumes: `saveAgentConfig`/`loadAgentConfig` internals (agent-registry.ts).
- Produces: `ConsolePrefs { height: number; open: boolean; sources: ConsoleSource[]; text: string }`; IPC `console:getPrefs → ConsolePrefs`, `console:setPrefs(prefs) → void`; preload `getConsolePrefs()`, `setConsolePrefs(prefs)`.

- [ ] **Step 1: Define `ConsolePrefs` and add to config**

Add to `src/shared/console.ts`:

```ts
export interface ConsolePrefs {
  height: number
  open: boolean
  sources: ConsoleSource[]
  text: string
}

export const DEFAULT_CONSOLE_PREFS: ConsolePrefs = {
  height: 240,
  open: false,
  sources: [],
  text: ''
}
```

In `src/main/agent-registry.ts`: add `console?: ConsolePrefs` to `AgentConfig`; add `'console'` to `KNOWN_TOP_LEVEL_KEYS`; in `loadAgentConfig`, validate/copy the field (fall back to `DEFAULT_CONSOLE_PREFS` on any malformed shape — mirror how `theme` is guarded); add `getConsolePrefs()` / `setConsolePrefs(prefs)` mirroring `getTheme`/`setTheme` (setter mutates `config.console` and calls `saveAgentConfig`).

- [ ] **Step 2: Write the round-trip test**

In the existing agent-registry config test (or a new `tests/unit/console-prefs.test.ts` mirroring `capture-ingest.test.ts`'s temp-dir pattern), write defaults when missing, set prefs, reload, and assert the values persist. Assert a config.json lacking `console` loads with `DEFAULT_CONSOLE_PREFS`.

- [ ] **Step 3: Run it to verify it fails, then implement, then pass**

Run: `npm test -- console-prefs` (or the config test name)
Expected: FAIL, then implement Step 1, then PASS.

- [ ] **Step 4: Add IPC + preload + api**

`index.ts`: `ipcMain.handle('console:getPrefs', () => getConsolePrefs())` and `ipcMain.on('console:setPrefs', (_e, prefs) => setConsolePrefs(prefs))` (mirror `theme:get`/`theme:set` at lines 729-739). Declare `getConsolePrefs(): Promise<ConsolePrefs>` and `setConsolePrefs(prefs: ConsolePrefs): void` on `LocalflowApi`; implement in preload.

- [ ] **Step 5: Load + persist in the drawer, and add a drag handle**

In `Console.tsx`: on first mount call `getConsolePrefs()` to seed `height`, `sources`, `text`, and lift `open` to App's initial `consoleOpen` (App reads prefs once at startup and seeds `useState`). On changes to height/open/sources/text, debounce a `setConsolePrefs(...)`. Add a top-edge drag handle (`data-console-resize`) that updates `height` via pointer events, clamped to a sane min/max (e.g. 120–600px).

- [ ] **Step 6: Typecheck, unit, build**

Run: `npm run typecheck && npm test -- console && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/console.ts src/main/agent-registry.ts src/main/index.ts src/preload/index.ts src/shared/api.ts src/renderer/src/components/Console.tsx tests/unit/
git commit -m "feat: persist console prefs + drag-resize"
```

---

### Task 7: Row actions (re-run watchpoint, open source view)

**Files:**
- Create: `src/shared/console-actions.ts` (pure guards: which actions a row supports)
- Modify: `src/renderer/src/components/Console.tsx` (render row actions; call existing IPC)
- Test: `tests/unit/console-actions.test.ts`

**Interfaces:**
- Consumes: `ConsoleEvent` (Task 1); existing watchpoint re-arm IPC and session-focus mechanism.
- Produces: `rowActions(event): ConsoleRowAction[]` where `ConsoleRowAction = 'rerun-watchpoint' | 'open-source'`.

- [ ] **Step 1: Write the failing guard test**

Create `tests/unit/console-actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rowActions } from '../../src/shared/console-actions'
import type { ConsoleEvent } from '../../src/shared/console'

function row(source: ConsoleEvent['source'], detail: ConsoleEvent['detail']): ConsoleEvent {
  return { id: 'x', ts: 1, source, environment: 1, label: 'l', detail }
}

describe('rowActions', () => {
  it('offers rerun-watchpoint + open-source on capture rows', () => {
    const e = row('capture', { source: 'capture', watchpointId: 'w', captureId: 'c', halted: false })
    expect(rowActions(e).sort()).toEqual(['open-source', 'rerun-watchpoint'])
  })

  it('offers only open-source on status and operator rows', () => {
    expect(rowActions(row('status', { source: 'status', kind: 'Stop', status: 'idle' }))).toEqual(['open-source'])
    expect(rowActions(row('operator', { source: 'operator', action: 'x' }))).toEqual(['open-source'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- console-actions`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `src/shared/console-actions.ts`**

```ts
import type { ConsoleEvent } from './console'

export type ConsoleRowAction = 'rerun-watchpoint' | 'open-source'

export function rowActions(event: ConsoleEvent): ConsoleRowAction[] {
  if (event.source === 'capture') return ['rerun-watchpoint', 'open-source']
  return ['open-source']
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- console-actions`
Expected: PASS.

- [ ] **Step 5: Wire the actions in the drawer**

In `Console.tsx`, in the expanded-detail region, render a button per `rowActions(e)`:
- `open-source`: for status rows, focus the session (`window.localflow` existing focus/select mechanism — mirror how a session row elsewhere navigates); for operator/capture rows, open the cockpit for `e.environment`. Wire via the App by passing an `onOpenSource(event)` callback prop into `<Console>` (App owns view/enlarged setters).
- `rerun-watchpoint`: capture rows only — re-arm via the existing operator watchpoint registration IPC for `detail.watchpointId` in `e.environment`. Pass an `onRerunWatchpoint(event)` callback prop from App (or call the existing control/watchpoint IPC directly if exposed on `window.localflow`). Keep the drawer show-not-author: no request composition.

Add the two callback props to `ConsoleProps` and supply them from `App.tsx`.

- [ ] **Step 6: Typecheck, unit, build**

Run: `npm run typecheck && npm test -- console && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/console-actions.ts tests/unit/console-actions.test.ts src/renderer/src/components/Console.tsx src/renderer/src/App.tsx
git commit -m "feat: console row actions (reflect-and-replay)"
```

---

### Task 8: End-to-end coverage

**Files:**
- Create: `tests/e2e/console.spec.ts`

**Interfaces:**
- Consumes: the whole feature; the control-API endpoint (`endpoint.json` `{ port, token }`, header `X-Localflow-Token`); `launchApp` helper conventions from `smoke.spec.ts`.

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/console.spec.ts` mirroring `smoke.spec.ts` conventions (`mkdtempSync` userData, `launchApp`, `LOCALFLOW_E2E=1`, stable `data-*` selectors). Cover:

1. **Toggle**: press `Meta+/` → `[data-console]` visible; press again → hidden. Then rebind `console-toggle` (write `keybindings.json` or via Settings), relaunch, and toggle with the remapped key.
2. **Three sources appear**: create a session and drive a hook event → a `[data-console-row][data-source="status"]` appears; POST an operator action via the control API → `[data-source="operator"]`; register + POST a watchpoint capture → `[data-source="capture"]`, and clicking it reveals `[data-console-detail]`.
3. **Filters**: click a `[data-console-source]` chip → assert only matching rows; type in `[data-console-text]` → assert substring narrowing; click `[data-console-scope="everywhere"]` and assert the pinned set.
4. **Scope follow + pin**: enlarge into a session → assert the timeline narrows to that session's rows; click `everywhere` (pin) → assert it stays while navigating; click `[data-console-follow]` → auto resumes.
5. **Resize + relaunch persistence**: drag `[data-console-resize]` to change height, close, relaunch against the same userData → assert height + open state remembered (re-read `config.json` `console` field, mirroring the theme/keybindings persistence assertions at smoke.spec.ts:1104-1108).

- [ ] **Step 2: Run e2e**

Run: `npm run e2e -- console.spec`
Expected: all cases PASS.

- [ ] **Step 3: Full suite gate**

Run: `npm run check && npm run e2e`
Expected: lint + typecheck + all unit + all e2e green.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/console.spec.ts
git commit -m "test: e2e for bottom console"
```

---

## Self-Review Notes

- **Spec coverage:** bus/ring + since-launch (T1), three sources tapped additively (T3), IPC snapshot+push (T3), pure filter reducer + scope follow/pin (T2, T5), drawer UX with newest-at-bottom/auto-scroll/expand (T5), keybinding `cmd+/` (T4), persistence + drag-resize (T6), row actions reflect-and-replay with guards (T7), full e2e (T8). Network source is reserved in the enum (T1) and never produced — matches "deferred to v2."
- **Additive guarantee:** every tap keeps the existing `sendToWindow`/`record` call and adds a `bus.emit` beside it; `onCapture` is an optional dep so control-api behavior is unchanged when unset.
- **Type consistency:** `ConsoleEventInput = Omit<ConsoleEvent,'id'|'ts'>` is produced by mappers and consumed by `bus.emit`; `ConsoleFocus` shape (`view`/`enlarged`/`environment`) matches App state exactly; `ConsolePrefs.sources` is `ConsoleSource[]` serialized (Set is rebuilt in the renderer).
- **Deferred detail:** T7's exact `open-source`/`rerun-watchpoint` IPC wiring depends on the existing session-focus + watchpoint-register APIs; the implementer must confirm the concrete `window.localflow` methods at implementation time and pass App callbacks rather than reaching into main directly.
