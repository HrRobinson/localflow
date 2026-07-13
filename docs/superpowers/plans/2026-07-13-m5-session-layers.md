# M5 Session Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions become parent nodes owning multiple panes (agent terminal + companions), with grouped-grid rendering, hierarchy-aware close/enlarge navigation, four creation flows, and an operator route.

**Architecture:** A `SessionGroup` layer over untouched per-pane records (`SessionInfo` gains optional `groupId`). SessionManager owns group CRUD + invariants; persistence moves to a versioned object shape with legacy-array compat; the renderer clusters panes by group and turns enlarge into a two-step staircase. Spec: `docs/superpowers/specs/2026-07-13-m5-session-layers-design.md`.

**Tech Stack:** Electron main (Node 22), React renderer, vitest unit tests in `tests/unit/`, Playwright e2e in `tests/e2e/`.

## Global Constraints

- Conventional Commits, subject ≤50 chars (husky commitlint + CI; PR title too — squash merge).
- PUBLIC repo: no personal notes, no maintainer references, no "NEEDS-JONAS".
- `npm run check` (lint + typecheck + unit) must pass at every task boundary.
- Never trust a cwd or file path from the renderer or the control API — always resolve from the main-process session record (pattern: the `git:status` handler in `src/main/index.ts`).
- The renderer never sees secrets; control-API additions must be env-scoped through the existing grant model.
- e2e affordances only under `LOCALFLOW_E2E === '1'`.
- UI copy: the group is a "session", children are "panes". Code keeps `SessionInfo` as the pane record.
- All new keybindings are remappable actions in `src/shared/keybindings.ts` with non-conflicting defaults.
- Status rollup ALWAYS uses the existing `worstStatus` from `src/shared/environment.ts` — do not write a second priority order.

---

### Task 1: SessionGroup type + persistence v2 (versioned file, legacy compat, atomic write)

**Files:**
- Modify: `src/shared/types.ts` (add `SessionGroup`, add `groupId?` to `SessionInfo`)
- Modify: `src/main/persistence.ts`
- Test: `tests/unit/persistence.test.ts` (create if absent, vitest style of `tests/unit/session-manager.test.ts`)

**Interfaces:**
- Produces: `interface SessionGroup { id: string; name: string; environment: number }` (types.ts); `SessionInfo.groupId?: string`; `SavedSession.groupId?: string`;
  `interface SavedState { sessions: SavedSession[]; groups: SessionGroup[] }`;
  `loadSavedState(file: string): SavedState` (replaces `loadSavedSessions` — update the one caller later in Task 3; keep old export removed, not deprecated);
  `saveState(file: string, state: SavedState): void` (atomic: write `file + '.tmp'`, `renameSync` over `file`; replaces `saveSessions`).

- [ ] **Step 1: Write failing tests** covering: (a) legacy bare-array file loads as `{ sessions: [...], groups: [] }`; (b) v2 object round-trips sessions + groups; (c) malformed groups entries (non-string id/name, non-number environment) are dropped; (d) unreadable/absent file → empty state; (e) `saveState` leaves no `.tmp` behind and the target parses.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSavedState, saveState } from '../../src/main/persistence'

