# M1.6 Durable Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split "session" (durable, named, kept until explicitly deleted)
from "terminal" (the ephemeral pty attached to it). Closing a terminal
(`cmd+w`, pane close button) no longer deletes the session — it goes back
to the list as an exited card, reopenable via resume/fresh, exactly like a
crash today. Deleting a session becomes a separate, confirm-gated action
from Overview/Sidebar. Sessions gain an inline-renameable `name`. Fixes the
M1 final-review finding that `cmd+w` is irreversibly destructive.

**Architecture:** `SessionManager.kill()` splits into `closeTerminal(id)`
(kill the pty, keep the record, force `status: 'exited'`, suppress the
instant-exit crash-message heuristic via a `closedByUser` flag) and
`deleteSession(id)` (today's `kill()` verbatim, renamed). A new
`rename(id, name)` sets `SessionInfo.name` and persists immediately via the
existing `changedCbs` → `saveSessions` pipeline. `SessionInfo`/
`SavedSession` both gain `name` (default `path.basename(cwd)`, restored
verbatim when present in `sessions.json`). Three new IPC channels
(`session:closeTerminal`, `session:delete` replacing `session:kill`,
`session:rename`) thread through `shared/api.ts` → `preload/index.ts` →
`main/index.ts`. `App.tsx` gains a shared `afterPaneGone` cleanup used by
both new renderer-side handlers; `Landing.tsx` and `Sidebar.tsx` each gain
an inline rename-on-double-click/pencil affordance and a two-step
confirm/cancel delete control, replacing today's one-click `×`. Spec:
`docs/superpowers/specs/2026-07-07-m16-durable-sessions-design.md`.

**Tech Stack:** existing app (Electron, React, TS strict, Tailwind v4
utilities + small plain-CSS design-system file, Vitest, Playwright).

## Global Constraints

- Conventional Commits, subject ≤50 chars (commitlint-enforced).
- TypeScript strict, no `any`. Tailwind utilities for all new layout/spacing
  in TSX; the status/data-attribute design system (`.pane[data-status=...]`,
  `.session-row .dot[data-status=...]`, `.side-session .dot[data-status=...]`
  in `src/renderer/src/styles.css`) stays as-is — do not duplicate those
  rules with new Tailwind classes, only add classes for genuinely new
  elements (rename input, confirm/cancel buttons).
- Preserve the e2e DOM contract: exactly one `.new-session` element at any
  time, `.row-open` on live-session open actions, `data-session-id` on
  Overview rows, `data-pane-id`/`data-status` on panes, `data-nav-session`
  on sidebar rows — all untouched by this work.
- **Concurrent-edit warning:** this plan touches `App.tsx`, `Landing.tsx`,
  and `Sidebar.tsx`, all already carrying M1's active-pane state and
  `onMouseDown={(e) => e.preventDefault()}` blur guards on every
  interactive control, and M1.5's centered-Overview/Settings-nav shape.
  Re-read the current file before editing each one and carry forward every
  existing guard/prop onto new and moved buttons — this plan is a delta on
  the M1/M1.5 shape, not a rewrite. Do not rename these three files.
- `session:kill`/`killSession`/`SessionManager.kill()` are removed
  entirely, not kept as deprecated aliases — this is a single-app project
  with no external IPC consumers to preserve compatibility for.
- Session `status` is still never persisted in `sessions.json` (unchanged
  from today) — only `id`, `cwd`, `agentId`, `command`, and now `name` are.
- Rename/delete confirm-state (`editingId`, `confirmDeleteId`) is local
  component state in `Landing.tsx`/`Sidebar.tsx` — no new global/App-level
  state beyond the two new handler functions each component calls into.

---

### Task 1: Data model + `SessionManager` split (TDD)

**Files:**
- Modify: `src/shared/types.ts`, `src/main/persistence.ts`,
  `src/main/session-manager.ts`
- Test: `tests/unit/session-manager.test.ts`,
  `tests/unit/persistence.test.ts`

**Interfaces (produces — later tasks import these exact names):**

```ts
// src/shared/types.ts — SessionInfo gains `name`
export interface SessionInfo {
  id: string
  cwd: string
  name: string
  status: SessionStatus
  agentId: AgentId
  command: string
  message?: string
}
```

```ts
// src/main/persistence.ts — SavedSession gains optional `name`
export interface SavedSession {
  id: string
  cwd: string
  agentId?: string
  command?: string
  name?: string
}
```

```ts
// src/main/session-manager.ts — new/changed public methods
create(cwd: string, spec: SpawnSpec): SessionInfo // unchanged signature, now defaults name
restore(id: string, cwd: string, spec: SpawnSpec, name?: string): SessionInfo // new optional param
restart(id: string, fresh?: boolean): SessionInfo // unchanged signature, now preserves name
closeTerminal(id: string): void // new
deleteSession(id: string): void // new (was `kill`)
rename(id: string, name: string): SessionInfo | null // new
// removed: kill(id: string): void
```

Semantics:

- `create()` defaults `name` to `path.basename(cwd)`.
- `restore()` uses `name` verbatim when it's a non-empty string, else
  falls back to `path.basename(cwd)` — this is the entire migration path
  for `sessions.json` files written before this milestone (no `name` key
  at all parses as `undefined`, same fallback).
- `restart()` preserves whatever `name` the session currently has (a user
  rename survives a resume/fresh relaunch) rather than recomputing it.
- `closeTerminal(id)`: no-op if the session doesn't exist or has no live
  pty. Otherwise kills the pty, sets `status: 'exited'` immediately (does
  not wait for the pty's own async `onExit`), attaches no message, and
  marks the record so the pty's real (later, async) `onExit` event is
  treated as already-handled — it must not re-run the instant-exit
  "Exited right away" message heuristic against a deliberate close.
- `deleteSession(id)`: identical behavior to today's `kill(id)` — kill the
  pty if alive, remove the record from the map, notify `changedCbs`.
- `rename(id, name)`: trims `name`; empty-after-trim is a no-op (returns
  the current, unchanged `SessionInfo`); otherwise updates `info.name`,
  fires `changedCbs` (persists immediately), returns the updated info.
  Returns `null` only when `id` doesn't exist.

- [ ] **Step 1: Write the failing tests.**

  In `tests/unit/persistence.test.ts`, add:
  ```ts
  it('round-trips an optional name', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    saveSessions(file, [{ id: 'a', cwd: '/x', name: 'my project' }])
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x', name: 'my project' }])
  })
  it('tolerates a saved session with no name key at all', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'saiife-p-')), 'sessions.json')
    writeFileSync(file, JSON.stringify([{ id: 'a', cwd: '/x' }]))
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  ```

  In `tests/unit/session-manager.test.ts`, add (alongside the existing
  `describe('SessionManager', ...)` block):
  - `create('/some/project', claudeSpec).name` equals `'project'`.
  - `closeTerminal`: create a session, call `mgr.closeTerminal(info.id)`
    immediately (within `INSTANT_EXIT_MS`) — assert `ptys[0].killed` is
    `true`, `mgr.list()` still has length 1 with that id, `status` is
    `'exited'`, and `message` is `undefined` (no crash framing for a
    deliberate close, unlike the existing "instant exit" test for organic
    pty death).
  - `closeTerminal` then the pty's real `exitCb` fires late — assert
    `mgr.list()[0].status` is still `'exited'` and `message` is still
    `undefined` (the late event must not re-run the message heuristic).
  - `closeTerminal` on an id with no live pty (e.g. right after another
    `closeTerminal`, or a `restore()`d placeholder) is a no-op: doesn't
    throw, `list()` unchanged.
  - `closeTerminal` on an unknown id doesn't throw.
  - `deleteSession` removes the session and kills the pty (port the
    existing `'kill removes the session and kills the pty'` test) and
    the existing `'does not forward late data from a killed session'`
    test, both renamed to call `deleteSession`.
  - `rename`: `mgr.rename(info.id, '  New Name  ')` returns
    `{ ...info, name: 'New Name' }`-shaped info (trimmed), and
    `mgr.list()[0].name` reflects it.
  - `rename` with `''`/`'   '` no-ops: returns the session's current
    (unchanged) name, `list()` unaffected.
  - `rename('missing-id', 'x')` returns `null`.
  - `rename` fires `onSessionsChanged` (persisted immediately): register
    a listener, call `rename`, assert it fired.
  - `restart()` preserves a renamed session's name: `create` → `rename` →
    kill the pty (`ptys[0].exitCb?.()`) → `restart()` → assert the
    restarted `SessionInfo.name` is still the renamed value, not
    recomputed from `cwd`.
  - `restore('id', '/old/project', claudeSpec, 'kept name').name` equals
    `'kept name'`; `restore('id', '/old/project', claudeSpec)` (no name
    arg) and `restore('id', '/old/project', claudeSpec, '')` both fall
    back to `'project'`.
  - Update the existing `'restore registers an exited placeholder without
    spawning'` test's `toEqual` to include `name: 'project'` (cwd is
    `/old/project`).

- [ ] **Step 2:** `npm test` → FAIL (new/changed assertions against
  not-yet-updated code, `closeTerminal`/`deleteSession`/`rename` don't
  exist yet). Record RED.

- [ ] **Step 3: Implement.**

  `src/shared/types.ts` — add `name: string` to `SessionInfo` (per
  Interfaces above, right after `cwd`).

  `src/main/persistence.ts` — add `name?: string` to `SavedSession` (per
  Interfaces above). No logic changes needed in `loadSavedSessions`/
  `saveSessions` themselves — both already pass unknown extra fields
  through untouched; adding `name` to the interface is sufficient for it
  to type-check and flow end to end.

  `src/main/session-manager.ts`:

  1. Add the import: `import { basename } from 'node:path'`.
  2. Extend `Record_`:
     ```ts
     interface Record_ {
       info: SessionInfo
       spec: SpawnSpec
       pty: PtyLike | null
       spawnedAt: number
       tail: string
       /** Set by closeTerminal() right before killing the pty; the
        * eventual real onExit event checks this to avoid re-running the
        * instant-exit message heuristic against a deliberate close, and
        * to avoid double-processing an already-handled transition. */
       closedByUser?: boolean
     }
     ```
  3. Replace `create`/`restore`/`restart`/`spawn` with:
     ```ts
     create(cwd: string, spec: SpawnSpec): SessionInfo {
       return this.spawn(randomUUID(), cwd, spec, false, basename(cwd))
     }

     restore(id: string, cwd: string, spec: SpawnSpec, name?: string): SessionInfo {
       const info: SessionInfo = {
         id,
         cwd,
         name: name && name.trim().length > 0 ? name : basename(cwd),
         status: 'exited',
         agentId: spec.agentId,
         command: spec.command
       }
       this.sessions.set(id, { info, spec, pty: null, spawnedAt: 0, tail: '' })
       this.changedCbs.forEach((cb) => cb())
       return info
     }

     /** Relaunch a dead session. `fresh` skips the agent's resume args. */
     restart(id: string, fresh = false): SessionInfo {
       const rec = this.sessions.get(id)
       if (!rec || rec.info.status !== 'exited') throw new Error(`cannot restart session ${id}`)
       return this.spawn(id, rec.info.cwd, rec.spec, !fresh, rec.info.name)
     }

     private spawn(
       id: string,
       cwd: string,
       spec: SpawnSpec,
       resume: boolean,
       name: string
     ): SessionInfo {
       const info: SessionInfo = {
         id,
         cwd,
         name,
         // Hook-fed agents report their own states; others we only know as alive.
         status: spec.useHooks ? 'idle' : 'running',
         agentId: spec.agentId,
         command: spec.command
       }
       // ...unchanged body below this point (try/spawn/catch, pty.onData, ...)
     ```
  4. In `spawn()`'s `pty.onExit` handler, add the `closedByUser` guard as
     the first check after the existing `disposed`/`rec` guards:
     ```ts
     pty.onExit(() => {
       if (this.disposed) return
       const rec = this.sessions.get(id)
       if (!rec) return
       if (rec.closedByUser) {
         // closeTerminal() already transitioned this session; the pty's
         // own exit event arrived late (kill() is not synchronous) and
         // must not re-run the instant-exit message logic below.
         rec.closedByUser = false
         return
       }
       rec.pty = null
       if (!rec.info.message && this.now() - rec.spawnedAt < INSTANT_EXIT_MS) {
         const tail = rec.tail.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim().slice(-160)
         rec.info.message = tail
           ? `Exited right away — last output: “${tail}”`
           : 'Exited right away with no output.'
       }
       this.setStatus(id, transition(this.status(id), 'pty-exit'))
     })
     ```
  5. Replace `kill()` with `closeTerminal()` and `deleteSession()`:
     ```ts
     closeTerminal(id: string): void {
       const rec = this.sessions.get(id)
       if (!rec || !rec.pty) return
       rec.closedByUser = true
       try {
         rec.pty.kill()
       } catch {
         /* dead pty */
       }
       rec.pty = null
       this.setStatus(id, 'exited')
       this.changedCbs.forEach((cb) => cb())
     }

     deleteSession(id: string): void {
       const rec = this.sessions.get(id)
       if (!rec) return
       try {
         rec.pty?.kill()
       } catch {
         /* dead pty */
       }
       this.sessions.delete(id)
       this.changedCbs.forEach((cb) => cb())
     }

     rename(id: string, name: string): SessionInfo | null {
       const rec = this.sessions.get(id)
       if (!rec) return null
       const trimmed = name.trim()
       if (trimmed.length > 0) {
         rec.info.name = trimmed
         this.changedCbs.forEach((cb) => cb())
       }
       return { ...rec.info }
     }
     ```
  6. `setStatus` is `private setStatus(id: string, status: SessionStatus)`
     already and already no-ops when the status is unchanged — no change
     needed to it; `closeTerminal` calling it with a literal `'exited'`
     (rather than routing through `transition()`) is intentional, since
     "close" always means "exited" regardless of current status.

- [ ] **Step 4:** `npm test` → PASS. `npm run check` clean.
- [ ] **Step 5:** Commit: `feat: split session close from delete, add rename`

---

### Task 2: IPC plumbing (`closeTerminal` / `deleteSession` / `rename`)

**Files:**
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `SessionManager.closeTerminal`/`deleteSession`/`rename`
  (Task 1), `SavedSession.name` (Task 1).
- Produces: `window.saiife.closeTerminal(id)`,
  `window.saiife.deleteSession(id)`,
  `window.saiife.renameSession(id, name)` — consumed by Task 3.

- [ ] **Step 1:** `src/shared/api.ts` — replace `killSession` with:
  ```ts
  /** Ends the pty; the session stays listed as exited, reopenable via resume/fresh. */
  closeTerminal(id: string): Promise<void>
  /** Removes the session entirely — separate, explicit, irreversible action. */
  deleteSession(id: string): Promise<void>
  /** Renames a session; empty/whitespace name is a no-op. Returns the updated info, or null if the id is unknown. */
  renameSession(id: string, name: string): Promise<SessionInfo | null>
  ```
  (keep the existing `SessionInfo` import — already imported in this file.)

- [ ] **Step 2:** `src/preload/index.ts` — replace the `killSession` entry
  in the `api` object with:
  ```ts
  closeTerminal: (id: string) => ipcRenderer.invoke('session:closeTerminal', id),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', id),
  renameSession: (id: string, name: string) => ipcRenderer.invoke('session:rename', id, name),
  ```

- [ ] **Step 3:** `src/main/index.ts` — three changes:
  1. Replace `ipcMain.handle('session:kill', (_e, id: string) =>
     manager.kill(id))` with:
     ```ts
     ipcMain.handle('session:closeTerminal', (_e, id: string) => manager.closeTerminal(id))
     ipcMain.handle('session:delete', (_e, id: string) => manager.deleteSession(id))
     ipcMain.handle('session:rename', (_e, id: string, name: string) => manager.rename(id, name))
     ```
  2. The restore loop passes the saved name through:
     ```ts
     for (const saved of loadSavedSessions(sessionsFile)) {
       const agentId = VALID_AGENTS.includes(saved.agentId as AgentId)
         ? (saved.agentId as AgentId)
         : 'claude'
       const spec = agentId === 'custom' ? specFor(agentId, saved.command ?? '') : specFor(agentId)
       manager.restore(saved.id, saved.cwd, spec, saved.name)
     }
     ```
  3. `onSessionsChanged` persists `name`:
     ```ts
     manager.onSessionsChanged(() =>
       saveSessions(
         sessionsFile,
         manager.list().map(({ id, cwd, agentId, command, name }) => ({ id, cwd, agentId, command, name }))
       )
     )
     ```
- [ ] **Step 4:** `npm run check` clean (no unit test added here — pure
  IPC wiring around already-tested `SessionManager` methods; exercised
  end-to-end in Task 4).
- [ ] **Step 5:** Commit: `feat: wire closeTerminal/delete/rename IPC`

---

### Task 3: Renderer — close-vs-delete routing + rename UX

**Files:**
- Modify: `src/renderer/src/App.tsx`,
  `src/renderer/src/components/Landing.tsx`,
  `src/renderer/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `window.saiife.closeTerminal`/`deleteSession`/
  `renameSession` (Task 2).
- `Landing`'s `Props.onRemove` becomes `onDelete: (id: string) => void`
  plus new `onRename: (id: string, name: string) => void`. `Sidebar`'s
  `Props` gains `onDeleteSession: (id: string) => void` and
  `onRenameSession: (id: string, name: string) => void`.

- [ ] **Step 1:** Re-read the current `App.tsx`/`Landing.tsx`/
  `Sidebar.tsx` (per Global Constraints) to confirm no other in-flight
  change has altered the button/prop shapes assumed below.

- [ ] **Step 2:** `App.tsx` — replace the single `close` function with
  three handlers plus a shared cleanup helper:
  ```ts
  const closeTerminal = async (id: string): Promise<void> => {
    await window.saiife.closeTerminal(id)
    await afterPaneGone(id)
  }
  const deleteSession = async (id: string): Promise<void> => {
    await window.saiife.deleteSession(id)
    await afterPaneGone(id)
  }
  const renameSession = async (id: string, name: string): Promise<void> => {
    const updated = await window.saiife.renameSession(id, name)
    if (updated) setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
  }
  // Shared post-action cleanup: whether the pane vanished entirely
  // (deleteSession) or just went dead-but-still-listed (closeTerminal), it
  // can no longer hold keyboard focus or stay enlarged.
  const afterPaneGone = async (id: string): Promise<void> => {
    setEnlarged((cur) => (cur === id ? null : cur))
    setActiveId((cur) => {
      if (cur !== id) return cur
      const idx = order.indexOf(id)
      if (idx === -1) return null
      return order[idx + 1] ?? order[idx - 1] ?? null
    })
    await refresh()
  }
  ```
  Update the `liveRef` (used by the capture-phase keydown dispatcher) to
  carry `closeTerminal` instead of `close`:
  ```ts
  const liveRef = useRef({ view, activeId, order, enlarged, closeTerminal })
  useEffect(() => {
    liveRef.current = { view, activeId, order, enlarged, closeTerminal }
  })
  ```
  And in the dispatcher's `close-pane` branch:
  ```ts
  if (action === 'close-pane') {
    void live.closeTerminal(activeId)
    return
  }
  ```
  Wire `TerminalPane`'s close button (unchanged prop name `onClose`) to
  the renamed handler: `onClose={() => void closeTerminal(s.id)}`.
  Update `<Landing>`'s props: `onDelete={(id) => void deleteSession(id)}`,
  `onRename={(id, name) => void renameSession(id, name)}` (keep
  `onCreate`/`onOpen`/`onResume`/`onOpenSettings` as-is). Update
  `<Sidebar>`'s props: add `onDeleteSession={(id) => void deleteSession(id)}`
  and `onRenameSession={(id, name) => void renameSession(id, name)}`.

- [ ] **Step 3:** `Landing.tsx` — rename the `Props.onRemove` field to
  `onDelete` and add `onRename: (id: string, name: string) => void`; add
  local state:
  ```ts
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  ```
  Add the click-elsewhere-disarms effect:
  ```ts
  useEffect(() => {
    if (!confirmDeleteId) return
    const onDocMouseDown = (e: MouseEvent): void => {
      const row = (e.target as HTMLElement).closest(`[data-session-id="${confirmDeleteId}"]`)
      if (!row) setConfirmDeleteId(null)
    }
    window.addEventListener('mousedown', onDocMouseDown)
    return () => window.removeEventListener('mousedown', onDocMouseDown)
  }, [confirmDeleteId])
  ```
  Replace the row's name display (today: `<strong className="text-sm">
  {projectName(s.cwd)}</strong>`) with an editable version — while not
  editing, show the name plus a hover-revealed pencil button; while
  editing, show an autofocused input:
  ```tsx
  {editingId === s.id ? (
    <input
      className="bg-surface -mx-1 -my-0.5 rounded border border-white/20 px-1 py-0.5 text-sm text-gray-100 outline-none"
      value={editValue}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setEditValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const trimmed = editValue.trim()
          if (trimmed) onRename(s.id, trimmed)
          setEditingId(null)
        } else if (e.key === 'Escape') {
          setEditingId(null)
        }
      }}
      onBlur={() => setEditingId(null)}
    />
  ) : (
    <span className="flex items-center gap-1.5">
      <strong
        className="cursor-text text-sm"
        title="Double-click to rename"
        onDoubleClick={() => {
          setEditingId(s.id)
          setEditValue(s.name)
        }}
      >
        {s.name}
      </strong>
      <button
        className="cursor-pointer border-0 bg-transparent p-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-white"
        title="Rename session"
        onClick={() => {
          setEditingId(s.id)
          setEditValue(s.name)
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        ✎
      </button>
    </span>
  )}
  ```
  Add `group` to the row's `className` (`"session-row group bg-surface-raised ..."`)
  so the pencil's `group-hover:opacity-100` works. Replace the trailing
  `×` button with the armed/disarmed pair (widen the actions wrapper from
  `w-[150px]` to fit, e.g. `w-[190px]`):
  ```tsx
  {confirmDeleteId === s.id ? (
    <>
      <button
        className={`${rowBtnBase} border border-red-500/60 bg-red-500/20 px-2 text-red-300 hover:bg-red-500/30`}
        onClick={() => {
          setConfirmDeleteId(null)
          onDelete(s.id)
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        Delete
      </button>
      <button
        className={`${rowBtnBase} ${rowBtnGray} px-2`}
        onClick={() => setConfirmDeleteId(null)}
        onMouseDown={(e) => e.preventDefault()}
      >
        Cancel
      </button>
    </>
  ) : (
    <button
      className={`${rowBtnBase} ${rowBtnGray} px-2 hover:text-red-400`}
      title="Delete session"
      onClick={() => setConfirmDeleteId(s.id)}
      onMouseDown={(e) => e.preventDefault()}
    >
      ×
    </button>
  )}
  ```
  Keep every other attribute on the row (`data-session-id`, the status
  dot, `data-status`, `.row-open`) exactly as today.

- [ ] **Step 4:** `Sidebar.tsx` — add `import { useEffect, useState } from
  'react'`; add `onDeleteSession`/`onRenameSession` to `Props`; add the
  same three pieces of local state and the click-elsewhere-disarms effect
  as Step 3. Change each session entry from a single `<button>` to a
  `<div>` row (a button cannot contain another focusable `<input>`/
  `<button>`) that keeps the `side-session`/`dot`/`data-status` classes
  CSS depends on, with an inner clickable name (opens the session) plus
  the same rename-on-double-click and armed-delete pattern as Landing,
  compacted for the sidebar's width:
  ```tsx
  <div
    key={s.id}
    className={`side-session group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-gray-300 hover:bg-white/5 hover:text-white ${activeId === s.id && view === 'terminals' ? 'active bg-white/10 text-white' : ''}`}
    data-nav-session={s.id}
  >
    <span className="dot bg-exited h-2 w-2 flex-none rounded-full" data-status={s.status} />
    {editingId === s.id ? (
      <input
        className="bg-surface min-w-0 flex-1 rounded border border-white/20 px-1 py-0 text-[13px] text-gray-100 outline-none"
        value={editValue}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const trimmed = editValue.trim()
            if (trimmed) onRenameSession(s.id, trimmed)
            setEditingId(null)
          } else if (e.key === 'Escape') {
            setEditingId(null)
          }
        }}
        onBlur={() => setEditingId(null)}
      />
    ) : (
      <button
        className="min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent p-0 text-left text-inherit"
        title={s.cwd}
        onClick={() => onOpenSession(s.id)}
        onDoubleClick={() => {
          setEditingId(s.id)
          setEditValue(s.name)
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {s.name}
      </button>
    )}
    {editingId !== s.id &&
      (confirmDeleteId === s.id ? (
        <span className="flex flex-none gap-1">
          <button
            className="cursor-pointer rounded border-0 bg-red-500/20 px-1.5 text-[11px] text-red-300 hover:bg-red-500/30"
            onClick={() => {
              setConfirmDeleteId(null)
              onDeleteSession(s.id)
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            Delete
          </button>
          <button
            className="cursor-pointer rounded border-0 bg-white/10 px-1.5 text-[11px] text-gray-300 hover:bg-white/20"
            onClick={() => setConfirmDeleteId(null)}
            onMouseDown={(e) => e.preventDefault()}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          className="cursor-pointer border-0 bg-transparent p-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-red-400"
          title="Delete session"
          onClick={() => setConfirmDeleteId(s.id)}
          onMouseDown={(e) => e.preventDefault()}
        >
          ×
        </button>
      ))}
  </div>
  ```
  Replace `s.cwd.split('/').filter(Boolean).pop() ?? s.cwd` (today's
  derived label) with `s.name` in this row — it's now the authoritative,
  independently-set display name.
- [ ] **Step 5:** `npm run check` clean.
- [ ] **Step 6:** Commit: `feat: durable-session rename and delete UX`

---

### Task 4: E2E coverage + README note

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`, `README.md`

- [ ] **Step 1:** Add a new `test()` to `tests/e2e/smoke.spec.ts` (same
  launch pattern as the existing three tests) covering close-vs-delete:
  - Launch, create a session via `createSession('claude', cwd)`, open it.
  - Click the pane's "close" button (or press `Meta+w`, matching the
    keyboard test's `win.keyboard.press` pattern for `close-pane`'s
    default binding).
  - Assert the pane (`[data-pane-id="<id>"]`) is **still present** with
    `data-status="exited"`, and its restart-overlay's "Resume
    conversation"/"Start fresh" buttons are visible.
  - Navigate to Overview; assert the session's row (`[data-session-id=
    "<id>"]`) is still present, showing `resume`/`fresh` (not `open`).
  - Click that row's `×`; assert a "Delete"/"Cancel" pair appears and the
    row is still present (armed, not yet deleted).
  - Click "Delete"; assert the row disappears from Overview, and that the
    pane no longer renders in the terminals grid (navigate to Terminals
    via the sidebar first if the view needs to be `terminals` to check).
- [ ] **Step 2:** Add a second new `test()` covering rename persistence:
  - Launch, create a session, assert its Overview row shows the default
    name (folder basename of the E2E temp `cwd`).
  - Double-click the row's name, type a new value, press Enter; assert
    the row now shows the new name, and the sidebar's matching
    `[data-nav-session="<id>"]` entry shows it too.
  - `app.close()`, relaunch against the **same** `SAIIFE_USER_DATA`
    dir (mirrors the existing `lastAgent` restart test's `launch()`
    helper), and assert the relaunched Overview's row for that session id
    still shows the renamed value (proves the write landed in
    `sessions.json`, not just React state).
- [ ] **Step 3:** `npm run e2e` → all pass (record output).
- [ ] **Step 4:** README.md — under "Usage", add a short paragraph:
  sessions are durable (named, kept until you delete them); closing a
  terminal (the pane's close button or `cmd+w`) only ends that pty — the
  session stays listed as exited and can be resumed or restarted fresh;
  deleting a session is a separate, confirm-gated action from Overview or
  the sidebar; session names default to the project folder name and are
  renameable inline (double-click, or the pencil icon on hover).
- [ ] **Step 5:** `npm run check` clean. Commit:
  `test: cover close-vs-delete and rename persistence` (tests),
  `docs: document durable sessions in README` (README) — two commits
  since these are unrelated concerns landing together.

---

## Self-Review Notes

- Spec coverage: `SessionInfo.name` + default/rename/persistence (T1),
  `closeTerminal`/`deleteSession` split with the crash-message-suppression
  detail for deliberate closes (T1), IPC/api/preload wiring for all three
  new calls (T2), `cmd+w`/pane-close routed to `closeTerminal` and
  Overview/sidebar `×` routed to `deleteSession` behind an inline
  confirm (T3), rename inline in both Overview and sidebar with the
  Enter-saves/Escape-cancels/blur-cancels contract and the bare-Escape
  safety argument from the standing M1 principle (T3), e2e for both the
  close-vs-delete distinction and rename-survives-relaunch (T4). Non-goals
  (session trees, undo/trash, multi-terminal-per-session) untouched.
- Type consistency: `SessionInfo.name` defined once in `src/shared/types.ts`
  (T1), consumed by `session-manager.ts` (T1), `persistence.ts`'s
  `SavedSession` (T1), and `Landing.tsx`/`Sidebar.tsx` (T3) — no parallel
  "display name" derivation left behind (both components stop deriving a
  name from `cwd` and read `s.name` instead).
- Known risk: the `closedByUser` flag in `session-manager.ts` assumes a
  session has at most one live pty generation in flight at a time (true
  today — `restart()` always requires `status === 'exited'` first). If a
  future milestone ever allows overlapping pty generations for one
  session id, this flag would need to become generation-scoped rather
  than a single boolean on the record.
- Known risk: this plan is written against the current (post-M1/M1.5)
  shape of `App.tsx`/`Landing.tsx`/`Sidebar.tsx`; per Global Constraints,
  re-verify the exact prop/state names before patching if any concurrent
  workstream has touched them since this spec was written.
- Known risk: Sidebar's session entry changes from a `<button>` to a
  `<div>` wrapper (Task 3, Step 4) — a real structural change, not just a
  style tweak, because an `<input>`/nested `<button>` inside a `<button>`
  is invalid HTML. Double-check no existing e2e selector or CSS rule
  assumed the row was literally a `<button>` element (`data-nav-session`
  and the `side-session`/`dot` classes are preserved on the new wrapper,
  which is what today's selectors and `styles.css` rules key off of).
