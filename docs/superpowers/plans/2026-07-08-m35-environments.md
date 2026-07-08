# M3.5 Environments & Browser Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename "workspace" to "environment" across the entire codebase (zero migration cost — M3 is unreleased), and ship the first non-terminal pane type: sandboxed browser panes with full mini-browser chrome, created from the New session picker.

**Architecture:** Task 1 is the atomic vocabulary pass (code, file formats, keys, copy). Browser panes are ordinary sessions without a pty: `SessionInfo` gains `kind`/`url`, `SessionManager` holds process-less records, and the grid renders a new `BrowserPane` (Electron `<webview>` tag — participates in DOM layout, so grid/enlarge/focus work unchanged) next to `TerminalPane`. Main enforces webview policy (deny-all permissions, http/https-only navigation, popups → system browser) and forwards bound key combos from focused webviews back to the renderer's dispatcher via `before-input-event` (main already loads the same keybindings file). URL logic is one shared pure module used at every boundary.

**Tech Stack:** Electron main/preload/renderer, `<webview>` tag, React 19, vitest (`tests/unit/**`, node env), Playwright `_electron` e2e with a local `http.createServer` fixture.

Spec: `docs/superpowers/specs/2026-07-08-m35-environments-design.md` (approved 2026-07-08).

## Global Constraints

- Conventional Commits, subject ≤ 50 chars, body lines ≤ 100 chars; `npm run check` green before every commit; PR titles ≤ 50 chars.
- The rename is TOTAL and atomic (one commit): actions `environment-1…9` / `move-to-environment-1…9` (defaults unchanged: `cmd+1…9` / `ctrl+1…9`), sessions.json field `environment`, config.json names key `environments`, IPC `session:setEnvironment` / `environments:getNames`, module `src/shared/environment.ts`, DOM hook `data-nav-environment`, sidebar header "Environments", nav item "Environment" (was "Terminals"), internal view key `'environment'` (was `'terminals'`). No `workspace` spelling survives in `src/`, `tests/`, or `README.md` except historical mentions in `docs/superpowers/` (plans/ledger stay as written; roadmap gets an amendment note).
- Browser panes: `kind: 'browser'`, persisted `url` (updated as the user browses), no pty, status `running` (open) / `exited` (closed), never `needs-you`. No fake agent in the `AgentId` union — browser records store inert filler (`agentId: 'custom'`, `command: ''`) and every UI surface branches on `kind`.
- URL policy at EVERY boundary (create, navigate, persist, open-external): `http:`/`https:` only, parsed with `new URL`; scheme-less input normalized to `https://` at the UI layer. One shared helper module — no duplicated validation logic.
- Webview security (stricter than the app window): `partition="persist:browser-panes"`, no preload, no `nodeintegration`, no `allowpopups`; main denies all permission requests for that partition, blocks non-http(s) `will-navigate`, and routes `window.open` to `shell.openExternal` (http/https) or denies.
- Bound key combos must keep working while a webview or the URL bar has focus (spec §4). Plain keystrokes in the URL bar must never reach other panes.
- DOM contract: `.pane[data-pane-id][data-status]`, `.session-row[data-session-id]`, `.dot[data-status]`, `[data-nav-session]`, `[data-nav-environment]`. Browser panes reuse the `.pane` contract.
- Button mousedown discipline: `onMouseDown={(e) => e.preventDefault()}`; pane-header buttons also `stopPropagation`. The URL bar is the documented exception (it must take focus) — it stops propagation without preventing default.
- Out of scope (spec §7): DRM/Widevine, devtools toggle, per-pane zoom, favicon/title auto-naming, omnibox history, M5 tree children, native-app embedding.

---

### Task 1: The rename — workspace → environment, everywhere