describe('persistence v2', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lf-persist-'))
    file = join(dir, 'sessions.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('loads a legacy bare-array file as all-solo state', () => {
    writeFileSync(file, JSON.stringify([{ id: 'a', cwd: '/x' }]))
    const state = loadSavedState(file)
    expect(state.sessions).toEqual([{ id: 'a', cwd: '/x' }])
    expect(state.groups).toEqual([])
  })

  it('round-trips the v2 object shape atomically', () => {
    saveState(file, {
      sessions: [{ id: 'a', cwd: '/x', groupId: 'g1' }],
      groups: [{ id: 'g1', name: 'checkout', environment: 2 }]
    })
    expect(existsSync(file + '.tmp')).toBe(false)
    const state = loadSavedState(file)
    expect(state.sessions[0].groupId).toBe('g1')
    expect(state.groups).toEqual([{ id: 'g1', name: 'checkout', environment: 2 }])
  })

  it('drops malformed group entries, keeps valid ones', () => {
    writeFileSync(
      file,
      JSON.stringify({
        sessions: [],
        groups: [{ id: 'g1', name: 'ok', environment: 1 }, { id: 7 }, 'junk', null]
      })
    )
    expect(loadSavedState(file).groups).toEqual([{ id: 'g1', name: 'ok', environment: 1 }])
  })

  it('returns empty state for a missing or corrupt file', () => {
    expect(loadSavedState(join(dir, 'nope.json'))).toEqual({ sessions: [], groups: [] })
    writeFileSync(file, '{{{')
    expect(loadSavedState(file)).toEqual({ sessions: [], groups: [] })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/persistence.test.ts` — expect FAIL (`loadSavedState` not exported).
- [ ] **Step 3: Implement.** In types.ts add (next to `SessionInfo`):

```ts
/** UI: "session". A parent node owning ≥1 panes in one environment (M5). */
export interface SessionGroup {
  id: string
  name: string
  environment: number
}
```

and on `SessionInfo`: `/** Group ("session") this pane belongs to; absent = solo pane. */ groupId?: string`.
In persistence.ts: `SavedSession` gains `groupId?: string`; keep the existing per-session filter exactly as-is, add:

```ts
export interface SavedState {
  sessions: SavedSession[]
  groups: SessionGroup[]
}

const isGroup = (g: unknown): g is SessionGroup =>
  typeof g === 'object' && g !== null &&
  typeof (g as SessionGroup).id === 'string' &&
  typeof (g as SessionGroup).name === 'string' &&
  typeof (g as SessionGroup).environment === 'number'

export function loadSavedState(file: string): SavedState {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    // Legacy shape (pre-M5): a bare array of sessions, no groups.
    if (Array.isArray(data)) return { sessions: filterSessions(data), groups: [] }
    if (typeof data !== 'object' || data === null) return { sessions: [], groups: [] }
    const obj = data as { sessions?: unknown; groups?: unknown }
    return {
      sessions: Array.isArray(obj.sessions) ? filterSessions(obj.sessions) : [],
      groups: Array.isArray(obj.groups) ? obj.groups.filter(isGroup) : []
    }
  } catch {
    return { sessions: [], groups: [] }
  }
}

export function saveState(file: string, state: SavedState): void {
  // Atomic: a crash mid-write must never leave a truncated sessions.json.
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file)
}
```

where `filterSessions` is the existing filter+map body of `loadSavedSessions` extracted verbatim. Delete `loadSavedSessions`/`saveSessions` (Task 3 updates the sole caller in index.ts; until then `npm run check` typecheck will flag it — acceptable inside one task ONLY if Task 1 and the index.ts caller-swap commit together; to keep the build green instead, keep thin wrappers `loadSavedSessions`/`saveSessions` delegating to the new functions and delete them in Task 3).
- [ ] **Step 4: Run** the test file — PASS — then `npm run check`.
- [ ] **Step 5: Commit** `feat: versioned session persistence with groups`

---

### Task 2: SessionManager group CRUD + invariants

**Files:**
- Modify: `src/main/session-manager.ts`
- Test: `tests/unit/session-manager.test.ts` (append a `describe('groups', ...)`)

**Interfaces:**
- Consumes: `SessionGroup` from Task 1.
- Produces (on `SessionManager`):
  - `createGroup(name: string, environment: number): SessionGroup`
  - `renameGroup(id: string, name: string): SessionGroup | null`
  - `assignToGroup(paneId: string, groupId: string | null): SessionInfo | null` — null groupId = ungroup; rejects (returns null) when group and pane environments differ or group unknown.
  - `listGroups(): SessionGroup[]`; `getGroup(id: string): SessionGroup | null`
  - `restoreGroups(groups: SessionGroup[]): void` — bulk-load at startup BEFORE session restore; drops nothing (validation happened in persistence).
  - Invariant hooks: `deleteSession` also deletes a group that lost its last member; `setEnvironment` on a grouped pane moves the WHOLE group (group + every member pane, one `moved` activity per pane, single changed callback at the end).
  - All group mutations fire the existing `changedCbs` (renderer refresh + persistence reuse the sessions-changed path).

- [ ] **Step 1: Write failing tests** (use the file's existing fake-spawn helpers):

```ts
describe('groups', () => {
  it('createGroup + assignToGroup sets groupId; ungroup clears it', () => { /* create mgr, 1 session; createGroup('g', 1); assign; expect(list()[0].groupId).toBe(g.id); assign null; expect undefined */ })
  it('assignToGroup rejects cross-environment assignment', () => { /* session on env 1, group on env 2 → null, groupId unchanged */ })
  it('deleting the last member deletes the group', () => { /* 1 grouped pane; deleteSession; listGroups() empty */ })
  it('deleting a non-last member keeps the group', () => { /* 2 grouped panes; delete one; group remains */ })
  it('closeTerminal never touches groups', () => { /* grouped pane; closeTerminal; groupId intact, group alive */ })
  it('setEnvironment on a grouped pane moves the whole group', () => { /* 2 panes in group on env1 + 1 solo; setEnvironment(member, 3); BOTH members + group now env 3; solo untouched */ })
  it('renameGroup trims and ignores empty, like session rename', () => {})
  it('restoreGroups then restore() members reconnects groupId', () => { /* restoreGroups([g]); restore(id,...) with groupId via new optional param — see Step 3 */ })
})
```

Write these as real assertions following the existing test file's construction patterns (SpawnFn fake, `now` override).
- [ ] **Step 2: Run** `npx vitest run tests/unit/session-manager.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Add `private groups = new Map<string, SessionGroup>()`. Methods per the Interfaces block; `createGroup` uses `randomUUID()` + `clampEnvironment`. `restore(...)` and `restoreBrowser(...)` gain a final optional `groupId?: string` param (set on info only when the group exists in the map and environments match). In `deleteSession`, after `this.sessions.delete(id)`: if the deleted info had a groupId and no remaining session carries it, `this.groups.delete(groupId)`. In `setEnvironment`: if the target has a groupId, clamp once, set the group's environment and every member's, record `moved` per member, fire changed once, return the requested pane's snapshot. `assignToGroup` fires changed + records a `moved` activity on the pane.
- [ ] **Step 4: Run** tests — PASS — `npm run check`.
- [ ] **Step 5: Commit** `feat: session groups in SessionManager`

