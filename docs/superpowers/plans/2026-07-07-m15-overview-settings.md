# M1.5 Overview + Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the cluttered Overview into a minimal, centered launcher
(latest sessions + one "New session" action defaulting to the last-used
agent) and a new Settings page that owns all agent configuration (Agents
section now; Keybindings/Themes placeholders for M4).

**Architecture:** `agent-registry.ts` gains a second config field
(`lastAgent`) alongside the existing `agentPaths`, read/written the same
way (`loadAgentConfig`/`saveAgentConfig`, whole-object rewrite). The main
process records `lastAgent` as a side effect of a successful
`session:create`, exposes it read-only via a new `agents:getLastAgent` IPC
call, and the renderer's Overview (`Landing.tsx`) uses it only to pick the
picker's initial value — it never writes the file itself. `Settings.tsx` is
a new, self-contained component (same "fetch on mount" pattern as today's
`Landing.tsx`) added as a third `view` value in `App.tsx`, with a matching
Sidebar nav item. Spec: `docs/superpowers/specs/2026-07-07-m15-overview-settings-design.md`.

**Tech Stack:** existing app (Electron, React, TS strict, Tailwind v4
utilities + small plain-CSS design-system file, Vitest, Playwright).

## Global Constraints

- Conventional Commits, subject ≤50 chars (commitlint-enforced).
- TypeScript strict, no `any`. Tailwind utilities for all new layout/spacing
  in TSX; the status/data-attribute design system (`.pane[data-status=...]`
  etc.) stays in `src/renderer/src/styles.css` — do not duplicate those
  rules with Tailwind classes.
- Preserve the e2e DOM contract: exactly one `.new-session` element at any
  time, `.row-open` on live-session open actions, `data-session-id` on
  session rows, `data-pane-id`/`data-status` on panes untouched.
- **Concurrent-edit warning:** the M1 keyboard workstream (see
  `docs/superpowers/plans/2026-07-07-m1-keyboard.md`) also rewrites
  `App.tsx`, `Landing.tsx`, and `Sidebar.tsx` (active-pane state, button
  `onMouseDown={(e) => e.preventDefault()}` blur guards on every
  interactive control, the `active`-pane class). Whoever executes this plan
  must diff those files against their post-M1 state first and preserve
  every M1 addition (especially the `onMouseDown` blur guards) when editing
  them below — this plan describes the *delta* on top of M1, not a
  from-scratch rewrite. Do not rename `Landing.tsx`/`Sidebar.tsx`/
  `App.tsx` — extend in place to minimize merge conflicts.
- `lastAgent` is written exactly once per flow, in the main process
  (`session:create` handler), never from the renderer directly.
- `agentId === 'custom'` has no detection/path row in Settings — its
  command is entered per-launch on Overview, unchanged from today.

---

### Task 1: `lastAgent` persistence in agent-registry (TDD)

**Files:**
- Modify: `src/shared/types.ts`, `src/main/agent-registry.ts`
- Test: `tests/unit/agent-registry.test.ts`

**Interfaces (produces — later tasks import these exact names):**

```ts
// src/shared/types.ts — add
export interface LastAgent {
  agentId: AgentId
  /** Only present when agentId === 'custom'. */
  customCommand?: string
}
```

```ts
// src/main/agent-registry.ts — AgentConfig gains a field
export interface AgentConfig {
  agentPaths: Partial<Record<AgentId, string>>
  lastAgent?: LastAgent
}

// New exports/methods
export function loadAgentConfig(file: string): AgentConfig // now also parses lastAgent
// saveAgentConfig signature unchanged — already writes the whole config object

// AgentRegistry gains:
getLastAgent(): LastAgent | null
recordLastAgent(agentId: AgentId, customCommand?: string): void
```

Semantics:
- `loadAgentConfig` validates `lastAgent` the same way it already tolerates
  bad `agentPaths`: parse errors, non-object `data`, and a malformed
  `lastAgent` all degrade gracefully — the field is simply omitted, nothing
  throws. Valid shapes: `{ agentId: 'claude' | 'codex' | 'gemini' }` or
  `{ agentId: 'custom', customCommand: <non-empty string> }`. Any other
  shape (unknown `agentId`, `'custom'` with missing/empty/non-string
  `customCommand`) is dropped.