**Files:**
- Rename: `src/shared/workspace.ts` → `src/shared/environment.ts`; `src/main/workspace-names.ts` → `src/main/environment-names.ts`; `tests/unit/workspace.test.ts` → `tests/unit/environment.test.ts`; `tests/unit/workspace-names.test.ts` → `tests/unit/environment-names.test.ts`
- Modify: `src/shared/types.ts`, `src/shared/keybindings.ts`, `src/shared/api.ts`, `src/main/persistence.ts`, `src/main/session-manager.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/lib/needs-you.ts`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/styles.css`, `tests/unit/keybindings.test.ts`, `tests/unit/needs-you.test.ts`, `tests/unit/session-manager.test.ts`, `tests/unit/persistence.test.ts`, `tests/e2e/smoke.spec.ts`, `README.md`

**Interfaces:**
- Consumes: everything M3 shipped under the workspace name.
- Produces (all later tasks use ONLY these spellings):
  - `src/shared/environment.ts`: `ENVIRONMENT_MIN = 1`, `ENVIRONMENT_MAX = 9`, `clampEnvironment(raw: unknown): number`, `visibleEnvironments(sessions: { environment: number }[], current: number): number[]`, `worstStatus(statuses: SessionStatus[]): SessionStatus` (unchanged name).
  - `SessionInfo.environment: number`; `SavedSession.environment?: number`.
  - `KeyAction`: `'environment-1'`…`'environment-9'`, `'move-to-environment-1'`…`'move-to-environment-9'` (defaults `cmd+N` / `ctrl+N`).
  - `SessionManager.create(cwd, spec, environment)`, `.setEnvironment(id, environment): SessionInfo | null`, `.restore(..., environment?: unknown)`.
  - IPC `session:setEnvironment`, `environments:getNames`; `LocalflowApi.setEnvironment(id, environment)`, `.getEnvironmentNames()`, `createSession(agentId, cwd?, customCommand?, environment?)`.
  - `src/main/environment-names.ts`: `parseEnvironmentNames(raw: unknown)`, `loadEnvironmentNames(configFile)` reading config key `environments`.
  - App: state `environment`, `switchEnvironment(n)`, `moveToEnvironment(id, n)`, view union `'home' | 'environment' | 'settings'`; Sidebar props `environment`, `onSwitchEnvironment`, `onEnvironment` (nav callback, was `onTerminals`), nav label "Environment", section header "Environments", `data-nav-environment`.
  - `nextNeedsYou(order, sessions, activeId, currentEnvironment)`.

This is a pure rename: NO behavior changes, NO new features. The reviewer's job is verifying totality and behavior-preservation.

- [ ] **Step 1: Mechanical sweep**

Use `git mv` for the four renamed files, then sweep identifiers. Exact replacement table (case-sensitive; apply in this order to avoid partial overlaps):

| old | new |
|---|---|
| `WORKSPACE_MIN` / `WORKSPACE_MAX` | `ENVIRONMENT_MIN` / `ENVIRONMENT_MAX` |
| `clampWorkspace` | `clampEnvironment` |
| `visibleWorkspaces` | `visibleEnvironments` |
| `parseWorkspaceNames` / `loadWorkspaceNames` | `parseEnvironmentNames` / `loadEnvironmentNames` |
| `setWorkspace` (manager method, IPC channel `session:setWorkspace`, api/preload) | `setEnvironment` / `session:setEnvironment` |
| `workspaces:getNames` / `getWorkspaceNames` | `environments:getNames` / `getEnvironmentNames` |
| `'workspace-` (action literals) | `'environment-` |
| `'move-to-workspace-` | `'move-to-environment-` |
| `workspace-` / `move-to-workspace-` (README keybinding names, dispatcher `startsWith`/`slice` strings) | `environment-` / `move-to-environment-` |
| `switchWorkspace` / `moveToWorkspace` / `onSwitchWorkspace` | `switchEnvironment` / `moveToEnvironment` / `onSwitchEnvironment` |
| `data-nav-workspace` | `data-nav-environment` |
| `workspace` (SessionInfo field, SavedSession field, App state, params, test fixtures, sessions.json assertions) | `environment` |
| `currentWorkspace` (needs-you param) | `currentEnvironment` |
| `"workspaces"` (config.json key in environment-names + its tests + README) | `"environments"` |

View/nav rename (NOT string-replaceable — do by hand):
- `App.tsx`: view union `'terminals'` → `'environment'`; `showTerminals` → `showEnvironment`; `enterTerminals` → `enterEnvironment`; every `view === 'terminals'` / `setView('terminals')` updated; the `liveRef` comment's "terminals view" wording updated.
- `Sidebar.tsx`: prop `view` union member `'terminals'` → `'environment'`; nav button label `Terminals` → `Environment`; prop `onTerminals` → `onEnvironment`; section header `Workspaces` → `Environments`.
- `tests/e2e/smoke.spec.ts`: `getByRole('button', { name: 'Terminals', exact: true })` → `'Environment'`; `data-nav-workspace` → `data-nav-environment`; sessions.json `workspace` field assertions → `environment`; the workspace e2e test's title/comments.
- `styles.css`: `[data-nav-workspace]` selectors → `[data-nav-environment]`.
- `README.md`: table rows ("Switch workspace" → "Switch environment", "Move pane to workspace" → "Move pane to environment"), all 18 example entries, the workspaces paragraph (reworded: "Sessions live on **environments 1–9** — one per customer or project…"), any remaining "workspace" prose.

Doc comments mentioning "workspace" in renamed/touched files: update wording to "environment" (e.g. types.ts field comment: `/** Environment 1-9 this session lives on (one per customer/project, M3.5 rename). */`).

- [ ] **Step 2: Verify totality**

Run: `grep -rni workspace src/ tests/ README.md | grep -v node_modules`
Expected: ZERO hits. (docs/superpowers/ is exempt — do not touch plans or old specs; the roadmap amendment happens in Task 6.)

- [ ] **Step 3: Full check + e2e**

Run: `npm run check && npm run e2e`
Expected: both fully green — the rename must be behavior-preserving; any failure is a missed reference.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename workspace to environment"
```

---

### Task 2: Shared URL module + browser session records + IPC

**Files:**
- Create: `src/shared/urls.ts`
- Create: `tests/unit/urls.test.ts`
- Modify: `src/shared/types.ts`, `src/main/persistence.ts`, `src/main/session-manager.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/shared/api.ts`
- Test: extend `tests/unit/session-manager.test.ts`, `tests/unit/persistence.test.ts`