---

### Task 3: Wiring — startup restore, save, IPC, api/preload

**Files:**
- Modify: `src/main/index.ts` (restore + save + new IPC), `src/shared/api.ts`, `src/preload/index.ts` (follow the exact pattern of neighboring session methods)
- Test: extend `tests/unit/session-manager.test.ts` only if gaps appear; this task is wiring, verified by typecheck + e2e later.

**Interfaces:**
- Consumes: Task 1 `loadSavedState`/`saveState`, Task 2 group methods.
- Produces IPC channels (with api/preload methods of the same camelCase names used elsewhere):
  - `group:create` `(name: string, environment: number) → SessionGroup`
  - `group:rename` `(id: string, name: string) → SessionGroup | null`
  - `group:assign` `(paneId: string, groupId: string | null) → SessionInfo | null`
  - `group:list` `() → SessionGroup[]`
  - api.ts: `createGroup`, `renameGroup`, `assignToGroup`, `listGroups`.

- [ ] **Step 1: Replace persistence calls.** Startup: `const state = loadSavedState(sessionsFile)`; call `manager.restoreGroups(state.groups)` BEFORE the session loop; pass `saved.groupId` through both `manager.restore(...)` and `manager.restoreBrowser(...)` (new last arg). Save (inside the existing `onSessionsChanged` handler): map `groupId` into the saved session objects and write `saveState(sessionsFile, { sessions, groups: manager.listGroups() })`. Delete the Task-1 compat wrappers.
- [ ] **Step 2: Register the four IPC handlers** next to `session:rename`, with boundary validation (`typeof name === 'string'`, `typeof paneId === 'string'`), mirroring neighbors.
- [ ] **Step 3: api/preload.** Extend `window.localflow` exactly like `renameSession` is done today (same file positions, same typing style).
- [ ] **Step 4:** `npm run check` — PASS (this is the task that must remove any Task-1 leftovers).
- [ ] **Step 5: Commit** `feat: wire session groups through IPC`

