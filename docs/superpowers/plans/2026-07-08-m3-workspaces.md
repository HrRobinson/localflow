# M3 Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AeroSpace-style workspaces 1–9: every session belongs to one workspace, `cmd+1…9` switches the visible grid, `cmd+shift+1…9` moves the active pane, and the sidebar shows non-empty workspaces with worst-status rollup dots.

**Architecture:** `workspace: number` becomes part of `SessionInfo`, owned by main and persisted per session in `sessions.json` (absent ⇒ 1, so pre-M3 files migrate silently). Pure workspace logic (clamping, visible-list, worst-status rollup) lives in one shared module. The renderer holds only "which workspace is visible" as state; the grid filters by it, the mount-once keydown dispatcher gains 18 new remappable actions, and `openSession` learns to switch workspaces so sidebar/overview/`cmd+u` all cross workspace boundaries uniformly. Optional workspace names are read from `config.json` (hand-edited; GUI comes in M4).

**Tech Stack:** Electron main/preload/renderer, React 19, vitest (`tests/unit/**`, node env), Playwright `_electron` e2e.

Spec: `docs/superpowers/specs/2026-07-06-localflow-v2-roadmap.md` § "M3 — Workspaces (spec written 2026-07-08)".

## Global Constraints

- Conventional Commits, subject ≤ 50 chars, body lines ≤ 100 chars (husky + CI commitlint; PR titles ≤ 50 chars including GitHub's ` (#N)` squash suffix allowance).
- `npm run check` (eslint + prettier + typecheck + vitest) green before every commit.
- Config-as-code: `sessions.json` gains a `workspace` field per entry and `config.json` may carry a hand-written `workspaces: { "3": "backend" }` map — both must round-trip (config.json's unknown-key preservation already handles `workspaces` via `extra`; do NOT add `workspaces` to `KNOWN_TOP_LEVEL_KEYS`).
- Workspaces 1–9 always exist (virtual): no create/delete, nothing stored for empty ones.
- Every new keybinding is a remappable action in `keybindings.json` (`workspace-1…9`, `move-to-workspace-1…9`; defaults `cmd+1…9`, `ctrl+1…9` (ctrl chosen 2026-07-08: macOS globally owns cmd+shift+3/4/5 for screenshots)).
- Overview (Landing) stays global — all sessions, all workspaces. The grid is per-workspace.
- New sessions land on the currently visible workspace.
- `focus-needs-you` (cmd+u) becomes cross-workspace: current-workspace panes first, then other workspaces; jumping switches the visible workspace.
- Rollup priority (worst wins): `needs-you > working > running > idle > exited`.
- DOM contract used by CSS + e2e: `.pane[data-pane-id][data-status]`, `.session-row[data-session-id]`, `.dot[data-status]`, `[data-nav-session]` — do not rename. New sidebar workspace rows use `[data-nav-workspace="N"]`.
- Button mousedown discipline: every new button gets `onMouseDown={(e) => e.preventDefault()}`.
- **Digit-binding gotcha (binding):** `Shift+1` produces `e.key === '!'` (layout-dependent), so digit bindings MUST also match on `e.code === 'Digit<N>'`. Letters keep matching via `e.key` exactly as today.

---

### Task 1: Shared workspace module + main-process ownership + IPC

**Files:**
- Create: `src/shared/workspace.ts`
- Create: `tests/unit/workspace.test.ts`
- Modify: `src/shared/types.ts` (SessionInfo)
- Modify: `src/main/persistence.ts` (SavedSession)
- Modify: `src/main/session-manager.ts` (create/restore/restart/spawn signatures, `setWorkspace`)
- Modify: `src/main/index.ts` (create param, `session:setWorkspace` handle, saveSessions pick list, restore wiring)
- Modify: `src/preload/index.ts`, `src/shared/api.ts`
- Test: extend `tests/unit/session-manager.test.ts`, `tests/unit/persistence.test.ts`

**Interfaces:**
- Consumes: existing `SessionManager` record/spawn structure, `SavedSession`, `saveSessions` pick list in `index.ts:132-139`.
- Produces (later tasks rely on these exact names):
  - `src/shared/workspace.ts`: `WORKSPACE_MIN = 1`, `WORKSPACE_MAX = 9`, `clampWorkspace(raw: unknown): number`, `visibleWorkspaces(sessions: { workspace: number }[], current: number): number[]`, `worstStatus(statuses: SessionStatus[]): SessionStatus`
  - `SessionInfo.workspace: number`
  - `SessionManager.create(cwd, spec, workspace: number)`, `SessionManager.setWorkspace(id: string, workspace: number): SessionInfo | null`
  - IPC: `session:create` gains 4th arg `workspace?: number`; new invoke `session:setWorkspace`
  - `LocalflowApi.createSession(agentId, cwd?, customCommand?, workspace?)`, `LocalflowApi.setWorkspace(id: string, workspace: number): Promise<SessionInfo | null>`

- [ ] **Step 1: Write the failing unit test for the shared module**

Create `tests/unit/workspace.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_MIN,
  WORKSPACE_MAX,
  clampWorkspace,
  visibleWorkspaces,
  worstStatus
} from '../../src/shared/workspace'

describe('clampWorkspace', () => {
  it('passes through integers 1..9', () => {
    expect(clampWorkspace(1)).toBe(1)
    expect(clampWorkspace(9)).toBe(9)
    expect(clampWorkspace(5)).toBe(5)
  })
  it('defaults everything else to 1', () => {
    expect(clampWorkspace(undefined)).toBe(1)
    expect(clampWorkspace(null)).toBe(1)
    expect(clampWorkspace(0)).toBe(1)
    expect(clampWorkspace(10)).toBe(1)
    expect(clampWorkspace(2.5)).toBe(1)
    expect(clampWorkspace('3')).toBe(1)
    expect(clampWorkspace(NaN)).toBe(1)
  })
  it('exports the 1..9 bounds', () => {
    expect(WORKSPACE_MIN).toBe(1)
    expect(WORKSPACE_MAX).toBe(9)
  })
})

describe('visibleWorkspaces', () => {
  it('lists non-empty workspaces plus the current one, ascending', () => {
    const sessions = [{ workspace: 3 }, { workspace: 1 }, { workspace: 3 }]
    expect(visibleWorkspaces(sessions, 5)).toEqual([1, 3, 5])
  })
  it('does not duplicate the current workspace when non-empty', () => {
    expect(visibleWorkspaces([{ workspace: 2 }], 2)).toEqual([2])
  })
  it('is just the current workspace when no sessions exist', () => {
    expect(visibleWorkspaces([], 4)).toEqual([4])
  })
})

describe('worstStatus', () => {
  it('ranks needs-you > working > running > idle > exited', () => {
    expect(worstStatus(['idle', 'working', 'needs-you'])).toBe('needs-you')
    expect(worstStatus(['exited', 'running', 'working'])).toBe('working')
    expect(worstStatus(['idle', 'running'])).toBe('running')
    expect(worstStatus(['exited', 'idle'])).toBe('idle')
    expect(worstStatus(['exited'])).toBe('exited')
  })
  it('returns exited for an empty list', () => {
    expect(worstStatus([])).toBe('exited')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: FAIL — module `src/shared/workspace` not found.

- [ ] **Step 3: Create `src/shared/workspace.ts`**

```ts
import type { SessionStatus } from './types'

export const WORKSPACE_MIN = 1
export const WORKSPACE_MAX = 9

/**
 * Workspaces 1–9 always exist (virtual, AeroSpace-style). Anything that is
 * not an integer in range — absent field in a pre-M3 sessions.json, a
 * hand-edited string, out-of-range number — lands on workspace 1 rather
 * than throwing: sessions.json is user-editable, validate at the boundary.
 */
export function clampWorkspace(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= WORKSPACE_MIN && raw <= WORKSPACE_MAX
    ? raw
    : WORKSPACE_MIN
}

/** Non-empty workspaces plus the current one, ascending — the sidebar list. */
export function visibleWorkspaces(
  sessions: { workspace: number }[],
  current: number
): number[] {
  const set = new Set(sessions.map((s) => s.workspace))
  set.add(current)
  return [...set].sort((a, b) => a - b)
}

// Worst wins: the rollup dot must surface the most attention-worthy state.
const STATUS_PRIORITY: SessionStatus[] = ['needs-you', 'working', 'running', 'idle', 'exited']

export function worstStatus(statuses: SessionStatus[]): SessionStatus {
  for (const status of STATUS_PRIORITY) {
    if (statuses.includes(status)) return status
  }
  return 'exited'
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Add `workspace` to the types**

`src/shared/types.ts` — in `SessionInfo`, after `command: string`:

```ts
  /** Workspace 1-9 this session lives on (AeroSpace-style, M3). */
  workspace: number
```

(Leave `message?: string` last.) `src/main/persistence.ts` — in `SavedSession`, after `name?: string`:

```ts
  /** Workspace 1-9; absent on files predating M3 (falls back to 1). */
  workspace?: number
```

- [ ] **Step 6: Write the failing session-manager tests**

Extend `tests/unit/session-manager.test.ts` (reuse the file's existing fixture idioms — `mgr`, `claudeSpec`, etc.; adapt names to what the file actually uses):

```ts
describe('workspaces', () => {
  it('create assigns the given workspace', () => {
    const info = mgr.create('/tmp', claudeSpec, 3)
    expect(info.workspace).toBe(3)
  })

  it('restore clamps a bad saved workspace to 1', () => {
    const info = mgr.restore('id-1', '/tmp', claudeSpec, undefined, 42 as number)
    expect(info.workspace).toBe(1)
  })

  it('setWorkspace moves a session and returns updated info', () => {
    const info = mgr.create('/tmp', claudeSpec, 1)
    const updated = mgr.setWorkspace(info.id, 7)
    expect(updated?.workspace).toBe(7)
    expect(mgr.list().find((s) => s.id === info.id)?.workspace).toBe(7)
  })

  it('setWorkspace returns null for an unknown id and clamps range', () => {
    expect(mgr.setWorkspace('nope', 3)).toBeNull()
    const info = mgr.create('/tmp', claudeSpec, 2)
    expect(mgr.setWorkspace(info.id, 99)?.workspace).toBe(1)
  })

  it('restart keeps the workspace', () => {
    const info = mgr.create('/tmp', claudeSpec, 4)
    mgr.closeTerminal(info.id)
    const restarted = mgr.restart(info.id)
    expect(restarted.workspace).toBe(4)
  })
})
```

NOTE: `create` gains a third parameter — update ALL existing `mgr.create(...)` call sites in this test file to pass an explicit workspace or rely on the default (see Step 8's signature: the parameter has no default; pass `1` at existing call sites — a mechanical sweep).

- [ ] **Step 7: Run to verify failure**

Run: `npx vitest run tests/unit/session-manager.test.ts`
Expected: FAIL — compile errors (`create` arity, `setWorkspace` missing, `workspace` missing on SessionInfo).

- [ ] **Step 8: Implement in `src/main/session-manager.ts`**

1. Import: `import { clampWorkspace } from '../shared/workspace'`
2. `create` (line ~110) becomes:

```ts
  create(cwd: string, spec: SpawnSpec, workspace: number): SessionInfo {
    return this.spawn(randomUUID(), cwd, spec, false, basename(cwd), clampWorkspace(workspace))
  }
```

3. `restore` gains a trailing param and passes it into the info literal:

```ts
  restore(id: string, cwd: string, spec: SpawnSpec, name?: string, workspace?: unknown): SessionInfo {
```

and inside its `info` literal add `workspace: clampWorkspace(workspace)` after `command: spec.command`.

4. `restart` passes the record's workspace through:

```ts
    return this.spawn(id, rec.info.cwd, rec.spec, !fresh, rec.info.name, rec.info.workspace)
```

5. `spawn` signature gains `workspace: number` as the last parameter; both `info` literals inside `spawn` (the success path and the catch path both build from the same literal at the top) add `workspace` after `command: spec.command`.

6. New method next to `rename` (line ~285):

```ts
  /** Moves a session to another workspace (1-9, clamped). Null for unknown id. */
  setWorkspace(id: string, workspace: number): SessionInfo | null {
    const rec = this.sessions.get(id)
    if (!rec) return null
    rec.info.workspace = clampWorkspace(workspace)
    this.changedCbs.forEach((cb) => cb())
    return { ...rec.info }
  }
```

- [ ] **Step 9: Run session-manager tests to verify green**

Run: `npx vitest run tests/unit/session-manager.test.ts`
Expected: PASS including all pre-existing tests.

- [ ] **Step 10: Persistence round-trip test + wiring**

Extend `tests/unit/persistence.test.ts` (match its existing tmp-file idiom):

```ts
it('round-trips the workspace field and tolerates its absence', () => {
  const file = join(dir, 'sessions.json')
  saveSessions(file, [
    { id: 'a', cwd: '/x', workspace: 3 },
    { id: 'b', cwd: '/y' }
  ])
  const loaded = loadSavedSessions(file)
  expect(loaded.find((s) => s.id === 'a')?.workspace).toBe(3)
  expect(loaded.find((s) => s.id === 'b')?.workspace).toBeUndefined()
})
```

(No parser change needed — `SavedSession.workspace?` flows through the existing filter/map; clamping happens in `restore`.)

Wire `src/main/index.ts`:

1. saveSessions pick list (line ~132-139) adds the field:

```ts
        .map(({ id, cwd, agentId, command, name, workspace }) => ({
          id,
          cwd,
          agentId,
          command,
          name,
          workspace
        }))
```

2. Restore loop passes it: `manager.restore(saved.id, saved.cwd, spec, saved.name, saved.workspace)`

3. `session:create` handler gains the arg and forwards it (import `clampWorkspace` from `'../shared/workspace'`):

```ts
  ipcMain.handle(
    'session:create',
    async (_e, agentId: AgentId, cwd?: string, customCommand?: string, workspace?: number) => {
      ...
      const created = manager.create(dir, specFor(agentId, customCommand?.trim()), clampWorkspace(workspace))
```

4. New handle after `session:rename`:

```ts
  ipcMain.handle('session:setWorkspace', (_e, id: string, workspace: number) =>
    manager.setWorkspace(id, workspace)
  )
```

- [ ] **Step 11: Preload + api types**

`src/shared/api.ts`:
- `createSession(agentId: AgentId, cwd?: string, customCommand?: string, workspace?: number): Promise<SessionInfo | null>` — extend the doc comment: "workspace defaults to 1".
- After `renameSession`:

```ts
  /** Moves a session to workspace 1-9 (clamped). Null if the id is unknown. */
  setWorkspace(id: string, workspace: number): Promise<SessionInfo | null>
```

`src/preload/index.ts`:

```ts
  createSession: (agentId: AgentId, cwd?: string, customCommand?: string, workspace?: number) =>
    ipcRenderer.invoke('session:create', agentId, cwd, customCommand, workspace),
  setWorkspace: (id: string, workspace: number) =>
    ipcRenderer.invoke('session:setWorkspace', id, workspace),
```

`src/renderer/src/App.tsx` compiles against the new required `SessionInfo.workspace` without changes (it only reads fields it knows), EXCEPT nothing constructs `SessionInfo` in the renderer — verify with typecheck.

- [ ] **Step 12: Full check**

Run: `npm run check`
Expected: PASS. (The e2e suite is NOT run here; renderer behavior lands in Tasks 3-5.)

- [ ] **Step 13: Commit**

```bash
git add src/shared/workspace.ts src/shared/types.ts src/shared/api.ts src/main/persistence.ts src/main/session-manager.ts src/main/index.ts src/preload/index.ts tests/unit/workspace.test.ts tests/unit/session-manager.test.ts tests/unit/persistence.test.ts
git commit -m "feat: sessions carry a workspace (main+ipc)"
```

---

### Task 2: 18 workspace keybinding actions + digit matching

**Files:**
- Modify: `src/shared/keybindings.ts`
- Test: extend `tests/unit/keybindings.test.ts`

**Interfaces:**
- Consumes: existing `KeyAction`, `DEFAULT_BINDINGS`, `ParsedBinding`, `KeyEventLike`, `eventMatches`.
- Produces:
  - `KeyAction` gains `'workspace-1'`…`'workspace-9'` and `'move-to-workspace-1'`…`'move-to-workspace-9'` (exact strings).
  - `DEFAULT_BINDINGS['workspace-N'] === 'cmd+N'`, `DEFAULT_BINDINGS['move-to-workspace-N'] === 'ctrl+N'`.
  - `KeyEventLike` gains `code?: string`; `eventMatches` matches digit bindings via `e.code === 'Digit<N>'` OR `e.key`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/keybindings.test.ts`:

```ts
describe('workspace bindings', () => {
  it('defaults workspace-N to cmd+N and move-to-workspace-N to ctrl+N', () => {
    for (let n = 1; n <= 9; n++) {
      expect(DEFAULT_BINDINGS[`workspace-${n}` as KeyAction]).toBe(`cmd+${n}`)
      expect(DEFAULT_BINDINGS[`move-to-workspace-${n}` as KeyAction]).toBe(`ctrl+${n}`)
    }
  })

  it('matches a digit binding via e.code when shift turns the key into a symbol', () => {
    const parsed = parseBinding('cmd+shift+1')!
    // US layout: shift+1 reports key '!' — only e.code identifies the digit.
    const event = { key: '!', code: 'Digit1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
    expect(eventMatches(parsed, event)).toBe(true)
  })

  it('still matches a plain digit binding via e.key without a code', () => {
    const parsed = parseBinding('cmd+3')!
    const event = { key: '3', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
    expect(eventMatches(parsed, event)).toBe(true)
  })

  it('does not cross-match different digits', () => {
    const parsed = parseBinding('cmd+shift+1')!
    const event = { key: '@', code: 'Digit2', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
    expect(eventMatches(parsed, event)).toBe(false)
  })

  it('letter bindings are unaffected by the code fallback', () => {
    const parsed = parseBinding('cmd+shift+h')!
    const event = { key: 'H', code: 'KeyH', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
    expect(eventMatches(parsed, event)).toBe(true)
  })
})
```

(Import `KeyAction` type into the test file if not already imported.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/keybindings.test.ts`
Expected: FAIL — missing DEFAULT_BINDINGS entries; the `'!'`/`Digit1` event does not match.

- [ ] **Step 3: Implement in `src/shared/keybindings.ts`**

1. Extend the union (after `'focus-needs-you'`) — write all 18 literals out:

```ts
  | 'workspace-1'
  | 'workspace-2'
  | 'workspace-3'
  | 'workspace-4'
  | 'workspace-5'
  | 'workspace-6'
  | 'workspace-7'
  | 'workspace-8'
  | 'workspace-9'
  | 'move-to-workspace-1'
  | 'move-to-workspace-2'
  | 'move-to-workspace-3'
  | 'move-to-workspace-4'
  | 'move-to-workspace-5'
  | 'move-to-workspace-6'
  | 'move-to-workspace-7'
  | 'move-to-workspace-8'
  | 'move-to-workspace-9'
```

2. Extend `DEFAULT_BINDINGS` (after `'focus-needs-you': 'cmd+u'`) — write all 18 entries out:

```ts
  'workspace-1': 'cmd+1',
  'workspace-2': 'cmd+2',
  'workspace-3': 'cmd+3',
  'workspace-4': 'cmd+4',
  'workspace-5': 'cmd+5',
  'workspace-6': 'cmd+6',
  'workspace-7': 'cmd+7',
  'workspace-8': 'cmd+8',
  'workspace-9': 'cmd+9',
  'move-to-workspace-1': 'ctrl+1',
  'move-to-workspace-2': 'ctrl+2',
  'move-to-workspace-3': 'ctrl+3',
  'move-to-workspace-4': 'ctrl+4',
  'move-to-workspace-5': 'ctrl+5',
  'move-to-workspace-6': 'ctrl+6',
  'move-to-workspace-7': 'ctrl+7',
  'move-to-workspace-8': 'ctrl+8',
  'move-to-workspace-9': 'ctrl+9'
```

3. `KeyEventLike` gains an optional field after `shiftKey: boolean`:

```ts
  /** KeyboardEvent.code — needed to identify digits under shift (key becomes '!' etc.). */
  code?: string
```

4. Replace the key comparison at the bottom of `eventMatches` (currently `return binding.key.toLowerCase() === e.key.toLowerCase()`):

```ts
  // Digits need physical-key matching: shift+1 reports key '!' (layout-
  // dependent), so a digit binding also accepts the matching e.code.
  if (/^[0-9]$/.test(binding.key) && e.code === `Digit${binding.key}`) {
    return true
  }
  return binding.key.toLowerCase() === e.key.toLowerCase()
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/keybindings.test.ts`
Expected: PASS, including all pre-existing tests (mergeBindings tests compare structurally against DEFAULT_BINDINGS and absorb the 18 new entries).

- [ ] **Step 5: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/shared/keybindings.ts tests/unit/keybindings.test.ts
git commit -m "feat: workspace keybinding actions 1-9"
```

---

### Task 3: Renderer workspace state — grid filter, dispatcher, cross-workspace cmd+u

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/lib/needs-you.ts`
- Test: extend `tests/unit/needs-you.test.ts`

**Interfaces:**
- Consumes: Task 1's `LocalflowApi.setWorkspace` / `createSession(..., workspace)` and `SessionInfo.workspace`; Task 2's 18 actions; existing `liveRef` pattern, `openSession`, `enterTerminals`.
- Produces:
  - `nextNeedsYou(order: string[], sessions: SessionInfo[], activeId: string | null, currentWorkspace: number): string | null` — NEW 4th parameter; current-workspace candidates first.
  - App state `workspace: number` and `switchWorkspace(n: number): void` — Task 4's sidebar consumes `workspace` + `switchWorkspace` as props.

- [ ] **Step 1: Write the failing needs-you tests**

In `tests/unit/needs-you.test.ts`, the `session` factory gains a workspace argument (update it and ALL existing calls — mechanical; existing tests pass `1`):

```ts
const session = (id: string, status: SessionInfo['status'], workspace = 1): SessionInfo => ({
  id,
  cwd: '/tmp',
  name: id,
  status,
  agentId: 'claude',
  command: 'claude',
  workspace
})
```

Every existing `nextNeedsYou(order, sessions, activeId)` call gains a 4th argument `1`. Then add:

```ts
describe('nextNeedsYou across workspaces', () => {
  it('prefers waiting panes on the current workspace', () => {
    const sessions = [
      session('a', 'working', 1),
      session('b', 'needs-you', 2),
      session('c', 'needs-you', 1),
      session('d', 'working', 1)
    ]
    expect(nextNeedsYou(order, sessions, 'a', 1)).toBe('c')
  })

  it('falls through to other workspaces when the current one is quiet', () => {
    const sessions = [
      session('a', 'working', 1),
      session('b', 'needs-you', 2),
      session('c', 'idle', 1),
      session('d', 'working', 1)
    ]
    expect(nextNeedsYou(order, sessions, 'a', 1)).toBe('b')
  })

  it('cycles current-workspace panes before foreign ones', () => {
    const sessions = [
      session('a', 'needs-you', 1),
      session('b', 'needs-you', 2),
      session('c', 'needs-you', 1),
      session('d', 'working', 1)
    ]
    const first = nextNeedsYou(order, sessions, 'd', 1)
    expect(first).toBe('a')
    const second = nextNeedsYou(order, sessions, first, 1)
    expect(second).toBe('c')
    expect(nextNeedsYou(order, sessions, second, 1)).toBe('b')
  })
})
```

NOTE the cycle expectation: candidates are ordered "current-workspace ids in `order`, then other-workspace ids in `order`", and the cycle position is "strictly after `activeId` in that combined list, wrapping".

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/needs-you.test.ts`
Expected: FAIL — arity + missing workspace on the factory.

- [ ] **Step 3: Reimplement `src/renderer/src/lib/needs-you.ts`**

```ts
import type { SessionInfo } from '../../../shared/types'

/**
 * Picks the pane the jump-to-attention key should land on. Candidates are
 * every needs-you session, ordered: current-workspace panes first (in
 * display order), then panes on other workspaces (in display order) —
 * attention outranks workspace boundaries, but nearby panes win ties.
 * The result is the candidate strictly after `activeId` in that combined
 * ring, wrapping — so repeated presses cycle through every waiting pane
 * everywhere. `activeId` null or unknown starts from the ring's top.
 * Pure; returns null when nothing needs attention.
 */
export function nextNeedsYou(
  order: string[],
  sessions: SessionInfo[],
  activeId: string | null,
  currentWorkspace: number
): string | null {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const waiting = order.filter((id) => byId.get(id)?.status === 'needs-you')
  if (waiting.length === 0) return null
  const ring = [
    ...waiting.filter((id) => byId.get(id)!.workspace === currentWorkspace),
    ...waiting.filter((id) => byId.get(id)!.workspace !== currentWorkspace)
  ]
  const start = activeId === null ? -1 : ring.indexOf(activeId)
  return ring[(start + 1) % ring.length] ?? null
}
```

(Note this also subsumes the old "ignores needs-you sessions not present in order" behavior — `waiting` is derived FROM `order`.)

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/needs-you.test.ts`
Expected: PASS — all old (updated) and new tests.

- [ ] **Step 5: Wire App.tsx**

All edits in `src/renderer/src/App.tsx`:

1. Import the shared helper: add `import { clampWorkspace } from '../../shared/workspace'` next to the keybindings import.

2. New state after `view` (line ~40):

```ts
  // Which workspace's grid is visible. Sessions on other workspaces stay
  // mounted-invisible? No — they simply don't render; their ptys live in
  // main regardless, so nothing is lost when a pane isn't shown.
  const [workspace, setWorkspace] = useState(1)
```

3. Derived visibility + switch primitive after `enterTerminals` (line ~122):

```ts
  // Switching workspaces re-scopes focus: the active/enlarged pane must be
  // one of the target workspace's panes, or null.
  const switchWorkspace = (n: number): void => {
    const target = clampWorkspace(n)
    setWorkspace(target)
    setView('terminals')
    const firstVisible =
      order.find((id) => sessions.find((s) => s.id === id)?.workspace === target) ?? null
    setActiveId((cur) =>
      cur !== null && sessions.find((s) => s.id === cur)?.workspace === target ? cur : firstVisible
    )
    setEnlarged((cur) =>
      cur !== null && sessions.find((s) => s.id === cur)?.workspace === target ? cur : null
    )
  }
```

4. `openSession` switches to the session's workspace (replace the existing body):

```ts
  const openSession = (id: string): void => {
    // Opening a session anywhere (sidebar, overview, cmd+u) must also make
    // its workspace the visible one — a focused pane in a hidden workspace
    // would be unreachable.
    const target = sessions.find((s) => s.id === id)
    if (target) setWorkspace(target.workspace)
    setView('terminals')
    setEnlarged(sessions.length > 1 ? id : null)
    setActiveId(id)
  }
```

5. `createSession` passes the current workspace (first line of the existing function changes):

```ts
    const created = await window.localflow.createSession(agentId, undefined, customCommand, workspace)
```

6. `enterTerminals` scopes its fallback to the visible workspace:

```ts
  const enterTerminals = (): void => {
    setView('terminals')
    setActiveId((cur) => {
      const visible = order.filter(
        (id) => sessions.find((s) => s.id === id)?.workspace === workspace
      )
      return cur !== null && visible.includes(cur) ? cur : (visible[0] ?? null)
    })
  }
```

7. Move primitive next to the other session actions:

```ts
  const moveToWorkspace = async (id: string, n: number): Promise<void> => {
    await window.localflow.setWorkspace(id, n)
    await refresh()
    // The pane leaves the visible grid (spec: focus stays behind): re-scope
    // focus/enlarge exactly like a closed pane.
    await afterPaneGone(id)
  }
```

NOTE: `afterPaneGone`'s neighbor pick uses global `order` — a neighbor may be on another workspace. Harden its fallback while here (replace its `setActiveId` updater):

```ts
    setActiveId((cur) => {
      if (cur !== id) return cur
      const visible = order.filter(
        (oid) => oid !== id && sessions.find((s) => s.id === oid)?.workspace === workspace
      )
      const idx = order.indexOf(id)
      const after = order.slice(idx + 1).find((oid) => visible.includes(oid))
      const before = [...order.slice(0, idx)].reverse().find((oid) => visible.includes(oid))
      return after ?? before ?? null
    })
```

8. liveRef carries the new state and primitives (both the `useRef` literal and the effect body):

```ts
  const liveRef = useRef({
    view,
    activeId,
    order,
    enlarged,
    sessions,
    workspace,
    closeTerminal,
    openSession,
    switchWorkspace,
    moveToWorkspace
  })
  useEffect(() => {
    liveRef.current = {
      view,
      activeId,
      order,
      enlarged,
      sessions,
      workspace,
      closeTerminal,
      openSession,
      switchWorkspace,
      moveToWorkspace
    }
  })
```

9. Dispatcher branches. In `onKey`, the `focus-needs-you` branch gains the workspace argument:

```ts
        const target = nextNeedsYou(
          live.order,
          live.sessions,
          live.view === 'terminals' ? live.activeId : null,
          live.workspace
        )
```

Directly after the `focus-needs-you` branch (still BEFORE the `live.view !== 'terminals'` guard — switching works from any view):

```ts
      if (action.startsWith('workspace-')) {
        liveRef.current.switchWorkspace(Number(action.slice('workspace-'.length)))
        return
      }
```

After the terminals-view guard (moving needs an active pane), before the enlarge-toggle branch:

```ts
      if (action.startsWith('move-to-workspace-')) {
        void live.moveToWorkspace(activeId, Number(action.slice('move-to-workspace-'.length)))
        return
      }
```

(`action.startsWith` is safe: TypeScript's `KeyAction` union means only real actions reach here, and `move-to-workspace-` is checked AFTER `workspace-` branches on a startsWith that cannot collide — `'move-to-workspace-3'.startsWith('workspace-')` is false.)

10. Grid render filters by workspace (the `order.map(...)` chain in the JSX):

```tsx
            {order
              .map((id) => sessions.find((s) => s.id === id))
              .filter((s): s is SessionInfo => s != null && s.workspace === workspace)
              .map((s) => (
```

11. `showTerminals` counts only visible sessions (line ~216):

```ts
  const showTerminals = view === 'terminals' && sessions.some((s) => s.workspace === workspace)
```

(When the visible workspace is empty, the Landing renders — which IS the "empty state with a New session affordance"; new sessions land on the current workspace per item 5. This satisfies the spec's "switching to an empty workspace shows the grid's empty state with a New session here affordance" without a new component.)

- [ ] **Step 6: Full check**

Run: `npm run check`
Expected: PASS (Task 4 wires the sidebar; App compiles because Sidebar's new props arrive in Task 4 — this task does NOT touch Sidebar. Verify nothing in this task's edits references Sidebar props).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/lib/needs-you.ts tests/unit/needs-you.test.ts
git commit -m "feat: workspace switching and pane moves"
```

---

### Task 4: Sidebar workspace list + rollup dots + config.json names

**Files:**
- Create: `src/main/workspace-names.ts`
- Create: `tests/unit/workspace-names.test.ts`
- Modify: `src/main/index.ts` (IPC handle)
- Modify: `src/preload/index.ts`, `src/shared/api.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/App.tsx` (pass two new props)

**Interfaces:**
- Consumes: Task 1's `visibleWorkspaces` + `worstStatus` from `src/shared/workspace.ts`; Task 3's `workspace` state and `switchWorkspace`.
- Produces:
  - `parseWorkspaceNames(raw: unknown): Record<string, string>` in `src/main/workspace-names.ts`
  - IPC invoke `'workspaces:getNames'` → `Record<string, string>`
  - `LocalflowApi.getWorkspaceNames(): Promise<Record<string, string>>`
  - Sidebar props gain `workspace: number` and `onSwitchWorkspace: (n: number) => void`
  - DOM: `[data-nav-workspace="N"]` rows with a `.dot[data-status]` rollup

- [ ] **Step 1: Write the failing parser test**

Create `tests/unit/workspace-names.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseWorkspaceNames } from '../../src/main/workspace-names'

describe('parseWorkspaceNames', () => {
  it('keeps entries keyed 1-9 with non-empty string values', () => {
    expect(parseWorkspaceNames({ '3': 'backend', '1': 'web' })).toEqual({
      '1': 'web',
      '3': 'backend'
    })
  })

  it('drops out-of-range keys, non-string and empty values', () => {
    expect(
      parseWorkspaceNames({ '0': 'x', '10': 'y', '2': 42, '4': '', '5': '  ', '6': 'ok' })
    ).toEqual({ '6': 'ok' })
  })

  it('returns {} for non-objects', () => {
    expect(parseWorkspaceNames(undefined)).toEqual({})
    expect(parseWorkspaceNames(null)).toEqual({})
    expect(parseWorkspaceNames('nope')).toEqual({})
    expect(parseWorkspaceNames([1, 2])).toEqual({})
  })

  it('trims whitespace-padded names', () => {
    expect(parseWorkspaceNames({ '7': '  infra  ' })).toEqual({ '7': 'infra' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/workspace-names.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/main/workspace-names.ts`**

```ts
import { readFileSync } from 'node:fs'
import { WORKSPACE_MIN, WORKSPACE_MAX } from '../shared/workspace'

/**
 * Optional workspace names, hand-written in config.json as
 * `"workspaces": { "3": "backend" }` (config-as-code; the Settings GUI for
 * this arrives in M4). config.json is user-edited: validate every entry at
 * the boundary and drop anything malformed rather than throwing.
 */
export function parseWorkspaceNames(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const n = Number(key)
    if (!Number.isInteger(n) || n < WORKSPACE_MIN || n > WORKSPACE_MAX) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    out[String(n)] = trimmed
  }
  return out
}

/** Reads names fresh from config.json — hand edits show up without a restart. */
export function loadWorkspaceNames(configFile: string): Record<string, string> {
  try {
    const data: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
    return parseWorkspaceNames((data as { workspaces?: unknown } | null)?.workspaces)
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/workspace-names.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: IPC + preload + api**

`src/main/index.ts` — import `{ loadWorkspaceNames } from './workspace-names'` and add after the `keybindings:get` handle:

```ts
  ipcMain.handle('workspaces:getNames', () => loadWorkspaceNames(join(userData, 'config.json')))
```

`src/shared/api.ts` — after `getKeybindings()`:

```ts
  /** Optional hand-configured workspace names from config.json ("3" -> "backend"). */
  getWorkspaceNames(): Promise<Record<string, string>>
```

`src/preload/index.ts` — after `getKeybindings`:

```ts
  getWorkspaceNames: () => ipcRenderer.invoke('workspaces:getNames'),
```

- [ ] **Step 6: Sidebar workspace list**

`src/renderer/src/components/Sidebar.tsx`:

1. Imports:

```ts
import { visibleWorkspaces, worstStatus } from '../../../shared/workspace'
```

2. Props gain (after `activeId`):

```ts
  workspace: number
  onSwitchWorkspace: (n: number) => void
```

(destructure both in the component signature).

3. Names state at the top of the component:

```ts
  const [wsNames, setWsNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void window.localflow.getWorkspaceNames().then((names) => {
      if (!cancelled) setWsNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [])
```

4. Replace the flat sessions list (the `Sessions` header div through the `sessions.map(...)` block, lines ~98-196) with workspace groups. The per-session row JSX moves VERBATIM into the group loop — do not restyle it:

```tsx
        <div className="px-2.5 pt-2 pb-1 text-[11px] tracking-[0.06em] text-gray-500 uppercase">
          Workspaces
        </div>
        {visibleWorkspaces(sessions, workspace).map((n) => {
          const wsSessions = sessions.filter((s) => s.workspace === n)
          return (
            <div key={n}>
              <button
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[12px] ${
                  n === workspace ? 'font-semibold text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`}
                data-nav-workspace={n}
                onClick={() => onSwitchWorkspace(n)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span
                  className="dot bg-exited h-2 w-2 flex-none rounded-full"
                  data-status={worstStatus(wsSessions.map((s) => s.status))}
                />
                <span className="flex-1">
                  {n}
                  {wsNames[String(n)] ? ` · ${wsNames[String(n)]}` : ''}
                </span>
                <span className="text-[11px] text-gray-600">{wsSessions.length || ''}</span>
              </button>
              {wsSessions.map((s) => (
                /* the existing per-session row JSX, unchanged, keyed s.id,
                   with its container class gaining a `ml-2` indent:
                   className={`side-session group ml-2 flex ...`} */
              ))}
            </div>
          )
        })}
        {sessions.length === 0 && (
          <div className="px-2.5 py-0.5 text-xs text-gray-600">none yet</div>
        )}
```

IMPORTANT: the comment placeholder above is for THIS plan's brevity only — in the real edit, paste the existing session-row JSX block (Sidebar.tsx lines 104-196) inside the loop unchanged except the `ml-2` addition, and delete the old flat list. The rollup dot must carry BOTH the `dot` class and `data-status` so the existing `.side-session .dot[data-status]` CSS does not apply (it won't — the workspace dot is outside `.side-session`), and instead needs its own CSS: add to `src/renderer/src/styles.css` next to the `.side-session .dot` rules:

```css
[data-nav-workspace] .dot[data-status='working'] {
  background: var(--working);
}
[data-nav-workspace] .dot[data-status='needs-you'] {
  background: var(--needs-you);
}
[data-nav-workspace] .dot[data-status='idle'] {
  background: var(--idle);
}
[data-nav-workspace] .dot[data-status='running'] {
  background: var(--running);
}
```

5. `App.tsx` passes the new props where `<Sidebar` is rendered:

```tsx
          workspace={workspace}
          onSwitchWorkspace={switchWorkspace}
```

- [ ] **Step 7: Full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/workspace-names.ts src/main/index.ts src/preload/index.ts src/shared/api.ts src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx src/renderer/src/styles.css tests/unit/workspace-names.test.ts
git commit -m "feat: sidebar workspace list with rollup dots"
```

---

### Task 5: e2e coverage + README docs

**Files:**
- Modify: `tests/e2e/smoke.spec.ts` (one new test)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above; existing e2e helpers `launchApp`, endpoint-POST pattern, `[data-pane-id]`/`[data-session-id]`/`[data-nav-workspace]` DOM contract.
- Produces: milestone complete.

- [ ] **Step 1: Write the e2e test**

Append to `tests/e2e/smoke.spec.ts`:

```ts
test('workspaces: switch, move, rollup dot, persistence', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  const createSession = (cwd: string): Promise<{ id: string } | null> =>
    win.evaluate(
      (dir) =>
        (
          window as unknown as {
            localflow: { createSession(a: string, c: string): Promise<{ id: string } | null> }
          }
        ).localflow.createSession('claude', dir),
      cwd
    )

  // Two sessions created while workspace 1 is current — both land on 1.
  const a = await createSession(userData)
  const b = await createSession(userData)
  await expect(win.locator(`[data-session-id="${b!.id}"]`)).toBeVisible()
  await win.locator(`[data-session-id="${a!.id}"]`).locator('.row-open').click()
  const paneA = win.locator(`[data-pane-id="${a!.id}"]`)
  const paneB = win.locator(`[data-pane-id="${b!.id}"]`)
  await expect(paneA).toBeVisible()
  await expect(paneB).toBeVisible()

  // cmd+2: switch to (empty) workspace 2 — grid empties back to the landing.
  await win.keyboard.press('Meta+Digit2')
  await expect(win.locator('.pane')).toHaveCount(0)
  await expect(win.locator('.new-session')).toBeVisible()

  // cmd+1: back — both panes return.
  await win.keyboard.press('Meta+Digit1')
  await expect(win.locator('.pane')).toHaveCount(2)
  await expect(paneA).toHaveClass(/active/)

  // ctrl+3 moves the ACTIVE pane (a) to workspace 3: it leaves this
  // grid, focus lands on the remaining pane.
  await win.keyboard.press('Control+Digit3')
  await expect(win.locator('.pane')).toHaveCount(1)
  await expect(paneB).toHaveClass(/active/)

  // Sidebar shows workspace 3 with a rollup dot; a needs-you event on the
  // moved session must turn exactly that dot yellow.
  const ws3 = win.locator('[data-nav-workspace="3"]')
  await expect(ws3).toBeVisible()
  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  await fetch(`http://127.0.0.1:${port}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
    body: JSON.stringify({ paneId: a!.id, event: 'Notification' })
  })
  await expect(ws3.locator('.dot')).toHaveAttribute('data-status', 'needs-you')

  // Clicking the workspace row switches the grid to it.
  await ws3.click()
  await expect(win.locator('.pane')).toHaveCount(1)
  await expect(paneA).toBeVisible()

  // cmd+u from workspace 3's quiet sibling: pane a is already here and
  // waiting — it gets focused+enlarged (2 sessions exist overall).
  await win.keyboard.press('Meta+Digit1')
  await win.keyboard.press('Meta+u')
  await expect(paneA).toBeVisible()
  await expect(paneA).toHaveClass(/active/)

  await app.close()

  // Relaunch: workspace assignments persisted via sessions.json.
  const saved = JSON.parse(readFileSync(join(userData, 'sessions.json'), 'utf8')) as Array<{
    id: string
    workspace?: number
  }>
  expect(saved.find((s) => s.id === a!.id)?.workspace).toBe(3)
  expect(saved.find((s) => s.id === b!.id)?.workspace).toBe(1)

  const app2 = await launchApp(userData)
  const win2 = await app2.firstWindow()
  await expect(win2.locator('[data-nav-workspace="3"]')).toBeVisible()
  await app2.close()
})
```

NOTE Playwright key syntax: `Meta+Digit2` presses the physical digit key — exactly what the `e.code` matcher (Task 2) expects when users remap moves to `cmd+shift+N` (where `e.key` becomes `'#'` etc.); the shipped `ctrl+N` defaults report a plain digit `e.key` either way.

- [ ] **Step 2: Run the new test, expect failure only if something above regressed**

Run: `npm run e2e`
Expected: ALL tests pass — Tasks 1-4 shipped the behavior; this test is the integration proof. If it fails, the failure is a real defect in Tasks 1-4: investigate, do not loosen assertions.

- [ ] **Step 3: README updates**

1. Keybindings table — after the "Jump to attention" row:

```markdown
| Switch workspace         | `cmd+1` … `cmd+9`                                             | shows that workspace's grid (AeroSpace-style; workspaces 1–9 always exist)                                                                                      |
| Move pane to workspace   | `ctrl+1` … `ctrl+9`                                           | sends the active pane to that workspace; focus stays behind                                                                                                     |
```

2. `keybindings.json` example block — after `"focus-needs-you": "cmd+u"` add two representative entries (the file lists every action; add all 18 lines `"workspace-1": "cmd+1",` … `"move-to-workspace-9": "ctrl+9"` to keep the example complete and copy-pasteable — mind the final comma placement).

3. New paragraph after the approve/`cmd+u` paragraph:

```markdown
Sessions live on **workspaces 1–9** (AeroSpace-style: always there, no
setup). `cmd+1…9` switches, `ctrl+1…9` moves the active pane, and the
sidebar lists non-empty workspaces with a worst-status dot — "workspace 3
needs you" at a glance. Workspace assignments persist in `sessions.json`;
optional names live in `config.json` as `"workspaces": { "3": "backend" }`.
The Overview always shows every session across all workspaces.
```

- [ ] **Step 3b: Amend the roadmap spec's move-binding line**

`docs/superpowers/specs/2026-07-06-localflow-v2-roadmap.md`, § M3, the `move-to-workspace-1…9` bullet: replace ``(default `cmd+shift+1…9`)`` with ``(default `ctrl+1…9`; decided 2026-07-08 — macOS globally owns cmd+shift+3/4/5 for screenshots)``. Also update the section's intro line "AeroSpace-style workspaces 1–9: `cmd-1…9` switch, `cmd-shift-1…9` move pane." if that phrasing appears — the spec must match shipped defaults.

- [ ] **Step 4: Full check + e2e**

Run: `npm run check && npm run e2e`
Expected: both PASS (prettier checks README).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/smoke.spec.ts README.md docs/superpowers/specs/2026-07-06-localflow-v2-roadmap.md
git commit -m "test: workspace e2e; docs: workspaces"
```

(If commitlint rejects the two-part subject, use `test: workspace e2e and docs` instead.)

---

## Self-Review Notes

**Spec coverage** (roadmap § M3):
- "Workspaces 1–9 always exist (virtual)" → `clampWorkspace` + `visibleWorkspaces` (Task 1); nothing stored for empty ones (names map only stores configured entries; sessions.json only stores per-session assignment).
- "Every session belongs to exactly one workspace... absent field ⇒ 1" → Task 1 restore-with-clamp + persistence round-trip test.
- "`workspace-1…9` switch / `move-to-workspace-1…9` move, remappable" → Task 2 (with the shift+digit `e.code` fix), dispatched in Task 3.
- "focus stays, pane leaves the grid" (move default) → Task 3's `moveToWorkspace` + hardened `afterPaneGone`.
- "cmd+u cross-workspace, current-workspace first" → Task 3's `nextNeedsYou` ring + `openSession` workspace switch.
- "Sidebar: non-empty + current, number, optional name, rollup dot (worst wins), click to switch, sessions under their workspace" → Task 4.
- "Names in config.json `workspaces: {"3": "backend"}`, file first" → Task 4 (`extra`-key preservation in AgentRegistry already keeps hand edits safe; parser validates at boundary).
- "New sessions land on the currently visible workspace" → Task 3 item 5 + Task 1 create param.
- "Overview stays global" → no Landing changes anywhere.
- "Switching to an empty workspace shows the grid's empty state with a New session affordance" → Task 3 item 11 (`showTerminals` scoped; Landing renders with its New session control).
- Scope guards (no per-workspace layouts, no workspace-scoped keybindings) → nothing in the plan builds them.

**Type consistency:** `clampWorkspace(raw: unknown): number` (Tasks 1/3/4), `visibleWorkspaces(sessions, current)` + `worstStatus(statuses)` (Tasks 1/4), `setWorkspace(id, workspace): SessionInfo | null` (Tasks 1/3), `nextNeedsYou(order, sessions, activeId, currentWorkspace)` (Task 3/5 e2e), Sidebar props `workspace`/`onSwitchWorkspace` (Tasks 3/4), `createSession(..., workspace?)` (Tasks 1/3). All match.

**Known risks / accepted trade-offs:**
- `switchWorkspace`/`openSession`/`enterTerminals` close over `sessions`/`order` from the render they were created in; the dispatcher reads them via `liveRef`, so they are at most one render stale — same staleness class the app already accepts for `closeTerminal` (documented at the liveRef).
- Sidebar restructure (Task 4 Step 6) is the one non-verbatim edit: the session-row JSX must move unchanged into the group loop. The task reviewer should diff-check that block for accidental drift.
- Electron's default menu: `cmd+1..9` are not menu accelerators in the current template (only cmd+H/W/M were freed in M1) — no menu conflict. Move defaults are `ctrl+1…9` (user decision 2026-07-08): the natural `cmd+shift+1…9` mirror collides with macOS's global screenshot chords on 3/4/5, which the OS consumes before the app. The `e.code` digit matcher (Task 2) still ships so a user remap to `cmd+shift+N` works. Task 5 amends the roadmap spec's `cmd-shift-1…9` line to match.