**Interfaces:**
- Consumes: Task 1's environment spellings (`clampEnvironment`, `SessionInfo.environment`, …).
- Produces:
  - `src/shared/urls.ts`: `normalizeHttpUrl(input: string): string | null` and `isHttpUrl(url: string): boolean`.
  - `src/shared/types.ts`: `export type SessionKind = 'terminal' | 'browser'`; `SessionInfo.kind: SessionKind`; `SessionInfo.url?: string`.
  - `SessionManager.createBrowser(url: string, environment: number): SessionInfo`, `.restoreBrowser(id: string, url: string, name?: string, environment?: unknown): SessionInfo | null` (null for invalid url), `.setUrl(id: string, url: string): SessionInfo | null`.
  - IPC: `session:createBrowser` (url, environment) invoke; `session:setUrl` invoke; `shell:openExternal` send (wired in Task 3's policy module — declared here in api/preload).
  - `LocalflowApi.createBrowserSession(url: string, environment?: number): Promise<SessionInfo | null>`, `.setSessionUrl(id: string, url: string): Promise<SessionInfo | null>`, `.openExternal(url: string): void`.

- [ ] **Step 1: Write the failing URL tests**

Create `tests/unit/urls.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeHttpUrl, isHttpUrl } from '../../src/shared/urls'

describe('normalizeHttpUrl', () => {
  it('passes through valid http/https URLs (normalized href)', () => {
    expect(normalizeHttpUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeHttpUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app')
  })
  it('prefixes https:// when the scheme is missing', () => {
    expect(normalizeHttpUrl('example.com')).toBe('https://example.com/')
    expect(normalizeHttpUrl('localhost:5173')).toBe('https://localhost:5173/')
  })
  it('trims surrounding whitespace', () => {
    expect(normalizeHttpUrl('  example.com  ')).toBe('https://example.com/')
  })
  it('rejects non-http(s) schemes outright', () => {
    expect(normalizeHttpUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeHttpUrl('data:text/html,<b>x</b>')).toBeNull()
    expect(normalizeHttpUrl('ftp://example.com')).toBeNull()
  })
  it('rejects empty and unparseable input', () => {
    expect(normalizeHttpUrl('')).toBeNull()
    expect(normalizeHttpUrl('   ')).toBeNull()
    expect(normalizeHttpUrl('http://')).toBeNull()
  })
})

describe('isHttpUrl', () => {
  it('accepts exactly http and https', () => {
    expect(isHttpUrl('https://example.com/x')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:8080')).toBe(true)
  })
  it('rejects everything else, including unparseable strings', () => {
    expect(isHttpUrl('file:///tmp')).toBe(false)
    expect(isHttpUrl('about:blank')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
    expect(isHttpUrl('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/urls.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/shared/urls.ts`**

```ts
/**
 * The one URL gate for browser panes. Everything that accepts a URL —
 * create, navigate, persist, open-external — goes through here: http(s)
 * only, parsed for real with `new URL`. Scheme-less user input
 * ("docs.example.com", "localhost:5173") gets an https:// prefix before
 * parsing; anything that declares another scheme (file:, javascript:,
 * data:, mailto:, …) is rejected, never rewritten.
 */
export function normalizeHttpUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  // A colon followed by a digit is a port (localhost:5173), not a scheme.
  // Any other "scheme:" prefix is explicit and must not be rewritten.
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?![0-9])/.test(trimmed)
  const candidate = hasExplicitScheme ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.hostname.length === 0) return null
    return url.href
  } catch {
    return null
  }
}

/** Strict check for already-formed URLs (navigation targets, open-external). */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
```

Add two more cases to the Step 1 test file (inside the `normalizeHttpUrl` describe) — they pin the port-vs-scheme distinction, the subtlest part of this function:

```ts
  it('treats host:port as a port, not a scheme', () => {
    expect(normalizeHttpUrl('localhost:5173')).toBe('https://localhost:5173/')
    expect(normalizeHttpUrl('127.0.0.1:3000/app')).toBe('https://127.0.0.1:3000/app')
  })
  it('does not rewrite explicit non-numeric schemes into hosts', () => {
    expect(normalizeHttpUrl('mailto:x@y.z')).toBeNull()
  })
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/urls.test.ts`
Expected: PASS (all cases including localhost:port).

- [ ] **Step 5: Types + persistence fields**

`src/shared/types.ts` — above `SessionInfo`:

```ts
export type SessionKind = 'terminal' | 'browser'
```

In `SessionInfo`, after `environment: number`:

```ts
  /** What this pane hosts. Absent in pre-M3.5 saved files ⇒ 'terminal'. */
  kind: SessionKind
  /** Browser panes only: the current URL, persisted as the user browses. */
  url?: string
```

`src/main/persistence.ts` — in `SavedSession`, after `environment?: number`:

```ts
  /** 'browser' for browser panes; absent ⇒ 'terminal'. */
  kind?: string
  /** Browser panes only. */
  url?: string
```

- [ ] **Step 6: Write the failing session-manager tests**

Extend `tests/unit/session-manager.test.ts` (adapt to the file's real fixtures; every existing `SessionInfo`-shaped expectation gains `kind: 'terminal'` only where tests assert whole objects — most assert single fields and need no change):

```ts
describe('browser sessions', () => {
  it('createBrowser makes a running, pty-less record named after the host', () => {
    const info = mgr.createBrowser('https://docs.example.com/guide', 3)
    expect(info.kind).toBe('browser')
    expect(info.status).toBe('running')
    expect(info.url).toBe('https://docs.example.com/guide')
    expect(info.name).toBe('docs.example.com')
    expect(info.environment).toBe(3)
    expect(info.cwd).toBe('')
  })

  it('closeTerminal exits a browser pane; restart reopens it', () => {
    const info = mgr.createBrowser('https://example.com/', 1)
    mgr.closeTerminal(info.id)
    expect(mgr.list().find((s) => s.id === info.id)?.status).toBe('exited')
    const reopened = mgr.restart(info.id)
    expect(reopened.status).toBe('running')
    expect(reopened.url).toBe('https://example.com/')
  })

  it('write/resize/peek are safe no-ops on browser panes', () => {
    const info = mgr.createBrowser('https://example.com/', 1)
    expect(() => mgr.write(info.id, 'x')).not.toThrow()
    expect(() => mgr.resize(info.id, 80, 24)).not.toThrow()
    expect(mgr.peek(info.id)).toEqual([])
  })

  it('setUrl updates and persists-notifies; rejects unknown ids', () => {
    const info = mgr.createBrowser('https://example.com/', 1)
    const updated = mgr.setUrl(info.id, 'https://example.com/deep/page')
    expect(updated?.url).toBe('https://example.com/deep/page')
    expect(mgr.setUrl('nope', 'https://x.y/')).toBeNull()
  })

  it('restoreBrowser recreates an exited pane; invalid url yields null', () => {
    const info = mgr.restoreBrowser('rb-1', 'https://example.com/', 'My docs', 2)
    expect(info?.status).toBe('exited')
    expect(info?.kind).toBe('browser')
    expect(info?.environment).toBe(2)
    expect(info?.name).toBe('My docs')
    expect(mgr.restoreBrowser('rb-2', 'file:///etc/passwd')).toBeNull()
  })

  it('hook events never touch browser panes', () => {
    const info = mgr.createBrowser('https://example.com/', 1)
    mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
    expect(mgr.list().find((s) => s.id === info.id)?.status).toBe('running')
  })
})
```

- [ ] **Step 7: Run to verify failure**

Run: `npx vitest run tests/unit/session-manager.test.ts`
Expected: FAIL — methods missing, `kind` missing.

- [ ] **Step 8: Implement in `src/main/session-manager.ts`**

1. Imports: add `import { normalizeHttpUrl } from '../shared/urls'`.
2. The inert spec browser records carry (module-level const, after `INSTANT_EXIT_MS`):

```ts
// Browser panes have no process; their Record_ still carries a SpawnSpec
// because the type requires one. This filler is inert — every code path
// branches on info.kind before touching spec/pty. No 'browser' member is
// added to AgentId (the registry/launcher must never see a fake agent).
const BROWSER_SPEC: SpawnSpec = {
  agentId: 'custom',
  command: '',
  resumeArgs: [],
  hookAdapter: 'none'
}
```

3. Both existing `info` literals in `spawn()` and the one in `restore()` gain `kind: 'terminal' as const` (placed after `environment`). TypeScript will point at every literal the moment `kind` becomes required — fix each.

4. New methods after `create` / before `restart`:

```ts
  /** A browser pane: an ordinary durable session with a URL instead of a pty. */
  createBrowser(url: string, environment: number): SessionInfo {
    const normalized = normalizeHttpUrl(url)
    if (!normalized) throw new Error(`invalid browser url: ${url}`)
    const info: SessionInfo = {
      id: randomUUID(),
      cwd: '',
      name: new URL(normalized).hostname,
      status: 'running',
      agentId: BROWSER_SPEC.agentId,
      command: BROWSER_SPEC.command,
      environment: clampEnvironment(environment),
      kind: 'browser',
      url: normalized
    }
    this.sessions.set(info.id, { info, spec: BROWSER_SPEC, pty: null, spawnedAt: 0, tail: '' })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  /** Restores a saved browser pane as exited. Null when the saved url is bad. */
  restoreBrowser(id: string, url: string, name?: string, environment?: unknown): SessionInfo | null {
    const normalized = normalizeHttpUrl(url)
    if (!normalized) return null
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const info: SessionInfo = {
      id,
      cwd: '',
      name: trimmed.length > 0 ? trimmed : new URL(normalized).hostname,
      status: 'exited',
      agentId: BROWSER_SPEC.agentId,
      command: BROWSER_SPEC.command,
      environment: clampEnvironment(environment),
      kind: 'browser',
      url: normalized
    }
    this.sessions.set(id, { info, spec: BROWSER_SPEC, pty: null, spawnedAt: 0, tail: '' })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  /** Follows the user's browsing: persist the pane's current URL. */
  setUrl(id: string, url: string): SessionInfo | null {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.kind !== 'browser') return null
    const normalized = normalizeHttpUrl(url)
    if (!normalized) return null
    if (rec.info.url !== normalized) {
      rec.info.url = normalized
      this.changedCbs.forEach((cb) => cb())
    }
    return { ...rec.info }
  }
```

5. `restart` branches for browser (insert before the existing spawn call):

```ts
  restart(id: string, fresh = false): SessionInfo {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status !== 'exited') throw new Error(`cannot restart session ${id}`)
    if (rec.info.kind === 'browser') {
      // Reopen at the stored URL; `fresh` has no meaning without a
      // conversation to resume and is deliberately identical.
      this.setStatus(id, 'running')
      return { ...rec.info }
    }
    return this.spawn(id, rec.info.cwd, rec.spec, !fresh, rec.info.name, rec.info.environment)
  }
```

6. `closeTerminal` branches for browser (insert after the `if (!rec ...)` fetch, replacing the single early return):

```ts
  closeTerminal(id: string): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    if (rec.info.kind === 'browser') {
      if (rec.info.status === 'exited') return
      this.setStatus(id, 'exited')
      this.changedCbs.forEach((cb) => cb())
      return
    }
    if (!rec.pty) return
    // ... existing pty path unchanged
```

7. `applyHookEvent` gains a kind guard (browser panes have no hook feed; a stray/malicious paneId hit must not recolor them):

```ts
  applyHookEvent(e: HookEvent): void {
    const rec = this.sessions.get(e.paneId)
    if (!rec || rec.info.kind === 'browser') return
    this.setStatus(e.paneId, transition(rec.info.status, e.event))
  }
```

- [ ] **Step 9: Run to verify green**

Run: `npx vitest run tests/unit/session-manager.test.ts`
Expected: PASS including all pre-existing tests.

- [ ] **Step 10: Persistence round-trip + main wiring**

Extend `tests/unit/persistence.test.ts`:

```ts
it('round-trips kind and url for browser panes', () => {
  const file = join(dir, 'sessions.json')
  saveSessions(file, [{ id: 'b', cwd: '', kind: 'browser', url: 'https://example.com/' }])
  const loaded = loadSavedSessions(file)
  expect(loaded[0]?.kind).toBe('browser')
  expect(loaded[0]?.url).toBe('https://example.com/')
})
```

`src/main/index.ts`:

1. saveSessions pick gains the fields:

```ts
      manager.list().map(({ id, cwd, agentId, command, name, environment, kind, url }) => ({
        id,
        cwd,
        agentId,
        command,
        name,
        environment,
        kind,
        url
      }))
```

2. Restore loop branches (replace the loop body):

```ts
  for (const saved of loadSavedSessions(sessionsFile)) {
    if (saved.kind === 'browser') {
      // restoreBrowser validates the stored URL; a hand-corrupted entry is
      // dropped rather than restored as an unloadable pane.
      manager.restoreBrowser(saved.id, saved.url ?? '', saved.name, saved.environment)
      continue
    }
    const agentId = VALID_AGENTS.includes(saved.agentId as AgentId)
      ? (saved.agentId as AgentId)
      : 'claude'
    const spec = agentId === 'custom' ? specFor(agentId, saved.command ?? '') : specFor(agentId)
    manager.restore(saved.id, saved.cwd, spec, saved.name, saved.environment)
  }
```

3. New handles after `session:setEnvironment` (import `normalizeHttpUrl` from `'../shared/urls'` and `clampEnvironment` is already imported):

```ts
  ipcMain.handle('session:createBrowser', (_e, url: string, environment?: number) => {
    // Validate at the boundary; manager.createBrowser re-validates (throws),
    // so reject cleanly here instead of surfacing an exception to the bridge.
    if (typeof url !== 'string' || normalizeHttpUrl(url) === null) return null
    return manager.createBrowser(url, clampEnvironment(environment))
  })
  ipcMain.handle('session:setUrl', (_e, id: string, url: string) =>
    typeof url === 'string' ? manager.setUrl(id, url) : null
  )
```

- [ ] **Step 11: api + preload**

`src/shared/api.ts` — after `setEnvironment`:

```ts
  /** Creates a browser pane on the given environment. Null for invalid URLs. */
  createBrowserSession(url: string, environment?: number): Promise<SessionInfo | null>
  /** Persists a browser pane's current URL (follows navigation). */
  setSessionUrl(id: string, url: string): Promise<SessionInfo | null>
  /** Opens an http(s) URL in the system browser. Non-http(s) is dropped in main. */
  openExternal(url: string): void
```

`src/preload/index.ts`:

```ts
  createBrowserSession: (url: string, environment?: number) =>
    ipcRenderer.invoke('session:createBrowser', url, environment),
  setSessionUrl: (id: string, url: string) => ipcRenderer.invoke('session:setUrl', id, url),
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
```

(The `shell:openExternal` main-side handler lands in Task 3 with the rest of the policy wiring.)

- [ ] **Step 12: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/shared/urls.ts src/shared/types.ts src/shared/api.ts src/main/persistence.ts src/main/session-manager.ts src/main/index.ts src/preload/index.ts tests/unit/urls.test.ts tests/unit/session-manager.test.ts tests/unit/persistence.test.ts
git commit -m "feat: browser session records and url gate"
```

---

### Task 3: Webview policy + key-combo forwarding (main)

**Files:**
- Create: `src/main/webview-policy.ts`
- Modify: `src/main/index.ts` (webviewTag, policy install, `shell:openExternal`, key forwarding)
- Modify: `src/preload/index.ts`, `src/shared/api.ts` (`onKeyAction`)
- Test: none new (pure wiring; the policy helpers reuse `isHttpUrl`, already unit-tested; behavior verified in Task 6's e2e + a manual checklist in this task's report)

**Interfaces:**
- Consumes: `isHttpUrl` (Task 2), `loadOrCreateKeybindings` + `parseBinding`/`eventMatches`/`bindingEntries` (existing shared code — works in main), `sendToWindow` (existing).
- Produces:
  - `installWebviewPolicy(opts: { bindings: Record<KeyAction, string>; onAction: (action: KeyAction) => void }): void` — attaches the global `app.on('web-contents-created')` handler and the partition permission handler.
  - IPC push channel `'keybinding:action'` (main → renderer); `LocalflowApi.onKeyAction(cb: (action: KeyAction) => void): () => void`.
  - IPC `'shell:openExternal'` (renderer → main, fire-and-forget, http/https only).
  - `BROWSER_PARTITION = 'persist:browser-panes'` exported for Task 4's webview element.

- [ ] **Step 1: Create `src/main/webview-policy.ts`**

```ts
import { app, session, shell } from 'electron'
import { isHttpUrl } from '../shared/urls'
import {
  parseBinding,
  eventMatches,
  bindingEntries,
  type KeyAction,
  type KeyEventLike
} from '../shared/keybindings'

/** The isolated storage partition every browser-pane webview runs in. */
export const BROWSER_PARTITION = 'persist:browser-panes'

/**
 * Webview pages are the app's only untrusted content — policy is stricter
 * than the app window (spec §3): all permission prompts denied, navigation
 * confined to http(s), popups sent to the system browser, and bound key
 * combos forwarded back to the app's dispatcher (keystrokes inside a
 * focused webview never bubble to the embedder DOM, so cmd+1…9 etc. would
 * otherwise die whenever a browser pane has focus).
 */
export function installWebviewPolicy(opts: {
  bindings: Record<KeyAction, string>
  onAction: (action: KeyAction) => void
}): void {
  session.fromPartition(BROWSER_PARTITION).setPermissionRequestHandler((_wc, _permission, cb) => {
    cb(false)
  })

  const parsed = bindingEntries(opts.bindings).flatMap(([action, binding]) => {
    const p = parseBinding(binding)
    return p ? ([[action, p]] as const) : []
  })

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const like: KeyEventLike = {
        key: input.key,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        code: input.code
      }
      const match = parsed.find(([, binding]) => eventMatches(binding, like))
      if (!match) return
      event.preventDefault()
      opts.onAction(match[0])
    })
  })
}
```

- [ ] **Step 2: Wire it in `src/main/index.ts`**

1. `createWindow` webPreferences gains (with comment, alongside the existing `sandbox: false` judgment-call note):

```ts
      // Browser panes use the <webview> tag: it participates in DOM layout
      // (grid/enlarge/focus need no special-casing, unlike WebContentsView).
      // Guest pages are locked down in installWebviewPolicy.
      webviewTag: true,