---

### Task 4: Grouped grid rendering + group header with rollup

**Files:**
- Modify: `src/renderer/src/App.tsx` (grid render for `view === 'environment'`), `src/renderer/src/styles.css`
- Create: `src/renderer/src/components/GroupBox.tsx`
- Test: renderer logic that's pure (grouping/ordering) goes in `tests/unit/` — create `tests/unit/group-order.test.ts` for the helper below.

**Interfaces:**
- Consumes: `listGroups`/`groups` state (poll with the existing `refresh()` — add `const [groups, setGroups] = useState<SessionGroup[]>([])` populated in the same `refresh` callback), `worstStatus` from `src/shared/environment.ts`.
- Produces: pure helper in `src/shared/group-order.ts`:
  `groupedOrder(order: string[], panes: SessionInfo[]): Array<{ group: string | null; ids: string[] }>` — walks `order`, emits contiguous runs: each group appears once at the position of its FIRST member (all members pulled adjacent, preserving their relative order); solo panes emit `{ group: null, ids: [id] }`.
- Produces: `GroupBox` component — props `{ group: SessionGroup; status: SessionStatus; onAddPane: () => void; onEnlargeSession: () => void; children: ReactNode }`; renders `.group-box` with `.group-header` (`data-group-id`, name, `.group-rollup[data-status]` dot, `+` button `.group-add-pane`, header click = `onEnlargeSession`).

- [ ] **Step 1: Write failing tests for `groupedOrder`** — order `[a,b,c,d]` where a,c share g1: result `[{group:'g1',ids:['a','c']},{group:null,ids:['b']},{group:null,ids:['d']}]`; empty inputs; unknown ids in order are skipped.
- [ ] **Step 2:** Run — FAIL. **Implement** `group-order.ts` (pure, ~20 lines). Run — PASS.
- [ ] **Step 3: Render.** In App.tsx's environment grid, map `groupedOrder(order, envSessions)`: `group: null` runs render exactly the current pane element (unchanged); grouped runs render `<GroupBox ...>` wrapping the same pane elements. Rollup: `worstStatus(members.map((m) => m.status))`. `onAddPane`/`onEnlargeSession` are stubs (`() => {}`) until Tasks 6/8. CSS: `.group-box { border: 1px solid var(--border); border-radius: 8px; padding: 4px }`, `.group-header` matches existing pane-header typography; reuse the existing status-dot classes for the rollup dot (grep `data-status` in styles.css and reuse those selectors).
- [ ] **Step 4:** `npm run check`; launch `npm run dev` briefly and verify solo panes look unchanged.
- [ ] **Step 5: Commit** `feat: grouped grid with rollup headers`

---

### Task 5: Hierarchy-aware close focus

**Files:**
- Modify: `src/renderer/src/App.tsx` (the close-pane handler)
- Create: `src/shared/close-focus.ts` + `tests/unit/close-focus.test.ts`

**Interfaces:**
- Produces: `nextFocusAfterClose(closedId: string, order: string[], panes: SessionInfo[]): string | null` — prefer the nearest pane (by `order` distance, earlier wins ties) sharing the closed pane's `groupId` (when it has one); else the nearest pane in `order`; null when none remain. "Closed" here = pty closed, pane still exists — the function is also used by delete, where the pane is gone from `panes` but still present in the passed `order` snapshot; implement against explicit args, no component state.

- [ ] **Step 1: Failing tests:** grouped sibling wins over a nearer non-sibling; falls back to nearest when solo; returns null for last pane; tie prefers earlier in order.
- [ ] **Step 2:** FAIL → implement (pure) → PASS.
- [ ] **Step 3:** Use it in App.tsx wherever close/delete currently recomputes `activeId` (grep `setActiveId` near the close handlers; replace the ad-hoc next-pane logic).
- [ ] **Step 4:** `npm run check`.
- [ ] **Step 5: Commit** `feat: close focuses group sibling first`

---

### Task 6: Enlarge staircase + breadcrumbs + sibling strip