- `AgentRegistry.getLastAgent()` returns `this.config.lastAgent ?? null`.
- `AgentRegistry.recordLastAgent(agentId, customCommand?)` sets
  `this.config.lastAgent` (including `customCommand` only when
  `agentId === 'custom'`) and calls `saveAgentConfig` immediately, mirroring
  `setPath()`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/agent-registry.test.ts`:
  - `loadAgentConfig`/`saveAgentConfig` round-trip `lastAgent` for a preset
    id (`{ agentId: 'claude' }`) and for `'custom'` with a `customCommand`.
  - Malformed `lastAgent` variants are dropped while `agentPaths` survives:
    missing `agentId`, unknown `agentId` (e.g. `'gpt4'`), `'custom'` with no
    `customCommand`, `'custom'` with an empty string, `lastAgent` as a
    non-object (`"claude"`, `42`, `null`).
  - `AgentRegistry.getLastAgent()` returns `null` on a fresh config file.
  - `AgentRegistry.recordLastAgent('codex')` then `getLastAgent()` returns
    `{ agentId: 'codex' }`, and `loadAgentConfig(file)` (re-reading from
    disk) agrees.
  - `AgentRegistry.recordLastAgent('custom', 'aider')` then `getLastAgent()`
    returns `{ agentId: 'custom', customCommand: 'aider' }`.
- [ ] **Step 2:** `npm test` → FAIL (new assertions against not-yet-updated
  code). Record RED.
- [ ] **Step 3:** Implement. Add `LastAgent` to `src/shared/types.ts`.
  In `agent-registry.ts`, import `LastAgent`, add the field to
  `AgentConfig`, and extend `loadAgentConfig` with a small
  `parseLastAgent(raw: unknown): LastAgent | null` helper used after the
  existing `agentPaths` parsing:

  ```ts
  function parseLastAgent(raw: unknown): LastAgent | null {
    if (typeof raw !== 'object' || raw === null) return null
    const agentId = (raw as { agentId?: unknown }).agentId
    const isKnown = agentId === 'custom' || AGENT_PRESETS.some((p) => p.id === agentId)
    if (typeof agentId !== 'string' || !isKnown) return null
    if (agentId === 'custom') {
      const cmd = (raw as { customCommand?: unknown }).customCommand
      return typeof cmd === 'string' && cmd.trim().length > 0
        ? { agentId: 'custom', customCommand: cmd }
        : null
    }
    return { agentId: agentId as AgentId }
  }
  ```

  Wire it into `loadAgentConfig`: after building `agentPaths`, read
  `(data as { lastAgent?: unknown }).lastAgent` through `parseLastAgent`
  and only set `config.lastAgent` when the result is non-null. Add
  `getLastAgent()`/`recordLastAgent()` to `AgentRegistry`:

  ```ts
  getLastAgent(): LastAgent | null {
    return this.config.lastAgent ?? null
  }

  recordLastAgent(agentId: AgentId, customCommand?: string): void {
    this.config.lastAgent =
      agentId === 'custom' ? { agentId, customCommand: customCommand ?? '' } : { agentId }
    saveAgentConfig(this.configFile, this.config)
  }
  ```

  (`recordLastAgent('custom', ...)` is only ever called after
  `session:create` has already validated a non-empty `customCommand`, so
  the `?? ''` fallback is defensive, not a real path.)
- [ ] **Step 4:** `npm test` → PASS. `npm run check` clean.
- [ ] **Step 5:** Commit: `feat: persist last-used agent in config.json`

---

### Task 2: IPC plumbing for `getLastAgent` + record on create

**Files:**
- Modify: `src/shared/api.ts`, `src/preload/index.ts`, `src/main/index.ts`

**Interfaces:**
- Consumes: `LastAgent` (Task 1), `AgentRegistry.getLastAgent`/
  `recordLastAgent` (Task 1).
- Produces: `window.saiife.getLastAgent(): Promise<LastAgent | null>`,
  consumed by Task 4 (Overview) and Task 3 (Settings' "last used" badge).

- [ ] **Step 1:** `src/shared/api.ts` — import `LastAgent`, add to
  `SaiifeApi`:

  ```ts
  getLastAgent(): Promise<LastAgent | null>
  ```

- [ ] **Step 2:** `src/preload/index.ts` — add to the `api` object:

  ```ts
  getLastAgent: () => ipcRenderer.invoke('agents:getLastAgent'),
  ```

- [ ] **Step 3:** `src/main/index.ts` — two changes:
  1. Next to the existing `ipcMain.handle('agents:list', ...)` /
     `agents:setPath` handlers, add:

     ```ts
     ipcMain.handle('agents:getLastAgent', () => registry.getLastAgent())
     ```

  2. In the `session:create` handler, record the agent that was actually
     launched right before returning. `manager.create(...)` is currently
     returned directly (`return manager.create(dir, specFor(agentId, customCommand?.trim()))`);
     change to:

     ```ts
     const created = manager.create(dir, specFor(agentId, customCommand?.trim()))
     registry.recordLastAgent(agentId, customCommand?.trim())
     return created
     ```

     Place this after the existing `if (!VALID_AGENTS.includes(agentId)) return null` /
     custom-command-empty guards, so `recordLastAgent` only ever runs for a
     validated, successfully-created session — never for a cancelled folder
     picker or a rejected empty custom command.
- [ ] **Step 4:** `npm run check` clean (no unit test added here — this is
  IPC wiring around already-tested `AgentRegistry` methods; it's exercised
  end-to-end in Task 5's e2e restart assertion).
- [ ] **Step 5:** Commit: `feat: wire lastAgent IPC and record on create`

---

### Task 3: Settings page (new component + nav + view state)

**Files:**
- Create: `src/renderer/src/components/Settings.tsx`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/components/Sidebar.tsx`