```

2. In `whenReady`, after `keybindings` is loaded and `sendToWindow` is defined (policy needs both — move the `installWebviewPolicy` call after the `sendToWindow` declaration):

```ts
  installWebviewPolicy({
    bindings: keybindings,
    onAction: (action) => sendToWindow('keybinding:action', action)
  })
```

Import: `import { installWebviewPolicy } from './webview-policy'`.

3. `shell:openExternal` handler next to `session:write` (import `shell` from electron, `isHttpUrl` from `'../shared/urls'`):

```ts
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && isHttpUrl(url)) void shell.openExternal(url)
  })
```

- [ ] **Step 3: Preload + api for the action push channel**

`src/shared/api.ts` — after `getKeybindings()`:

```ts
  /** Bound combos pressed while a webview has focus, forwarded from main. */
  onKeyAction(cb: (action: KeyAction) => void): () => void
```

`src/preload/index.ts` (mirror the `onStatus` listener pattern; import `KeyAction` type):

```ts
  onKeyAction: (cb) => {
    const listener = (_e: IpcRendererEvent, action: KeyAction): void => cb(action)
    ipcRenderer.on('keybinding:action', listener)
    return () => ipcRenderer.removeListener('keybinding:action', listener)
  },
```

- [ ] **Step 4: Full check + manual checklist + commit**

Run: `npm run check` — expected PASS.

Record in the task report (manual verification checklist for the human, mirroring the M2 hook-checklist precedent — these are hard to e2e):
1. A page calling `Notification.requestPermission()` / getUserMedia is denied without a prompt.
2. A `target="_blank"` link opens in the system browser, never a new Electron window.
3. Typing `file:///etc/passwd` in the URL bar is rejected (Task 4 gates it, main double-gates).
4. With a webview focused, `cmd+2` still switches environments.