**Files:**
- Modify: `src/renderer/src/App.tsx` (`enlarged` state shape + `enlarge-toggle`/`go-up` handlers), `src/renderer/src/styles.css`
- Create: `src/renderer/src/components/Breadcrumb.tsx`

**Interfaces:**
- `enlarged` becomes `{ id: string; level: 'pane' | 'session' } | null` (id is always a PANE id; `'session'` means "show every pane of id's group side by side"). Grep every `enlarged` usage in App.tsx and update — the compiler is the checklist.
- `enlarge-toggle` cycle: `null → { id: active, level: 'pane' }`; from `'pane'`: if the pane has a groupId → `{ level: 'session' }`, else `null`; from `'session'` → `null`.
- `go-up` (existing `cmd+escape`) walks one step UP: `'session'` → `'pane'` → `null` → existing go-home behavior (preserve current semantics when nothing is enlarged).
- `Breadcrumb` props: `{ envName: string; groupName?: string; paneName?: string }` — renders `.breadcrumb` bar with ` › ` separators; env names from the existing environment-names api the Sidebar uses (grep `visibleEnvironments`/env-name usage and reuse).
- Sibling strip (pane level, grouped panes only): `.sibling-strip` of buttons (`data-pane-id`, pane name, status dot) above the enlarged pane; click switches `enlarged.id` (stays at pane level). Session level: render the group's panes in a simple side-by-side flex row, each with its normal pane header.
- Both levels render a `.spin-up-pane` button (wired to a stub until Task 8; label "spin up a pane here").

- [ ] **Step 1:** Update the `enlarged` type and mechanically fix all usages (typecheck-driven). Existing behavior parity first: single-pane enlarge must look exactly as today, plus the breadcrumb bar.
- [ ] **Step 2:** Implement the cycle + walk-up in the two key handlers; solo panes must skip the session level (test manually: solo enlarge-toggle twice returns to grid).
- [ ] **Step 3:** Breadcrumb + sibling strip + session-level layout + CSS (match existing header styles; keep it thin).
- [ ] **Step 4:** `npm run check`; `npm run dev` sanity: grouped pane cycles grid→pane→session→grid; go-up walks backwards; solo unchanged.
- [ ] **Step 5: Commit** `feat: enlarge staircase with breadcrumbs`

---

### Task 7: Shell agent preset