**Interfaces:**
- Produces: `Settings` component, self-contained (no props), same
  "fetch on mount" pattern as `Landing.tsx`'s agent list. `App`'s `view`
  union grows from `'home' | 'terminals'` (post-M1 shape — confirm exact
  current union before editing) to include `'settings'`. `Sidebar` gains an
  `onSettings: () => void` prop and a third, always-enabled nav button
  (unlike "Terminals", which stays disabled at zero sessions).

- [ ] **Step 1:** Create `src/renderer/src/components/Settings.tsx`:

  ```tsx
  import { useEffect, useState } from 'react'
  import type { AgentId, AgentInfo } from '../../../shared/types'

  const card =
    'bg-surface-raised flex flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left'
  const rowBtn =
    'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white'

  export default function Settings(): React.JSX.Element {
    const [agents, setAgents] = useState<AgentInfo[] | null>(null)
    const [lastAgentId, setLastAgentId] = useState<AgentId | null>(null)

    useEffect(() => {
      let cancelled = false
      void window.saiife.listAgents().then((list) => {
        if (!cancelled) setAgents(list)
      })
      void window.saiife.getLastAgent().then((last) => {
        if (!cancelled) setLastAgentId(last?.agentId ?? null)
      })
      return () => {
        cancelled = true
      }
    }, [])

    const setPath = async (agentId: AgentId): Promise<void> => {
      const updated = await window.saiife.setAgentPath(agentId)
      if (updated) setAgents(updated)
    }

    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-8 text-left">
        <section className="flex flex-col gap-3">
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Agents</h3>
          <p className="m-0 text-[13px] text-gray-500">
            Detected agent binaries and manual path overrides. Custom commands
            are entered when starting a session from Overview.
          </p>
          <div className="flex flex-col gap-2.5">
            {agents === null && (
              <p className="m-0 text-[13px] text-gray-400">Detecting installed agents…</p>
            )}
            {agents?.map((agent) => (
              <div key={agent.id} className={`${card} flex-row items-center justify-between gap-3`}>
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span
                    className={`h-2 w-2 flex-none rounded-full ${agent.resolvedPath ? 'bg-idle' : 'bg-exited'}`}
                  />
                  <span className="text-sm font-semibold">{agent.label}</span>
                  {lastAgentId === agent.id && (
                    <span className="border-idle/50 text-idle rounded-full border px-2 py-px text-[10px] whitespace-nowrap">
                      last used
                    </span>
                  )}
                  {agent.hasStatusFeed && (
                    <span
                      className="border-idle/50 text-idle rounded-full border px-2 py-px text-[10px] whitespace-nowrap"
                      title="Reports working / needs-you / done"
                    >
                      live status
                    </span>
                  )}
                  <span
                    className="min-w-0 flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-gray-400"
                    title={agent.resolvedPath ?? undefined}
                  >
                    {agent.resolvedPath ?? `not found (${agent.command})`}
                  </span>
                </div>
                <button className={rowBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => void setPath(agent.id)}>
                  {agent.resolvedPath ? 'Change path…' : 'Set path…'}
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className={`${card} opacity-60`}>
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Keybindings</h3>
          <p className="m-0 text-[13px] text-gray-500">
            Remap focus/swap/enlarge actions. Coming in M4 — for now, edit
            keybindings.json in the app&apos;s userData directory and restart.
          </p>
        </section>

        <section className={`${card} opacity-60`}>
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Themes</h3>
          <p className="m-0 text-[13px] text-gray-500">App and terminal color themes. Coming in M4.</p>
        </section>
      </div>
    )
  }
  ```

  (The `onMouseDown={(e) => e.preventDefault()}` on the path button matches
  the button-blur guard M1 adds elsewhere — keep this component consistent
  with that convention even though it's new.)

- [ ] **Step 2:** `App.tsx` — widen the view state type to include
  `'settings'` (keep whatever M1 named the state variable, e.g. `view`),
  add a branch that renders `<Settings />` when `view === 'settings'`, and
  update the header title logic (today: `showTerminals ? 'Terminals' :
  'Overview'`) to a three-way switch that also shows `'Settings'`. Pass a
  new `onSettings={() => setView('settings')}` handler to `<Sidebar>`, and
  an `onOpenSettings={() => setView('settings')}` prop to `<Landing>` (used
  by Task 4's "Configure in Settings" hint).
- [ ] **Step 3:** `Sidebar.tsx` — widen the `view` prop type to
  `'home' | 'terminals' | 'settings'`, add `onSettings: () => void` to
  `Props`, and add a third nav button after "Terminals" in the existing
  `<nav>` block, always enabled:

  ```tsx
  <button
    className={`${navItemBase}${view === 'settings' ? ` ${navItemActive}` : ''}`}
    onClick={onSettings}
  >
    Settings
  </button>
  ```

  Preserve any `onMouseDown` blur guard M1 already added to the sibling
  "Overview"/"Terminals" buttons on this new button too.
- [ ] **Step 4:** `npm run check` clean.
- [ ] **Step 5:** Commit: `feat: add Settings page and sidebar nav item`

---

### Task 4: Redesign Overview (`Landing.tsx`) — minimal + centered

**Files:**
- Modify: `src/renderer/src/components/Landing.tsx`

**Interfaces:**
- Consumes: `getLastAgent()` (Task 2), `onOpenSettings` prop (Task 3's
  App.tsx wiring).
- `Props` gains `onOpenSettings: () => void`; everything else
  (`sessions`, `onCreate`, `onOpen`, `onResume`, `onRemove`) is unchanged.

- [ ] **Step 1:** Before editing, re-read the current file to confirm which
  M1 changes already landed on it (button `onMouseDown` blur guards are the
  main one) — carry every one of them forward onto the new/kept buttons
  below.
- [ ] **Step 2:** Replace the two large sections below the ghost-grid hero
  (today's full session table, and the agent-cards + custom-command grid)
  with:
  1. A **Latest sessions** section, rendered only when `sessions.length >
     0`, showing `sessions.slice(-5).reverse()` as bigger rows (project
     name + cwd, agent chip, status label, `open`/`resume`+`fresh`, and the
     `×` remove control) — same event handlers as today
     (`onOpen`/`onResume`/`onRemove`), same `data-session-id` /
     `.row-open` attributes, just restyled and truncated to 5.
  2. A **New session** section that always renders: fetch `listAgents()`
     and `getLastAgent()` together on mount, keep `agents`,
     `selectedAgentId`, `customCommand` state, and default
     `selectedAgentId` per the spec's fallback chain (`lastAgent` if
     still valid → first resolved preset → `AGENT_PRESETS[0].id`); prefill
     `customCommand` from `lastAgent.customCommand` when the restored
     agent is `'custom'`. Render an agent `<select>` (presets + "Custom
     command…"), a command `<input>` shown only when `'custom'` is
     selected (same placeholder/Enter-to-create behavior as today's
     custom-command box), and the single primary button carrying class
     `new-session`, disabled when the selection isn't launchable, with the
     "not found … Configure in Settings" hint (calling `onOpenSettings`)
     shown under the row in that case.
  3. Change the outer container from the current full-width
     (`max-w-[960px]`, `items-stretch`) shell to a centered, narrower one:
     `mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-8
     overflow-auto px-6 py-8 text-left` (keep the ghost-grid's own
     `self-center` as-is).
  - Keep `GHOST_LINES`, `STATUS_LABEL`, `projectName`, and the row-button
    style constants — trim only the constants that were exclusively used
    by the removed agent-cards grid (`agentStartAlt` and the custom-command
    card markup move to `Settings.tsx`'s styling needs, if any overlap; do
    not leave dead exports behind — run a final grep for unused constants
    before committing).
- [ ] **Step 3:** `npm run check` clean.
- [ ] **Step 4:** Commit: `feat: redesign Overview as minimal launcher`

---

### Task 5: E2E coverage + README note

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`, `README.md`

- [ ] **Step 1:** Extend `tests/e2e/smoke.spec.ts` with a second `test()`
  in the same file (same `SAIIFE_E2E`/`SAIIFE_USER_DATA`/
  `SAIIFE_CLAUDE_BIN` launch pattern):
  - Launch, assert exactly one `.new-session` element.
  - Click the Sidebar's "Settings" nav item; assert an Agents-section
    element is visible (e.g. text "Agents" or a locator scoped to the new
    `Settings` component) and `.new-session` is no longer present on this
    view (confirms session-creation UI fully left Settings).
  - Navigate back to Overview; change the agent `<select>` to `'codex'`
    (unresolved in this fixture — only `claude` is faked); assert
    `.new-session` becomes `disabled` and a "Configure in Settings" hint
    becomes visible. Switch back to `'claude'`; assert enabled again.
  - Click `.new-session` (with the folder-picker path — same
    `SAIIFE_E2E`-gated `cwd` short-circuit the existing test relies on
    for `createSession`, or call `window.saiife.createSession('claude',
    cwd)` directly if the picker isn't test-friendly here, matching the
    existing test's approach) to create a session, then `app.close()` and
    relaunch Electron with the **same** `SAIIFE_USER_DATA` dir; evaluate
    `window.saiife.getLastAgent()` in the new window and assert it
    resolves to `{ agentId: 'claude' }` — proves `lastAgent` persisted
    across a real restart, not just in-memory state.
- [ ] **Step 2:** `npm run e2e` → all pass (record output).
- [ ] **Step 3:** README.md — under "Usage", add one short paragraph: the
  Overview page is now just "latest sessions + new session"; agent
  detection, paths, and (later) keybindings/themes live on the new
  Settings page reachable from the sidebar; the app remembers the last
  agent you launched and preselects it next time.
- [ ] **Step 4:** `npm run check` clean. Commit:
  `test: cover Settings nav and lastAgent e2e` (tests) and
  `docs: document Settings page and lastAgent` (README) as two commits if
  mixing docs into a `test:` commit feels wrong — otherwise one commit is
  fine given both are small.

---

## Self-Review Notes

- Spec coverage: minimal/centered Overview + latest-sessions digest +
  single always-present New-session control (T4), default/last-used agent
  selection logic (T4, backed by T1/T2), Settings page with Agents section
  + M4 placeholders + sidebar nav (T3), `lastAgent` shape and persistence
  exactly where the constraints demanded — in `agent-registry.ts`,
  extending `loadAgentConfig`/`saveAgentConfig` (T1) — DOM contract
  preserved (`.new-session` singular, `.row-open`, `data-session-id`, T4 +
  verified in T5), ghost-grid hero untouched (T4 only edits the sections
  below it). Non-goals (keybindings editor, themes, stats strip, real
  timestamps) untouched.
- Type consistency: `LastAgent` defined once in `src/shared/types.ts` (T1),
  consumed by `agent-registry.ts` (T1), `shared/api.ts` +
  `preload/index.ts` (T2), and both `Settings.tsx` and `Landing.tsx` (T3/T4)
  via `window.saiife.getLastAgent()` — no duplicate/parallel type
  definitions.
- Known risk: this plan is written against the *current* (partially
  mid-M1) `App.tsx`/`Sidebar.tsx`/`Landing.tsx`, but explicitly defers to
  whatever M1 actually lands (see Global Constraints) — the implementer
  must re-check the view-state variable name, the exact button set needing
  `onMouseDown` guards, and the header-title switch statement's current
  shape before patching them, rather than assuming today's file contents
  verbatim.
- Known risk: the e2e restart assertion in T5 (close + relaunch Electron
  mid-test) is heavier than this repo's existing single-launch tests — if
  it proves flaky in CI, fall back to asserting `recordLastAgent` was
  called via a unit test only (already covered in T1) and drop the
  restart assertion from e2e, noting the substitution in the PR.