```bash
git add src/main/webview-policy.ts src/main/index.ts src/preload/index.ts src/shared/api.ts
git commit -m "feat: webview policy and key forwarding"
```

---

### Task 4: BrowserPane component + grid + dispatcher integration

**Files:**
- Create: `src/renderer/src/components/BrowserPane.tsx`
- Modify: `src/renderer/src/env.d.ts` (webview JSX typing)
- Modify: `src/renderer/src/App.tsx` (render by kind; `runAction` extraction + `onKeyAction` subscription)
- Test: none new (no component rig; behavior in Task 6 e2e; `npm run check` gates)

**Interfaces:**
- Consumes: `SessionInfo.kind`/`url` (Task 2), `window.localflow.setSessionUrl` / `openExternal` (Tasks 2-3), `onKeyAction` (Task 3), `normalizeHttpUrl` (Task 2 — shared module works in the renderer), partition string `'persist:browser-panes'` (MUST match Task 3's `BROWSER_PARTITION`; it is a JSX attribute here, so the literal is repeated with a comment pointing at the constant).
- Produces: `BrowserPane` default export, props `{ session: SessionInfo; enlarged: boolean; active: boolean; onToggleEnlarge: () => void; onActivate: () => void; onReopen: () => void; onClose: () => void }`. e2e contract: the pane keeps `.pane[data-pane-id][data-status]`; the webview element carries class `.browser-view`; the URL input carries class `.url-bar`; buttons `.nav-back`, `.nav-forward`, `.nav-reload`, `.open-external`.

- [ ] **Step 1: webview JSX typing in `src/renderer/src/env.d.ts`**

Append:

```ts
// The <webview> tag is enabled via webviewTag: true (main). React has no
// intrinsic for it; typed here once. Methods (goBack, loadURL, …) come from
// Electron.WebviewTag via the ref cast in BrowserPane.
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
        },
        HTMLElement
      >
    }
  }
}
```

- [ ] **Step 2: Create `src/renderer/src/components/BrowserPane.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import type { SessionInfo } from '../../../shared/types'
import { normalizeHttpUrl } from '../../../shared/urls'

interface Props {
  session: SessionInfo
  enlarged: boolean
  active: boolean
  onToggleEnlarge: () => void
  onActivate: () => void
  /** Remounts an exited browser pane at its stored URL. */
  onReopen: () => void
  onClose: () => void
}

/**
 * A browser pane: same .pane shell and header discipline as TerminalPane,
 * with a guest <webview> instead of xterm. The URL bar is the one header
 * control allowed to take DOM focus; everything else preserves the
 * "clicking chrome never steals focus" rule. Navigation is followed and
 * persisted (main is the source of truth for the stored URL), so a
 * relaunch reopens where the user actually was.
 */
export default function BrowserPane({
  session,
  enlarged,
  active,
  onToggleEnlarge,
  onActivate,
  onReopen,
  onClose
}: Props): React.JSX.Element {
  const viewRef = useRef<WebviewTag | null>(null)
  // The URL bar mirrors navigation but must not clobber the user's typing:
  // editing=true freezes mirroring until Enter/Escape/blur.
  const [barValue, setBarValue] = useState(session.url ?? '')
  const [editing, setEditing] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const alive = session.status !== 'exited'

  useEffect(() => {
    if (!alive) return
    const view = viewRef.current
    if (!view) return
    const onNavigate = (): void => {
      const current = view.getURL()
      setCanGoBack(view.canGoBack())
      setCanGoForward(view.canGoForward())
      if (!editing) setBarValue(current)
      void window.localflow.setSessionUrl(session.id, current)
    }
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigate)
    return () => {
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigate)
    }
  }, [session.id, alive, editing])

  // Parallel to TerminalPane's xterm focus rule: the active pane's guest
  // page owns the keyboard (bound combos still work — main forwards them).
  useEffect(() => {
    if (active && alive) viewRef.current?.focus()
  }, [active, alive])

  const navigate = (): void => {
    const normalized = normalizeHttpUrl(barValue)
    if (!normalized) return // invalid input: leave the bar as-is, no nav
    setEditing(false)
    setBarValue(normalized)
    void viewRef.current?.loadURL(normalized)
  }

  const headerBtn =
    'cursor-pointer border-0 bg-transparent text-xs text-gray-400 hover:text-white disabled:cursor-default disabled:opacity-35 disabled:hover:text-gray-400'
  const guard = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      className={
        'pane border-exited bg-surface-raised flex min-h-0 flex-col overflow-hidden rounded-lg border-2' +
        (enlarged ? ' enlarged' : '') +
        (active ? ' active' : '')
      }
      data-pane-id={session.id}
      data-status={session.status}
      onMouseDown={() => {
        onActivate()
        if (active) viewRef.current?.focus()
      }}
    >
      <div
        className="pane-header flex cursor-pointer items-center gap-2 bg-white/[0.04] px-2.5 py-1 text-xs select-none"
        onDoubleClick={onToggleEnlarge}
        onMouseDown={(e) => e.preventDefault()}
      >
        <span className="dot bg-exited h-2.5 w-2.5 rounded-full" />
        <span className="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
          {session.name}
        </span>
        <input
          className="url-bar bg-surface min-w-0 flex-1 rounded border border-white/[0.14] px-1.5 py-0.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40"
          value={barValue}
          spellCheck={false}
          onFocus={() => setEditing(true)}
          onChange={(e) => setBarValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              navigate()
              viewRef.current?.focus()
            } else if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
              // Restore the real URL and hand focus back to the page.
              setEditing(false)
              setBarValue(viewRef.current?.getURL() ?? session.url ?? '')
              viewRef.current?.focus()
            }
          }}
          onBlur={() => setEditing(false)}
          onMouseDown={(e) => {
            // The one focusable header control: allow default (focus +
            // caret) but keep the pane root's activate-refocus from
            // yanking focus back to the webview.
            e.stopPropagation()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        <button
          className={`nav-back ${headerBtn}`}
          disabled={!alive || !canGoBack}
          onClick={() => viewRef.current?.goBack()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ‹
        </button>
        <button
          className={`nav-forward ${headerBtn}`}
          disabled={!alive || !canGoForward}
          onClick={() => viewRef.current?.goForward()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ›
        </button>
        <button
          className={`nav-reload ${headerBtn}`}
          disabled={!alive}
          onClick={() => viewRef.current?.reload()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ⟳
        </button>
        <button
          className={`open-external ${headerBtn}`}
          disabled={!alive}
          title="Open in system browser"
          onClick={() => {
            const current = viewRef.current?.getURL() ?? session.url
            if (current) window.localflow.openExternal(current)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          ↗
        </button>
        <button
          className={headerBtn}
          onClick={() => {
            onActivate()
            onToggleEnlarge()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          {enlarged ? 'shrink' : 'enlarge'}
        </button>
        <button
          className={headerBtn}
          onClick={onClose}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={guard}
        >
          close
        </button>
      </div>
      {alive ? (
        <webview
          // Must equal BROWSER_PARTITION in src/main/webview-policy.ts —
          // the partition carries the deny-all permission handler.
          partition="persist:browser-panes"
          className="browser-view min-h-0 flex-1"
          src={session.url}
          ref={(el) => {
            viewRef.current = el as WebviewTag | null
          }}
        />
      ) : (
        <div className="restart-overlay flex flex-1 flex-col items-center justify-center gap-3">
          <p className="m-0 max-w-[80%] px-4 text-center text-[13px] text-gray-400">
            {session.url}
          </p>
          <button
            className="cursor-pointer rounded-md border-0 bg-gray-700 px-4 py-2 text-white"
            onClick={onReopen}
            onMouseDown={(e) => e.preventDefault()}
          >
            Reopen
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: App.tsx — render by kind, dispatch forwarded actions**

1. Import: `import BrowserPane from './components/BrowserPane'`.

2. In the grid JSX, replace the single `<TerminalPane …/>` with a kind branch (props map 1:1; `onReopen` is `restart(id, false)`):

```tsx
              .map((s) =>
                s.kind === 'browser' ? (
                  <BrowserPane
                    key={s.id}
                    session={s}
                    enlarged={enlarged === s.id}
                    active={activeId === s.id}
                    onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
                    onActivate={() => setActiveId(s.id)}
                    onReopen={() => void restart(s.id, false)}
                    onClose={() => void closeTerminal(s.id)}
                  />
                ) : (
                  <TerminalPane
                    key={s.id}
                    session={s}
                    enlarged={enlarged === s.id}
                    active={activeId === s.id}
                    onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
                    onActivate={() => setActiveId(s.id)}
                    onRestart={(fresh) => void restart(s.id, fresh)}
                    onClose={() => void closeTerminal(s.id)}
                  />
                )
              )}