**Files:**
- Modify: `src/shared/agents.ts` (preset table + `AgentId` in `src/shared/types.ts`), `src/main/agent-registry.ts` (only if detection needs a branch — the user's shell always exists)
- Test: extend the existing agents/registry unit tests (grep `AGENT_PRESETS` in tests/).

**Interfaces:**
- `AgentId` gains `'shell'`. Preset: label "Shell", command = `process.env.SHELL || '/bin/zsh'` resolved MAIN-side (shared/agents.ts must stay env-free if it's imported by the renderer — put the SHELL fallback in the main-side spec builder `specFor`, mirroring how custom commands flow), `hookAdapter: 'none'`, `resumeArgs: []`, statusFidelity 'none'.
- Follow Task 1 of the openclaw-launch plan (`docs/superpowers/plans/2026-07-11-openclaw-operator-launch.md`) as the reference for every table that must gain the new id (`AGENT_PRESETS`, `VALID_AGENTS`, `KNOWN_AGENT_IDS`, detection). No e2e binary override needed — a real shell exists in CI.

- [ ] **Step 1:** Failing test: `specFor('shell')` yields hookAdapter 'none' and a non-empty command; launcher list includes Shell.
- [ ] **Step 2:** FAIL → implement → PASS; `npm run check`.
- [ ] **Step 3: Commit** `feat: shell agent preset`

---

### Task 8: Add-pane flow (picker + main-side pane-ops)

**Files:**
- Create: `src/main/pane-ops.ts`, `src/renderer/src/components/AddPanePicker.tsx`
- Modify: `src/main/index.ts` (IPC `group:addPane`), `src/shared/api.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx` (wire GroupBox `+`, the `spin-up-pane` buttons, and new keybinding `add-pane`), `src/shared/keybindings.ts`
- Test: `tests/unit/pane-ops.test.ts`

**Interfaces:**
- Produces `src/main/pane-ops.ts`:

```ts
export type AddPaneRequest =
  | { kind: 'terminal'; agentId: AgentId; customCommand?: string }
  | { kind: 'browser'; url: string }

/**
 * Adds a companion pane next to `sourcePaneId`: reuses its group, or wraps a
 * solo source into a fresh group named after it. cwd/environment come from
 * the SOURCE RECORD, never from the caller. Returns the new pane or null
 * (unknown source, invalid request).
 */
export function addCompanionPane(
  manager: SessionManager,
  specFor: (agentId: AgentId, customCommand?: string) => SpawnSpec,
  sourcePaneId: string,
  req: AddPaneRequest
): SessionInfo | null
```

Implementation: look up source via `manager.get`; resolve group = source.groupId ?? `manager.createGroup(source.name, source.environment).id` (then `assignToGroup(source.id, groupId)`); create pane (`manager.create(source.cwd || homedir(), specFor(...), source.environment)` for terminal — browser panes have empty cwd, fall back to `homedir()`; `manager.createBrowser(req.url, source.environment)` for browser); `assignToGroup(newPane.id, groupId)`; return the fresh snapshot.
- New keybinding: `'add-pane': 'cmd+t'` (verify no conflict in DEFAULT_BINDINGS — there is none).
- IPC `group:addPane (sourcePaneId: string, req: AddPaneRequest) → SessionInfo | null`; api method `addPane`.
- `AddPanePicker` props `{ onPick: (req: AddPaneRequest) => void; onCancel: () => void; agents: AgentInfo[] }` — minimal modal (reuse the Landing picker's CSS classes where possible): agent buttons (incl. Shell), a URL input + "Browser" button. Opens from: GroupBox `+`, breadcrumb `spin-up-pane`, `add-pane` keybinding on the focused pane.

- [ ] **Step 1:** Failing pane-ops tests: wraps solo into named group; reuses existing group; cross checks — cwd inherited from source record even when caller lies (no caller cwd exists in the signature — assert cwd equals source's); browser source (empty cwd) falls back to homedir for a terminal companion; unknown source → null.
- [ ] **Step 2:** FAIL → implement pane-ops → PASS.
- [ ] **Step 3:** IPC + api/preload + keybinding + picker component + App wiring (replace Task 4/6 stubs). Picker focus: Escape cancels, matches existing modal conventions if one exists (grep for an existing overlay/modal pattern in App.tsx — the resume overlay — and follow it).
- [ ] **Step 4:** `npm run check`; dev-app sanity: `+` on a solo pane groups it and adds a shell pane in the same cwd.
- [ ] **Step 5: Commit** `feat: add companion panes to sessions`

---

### Task 9: Group/ungroup existing panes

**Files:**
- Modify: `src/shared/keybindings.ts` (`'group-pane': 'cmd+g'`, `'ungroup-pane': 'cmd+shift+g'`), `src/renderer/src/App.tsx`
- Create: `src/renderer/src/components/GroupPicker.tsx`

**Interfaces:**
- Consumes: `assignToGroup` IPC (Task 3), `createGroup` IPC.
- `GroupPicker` props `{ groups: SessionGroup[]; onPick: (groupId: string | 'new') => void; onCancel: () => void }` — lists the CURRENT environment's groups + "New session…" (creates a group named after the pane, then assigns).
- `ungroup-pane` needs no picker: assignToGroup(active, null).

- [ ] **Step 1:** Implement both actions + picker (same modal conventions as Task 8). Cross-environment groups must not appear (filter by current `environment`).
- [ ] **Step 2:** `npm run check`; dev sanity: group two panes, ungroup one, group persists across app restart (verifies Task 3 save/restore end-to-end).
- [ ] **Step 3: Commit** `feat: group and ungroup panes by keyboard`

---

### Task 10: Session templates

**Files:**
- Create: `src/shared/templates.ts`, `tests/unit/templates.test.ts`
- Modify: `src/main/index.ts` (IPC `templates:list`, `templates:create`), `src/shared/api.ts`, `src/preload/index.ts`, `src/renderer/src/components/Landing.tsx`

**Interfaces:**
- `src/shared/templates.ts`:

```ts
export interface TemplatePane {
  kind: 'terminal' | 'browser'
  agentId?: AgentId   // terminal only; default 'claude'
  url?: string        // browser only; required
}
export interface SessionTemplate { name: string; panes: TemplatePane[] }
/** Non-fatal: malformed entries are skipped; never throws. */
export function parseSessionTemplates(raw: unknown): SessionTemplate[]
```

- config.json key: `sessionTemplates` (read fresh from the config file per call, following the `loadEditorCommand` read-fresh pattern in `src/main/editor-config.ts`).
- IPC `templates:list () → SessionTemplate[]`; `templates:create (name: string, cwd: string | undefined, environment: number) → SessionInfo[] | null` — dialog for cwd unless `LOCALFLOW_E2E` (copy the `session:create` dir logic verbatim); creates a group named after the PROJECT dir (`basename(cwd)`), then one pane per template entry via Task 8's pane-ops (`addCompanionPane` from the first-created pane, or direct create+assign — pick one and stay consistent), skipping panes whose agent binary is missing rather than failing the whole template.
- Landing: template cards render beside agent cards (reuse card CSS), label = template name, subtitle = pane summary ("claude + browser").

- [ ] **Step 1:** Failing parse tests: valid template passes; entry with bad kind skipped; browser without url skipped; terminal defaults agentId claude; non-array → []; whole template with zero valid panes → skipped.
- [ ] **Step 2:** FAIL → implement parser → PASS.
- [ ] **Step 3:** IPC + api/preload + Landing cards.
- [ ] **Step 4:** `npm run check`; dev sanity with a hand-written template in config.json.
- [ ] **Step 5: Commit** `feat: session templates in new-session picker`

---

### Task 11: Operator route POST /panes

**Files:**
- Modify: `src/main/control-api.ts` (route + `ControlDeps`), `src/main/index.ts` (dep wiring)
- Test: `tests/unit/control-api.test.ts` (append)

**Interfaces:**
- Consumes: Task 8 `addCompanionPane` / Task 2 group methods.
- `ControlDeps` gains:

```ts
panes: {
  /** Create a pane inside `environment`; groupId (if set) must belong to it. */
  create(environment: number, req: OperatorPaneRequest): SessionInfo | null
}
export type OperatorPaneRequest =
  | { kind: 'browser'; url: string; groupId?: string }
  | { kind: 'terminal'; agentId: AgentId; groupId: string } // groupId REQUIRED: cwd comes from a group member
```

- Route `POST /panes` (note: extend the router where `/panes/:handle/...` is matched — a bare `/panes` POST must not collide with the existing GET /panes listing): auth first (existing pattern), parse body (existing JSON-parse safety), env from token, validate: bad kind/missing fields → 400 `{ error: 'invalid pane request' }`; groupId not in this environment → 400 `{ error: 'unknown group' }` (same wording for a foreign env's group — do not leak existence); terminal cwd = first member pane of the group with a non-empty cwd, else 400. On success 200 with the pane snapshot; record an `operator:activity` entry like neighboring routes.
- index.ts implements `deps.panes.create` with the same helper used by IPC — one code path.

- [ ] **Step 1:** Failing router tests (follow the file's existing deps() fixture): happy browser create in own env; terminal create pulls cwd from group member; groupId from another env → 400 'unknown group'; kind 'x' → 400; no token → 403.
- [ ] **Step 2:** FAIL → implement → PASS; `npm run check`.
- [ ] **Step 3:** Update `openclaw/skills/localflow/SKILL.md` + the CLI (`localflow-control.mjs` buildRequest) with the new verb, mirroring how existing verbs are documented/built; extend its CLI test.
- [ ] **Step 4: Commit** `feat: operator can add panes via control API`

---

### Task 12: Resume dead-end UX

**Files:**
- Modify: `src/main/session-manager.ts` (flag), `src/shared/types.ts` (`SessionInfo.resumeFailed?: boolean`), `src/renderer/src/components/TerminalPane.tsx` (overlay button order/copy)
- Test: `tests/unit/session-manager.test.ts` (append)

**Interfaces:**
- `restart(id, fresh=false)` remembers `resume = !fresh`; when the resulting pty INSTANT-EXITS (existing `INSTANT_EXIT_MS` path in the `onExit` closure), and the spawn was a resume, set `info.resumeFailed = true`. Any later successful restart (status leaves 'exited') clears it. Never persisted (in-memory like `needsYouSince` — do NOT add it to the save mapping).
- TerminalPane's dead overlay (grep the resume/fresh buttons): when `info.resumeFailed`, "Start fresh" renders first/primary (reuse the existing primary-button class) and the message line shows `info.message` plus a fixed one-liner: "Resume failed instantly — this conversation may be gone."

- [ ] **Step 1:** Failing manager test: restart(resume) with a spawnFn whose pty exits immediately → `resumeFailed` true; restart(fresh) after that → flag cleared on spawn; instant exit of a FRESH start does not set it.
- [ ] **Step 2:** FAIL → implement (thread a `resumeAttempt` boolean through `spawn` into the `onExit` closure's instant-exit branch) → PASS.
- [ ] **Step 3:** TerminalPane overlay change; `npm run check`.
- [ ] **Step 4: Commit** `feat: promote start fresh on dead resume`

---

### Task 13: e2e suite + docs

**Files:**
- Create: `tests/e2e/groups.spec.ts`
- Modify: `README.md` (sessions & panes section + new keybindings), `tests/e2e/smoke.spec.ts` ONLY if selectors it uses changed (grid markup for solo panes must be unchanged — prefer zero smoke edits)
- Reference: read `tests/e2e/operator.spec.ts` + `operator-launch.spec.ts` for launch/poll/teardown patterns; NO `waitForTimeout`, use toPass polling; guarded finally teardown.

**Scenarios (one test each, LOCALFLOW_E2E create with explicit cwd + fake agent bins per existing fixtures):**
- [ ] Template create → group box appears with 2 panes, shared header + rollup dot (`.group-box`, `.group-header`, `.group-rollup`). (Write the template into the e2e config file the harness already provisions — grep how e2e seeds config.json.)
- [ ] Add-pane on a solo pane → group forms; new pane's cwd equals source cwd (assert via the fake agent's marker output, pattern from operator-launch.spec).
- [ ] close-pane on a grouped pane → focus (cyan ring selector used in existing smoke tests) lands on its sibling.
- [ ] Enlarge staircase: enlarge → breadcrumb shows env›session›pane; enlarge again → session level, both panes visible; go-up twice → grid.
- [ ] Operator: grant env, `POST /panes` browser+groupId → pane appears in group; same request with the OTHER env's token → 400/403 per route contract.
- [ ] Resume dead-end: fake agent that exits instantly on resume args (extend `tests/fixtures/fake-claude.sh` behavior via an env flag, following existing fixture conventions) → overlay shows Start fresh as primary.
- [ ] **Run** the new spec 3x locally green (`npx playwright test tests/e2e/groups.spec.ts` — check package.json for the exact e2e script) + full `npm run check`.
- [ ] README: grouped sessions paragraph + keybindings table rows (`cmd+t` add pane, `cmd+g`/`cmd+shift+g` group/ungroup, enlarge cycle description, cmd+escape walk-up).
- [ ] **Commit** `test: e2e for session groups` + `docs: session layers`

---

## Self-review notes (already applied)

- Spec coverage: data model (T1-3), grouped grid (T4), close semantics (T5), staircase (T6), Shell preset (T7), creation flows (T8-10), operator route (T11), resume dead-end (T12), rollup (T4 via worstStatus), atomic writes (T1), e2e+docs (T13). Escape semantics: covered by reusing the existing `go-up` (`cmd+escape`) — bare Escape stays with the terminal, matching the shipped "bare Escape never captured" rule.
- Type consistency: `SessionGroup` defined once (T1), consumed by T2-T4, T9-T11; `AddPaneRequest` (T8) consumed by T11's `OperatorPaneRequest` variant naming; `enlarged` shape only in T6.
- Known drift risk for implementers: App.tsx state/JSX evolves task-to-task — always grep current code before editing; the controller resolves brief-vs-reality drift as in previous milestones.