```

3. Extract the dispatcher's action handling so main-forwarded actions reuse it. Inside the mount-once dispatcher effect, restructure `onKey` into `runAction(action)` + a thin `onKey` wrapper, and subscribe to the forward channel IN THE SAME EFFECT:

```ts
    const runAction = (action: KeyAction): void => {
      // (the entire existing body of onKey after the preventDefault/
      //  stopPropagation lines moves here verbatim — every `action`
      //  reference stays; nothing else changes)
    }
    const onKey = (e: KeyboardEvent): void => {
      const match = bindings.find(([, binding]) => eventMatches(binding, e))
      if (!match) return
      e.preventDefault()
      e.stopPropagation()
      runAction(match[0])
    }
    const offForwarded = window.localflow.onKeyAction((action) => runAction(action))
    window.addEventListener('keydown', onKey, true)
    return () => {
      offForwarded()
      window.removeEventListener('keydown', onKey, true)
    }
```

CAUTION: while the URL bar is focused, bound combos still hit the window capture-phase listener (the URL bar is in the embedder DOM, not the guest) — correct and intended; plain keys go to the input and nowhere else. No extra code needed.

- [ ] **Step 4: Full check + commit**

Run: `npm run check`
Expected: PASS (typecheck exercises the webview JSX declaration and WebviewTag ref cast).

```bash
git add src/renderer/src/components/BrowserPane.tsx src/renderer/src/env.d.ts src/renderer/src/App.tsx
git commit -m "feat: browser pane with mini-browser chrome"
```

---

### Task 5: Creation UI + overview/sidebar presentation

**Files:**
- Modify: `src/renderer/src/components/Landing.tsx`
- Modify: `src/renderer/src/App.tsx` (create-browser wiring)
- Test: none new (Task 6 e2e drives the full UI path headlessly — browser creation needs no folder picker)

**Interfaces:**
- Consumes: `window.localflow.createBrowserSession(url, environment)` (Task 2), `normalizeHttpUrl` (Task 2), App's `environment` state.
- Produces: Landing prop `onCreateBrowser: (url: string) => void`; picker option `value="browser"` labeled `Browser…`; URL input class `.url-input` (e2e contract); browser rows show the URL as subtitle, chip text `browser`, and a single `reopen` action when exited.

- [ ] **Step 1: App.tsx — create wiring**

Next to `createSession`:

```ts
  const createBrowser = async (url: string): Promise<void> => {
    const created = await window.localflow.createBrowserSession(url, environment)
    if (created) {
      setView('environment')
      setEnlarged(null)
      setActiveId(created.id)
      await refresh()
    }
  }
```

Pass to Landing: `onCreateBrowser={(url) => void createBrowser(url)}`.

- [ ] **Step 2: Landing.tsx — picker + URL input + row presentation**

1. Import `normalizeHttpUrl` from `'../../../shared/urls'`. Props gain `onCreateBrowser: (url: string) => void`.

2. Selection state widens (browser is NOT an AgentId):

```ts
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | 'browser'>(AGENT_PRESETS[0].id)
  const [urlInput, setUrlInput] = useState('')
```

Existing `agents?.find` / `lastValid` logic is untouched (it never yields `'browser'`). Where `selectedAgentId` feeds APIs typed `AgentId`, the `'browser'` case is handled first so the narrowing holds.

3. `launchable` and `create`:

```ts
  const launchable =
    selectedAgentId === 'browser'
      ? normalizeHttpUrl(urlInput) !== null
      : selectedAgentId === 'custom'
        ? customCommand.trim().length > 0
        : !!selectedAgent?.resolvedPath

  const create = (): void => {
    if (!launchable) return
    if (selectedAgentId === 'browser') {
      onCreateBrowser(normalizeHttpUrl(urlInput)!)
      return
    }
    onCreate(selectedAgentId, selectedAgentId === 'custom' ? customCommand.trim() : undefined)
  }
```

(`selectedAgent` lookup: guard it — `const selectedAgent = selectedAgentId === 'browser' ? null : (agents?.find((a) => a.id === selectedAgentId) ?? null)`.)

4. Picker: after the `Custom command…` option:

```tsx
              <option value="browser">Browser…</option>
```

5. URL field (sibling of the custom-command input, same conditional pattern):

```tsx
            {selectedAgentId === 'browser' && (
              <input
                className="url-input bg-surface focus:border-working flex-1 rounded-md border border-white/[0.14] px-2.5 py-2 font-mono text-xs text-gray-200 outline-none"
                placeholder="e.g. localhost:5173 or docs.anthropic.com"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && normalizeHttpUrl(urlInput) !== null) create()
                }}
              />
            )}
```

6. The "not found / Configure in Settings" hint must not fire for browser: extend its condition with `selectedAgentId !== 'browser'`.

7. Row presentation (the sessions map): subtitle span shows `s.kind === 'browser' ? (s.url ?? '') : s.cwd` (and `title` likewise); agent chip content becomes:

```tsx
                    {s.kind === 'browser'
                      ? 'browser'
                      : s.agentId === 'custom'
                        ? s.command.split('/').pop()
                        : s.agentId}
```

Exited-row actions: browser panes get ONE button instead of resume/fresh:

```tsx
                    {s.status === 'exited' ? (
                      s.kind === 'browser' ? (
                        <button
                          className={rowBtn}
                          onClick={() => onResume(s.id, false)}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          reopen
                        </button>
                      ) : (
                        <>
                          {/* existing resume + fresh buttons, unchanged */}
                        </>
                      )
                    ) : (
                      /* existing open button, unchanged */
                    )}
```

(The `/* existing … */` comments are placement markers — keep the current button JSX verbatim inside the new branches.)

- [ ] **Step 3: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Landing.tsx
git commit -m "feat: create browser panes from overview"
```

---

### Task 6: e2e + docs

**Files:**
- Modify: `tests/e2e/smoke.spec.ts` (one new test)
- Modify: `README.md`, `docs/superpowers/specs/2026-07-06-localflow-v2-roadmap.md`

**Interfaces:**
- Consumes: everything above; e2e contract classes `.url-input`, `.url-bar`, `.browser-view`, `.nav-back`/`.nav-forward`/`.nav-reload`/`.open-external`; `data-nav-environment`; existing `launchApp` helper.
- Produces: milestone complete.

- [ ] **Step 1: Write the e2e test**

Append to `tests/e2e/smoke.spec.ts` (imports: add `createServer` from `'node:http'` and `AddressInfo` from `'node:net'` at the top of the file):

```ts
test('browser pane: UI creation, chrome, close/reopen, persistence', async () => {
  // Local page — no external network, no flake. Serves for the whole test.
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><title>fixture-page</title><h1>hello from fixture</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  await expect(win.locator('.new-session')).toBeVisible()

  // Fully UI-driven creation — browser panes need no folder picker, so this
  // is the first pane type whose whole creation path runs headless.
  await win.locator('.landing select').selectOption('browser')
  await expect(win.locator('.new-session')).toBeDisabled()
  await win.locator('.url-input').fill(pageUrl)
  await expect(win.locator('.new-session')).toBeEnabled()
  await win.locator('.new-session').click()

  // The pane mounts in the environment grid, violet (running), webview live.
  const pane = win.locator('.pane')
  await expect(pane).toHaveCount(1)
  await expect(pane).toHaveAttribute('data-status', 'running')
  await expect(pane.locator('.browser-view')).toHaveAttribute('src', pageUrl)
  await expect(pane.locator('.url-bar')).toHaveValue(pageUrl)

  // Chrome present; back/forward disabled on a fresh page, reload enabled.
  await expect(pane.locator('.nav-back')).toBeDisabled()
  await expect(pane.locator('.nav-forward')).toBeDisabled()
  await expect(pane.locator('.nav-reload')).toBeEnabled()
  await expect(pane.locator('.open-external')).toBeEnabled()

  // Close → gray exited with the Reopen overlay (never deletes).
  await pane.getByRole('button', { name: 'close', exact: true }).click()
  await expect(pane).toHaveAttribute('data-status', 'exited')
  await expect(pane.getByRole('button', { name: 'Reopen' })).toBeVisible()
  await expect(pane.locator('.browser-view')).toHaveCount(0)

  // Reopen → running again at the stored URL.
  await pane.getByRole('button', { name: 'Reopen' }).click()
  await expect(pane).toHaveAttribute('data-status', 'running')
  await expect(pane.locator('.browser-view')).toHaveAttribute('src', pageUrl)

  // Overview row: url subtitle, browser chip.
  await win.getByRole('button', { name: 'Overview', exact: true }).click()
  const row = win.locator('.session-row')
  await expect(row).toContainText('browser')
  await expect(row).toContainText(pageUrl)

  await app.close()

  // Relaunch: kind/url/environment persisted; pane restores as exited.
  const saved = JSON.parse(readFileSync(join(userData, 'sessions.json'), 'utf8')) as Array<{
    kind?: string
    url?: string
    environment?: number
  }>
  expect(saved[0]?.kind).toBe('browser')
  expect(saved[0]?.url).toBe(pageUrl)
  expect(saved[0]?.environment).toBe(1)

  const app2 = await launchApp(userData)
  const win2 = await app2.firstWindow()
  const row2 = win2.locator('.session-row')
  await expect(row2).toBeVisible()
  await expect(row2.getByRole('button', { name: 'reopen', exact: true })).toBeVisible()

  await app2.close()
  server.close()
})
```

- [ ] **Step 2: Run the full e2e suite**

Run: `npm run e2e`
Expected: ALL tests green (11 existing + 1 new = 12). A failure in the new test is a real Task 2-5 defect — investigate, never loosen assertions; report BLOCKED if it traces to earlier tasks.

- [ ] **Step 3: Docs**

1. `README.md` — new section after the environments paragraph:

```markdown
## Browser panes

An environment isn't only terminals: pick **Browser…** in the New session
launcher and give it a URL (scheme optional — `localhost:5173` works) to put
a web page in the grid — the localhost preview of what your agent is
building, docs, a PR. Browser panes get a URL bar, back/forward/reload, and
an open-in-system-browser button; they're violet while open (no status
feed), persist across restarts at the URL you left them on, and close/reopen
like any session. Embedded pages are sandboxed hard: permission prompts are
auto-denied, navigation is confined to http(s), and popups open in your
system browser. Keyboard combos (`cmd+1…9`, `cmd+u`, …) keep working while a
page has focus.
```

2. `docs/superpowers/specs/2026-07-06-localflow-v2-roadmap.md`:
   - § M3 heading line: append ` **Renamed workspaces → environments in M3.5.**` after the heading's first paragraph (one sentence, no rewrite of the shipped spec).
   - § M3.5: prepend a line `**Superseded by docs/superpowers/specs/2026-07-08-m35-environments-design.md (approved design; shipped).**`

- [ ] **Step 4: Full check + commit**

Run: `npm run check`
Expected: PASS.

```bash
git add tests/e2e/smoke.spec.ts README.md docs/superpowers/specs/2026-07-06-localflow-v2-roadmap.md
git commit -m "test: browser pane e2e; docs: environments"
```

---

## Self-Review Notes

**Spec coverage (design doc §§1-7):**
- §1 rename, total, atomic → Task 1 (grep-zero gate).
- §2 kind/url data model, no fake AgentId, hostname default name, url follows browsing, close/reopen semantics, never needs-you → Task 2 (incl. `applyHookEvent` guard; `cmd+u` skips browsers because they never reach `needs-you`).
- §3 webview tag + rationale, partition, deny-all permissions, http(s)-only nav, popups → system browser, boundary validation → Tasks 2-4 (shared `urls.ts` is the single gate; policy in `webview-policy.ts`).
- §4 full chrome (URL bar Enter/Escape semantics, back/forward/reload/open-external, focus rules, combos-keep-working) → Task 4 (`before-input-event` forwarding from Task 3 delivers the combos promise; native error pages by omission).
- §5 creation flow (Browser… option, URL field, disable gate, https prefix, current environment) → Task 5.
- §6 testing → Tasks 2 (unit) and 6 (e2e with local server, UI-driven creation).
- §7 out of scope → nothing in the plan builds any of it.

**Type consistency:** `normalizeHttpUrl(input): string | null` / `isHttpUrl(url): boolean` (Tasks 2/3/4/5); `createBrowser(url, environment)` / `restoreBrowser(id, url, name?, environment?)` / `setUrl(id, url)` (Task 2, consumed by index.ts same task); `createBrowserSession(url, environment?)` / `setSessionUrl(id, url)` / `openExternal(url)` / `onKeyAction(cb)` (api names, Tasks 2-5); `BrowserPane` props incl. `onReopen` (Tasks 4/5-App); environment spellings fixed by Task 1's table. All match.

**Known risks / accepted trade-offs:**
- Task 1 is a wide mechanical diff; its safety net is the zero-grep gate plus a fully green `npm run check && npm run e2e` with no behavior change.
- The partition string is duplicated (JSX attribute vs main constant) with cross-referencing comments — a webview attribute cannot import a TS constant without indirection that outweighs the risk.
- `setSessionUrl` fires on every navigation; `SessionManager.setUrl` no-ops on identical URLs, bounding sessions.json writes to real navigations.
- The URL-bar `barValue` mirrors via the `editing` flag; a navigation completing mid-edit is intentionally not mirrored (user's typing wins; Escape recovers the live URL).
- The e2e cannot cover: permission denial, popup→system-browser, non-http rejection inside the guest, combos-while-webview-focused. These are the four lines of Task 3's manual checklist, mirroring the M2 hook-verification precedent.
- `restoreBrowser` drops entries with corrupt URLs (session silently absent after relaunch) — chosen over restoring an unloadable pane; the sessions.json write on next change purges the entry.
