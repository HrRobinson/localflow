# Agent-driven environment control (OpenClaw) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an optional, per-environment, revocable **operator** (OpenClaw)
drive a saiife environment's panes through a loopback, token-guarded control
API, and let workflow **watchpoints** capture pane/workflow state at a chosen
step — while every pane stays fully human-drivable with no operator connected.

**Architecture:** saiife is the cockpit and control surface, not the brain. A
`pane-registry` assigns stable handles (a pane's handle *is* its session id) and
resolves them **only within a granted environment** (the isolation guarantee). An
`operator-grant` store mints a per-environment bearer secret. A single loopback
`control-api` HTTP server (same `node:http` + `timingSafeEqual` pattern as the
existing hook server) authenticates each request's bearer token to an
environment and dispatches environment-scoped routes: terminal control reuses
`SessionManager.write`/`peek`; browser control drives the **existing M3.5
`<webview>`** via its `webContents` (`loadURL`, `capturePage`, the `debugger`
CDP session, and the isolated `persist:browser-panes` partition's cookies). A
`capture-store` writes screenshots/captures to a per-environment scratch dir; a
`watchpoints` registry receives captures POSTed by the OpenClaw-side `checkpoint`
action. The renderer adds a read-only **cockpit** (operator status, action log,
captures) and a per-environment **grant toggle**. OpenClaw integrates via a
shipped `saiife` skill (SKILL.md + thin CLI) wrapping the control API.

**Tech Stack:** Electron main/preload/renderer, React 19, `node:http` loopback
server, Electron `webContents` DevTools protocol (`debugger`, `capturePage`,
partition `session.cookies`), vitest (`tests/unit/**`, node env), Playwright
`_electron` e2e driving a **scripted control-API client** (no real OpenClaw).

Spec: `docs/superpowers/specs/2026-07-09-agent-environment-control-design.md`
(approved 2026-07-09; currently on branch `docs/agent-env-control-spec` / PR #34).

## Global Constraints

- Conventional Commits, subject ≤ 50 chars, body lines ≤ 100 chars (husky + CI
  commitlint; PR titles ≤ 50 chars including GitHub's ` (#N)` squash suffix).
- `npm run check` (`eslint` + `prettier --check` + `tsc` typecheck + `vitest run`)
  green before every commit. `npm run e2e` (electron-vite build + Playwright) for
  e2e tasks.
- **This milestone runs in a SEPARATE git worktree.** Task 1 Step 1 begins with
  `npm ci` to install dependencies into the fresh worktree before anything else.
- **Opt-in, per-environment, revocable, never ambient.** An environment has **at
  most one operator (v1)**. No grant / revoked → the control API denies (403).
  Revocation takes effect immediately (the token stops resolving). A visible
  indicator whenever an environment has an operator.
- **Environment-scoped isolation enforced in `pane-registry`, not just the UI.**
  An operator whose token grants environment A can neither see nor drive
  environment B's panes: `resolve(handle, environment)` returns null for a
  foreign-environment handle. This is the "9 customers → 9 environments" story.
- **Loopback + per-grant bearer token.** The control-API server binds
  `127.0.0.1` only. Auth is `Authorization: Bearer <secret>`, compared with
  `crypto.timingSafeEqual` over SHA-256 digests (mirrors `hook-server.ts`). No
  token / wrong token → 403.
- **Partition-confined reads.** Cookies and network come from the isolated
  `persist:browser-panes` partition (`BROWSER_PARTITION` in `webview-policy.ts`),
  never the user's real browser session.
- **One browser, reused.** Browser control drives the same M3.5 `<webview>` a
  human drives. No second browser. `act` v1 is selector-based via
  `executeJavaScript`; the snapshot-ref interaction model is deferred (spec "Out
  of scope"). No remote-CDP endpoint is exposed (v1 choice, spec "Considered
  alternative — rejected").
- **Main is authoritative for identity and scope.** Handles, environments, and
  the pane→webContents mapping resolve from main's records — the control-API
  caller supplies only a handle string, never a cwd, path, or webContents id that
  main trusts. A screenshot path is minted by main under a per-environment
  scratch dir; the caller never chooses it.
- **Human override always.** Every pane is human-drivable regardless of the
  grant. Nothing in this milestone gates a pane on an operator being present.
- **Config-as-code.** No new persisted config files beyond a per-environment
  operator scratch dir under `userData`. The activity feed and watchpoints are
  **in-memory** (spec "Out of scope": no cross-restart persistence of the feed).
- **DOM contract used by CSS + e2e (do not rename).** Existing:
  `.pane[data-pane-id][data-status]`, `.session-row[data-session-id]`,
  `.dot[data-status]`, `[data-nav-session]`, `[data-nav-environment]`. New:
  `.cockpit-view`, `.operator-status[data-connected]`, `.operator-grant-toggle`,
  `.operator-activity`, `.activity-entry[data-route]`, `.captures-list`,
  `.capture-row[data-capture-id]` (`.halted` when awaiting resume),
  `.capture-resume`, `.capture-stop`, `.watchpoints-list`,
  `.watchpoint-row[data-watchpoint-id][data-hit]`, `.cockpit-empty`.
- **Button mousedown discipline:** every new renderer button gets
  `onMouseDown={(e) => e.preventDefault()}` (preserve the "clicking chrome never
  steals pane focus" rule).
- **Wire format is JSON over loopback HTTP** (this plan pins the spec's
  "illustrative, not final" shape — see the "Pinned control-API wire format"
  block below). Bodies are capped at 64 KiB; oversize → 400.

### Pinned control-API wire format (v1, authoritative)

Base URL `http://127.0.0.1:<port>` (loopback). Every request carries
`Authorization: Bearer <grant-secret>`; the secret resolves to exactly one
environment. `:handle` is a session id. Errors: `403` no/invalid/revoked token or
foreign-environment handle; `404` unknown or closed handle; `400` malformed body
or invalid argument. All bodies/responses are JSON.

```
GET    /panes                       -> 200 {panes: PaneView[]}
POST   /panes/:handle/navigate      {url}                 -> 200 {url}     (browser)
POST   /panes/:handle/screenshot                          -> 200 {path}   (browser)
GET    /panes/:handle/cookies                             -> 200 {cookies} (browser)
GET    /panes/:handle/network                             -> 200 {requests}(browser)
POST   /panes/:handle/act            {selector, action, text?} -> 200 {ok} (browser)
POST   /panes/:handle/prompt         {text, attachments?} -> 200 {ok}     (terminal)
GET    /panes/:handle/output?maxLines=N                   -> 200 {lines}  (terminal)
POST   /watchpoints                  {workflow, step, capture[], paneHandle?} -> 201 {id}
GET    /watchpoints                                       -> 200 {watchpoints}
POST   /captures                     {watchpointId, envelope?, screenshotHandle?,
                                       outputHandle?, memoryRef?, halted?, resumeToken?} -> 201 {id}
GET    /captures/:id                                      -> 200 {capture}
```

Shared types (defined in `src/shared/operator.ts`, Task 1):

```ts
type PaneKind = 'browser' | 'terminal'
interface PaneView { handle: string; kind: PaneKind; title: string; cwd: string; url?: string; status: string }
type CaptureKind = 'envelope' | 'screenshot' | 'output' | 'memory'
interface Watchpoint { id: string; environment: number; workflow: string; step: string; capture: CaptureKind[]; paneHandle?: string; hit: boolean }
interface Capture { id: string; environment: number; watchpointId: string; createdAt: number; envelope?: unknown; screenshotPath?: string; output?: string[]; memoryRef?: string; halted: boolean; resumeToken?: string }
interface ActivityEntry { at: number; route: string; handle?: string; detail?: string }
interface GrantInfo { environment: number; endpoint: string; token: string }
interface OperatorStatus { environment: number; granted: boolean; connected: boolean; endpoint?: string; activity: ActivityEntry[] }
```

---

## Layer 1 — Pane registry + operator grant + control API + terminal control

*Independently shippable: a scripted control-API client can grant an operator on
an environment and drive terminal panes (prompt/output) and list panes, with full
auth + scoping, before any browser or OpenClaw code exists.*

### Task 1: Shared operator types + pane registry (stable handles, env scoping)

**Files:**
- Create: `src/shared/operator.ts`
- Create: `src/main/pane-registry.ts`
- Create: `tests/unit/pane-registry.test.ts`

**Interfaces:**
- Consumes: existing `SessionInfo` (`id`, `environment`, `kind`, `cwd`, `name`,
  `status`, `url`); `SessionManager.list()`, `SessionManager.get(id)`.
- Produces (all later tasks rely on these exact names):
  - `src/shared/operator.ts`: the types in the "Pinned wire format" block above,
    plus `const CONTROL_MAX_BODY_BYTES = 65536`.
  - `src/main/pane-registry.ts`: `class PaneRegistry` with
    - `constructor(manager: Pick<SessionManager, 'list' | 'get'>)`
    - `list(environment: number): PaneView[]` — panes in that environment only.
    - `resolve(handle: string, environment: number): SessionInfo | null` — the
      session **iff** it exists and lives in `environment`, else null.
    - `toPaneView(info: SessionInfo): PaneView` (static-ish helper, exported).

- [ ] **Step 1: `npm ci` (fresh worktree)**

Run: `npm ci`
Expected: clean install; `npm run check` scripts become runnable.

- [ ] **Step 2: Write `src/shared/operator.ts`**

```ts
/** Shared operator/control-API types. No I/O — used by main and renderer. */

export type PaneKind = 'browser' | 'terminal'

/** One pane as seen over the control API. `handle` is the session id. */
export interface PaneView {
  handle: string
  kind: PaneKind
  title: string
  cwd: string
  url?: string
  status: string
}

export type CaptureKind = 'envelope' | 'screenshot' | 'output' | 'memory'

export interface Watchpoint {
  id: string
  environment: number
  workflow: string
  step: string
  capture: CaptureKind[]
  paneHandle?: string
  /** Flipped true once a matching capture arrives. */
  hit: boolean
}

export interface Capture {
  id: string
  environment: number
  watchpointId: string
  createdAt: number
  envelope?: unknown
  screenshotPath?: string
  output?: string[]
  memoryRef?: string
  /** True when the workflow halted on Lobster's approve token for review. */
  halted: boolean
  resumeToken?: string
}

/** One recorded control-API call, for the cockpit's action log. */
export interface ActivityEntry {
  at: number
  route: string
  handle?: string
  detail?: string
}

/** Returned to the UI/skill on grant: where + how to reach the control API. */
export interface GrantInfo {
  environment: number
  endpoint: string
  token: string
}

export interface OperatorStatus {
  environment: number
  granted: boolean
  connected: boolean
  endpoint?: string
  activity: ActivityEntry[]
}

/** Request/response bodies over this size are rejected with 400. */
export const CONTROL_MAX_BODY_BYTES = 65536
```

- [ ] **Step 3: Write the failing registry test**

Create `tests/unit/pane-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PaneRegistry } from '../../src/main/pane-registry'
import type { SessionInfo } from '../../src/shared/types'

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'x', cwd: '/p', name: 'p', status: 'idle', agentId: 'claude',
    command: 'claude', environment: 1, kind: 'terminal', ...over
  }
}

function fakeManager(sessions: SessionInfo[]): { list: () => SessionInfo[]; get: (id: string) => SessionInfo | null } {
  return { list: () => sessions, get: (id) => sessions.find((s) => s.id === id) ?? null }
}

describe('PaneRegistry', () => {
  const a1 = session({ id: 'a1', environment: 1, name: 'shopA-term' })
  const a2 = session({ id: 'a2', environment: 1, kind: 'browser', url: 'http://localhost:3000', name: 'shopA-web' })
  const b1 = session({ id: 'b1', environment: 2, name: 'shopB-term' })
  const reg = new PaneRegistry(fakeManager([a1, a2, b1]))

  it('lists only panes in the given environment', () => {
    const handles = reg.list(1).map((p) => p.handle).sort()
    expect(handles).toEqual(['a1', 'a2'])
  })

  it('resolves a handle only within its environment', () => {
    expect(reg.resolve('a1', 1)?.id).toBe('a1')
    // Foreign-environment handle is rejected — the isolation guarantee.
    expect(reg.resolve('b1', 1)).toBeNull()
    expect(reg.resolve('a1', 2)).toBeNull()
    expect(reg.resolve('nope', 1)).toBeNull()
  })

  it('projects a browser pane to a PaneView with its url', () => {
    const view = reg.list(1).find((p) => p.handle === 'a2')
    expect(view).toMatchObject({ kind: 'browser', url: 'http://localhost:3000', title: 'shopA-web' })
  })
})
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run tests/unit/pane-registry.test.ts`
Expected: FAIL — `src/main/pane-registry` not found.

- [ ] **Step 5: Create `src/main/pane-registry.ts`**

```ts
import type { SessionInfo } from '../shared/types'
import type { PaneView } from '../shared/operator'

/** The slice of SessionManager the registry needs (kept narrow for testing). */
interface SessionSource {
  list(): SessionInfo[]
  get(id: string): SessionInfo | null
}

/** Project a session to its control-API view. */
export function toPaneView(info: SessionInfo): PaneView {
  return {
    handle: info.id,
    kind: info.kind,
    title: info.name,
    cwd: info.cwd,
    url: info.url,
    status: info.status
  }
}

/**
 * Assigns stable pane handles (a pane's handle IS its session id, already a
 * stable UUID) and — critically — resolves a handle ONLY within a given
 * environment. This is where the cross-environment isolation guarantee lives:
 * an operator granted on environment A can never resolve an environment-B
 * handle, no matter what string it sends.
 */
export class PaneRegistry {
  constructor(private source: SessionSource) {}

  /** Panes in `environment`, projected to control-API views. */
  list(environment: number): PaneView[] {
    return this.source
      .list()
      .filter((s) => s.environment === environment)
      .map(toPaneView)
  }

  /** The session for `handle` iff it lives in `environment`; else null. */
  resolve(handle: string, environment: number): SessionInfo | null {
    const s = this.source.get(handle)
    return s && s.environment === environment ? s : null
  }
}
```

- [ ] **Step 6: Run to verify green**

Run: `npx vitest run tests/unit/pane-registry.test.ts`
Expected: PASS.

- [ ] **Step 7: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/shared/operator.ts src/main/pane-registry.ts tests/unit/pane-registry.test.ts
git commit -m "feat: operator types and pane registry"
```

---

### Task 2: Operator-grant store (per-env secret mint, token→env, revoke)

**Files:**
- Create: `src/main/operator-grant.ts`
- Create: `tests/unit/operator-grant.test.ts`

**Interfaces:**
- Consumes: `node:crypto` (`randomUUID`).
- Produces:
  - `class OperatorGrantStore`:
    - `grant(environment: number): string` — mints (or returns the existing)
      per-environment bearer secret; one operator per environment.
    - `revoke(environment: number): void` — drops the grant; its token stops
      resolving immediately.
    - `environmentForToken(token: string): number | null` — constant-time match;
      null when no grant holds that token.
    - `isGranted(environment: number): boolean`
    - `markConnected(environment: number): void` / `isConnected(environment: number): boolean`
      — "connected" flips true the first time the token is used successfully.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/operator-grant.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { OperatorGrantStore } from '../../src/main/operator-grant'

describe('OperatorGrantStore', () => {
  it('mints a per-environment secret and resolves it back to the env', () => {
    const store = new OperatorGrantStore()
    const tokenA = store.grant(1)
    const tokenB = store.grant(2)
    expect(tokenA).not.toBe(tokenB)
    expect(store.environmentForToken(tokenA)).toBe(1)
    expect(store.environmentForToken(tokenB)).toBe(2)
    expect(store.environmentForToken('garbage')).toBeNull()
  })

  it('is idempotent per environment (one operator per env)', () => {
    const store = new OperatorGrantStore()
    expect(store.grant(3)).toBe(store.grant(3))
    expect(store.isGranted(3)).toBe(true)
  })

  it('revocation invalidates the token immediately', () => {
    const store = new OperatorGrantStore()
    const token = store.grant(4)
    store.revoke(4)
    expect(store.environmentForToken(token)).toBeNull()
    expect(store.isGranted(4)).toBe(false)
  })

  it('tracks connected once the token is used', () => {
    const store = new OperatorGrantStore()
    store.grant(5)
    expect(store.isConnected(5)).toBe(false)
    store.markConnected(5)
    expect(store.isConnected(5)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/operator-grant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/main/operator-grant.ts`**

```ts
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest()
}

interface Grant {
  token: string
  connected: boolean
}

/**
 * Per-environment operator grants. At most one operator per environment (v1):
 * a grant mints a bearer secret; the control API resolves an incoming token
 * back to its environment in constant time. Revocation drops the grant so the
 * token stops resolving immediately (spec: "Revoking it immediately invalidates
 * the operator's access"). All in-memory — grants do not survive a restart.
 */
export class OperatorGrantStore {
  private byEnv = new Map<number, Grant>()

  grant(environment: number): string {
    const existing = this.byEnv.get(environment)
    if (existing) return existing.token
    const token = randomUUID()
    this.byEnv.set(environment, { token, connected: false })
    return token
  }

  revoke(environment: number): void {
    this.byEnv.delete(environment)
  }

  /** Constant-time token match; null when no grant currently holds it. */
  environmentForToken(token: string): number | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const probe = sha256(token)
    for (const [env, grant] of this.byEnv) {
      if (timingSafeEqual(probe, sha256(grant.token))) return env
    }
    return null
  }

  isGranted(environment: number): boolean {
    return this.byEnv.has(environment)
  }

  markConnected(environment: number): void {
    const g = this.byEnv.get(environment)
    if (g) g.connected = true
  }

  isConnected(environment: number): boolean {
    return this.byEnv.get(environment)?.connected ?? false
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/operator-grant.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/operator-grant.ts tests/unit/operator-grant.test.ts
git commit -m "feat: per-environment operator grant store"
```

---

### Task 3: Control-API loopback server — auth, scoping, `/panes`, terminal routes

**Files:**
- Create: `src/main/control-api.ts`
- Create: `tests/unit/control-api.test.ts`

**Interfaces:**
- Consumes: Task 1 `PaneRegistry`, `toPaneView`, `CONTROL_MAX_BODY_BYTES`,
  `PaneView`; Task 2 `OperatorGrantStore`; existing `SessionManager`
  (`write(id, data)`, `peek(id, maxLines)`). `node:http`, `node:crypto`.
- Produces:
  - `interface ControlDeps { registry: PaneRegistry; grants: OperatorGrantStore;
    manager: Pick<SessionManager, 'write' | 'peek'>; onActivity?: (env: number, e: ActivityEntry) => void;
    browser?: BrowserControl; captures?: CaptureStore; watchpoints?: WatchpointRegistry }`
    — `browser`/`captures`/`watchpoints` are optional here and wired in Layers 2/4.
  - `interface ControlEndpoint { port: number; close(): void }`
  - `function startControlServer(deps: ControlDeps): Promise<ControlEndpoint>`
  - `function handleRequest(deps, method, url, token, body): Promise<{ status: number; json: unknown }>`
    — the pure-ish router, unit-tested without a live socket.

- [ ] **Step 1: Write the failing router test**

Create `tests/unit/control-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { handleRequest, type ControlDeps } from '../../src/main/control-api'
import { PaneRegistry } from '../../src/main/pane-registry'
import { OperatorGrantStore } from '../../src/main/operator-grant'
import type { SessionInfo } from '../../src/shared/types'

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'x', cwd: '/p', name: 'p', status: 'idle', agentId: 'claude',
    command: 'claude', environment: 1, kind: 'terminal', ...over
  }
}

function deps(): { deps: ControlDeps; grants: OperatorGrantStore; writes: string[] } {
  const sessions = [
    session({ id: 'a-term', environment: 1, name: 'termA' }),
    session({ id: 'b-term', environment: 2, name: 'termB' })
  ]
  const grants = new OperatorGrantStore()
  const writes: string[] = []
  const manager = {
    list: () => sessions,
    get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    write: (_id: string, data: string) => writes.push(data),
    peek: (_id: string, n = 5) => ['line1', 'line2'].slice(0, n)
  }
  return {
    deps: { registry: new PaneRegistry(manager), grants, manager },
    grants,
    writes
  }
}

describe('control-api router', () => {
  it('rejects a missing/invalid token with 403', async () => {
    const { deps: d } = deps()
    const r = await handleRequest(d, 'GET', '/panes', 'nope', '')
    expect(r.status).toBe(403)
  })

  it('lists only the granted environment’s panes', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'GET', '/panes', token, '')
    expect(r.status).toBe(200)
    expect((r.json as { panes: { handle: string }[] }).panes.map((p) => p.handle)).toEqual(['a-term'])
  })

  it('rejects a foreign-environment handle with 404', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'POST', '/panes/b-term/prompt', token, JSON.stringify({ text: 'hi' }))
    expect(r.status).toBe(404)
  })

  it('prompt writes text plus a trailing carriage return to the pty', async () => {
    const { deps: d, grants, writes } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'POST', '/panes/a-term/prompt', token, JSON.stringify({ text: 'do it' }))
    expect(r.status).toBe(200)
    expect(writes).toEqual(['do it\r'])
  })

  it('output returns peeked lines, clamping maxLines', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const r = await handleRequest(d, 'GET', '/panes/a-term/output?maxLines=1', token, '')
    expect(r.status).toBe(200)
    expect((r.json as { lines: string[] }).lines).toEqual(['line1'])
  })

  it('rejects an oversize body with 400', async () => {
    const { deps: d, grants } = deps()
    const token = grants.grant(1)
    const big = 'x'.repeat(70000)
    const r = await handleRequest(d, 'POST', '/panes/a-term/prompt', token, JSON.stringify({ text: big }))
    expect(r.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/control-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/main/control-api.ts`**

```ts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PaneRegistry } from './pane-registry'
import type { OperatorGrantStore } from './operator-grant'
import type { SessionManager } from './session-manager'
import type { BrowserControl } from './browser-control'
import type { CaptureStore } from './capture-store'
import type { WatchpointRegistry } from './watchpoints'
import { CONTROL_MAX_BODY_BYTES, type ActivityEntry } from '../shared/operator'

export interface ControlDeps {
  registry: PaneRegistry
  grants: OperatorGrantStore
  manager: Pick<SessionManager, 'write' | 'peek'>
  onActivity?: (environment: number, entry: ActivityEntry) => void
  // Wired in Layers 2 & 4; absent routes return 404 until then.
  browser?: BrowserControl
  captures?: CaptureStore
  watchpoints?: WatchpointRegistry
}

export interface ControlEndpoint {
  port: number
  close(): void
}

interface Result {
  status: number
  json: unknown
}

function json(status: number, body: unknown): Result {
  return { status, json: body }
}

function clampLines(raw: string | null): number {
  const n = Number(raw)
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 5, 1), 50)
}

/**
 * The control-API router. Pure over its inputs (no socket), so auth, scoping,
 * and every route are unit-testable. `token` is the raw bearer secret; it must
 * resolve to exactly one environment, and every handle is resolved ONLY within
 * that environment (the isolation guarantee lives in PaneRegistry.resolve).
 */
export async function handleRequest(
  deps: ControlDeps,
  method: string,
  url: string,
  token: string,
  body: string
): Promise<Result> {
  if (body.length > CONTROL_MAX_BODY_BYTES) return json(400, { error: 'body too large' })
  const environment = deps.grants.environmentForToken(token)
  if (environment === null) return json(403, { error: 'no grant' })
  deps.grants.markConnected(environment)

  const parsed = new URL(url, 'http://127.0.0.1')
  const path = parsed.pathname
  const record = (route: string, handle?: string, detail?: string): void =>
    deps.onActivity?.(environment, { at: Date.now(), route, handle, detail })

  const readBody = (): Record<string, unknown> => {
    if (!body) return {}
    try {
      const v: unknown = JSON.parse(body)
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  // GET /panes
  if (method === 'GET' && path === '/panes') {
    record('GET /panes')
    return json(200, { panes: deps.registry.list(environment) })
  }

  // Watchpoint + capture routes (Layer 4) — server-scoped, not per-pane.
  if (path === '/watchpoints') {
    if (!deps.watchpoints) return json(404, { error: 'not enabled' })
    if (method === 'GET') return json(200, { watchpoints: deps.watchpoints.list(environment) })
    if (method === 'POST') {
      const b = readBody()
      const wp = deps.watchpoints.register(environment, b)
      if (!wp) return json(400, { error: 'invalid watchpoint' })
      record('POST /watchpoints', undefined, wp.step)
      return json(201, { id: wp.id })
    }
  }
  if (path === '/captures' && method === 'POST') {
    if (!deps.watchpoints || !deps.captures) return json(404, { error: 'not enabled' })
    const b = readBody()
    const cap = await deps.captures.ingest(environment, b, deps.watchpoints)
    if (!cap) return json(400, { error: 'invalid capture' })
    record('POST /captures', undefined, cap.watchpointId)
    return json(201, { id: cap.id })
  }
  const capMatch = /^\/captures\/([^/]+)$/.exec(path)
  if (capMatch && method === 'GET') {
    if (!deps.captures) return json(404, { error: 'not enabled' })
    const cap = deps.captures.get(environment, capMatch[1])
    return cap ? json(200, { capture: cap }) : json(404, { error: 'unknown capture' })
  }

  // Per-pane routes: /panes/:handle/:verb
  const paneMatch = /^\/panes\/([^/]+)\/([^/]+)$/.exec(path)
  if (paneMatch) {
    const [, handle, verb] = paneMatch
    const session = deps.registry.resolve(handle, environment)
    if (!session) return json(404, { error: 'unknown handle' })

    // Terminal routes (reuse write/peek).
    if (verb === 'prompt' && method === 'POST') {
      if (session.kind !== 'terminal') return json(400, { error: 'not a terminal pane' })
      const b = readBody()
      if (typeof b.text !== 'string') return json(400, { error: 'text required' })
      // Attachments are referenced by path in the prompt text by the operator;
      // v1 does not re-inject them separately (screenshot() already returns a
      // path the operator embeds). Write text + submit (carriage return).
      deps.manager.write(handle, `${b.text}\r`)
      record('POST prompt', handle, b.text.slice(0, 80))
      return json(200, { ok: true })
    }
    if (verb === 'output' && method === 'GET') {
      if (session.kind !== 'terminal') return json(400, { error: 'not a terminal pane' })
      record('GET output', handle)
      return json(200, { lines: deps.manager.peek(handle, clampLines(parsed.searchParams.get('maxLines'))) })
    }

    // Browser routes (Layer 2) — need the browser-control dep.
    if (session.kind !== 'browser') return json(400, { error: 'not a browser pane' })
    if (!deps.browser) return json(404, { error: 'browser control not enabled' })
    const b = readBody()
    switch (`${method} ${verb}`) {
      case 'POST navigate': {
        if (typeof b.url !== 'string') return json(400, { error: 'url required' })
        const nav = await deps.browser.navigate(handle, b.url)
        record('POST navigate', handle, b.url)
        return nav.ok ? json(200, { url: nav.url }) : json(400, { error: nav.error })
      }
      case 'POST screenshot': {
        const shot = await deps.browser.screenshot(handle, environment)
        record('POST screenshot', handle, shot.ok ? shot.path : undefined)
        return shot.ok ? json(200, { path: shot.path }) : json(400, { error: shot.error })
      }
      case 'GET cookies': {
        record('GET cookies', handle)
        return json(200, { cookies: await deps.browser.cookies(handle) })
      }
      case 'GET network': {
        record('GET network', handle)
        return json(200, { requests: await deps.browser.network(handle) })
      }
      case 'POST act': {
        const r = await deps.browser.act(handle, b)
        record('POST act', handle, typeof b.selector === 'string' ? b.selector : undefined)
        return r.ok ? json(200, { ok: true }) : json(400, { error: r.error })
      }
    }
  }

  return json(404, { error: 'not found' })
}

/** Bind the loopback control server. One server; the bearer token selects the
 *  environment (via OperatorGrantStore), so a single port serves every grant. */
export function startControlServer(deps: ControlDeps): Promise<ControlEndpoint> {
  const server = createServer((req, res) => {
    const auth = req.headers['authorization']
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    let body = ''
    let responded = false
    req.on('error', () => {
      responded = true
    })
    req.on('data', (chunk: Buffer) => {
      if (responded) return
      body += chunk.toString()
      if (body.length > CONTROL_MAX_BODY_BYTES) {
        responded = true
        res.writeHead(400)
        res.end()
        req.destroy()
      }
    })
    req.on('end', () => {
      if (responded) return
      responded = true
      void handleRequest(deps, req.method ?? 'GET', req.url ?? '/', token, body).then((r) => {
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.json))
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => server.close() })
    })
  })
}
```

> Note: `BrowserControl`, `CaptureStore`, `WatchpointRegistry` are imported as
> `type`-only and are optional in `ControlDeps`; their modules land in Layers 2
> and 4. TypeScript type-only imports of not-yet-created modules will fail
> `typecheck`, so **in this task create empty stub modules** exporting the
> interfaces (Step 3b) and flesh them out later.

- [ ] **Step 3b: Create type stubs so typecheck passes now**

Create `src/main/browser-control.ts`:

```ts
/** Browser control over the M3.5 webview. Implemented in Layer 2. */
export interface BrowserControl {
  navigate(handle: string, url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>
  screenshot(handle: string, environment: number): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  cookies(handle: string): Promise<{ name: string; value: string; domain: string; path: string }[]>
  network(handle: string): Promise<{ url: string; method: string; status?: number; type?: string }[]>
  act(handle: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>
}
```

Create `src/main/capture-store.ts`:

```ts
import type { Capture } from '../shared/operator'
import type { WatchpointRegistry } from './watchpoints'

/** Writes screenshots and watchpoint captures to disk. Fleshed out in Layers 2 & 4. */
export interface CaptureStore {
  ingest(environment: number, body: Record<string, unknown>, watchpoints: WatchpointRegistry): Promise<Capture | null>
  get(environment: number, id: string): Capture | null
}
```

Create `src/main/watchpoints.ts`:

```ts
import type { Watchpoint } from '../shared/operator'

/** Registry of workflow watchpoints. Fleshed out in Layer 4. */
export interface WatchpointRegistry {
  register(environment: number, body: Record<string, unknown>): Watchpoint | null
  list(environment: number): Watchpoint[]
  markHit(id: string): void
}
```

> These are interface-only stubs; Layers 2/4 replace them with concrete classes
> that satisfy the same interface names (rename the interface to `I…` or keep the
> class implementing it — see those tasks). For now they make `control-api.ts`
> typecheck.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/control-api.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/control-api.ts src/main/browser-control.ts src/main/capture-store.ts src/main/watchpoints.ts tests/unit/control-api.test.ts
git commit -m "feat: loopback control-api with terminal routes"
```

---

### Task 4: Grant IPC + api/preload + server wiring in main

**Files:**
- Modify: `src/main/index.ts` (construct registry/grants/server; grant/revoke/status IPC; e2e grant file)
- Modify: `src/shared/api.ts`, `src/preload/index.ts`
- Create: `tests/unit/index-wiring.test.ts` is NOT added (main wiring is covered by the Layer-1 e2e in Task 16); this task's gate is `npm run check` + a manual scripted-client smoke.

**Interfaces:**
- Consumes: Task 1–3 (`PaneRegistry`, `OperatorGrantStore`, `startControlServer`,
  `GrantInfo`, `OperatorStatus`, `ActivityEntry`); existing `manager`, `userData`.
- Produces:
  - IPC: `operator:grant` (invoke, `environment` → `GrantInfo`),
    `operator:revoke` (invoke, `environment` → `void`),
    `operator:status` (invoke, `environment` → `OperatorStatus`).
  - `SaiifeApi.grantOperator(environment): Promise<GrantInfo>`,
    `.revokeOperator(environment): Promise<void>`,
    `.operatorStatus(environment): Promise<OperatorStatus>`.
  - A per-environment rolling activity buffer in main (`Map<number, ActivityEntry[]>`,
    cap 200 newest) fed by `onActivity`.

- [ ] **Step 1: Wire the server + registry + grants in `src/main/index.ts`**

Add imports next to the existing main-module imports:

```ts
import { PaneRegistry } from './pane-registry'
import { OperatorGrantStore } from './operator-grant'
import { startControlServer } from './control-api'
import type { ActivityEntry, GrantInfo, OperatorStatus } from '../shared/operator'
```

Inside `app.whenReady()`, after `managerRef = manager` (~line 123), add:

```ts
  const grants = new OperatorGrantStore()
  const registry = new PaneRegistry(manager)
  // Rolling per-environment action log (newest last, capped). In-memory only —
  // the feed is deliberately not persisted across restarts (spec "Out of scope").
  const activity = new Map<number, ActivityEntry[]>()
  const control = await startControlServer({
    registry,
    grants,
    manager,
    onActivity: (env, entry) => {
      const log = activity.get(env) ?? []
      log.push(entry)
      if (log.length > 200) log.splice(0, log.length - 200)
      activity.set(env, log)
      sendToWindow('operator:activity', env, entry)
    }
  })
```

> `browser`, `captures`, `watchpoints` deps are added to this
> `startControlServer` call in Layers 2 and 4.

- [ ] **Step 2: Grant/revoke/status IPC**

After the `agents:setPath` handle (~line 247), add:

```ts
  ipcMain.handle('operator:grant', (_e, environment: number): GrantInfo => {
    const env = clampEnvironment(environment)
    const token = grants.grant(env)
    const info: GrantInfo = { environment: env, endpoint: `http://127.0.0.1:${control.port}`, token }
    // Under e2e, expose the grant to the scripted control-API client on disk
    // (mirrors the hook server's endpoint.json handshake).
    if (process.env['SAIIFE_E2E'] === '1') {
      writeFileSync(join(userData, `operator-grant-${env}.json`), JSON.stringify(info), { mode: 0o600 })
    }
    return info
  })
  ipcMain.handle('operator:revoke', (_e, environment: number) => {
    grants.revoke(clampEnvironment(environment))
  })
  ipcMain.handle('operator:status', (_e, environment: number): OperatorStatus => {
    const env = clampEnvironment(environment)
    return {
      environment: env,
      granted: grants.isGranted(env),
      connected: grants.isConnected(env),
      endpoint: grants.isGranted(env) ? `http://127.0.0.1:${control.port}` : undefined,
      activity: activity.get(env) ?? []
    }
  })
```

Add `control.close()` to `before-quit` cleanup:

```ts
app.on('before-quit', () => {
  managerRef?.disposeAll()
})
```

becomes — inside `whenReady`, register `app.on('before-quit', () => control.close())`
next to the server construction (so `control` is in scope).

- [ ] **Step 3: api + preload**

`src/shared/api.ts` — add the import next to the existing type imports:

```ts
import type { GrantInfo, OperatorStatus } from './operator'
```

Add to `SaiifeApi`, after `getEnvironmentNames()`:

```ts
  /** Grants (or returns the existing) operator on an environment; mints its bearer token + loopback endpoint. */
  grantOperator(environment: number): Promise<GrantInfo>
  /** Revokes the operator on an environment; its token stops resolving immediately. */
  revokeOperator(environment: number): Promise<void>
  /** Grant + connection state + the rolling action log for an environment. */
  operatorStatus(environment: number): Promise<OperatorStatus>
```

`src/preload/index.ts` — after `getEnvironmentNames`:

```ts
  grantOperator: (environment: number) => ipcRenderer.invoke('operator:grant', environment),
  revokeOperator: (environment: number) => ipcRenderer.invoke('operator:revoke', environment),
  operatorStatus: (environment: number) => ipcRenderer.invoke('operator:status', environment),
```

- [ ] **Step 4: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/index.ts src/shared/api.ts src/preload/index.ts
git commit -m "feat: operator grant ipc and control server wiring"
```

---

## Layer 2 — Browser control over the webview DevTools protocol

*Independently shippable: once the webview registers its webContents, the control
API can navigate, screenshot (to a path), and read partition-confined
cookies/network for a browser pane, plus perform a basic selector `act`.*

### Task 5: Capture-store — per-environment scratch dir, screenshot paths

**Files:**
- Modify: `src/main/capture-store.ts` (replace the Layer-1 stub with a class)
- Create: `tests/unit/capture-store.test.ts`

**Interfaces:**
- Consumes: `node:fs`, `node:path`; `Capture`, `CaptureKind` from `operator.ts`.
- Produces:
  - `class CaptureStore` implementing the Layer-1 `CaptureStore` interface shape,
    plus:
    - `constructor(baseDir: string)` — root under which `env-<N>/` dirs live.
    - `dirFor(environment: number): string` — ensures + returns the scratch dir.
    - `writeScreenshot(environment: number, png: Buffer): string` — writes
      `shot-<uuid>.png`, returns its absolute path.
  - The `ingest`/`get` capture methods are extended in Layer 4 (Task 15); this
    task ships screenshot storage + the in-memory capture map skeleton.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/capture-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureStore } from '../../src/main/capture-store'

describe('CaptureStore', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lf-cap-'))
  })

  it('creates a per-environment scratch dir', () => {
    const store = new CaptureStore(base)
    const dir = store.dirFor(2)
    expect(dir).toBe(join(base, 'env-2'))
    expect(existsSync(dir)).toBe(true)
  })

  it('writes a screenshot and returns its absolute path', () => {
    const store = new CaptureStore(base)
    const png = Buffer.from('PNGDATA')
    const path = store.writeScreenshot(1, png)
    expect(path.startsWith(join(base, 'env-1'))).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    expect(readFileSync(path)).toEqual(png)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/capture-store.test.ts`
Expected: FAIL — `CaptureStore` is an interface, not a class / no constructor.

- [ ] **Step 3: Replace `src/main/capture-store.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Capture } from '../shared/operator'
import type { WatchpointRegistry } from './watchpoints'

/**
 * Writes screenshots and watchpoint captures to disk under a per-environment
 * scratch dir the target project's terminal can read. A screenshot is handed to
 * a coding-agent terminal by PATH, never by pixels (spec "Screenshot → terminal
 * handoff"): screenshot() returns the path, the operator's prompt references it.
 * Captures are kept in-memory (not persisted across restarts) with their assets
 * on disk.
 */
export class CaptureStore {
  private byEnv = new Map<number, Map<string, Capture>>()

  constructor(private baseDir: string) {}

  /** Ensure + return `env-<N>/` under the base scratch dir. */
  dirFor(environment: number): string {
    const dir = join(this.baseDir, `env-${environment}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Write a PNG capture; return its absolute path. */
  writeScreenshot(environment: number, png: Buffer): string {
    const path = join(this.dirFor(environment), `shot-${randomUUID()}.png`)
    writeFileSync(path, png)
    return path
  }

  /** Layer 4 fills in envelope/output/memory handling; see Task 15. */
  async ingest(
    _environment: number,
    _body: Record<string, unknown>,
    _watchpoints: WatchpointRegistry
  ): Promise<Capture | null> {
    return null
  }

  get(environment: number, id: string): Capture | null {
    return this.byEnv.get(environment)?.get(id) ?? null
  }

  /** Internal helper Layer 4 uses to file a completed capture. */
  protected store(capture: Capture): void {
    const map = this.byEnv.get(capture.environment) ?? new Map<string, Capture>()
    map.set(capture.id, capture)
    this.byEnv.set(capture.environment, map)
  }
}
```

> The Layer-1 `import type { CaptureStore }` in `control-api.ts` now resolves to
> this class (a class is a valid type). Remove the interface-only stub content —
> the class replaces it.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/capture-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/capture-store.ts tests/unit/capture-store.test.ts
git commit -m "feat: capture-store screenshot scratch dir"
```

---

### Task 6: Webview registration seam — pane→webContents mapping

**Files:**
- Create: `src/main/browser-bridge.ts`
- Create: `tests/unit/browser-bridge.test.ts`
- Modify: `src/renderer/src/components/BrowserPane.tsx` (register/unregister webContentsId)
- Modify: `src/main/index.ts` (`browser:register` / `browser:unregister` IPC)
- Modify: `src/shared/api.ts`, `src/preload/index.ts`

**Interfaces:**
- Consumes: existing `WebviewTag` (`getWebContentsId()`), the pane's session id.
- Produces:
  - `class BrowserBridge`:
    - `register(handle: string, webContentsId: number): void`
    - `unregister(handle: string): void`
    - `webContentsIdFor(handle: string): number | null`
  - IPC: `browser:register` (send, `handle`, `webContentsId`),
    `browser:unregister` (send, `handle`).
  - `SaiifeApi.registerBrowser(handle, webContentsId): void`,
    `.unregisterBrowser(handle): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/browser-bridge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BrowserBridge } from '../../src/main/browser-bridge'

describe('BrowserBridge', () => {
  it('maps a handle to a webContents id and back', () => {
    const bridge = new BrowserBridge()
    bridge.register('pane-1', 42)
    expect(bridge.webContentsIdFor('pane-1')).toBe(42)
    expect(bridge.webContentsIdFor('missing')).toBeNull()
  })

  it('unregister drops the mapping', () => {
    const bridge = new BrowserBridge()
    bridge.register('pane-1', 42)
    bridge.unregister('pane-1')
    expect(bridge.webContentsIdFor('pane-1')).toBeNull()
  })

  it('a re-register (remount) overwrites the stale id', () => {
    const bridge = new BrowserBridge()
    bridge.register('pane-1', 42)
    bridge.register('pane-1', 99)
    expect(bridge.webContentsIdFor('pane-1')).toBe(99)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/browser-bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/main/browser-bridge.ts`**

```ts
/**
 * Maps a browser pane's stable handle (session id) to its live guest
 * webContents id. The guest webContents is created inside the renderer, but
 * main needs it to drive the pane (loadURL/capturePage/debugger). The renderer
 * reports it on mount via IPC; browser-control resolves handle → id →
 * webContents.fromId(). Cleared on unmount so a closed pane resolves to null
 * (control API then returns 404).
 */
export class BrowserBridge {
  private byHandle = new Map<string, number>()

  register(handle: string, webContentsId: number): void {
    this.byHandle.set(handle, webContentsId)
  }

  unregister(handle: string): void {
    this.byHandle.delete(handle)
  }

  webContentsIdFor(handle: string): number | null {
    return this.byHandle.get(handle) ?? null
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/browser-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Register from `BrowserPane.tsx`**

In `src/renderer/src/components/BrowserPane.tsx`, extend the focus/nav effect
region. Add a new effect after the existing `did-navigate` effect (~line 82) that
registers the guest webContents id once the webview is ready and unregisters on
unmount:

```tsx
  // Report this pane's guest webContents id to main so the operator control API
  // can drive the SAME webview a human drives. Registered on dom-ready (the id
  // is stable for the guest's life); unregistered on unmount / exit.
  useEffect(() => {
    if (!alive) {
      window.saiife.unregisterBrowser(session.id)
      return
    }
    const view = viewRef.current
    if (!view) return
    const onReady = (): void => {
      try {
        window.saiife.registerBrowser(session.id, view.getWebContentsId())
      } catch {
        /* guest not attached yet; a later dom-ready will catch it */
      }
    }
    view.addEventListener('dom-ready', onReady)
    return () => {
      view.removeEventListener('dom-ready', onReady)
      window.saiife.unregisterBrowser(session.id)
    }
  }, [session.id, alive])
```

- [ ] **Step 6: IPC + api + preload**

`src/main/index.ts` — add `import { BrowserBridge } from './browser-bridge'`, then
inside `whenReady` next to the other operator wiring:

```ts
  const browserBridge = new BrowserBridge()
  ipcMain.on('browser:register', (_e, handle: string, webContentsId: number) => {
    if (typeof handle === 'string' && Number.isInteger(webContentsId)) {
      browserBridge.register(handle, webContentsId)
    }
  })
  ipcMain.on('browser:unregister', (_e, handle: string) => {
    if (typeof handle === 'string') browserBridge.unregister(handle)
  })
```

`src/shared/api.ts` — add to `SaiifeApi`:

```ts
  /** Browser panes report their guest webContents id so the operator API can drive them. */
  registerBrowser(handle: string, webContentsId: number): void
  /** Dropped on unmount/exit; a closed pane then resolves to 404 over the control API. */
  unregisterBrowser(handle: string): void
```

`src/preload/index.ts`:

```ts
  registerBrowser: (handle: string, webContentsId: number) =>
    ipcRenderer.send('browser:register', handle, webContentsId),
  unregisterBrowser: (handle: string) => ipcRenderer.send('browser:unregister', handle),
```

- [ ] **Step 7: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/browser-bridge.ts tests/unit/browser-bridge.test.ts src/renderer/src/components/BrowserPane.tsx src/main/index.ts src/shared/api.ts src/preload/index.ts
git commit -m "feat: register browser pane webcontents to main"
```

---

### Task 7: Browser control — navigate, screenshot, cookies (partition-confined)

**Files:**
- Modify: `src/main/browser-control.ts` (replace the stub interface with a class)
- Modify: `src/main/index.ts` (construct `WebviewBrowserControl`, pass to server)

**Interfaces:**
- Consumes: Task 5 `CaptureStore`, Task 6 `BrowserBridge`; Electron
  `webContents.fromId`, `session.fromPartition`; `BROWSER_PARTITION` from
  `webview-policy.ts`; `normalizeHttpUrl` from `shared/urls.ts`.
- Produces:
  - `class WebviewBrowserControl` implementing the `BrowserControl` interface
    (navigate/screenshot/cookies/network/act). `network`/`act` are stubbed here
    and completed in Task 8.
  - Constructor: `(bridge: BrowserBridge, captures: CaptureStore, deps?: { fromId?; partitionSession? })`
    (deps injectable for tests, defaulting to Electron's real functions).

**Note on testing:** `webContents`/`session` are Electron runtime objects not
available under vitest's node env. This task's unit coverage is the **URL
validation + missing-webContents** branch (pure); the live capture/cookies paths
are exercised by the Task 16 e2e against a real browser pane. Create
`tests/unit/browser-control.test.ts` for the pure branches with an injected fake.

- [ ] **Step 1: Write the failing pure-branch test**

Create `tests/unit/browser-control.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { WebviewBrowserControl } from '../../src/main/browser-control'
import { BrowserBridge } from '../../src/main/browser-bridge'
import { CaptureStore } from '../../src/main/capture-store'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function make(): WebviewBrowserControl {
  const bridge = new BrowserBridge()
  const captures = new CaptureStore(mkdtempSync(join(tmpdir(), 'lf-bc-')))
  // No webContents registered — every op should degrade, never throw.
  return new WebviewBrowserControl(bridge, captures)
}

describe('WebviewBrowserControl', () => {
  it('navigate rejects a non-http url before touching the guest', async () => {
    const r = await make().navigate('h', 'javascript:alert(1)')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('url') })
  })

  it('navigate on an unregistered handle errors (no webContents)', async () => {
    const r = await make().navigate('h', 'http://localhost:3000')
    expect(r.ok).toBe(false)
  })

  it('screenshot on an unregistered handle errors, never throws', async () => {
    const r = await make().screenshot('h', 1)
    expect(r.ok).toBe(false)
  })

  it('cookies/network on an unregistered handle return empty arrays', async () => {
    const bc = make()
    expect(await bc.cookies('h')).toEqual([])
    expect(await bc.network('h')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/browser-control.test.ts`
Expected: FAIL — `WebviewBrowserControl` not exported.

- [ ] **Step 3: Replace `src/main/browser-control.ts`**

```ts
import { webContents as allWebContents, session as electronSession } from 'electron'
import type { WebContents, Cookie } from 'electron'
import { normalizeHttpUrl } from '../shared/urls'
import { BROWSER_PARTITION } from './webview-policy'
import type { BrowserBridge } from './browser-bridge'
import type { CaptureStore } from './capture-store'

export interface BrowserControl {
  navigate(handle: string, url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>
  screenshot(handle: string, environment: number): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  cookies(handle: string): Promise<{ name: string; value: string; domain: string; path: string }[]>
  network(handle: string): Promise<{ url: string; method: string; status?: number; type?: string }[]>
  act(handle: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>
}

interface ElectronDeps {
  fromId: (id: number) => WebContents | undefined
  partitionCookies: () => Electron.Cookies
}

/**
 * Browser control implemented over the M3.5 webview's own webContents — the
 * SAME pane a human drives. navigate → loadURL, screenshot → capturePage, and
 * ALL reads (cookies, network) are confined to the isolated
 * persist:browser-panes partition (never the user's real browser). CDP is used
 * only for network/act (Task 8). Every op degrades to an error (never crashes
 * the pane) when the webContents is gone (spec "Error handling").
 */
export class WebviewBrowserControl implements BrowserControl {
  private deps: ElectronDeps

  constructor(
    private bridge: BrowserBridge,
    private captures: CaptureStore,
    deps?: Partial<ElectronDeps>
  ) {
    this.deps = {
      fromId: deps?.fromId ?? ((id) => allWebContents.fromId(id)),
      partitionCookies: deps?.partitionCookies ?? (() => electronSession.fromPartition(BROWSER_PARTITION).cookies)
    }
  }

  private wc(handle: string): WebContents | null {
    const id = this.bridge.webContentsIdFor(handle)
    if (id === null) return null
    const wc = this.deps.fromId(id)
    return wc && !wc.isDestroyed() ? wc : null
  }

  async navigate(handle: string, url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const normalized = normalizeHttpUrl(url)
    if (!normalized) return { ok: false, error: 'invalid url (http/https only)' }
    const wc = this.wc(handle)
    if (!wc) return { ok: false, error: 'pane unavailable' }
    try {
      await wc.loadURL(normalized)
      return { ok: true, url: normalized }
    } catch (e) {
      return { ok: false, error: `navigation failed: ${(e as Error).message}` }
    }
  }

  async screenshot(handle: string, environment: number): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const wc = this.wc(handle)
    if (!wc) return { ok: false, error: 'pane unavailable' }
    try {
      const image = await wc.capturePage()
      const path = this.captures.writeScreenshot(environment, image.toPNG())
      return { ok: true, path }
    } catch (e) {
      return { ok: false, error: `capture failed: ${(e as Error).message}` }
    }
  }

  async cookies(handle: string): Promise<{ name: string; value: string; domain: string; path: string }[]> {
    const wc = this.wc(handle)
    if (!wc) return []
    try {
      // Partition-confined: read the pane's own url cookies from the isolated
      // browser-panes partition, NEVER the user's real browser session.
      const list: Cookie[] = await this.deps.partitionCookies().get({ url: wc.getURL() })
      return list.map((c) => ({ name: c.name, value: c.value, domain: c.domain ?? '', path: c.path ?? '/' }))
    } catch {
      return []
    }
  }

  async network(handle: string): Promise<{ url: string; method: string; status?: number; type?: string }[]> {
    // Implemented in Task 8 (CDP Network buffer).
    void handle
    return []
  }

  async act(handle: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    // Implemented in Task 8 (selector-based executeJavaScript).
    void handle
    void body
    return { ok: false, error: 'act not enabled' }
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/browser-control.test.ts`
Expected: PASS (pure branches; live paths return the unavailable error).

- [ ] **Step 5: Wire into the control server**

In `src/main/index.ts`, add `import { WebviewBrowserControl } from './browser-control'`.
Construct it before `startControlServer` and pass it in:

```ts
  const browserControl = new WebviewBrowserControl(browserBridge, new CaptureStore(join(userData, 'captures')))
```

Add `browser: browserControl` to the `startControlServer({ ... })` deps. Keep the
same `CaptureStore` instance for Layer 4 by hoisting it to a `const captureStore`
and passing `captures: captureStore` too (add now to avoid a second instance):

```ts
  const captureStore = new CaptureStore(join(userData, 'captures'))
  const browserControl = new WebviewBrowserControl(browserBridge, captureStore)
  const control = await startControlServer({
    registry, grants, manager, browser: browserControl, captures: captureStore,
    onActivity: /* unchanged */
  })
```

- [ ] **Step 6: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/browser-control.ts src/main/index.ts tests/unit/browser-control.test.ts
git commit -m "feat: browser navigate screenshot cookies"
```

---

### Task 8: Browser control — network buffer (CDP) + selector `act`

**Files:**
- Modify: `src/main/browser-control.ts` (network via `debugger`; act via `executeJavaScript`)
- Modify: `tests/unit/browser-control.test.ts` (act validation branch)

**Interfaces:**
- Consumes: Electron `WebContents.debugger` (CDP `Network.enable` +
  `Network.requestWillBeSent`/`responseReceived`); `WebContents.executeJavaScript`.
- Produces (pinned `act` v1 wire format): body
  `{ selector: string, action: 'click' | 'type', text?: string }`. The snapshot-ref
  `{ ref, action }` model is **deferred** (spec "Out of scope"); an unknown action
  or missing selector → `{ ok: false }`.

- [ ] **Step 1: Add the act-validation test**

Append to `tests/unit/browser-control.test.ts`:

```ts
describe('act validation', () => {
  it('rejects a missing selector', async () => {
    const bc = make()
    const r = await bc.act('h', { action: 'click' })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('selector') })
  })

  it('rejects an unknown action', async () => {
    const bc = make()
    const r = await bc.act('h', { selector: '#go', action: 'teleport' })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('action') })
  })

  it('errors on an unregistered handle for a valid body', async () => {
    const bc = make()
    const r = await bc.act('h', { selector: '#go', action: 'click' })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx vitest run tests/unit/browser-control.test.ts`
Expected: FAIL — current `act` returns the generic "not enabled" error, not the
validation errors.

- [ ] **Step 3: Implement `network` and `act`**

Replace the two stub methods in `src/main/browser-control.ts`. Add a per-handle
network buffer field and attach the CDP debugger lazily:

```ts
  // Rolling CDP network buffer per handle (newest last, capped). The debugger is
  // attached lazily on first read and kept for the guest's life.
  private netBuffers = new Map<string, { url: string; method: string; status?: number; type?: string }[]>()
  private attached = new Set<string>()

  private ensureNetwork(handle: string, wc: WebContents): void {
    if (this.attached.has(handle)) return
    try {
      wc.debugger.attach('1.3')
    } catch {
      // Already attached (e.g. devtools) — reuse it.
    }
    this.attached.add(handle)
    const buf: { url: string; method: string; status?: number; type?: string }[] = []
    this.netBuffers.set(handle, buf)
    wc.debugger.on('message', (_e, method, params) => {
      const p = params as Record<string, unknown>
      if (method === 'Network.requestWillBeSent') {
        const req = p['request'] as { url?: string; method?: string } | undefined
        buf.push({ url: req?.url ?? '', method: req?.method ?? 'GET', type: p['type'] as string | undefined })
        if (buf.length > 200) buf.splice(0, buf.length - 200)
      } else if (method === 'Network.responseReceived') {
        const res = p['response'] as { url?: string; status?: number } | undefined
        const hit = [...buf].reverse().find((r) => r.url === res?.url && r.status === undefined)
        if (hit) hit.status = res?.status
      }
    })
    wc.debugger.sendCommand('Network.enable').catch(() => undefined)
    // Detach cleanly when the guest goes away.
    wc.once('destroyed', () => {
      this.attached.delete(handle)
      this.netBuffers.delete(handle)
    })
  }

  async network(handle: string): Promise<{ url: string; method: string; status?: number; type?: string }[]> {
    const wc = this.wc(handle)
    if (!wc) return []
    try {
      this.ensureNetwork(handle, wc)
      return [...(this.netBuffers.get(handle) ?? [])]
    } catch {
      return []
    }
  }

  async act(handle: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    const selector = body['selector']
    const action = body['action']
    if (typeof selector !== 'string' || selector.length === 0) return { ok: false, error: 'selector required' }
    if (action !== 'click' && action !== 'type') return { ok: false, error: 'action must be click|type' }
    const wc = this.wc(handle)
    if (!wc) return { ok: false, error: 'pane unavailable' }
    // v1 selector-based act, confined to the guest page. The richer snapshot-ref
    // interaction model is deferred (spec "Out of scope"). String is JSON-encoded
    // to neutralize injection into the guest expression.
    const sel = JSON.stringify(selector)
    const text = JSON.stringify(typeof body['text'] === 'string' ? body['text'] : '')
    const expr =
      action === 'click'
        ? `(() => { const el = document.querySelector(${sel}); if (!el) return false; el.click(); return true; })()`
        : `(() => { const el = document.querySelector(${sel}); if (!el) return false; el.focus(); el.value = ${text}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
    try {
      const ok = await wc.executeJavaScript(expr, true)
      return ok ? { ok: true } : { ok: false, error: 'selector matched nothing' }
    } catch (e) {
      return { ok: false, error: `act failed: ${(e as Error).message}` }
    }
  }
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/browser-control.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/browser-control.ts tests/unit/browser-control.test.ts
git commit -m "feat: browser network buffer and selector act"
```

---

## Layer 3 — OpenClaw `saiife` skill + renderer cockpit + grant toggle

*Independently shippable: a user can grant/revoke an operator from the UI, watch
the action log fill in the cockpit, and OpenClaw can be pointed at the grant via a
shipped skill.*

### Task 9: The OpenClaw `saiife` skill (SKILL.md + CLI wrapper)

> **Design decisions (OpenClaw-side).** The grant's `SAIIFE_ENDPOINT` +
> `SAIIFE_TOKEN` are injected via `skills.entries.saiife.env` in
> `~/.openclaw/openclaw.json`, and saiife **auto-writes** that block
> (transparently — it surfaces exactly what it wrote) when it launches a managed
> OpenClaw session. Watchpoint `checkpoint` steps are **authored directly** in the
> user's Lobster workflow YAML, calling the wrapper CLI as a step `command`. The
> control API is stable regardless of the OpenClaw-side packaging.

**Files:**
- Create: `openclaw/skills/saiife/SKILL.md`
- Create: `openclaw/skills/saiife/bin/saiife-control.mjs`
- Create: `openclaw/skills/saiife/README.md`
- Create: `tests/unit/saiife-cli.test.ts`

**Interfaces:**
- Consumes: the control API (Layers 1–2/4) via `endpoint` + `token`, read from
  env `SAIIFE_ENDPOINT` / `SAIIFE_TOKEN`.
- Produces: a CLI `saiife-control <verb> [args...]` emitting JSON on stdout,
  wrapping the routes: `panes`, `navigate <handle> <url>`, `screenshot <handle>`,
  `cookies <handle>`, `network <handle>`, `act <handle> <selector> <click|type> [text]`,
  `prompt <handle> <text...>`, `output <handle> [maxLines]`,
  `checkpoint <watchpointId> [--halt]`.

- [ ] **Step 1: Write the failing CLI arg-parse test**

The CLI's URL construction + verb mapping is pure and testable without a live
server. Extract it into an exported `buildRequest`. Create
`tests/unit/saiife-cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRequest } from '../../openclaw/skills/saiife/bin/saiife-control.mjs'

describe('buildRequest', () => {
  const base = 'http://127.0.0.1:5000'
  it('maps panes to GET /panes', () => {
    expect(buildRequest(base, ['panes'])).toMatchObject({ method: 'GET', path: '/panes' })
  })
  it('maps navigate to POST /panes/:h/navigate with a url body', () => {
    const r = buildRequest(base, ['navigate', 'h1', 'http://localhost:3000'])
    expect(r).toMatchObject({ method: 'POST', path: '/panes/h1/navigate', body: { url: 'http://localhost:3000' } })
  })
  it('maps prompt joining the remaining args as text', () => {
    const r = buildRequest(base, ['prompt', 'term1', 'fix', 'the', 'bug'])
    expect(r).toMatchObject({ method: 'POST', path: '/panes/term1/prompt', body: { text: 'fix the bug' } })
  })
  it('maps output with a maxLines query', () => {
    const r = buildRequest(base, ['output', 'term1', '10'])
    expect(r).toMatchObject({ method: 'GET', path: '/panes/term1/output?maxLines=10' })
  })
  it('maps checkpoint --halt to a captures POST flagged halted', () => {
    const r = buildRequest(base, ['checkpoint', 'wp1', '--halt'])
    expect(r).toMatchObject({ method: 'POST', path: '/captures', body: { watchpointId: 'wp1', halted: true } })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/saiife-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `openclaw/skills/saiife/bin/saiife-control.mjs`**

```js
#!/usr/bin/env node
/**
 * saiife control-API CLI, wrapped by the OpenClaw `saiife` skill. Reads
 * the grant endpoint + token from SAIIFE_ENDPOINT / SAIIFE_TOKEN and
 * turns a verb into one control-API request, printing the JSON response.
 *
 * Env is injected via skills.entries.saiife.env (auto-written by saiife).
 */

/** Pure verb → request mapping (exported for unit tests). */
export function buildRequest(base, argv) {
  const [verb, ...rest] = argv
  switch (verb) {
    case 'panes':
      return { method: 'GET', path: '/panes' }
    case 'navigate':
      return { method: 'POST', path: `/panes/${rest[0]}/navigate`, body: { url: rest[1] } }
    case 'screenshot':
      return { method: 'POST', path: `/panes/${rest[0]}/screenshot` }
    case 'cookies':
      return { method: 'GET', path: `/panes/${rest[0]}/cookies` }
    case 'network':
      return { method: 'GET', path: `/panes/${rest[0]}/network` }
    case 'act':
      return {
        method: 'POST',
        path: `/panes/${rest[0]}/act`,
        body: { selector: rest[1], action: rest[2], text: rest[3] }
      }
    case 'prompt':
      return { method: 'POST', path: `/panes/${rest[0]}/prompt`, body: { text: rest.slice(1).join(' ') } }
    case 'output':
      return { method: 'GET', path: `/panes/${rest[0]}/output?maxLines=${rest[1] ?? 5}` }
    case 'checkpoint': {
      const halted = rest.includes('--halt')
      return { method: 'POST', path: '/captures', body: { watchpointId: rest[0], halted } }
    }
    default:
      throw new Error(`unknown verb: ${verb}`)
  }
}

async function main() {
  const base = process.env.SAIIFE_ENDPOINT
  const token = process.env.SAIIFE_TOKEN
  if (!base || !token) throw new Error('SAIIFE_ENDPOINT and SAIIFE_TOKEN required')
  const req = buildRequest(base, process.argv.slice(2))
  const res = await fetch(base + req.path, {
    method: req.method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: req.body ? JSON.stringify(req.body) : undefined
  })
  const text = await res.text()
  process.stdout.write(text + '\n')
  if (!res.ok) process.exit(1)
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e) + '\n')
    process.exit(1)
  })
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/saiife-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `openclaw/skills/saiife/SKILL.md`**

```markdown
---
name: saiife
description: Drive a granted saiife environment's panes — list, navigate, screenshot, inspect, act, prompt terminals, and checkpoint workflows.
metadata:
  openclaw:
    requires:
      bins: [node]
      env: [SAIIFE_ENDPOINT, SAIIFE_TOKEN]
---

# saiife operator skill

saiife exposes a loopback control API for the ONE environment this grant
covers. Every command is scoped to that environment; foreign-environment handles
return 404. Auth is the per-grant bearer token in `SAIIFE_TOKEN`.

Run the wrapped CLI:

    node "$SKILL_DIR/bin/saiife-control.mjs" <verb> [args...]

Verbs: `panes`, `navigate <handle> <url>`, `screenshot <handle>`,
`cookies <handle>`, `network <handle>`, `act <handle> <selector> <click|type> [text]`,
`prompt <handle> <text...>`, `output <handle> [maxLines]`,
`checkpoint <watchpointId> [--halt]`.

`screenshot` returns a `{path}` on the target project's disk — reference that
path in a following `prompt` to hand the image to a coding-agent terminal.

<!-- Wiring: saiife injects SAIIFE_ENDPOINT + SAIIFE_TOKEN via
     skills.entries.saiife.env in ~/.openclaw/openclaw.json, auto-written when
     it launches a managed OpenClaw session (and shown to the user). -->
```

- [ ] **Step 6: Create `openclaw/skills/saiife/README.md`**

Document, for a human wiring OpenClaw: the grant flow (grant in saiife → copy
endpoint+token → set `SAIIFE_ENDPOINT`/`SAIIFE_TOKEN`, or let saiife
auto-write `skills.entries.saiife.env`), and the checkpoint authoring model
(the `checkpoint` step is written directly in the user's Lobster workflow YAML as
a `command`). Keep it to the facts confirmed from `docs.openclaw.ai`
(`SKILL.md` frontmatter `name`/`description`/`metadata.openclaw.requires`;
`skills.entries.<name>` config block).

- [ ] **Step 7: Full check + commit**

Run: `npm run check` — expected PASS (the `.mjs` is ESM; ensure eslint globs
include `openclaw/**` or is ignored — if lint complains, add `openclaw/skills/**`
to the eslint ignore for the CLI and keep only the test under lint).

```bash
git add openclaw/skills/saiife tests/unit/saiife-cli.test.ts
git commit -m "feat: openclaw saiife skill and cli"
```

---

### Task 10: Cockpit view — operator status + action log

**Files:**
- Create: `src/renderer/src/components/Cockpit.tsx`
- Modify: `src/renderer/src/App.tsx` (view union `'cockpit'`, state, render branch, Sidebar prop)
- Modify: `src/renderer/src/components/Sidebar.tsx` (view union + "Cockpit" nav item)
- Modify: `src/renderer/src/styles.css` (cockpit + activity + status styles)
- Modify: `src/preload/index.ts`, `src/shared/api.ts` (`onOperatorActivity` subscription)

**Interfaces:**
- Consumes: Task 4 IPC (`operatorStatus`, `grantOperator`, `revokeOperator`) and a
  new `operator:activity` push; `OperatorStatus`, `ActivityEntry`, `GrantInfo`.
- Produces:
  - `Cockpit` default export, props `{ environment: number }`.
  - `SaiifeApi.onOperatorActivity(cb: (environment: number, entry: ActivityEntry) => void): () => void`.
  - App: view union gains `'cockpit'`; `enterCockpit()`.
  - Sidebar: `view` union gains `'cockpit'`; prop `onCockpit: () => void`; nav item.

- [ ] **Step 1: Add the activity subscription to preload + api**

`src/shared/api.ts` — extend the operator import and add:

```ts
import type { GrantInfo, OperatorStatus, ActivityEntry } from './operator'
```
```ts
  /** Live control-API action-log entries, per environment. */
  onOperatorActivity(cb: (environment: number, entry: ActivityEntry) => void): () => void
```

`src/preload/index.ts`:

```ts
  onOperatorActivity: (cb) => {
    const listener = (_e: IpcRendererEvent, environment: number, entry: ActivityEntry): void =>
      cb(environment, entry)
    ipcRenderer.on('operator:activity', listener)
    return () => ipcRenderer.removeListener('operator:activity', listener)
  },
```

(add `import type { ActivityEntry } from '../shared/operator'` at the top).

- [ ] **Step 2: Create `src/renderer/src/components/Cockpit.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { ActivityEntry, OperatorStatus } from '../../../shared/operator'

interface Props {
  environment: number
}

/**
 * Read-only operator cockpit for one environment: whether an operator is granted
 * / connected, and a rolling action log of the control-API calls it made. The
 * cockpit REFLECTS the operator; it never owns OpenClaw's sessions, and the panes
 * stay human-drivable regardless. Captures (Layer 4) render below the log.
 */
export default function Cockpit({ environment }: Props): React.JSX.Element {
  const [status, setStatus] = useState<OperatorStatus | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setStatus(await window.saiife.operatorStatus(environment))
  }, [environment])

  useEffect(() => {
    void reload()
  }, [reload])

  // Append live activity for THIS environment without a full refetch.
  useEffect(() => {
    return window.saiife.onOperatorActivity((env, entry: ActivityEntry) => {
      if (env !== environment) return
      setStatus((cur) => (cur ? { ...cur, connected: true, activity: [...cur.activity, entry].slice(-200) } : cur))
    })
  }, [environment])

  const grant = async (): Promise<void> => {
    await window.saiife.grantOperator(environment)
    await reload()
  }
  const revoke = async (): Promise<void> => {
    await window.saiife.revokeOperator(environment)
    await reload()
  }

  const granted = status?.granted ?? false
  const connected = status?.connected ?? false

  return (
    <div className="cockpit-view flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-white/[0.07] px-3 py-2 text-[12px]">
        <span
          className="operator-status flex items-center gap-2 font-semibold"
          data-connected={connected ? 'true' : 'false'}
        >
          <span className={`dot h-2.5 w-2.5 rounded-full ${connected ? 'bg-idle' : granted ? 'bg-needs-you' : 'bg-exited'}`} />
          {connected ? 'Operator connected' : granted ? 'Operator granted — not connected' : 'No operator'}
          <span className="text-gray-500">· env {environment}</span>
        </span>
        <span className="flex-1" />
        <button
          className="operator-grant-toggle cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-gray-200 hover:bg-white/[0.13]"
          onClick={() => void (granted ? revoke() : grant())}
          onMouseDown={(e) => e.preventDefault()}
        >
          {granted ? 'Revoke operator' : 'Let an operator drive this environment'}
        </button>
      </div>
      {status?.endpoint && (
        <div className="px-3 py-1 font-mono text-[11px] text-gray-500">endpoint: {status.endpoint}</div>
      )}
      <div className="operator-activity min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px]">
        {(status?.activity.length ?? 0) === 0 ? (
          <div className="cockpit-empty text-gray-500">No operator activity yet.</div>
        ) : (
          status?.activity
            .slice()
            .reverse()
            .map((e, i) => (
              <div key={i} className="activity-entry flex gap-2 py-0.5 text-gray-300" data-route={e.route}>
                <span className="text-gray-600">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="text-gray-200">{e.route}</span>
                {e.handle && <span className="text-gray-500">{e.handle}</span>}
                {e.detail && <span className="truncate text-gray-500">{e.detail}</span>}
              </div>
            ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Cockpit CSS in `src/renderer/src/styles.css`**

Append (keeping the status-token system together):

```css
/* Operator cockpit (M7). Reuses status tokens; no new palette. */
.operator-status[data-connected='true'] {
  color: var(--idle);
}
.activity-entry {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
```

- [ ] **Step 4: App.tsx — view union, state, handler, render branch, Sidebar prop**

All edits in `src/renderer/src/App.tsx`:

1. `import Cockpit from './components/Cockpit'`.
2. Widen the union: `useState<'home' | 'environment' | 'settings' | 'cockpit'>('home')`.
3. Handler near `enterEnvironment`:

```ts
  const enterCockpit = (): void => {
    setEnlarged(null)
    setView('cockpit')
  }
```

4. Render branch — insert between the environment grid and settings case
(`) : view === 'settings' ? (`):

```tsx
        ) : view === 'cockpit' ? (
          <Cockpit environment={environment} />
        ) : view === 'settings' ? (
```

5. Sidebar `view` mapping: add `: view === 'cockpit' ? 'cockpit'` to the chain, and
add `onCockpit={enterCockpit}` next to `onSettings`.

- [ ] **Step 5: Sidebar.tsx — union + "Cockpit" nav item**

Widen `view` to include `'cockpit'`, add `onCockpit: () => void` to Props,
destructure it, and add a nav button between Environment and Settings mirroring
the existing pattern:

```tsx
        <button
          className={`${navItemBase}${view === 'cockpit' ? ` ${navItemActive}` : ''}`}
          onClick={onCockpit}
          onMouseDown={(e) => e.preventDefault()}
        >
          Cockpit
        </button>
```

- [ ] **Step 6: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/renderer/src/components/Cockpit.tsx src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/styles.css src/shared/api.ts src/preload/index.ts
git commit -m "feat: operator cockpit status and action log"
```

---

### Task 11: Grant toggle indicator on the environment sidebar

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx` (per-environment operator dot)
- Modify: `src/renderer/src/App.tsx` (poll operator status per visible environment)

**Interfaces:**
- Consumes: `operatorStatus(environment)`; the existing `[data-nav-environment]`
  rows.
- Produces: a visible per-environment operator indicator
  (`.operator-indicator[data-environment][data-granted]`) so a granted environment
  is always marked (spec "always visibly indicated on the environment").

- [ ] **Step 1: Add a grant map + poll in App.tsx**

In `src/renderer/src/App.tsx`, add state and a light poll (statuses are cheap,
in-memory in main):

```ts
  // Which environments currently have an operator, for the sidebar indicator.
  const [grantedEnvs, setGrantedEnvs] = useState<Set<number>>(new Set())
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      const envs = [...new Set(sessions.map((s) => s.environment))]
      const flags = await Promise.all(envs.map((e) => window.saiife.operatorStatus(e)))
      if (cancelled) return
      setGrantedEnvs(new Set(flags.filter((f) => f.granted).map((f) => f.environment)))
    }
    void tick()
    const iv = setInterval(() => void tick(), 3000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [sessions])
```

Pass `grantedEnvs={grantedEnvs}` to `<Sidebar />`.

- [ ] **Step 2: Render the indicator in Sidebar.tsx**

Add `grantedEnvs: Set<number>` to Props, destructure it, and inside the
`[data-nav-environment]` row render, add next to the environment label:

```tsx
              {grantedEnvs.has(n) && (
                <span
                  className="operator-indicator ml-1 inline-block h-1.5 w-1.5 rounded-full bg-idle align-middle"
                  data-environment={n}
                  data-granted="true"
                  title="An operator can drive this environment"
                />
              )}
```

- [ ] **Step 3: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat: per-environment operator indicator"
```

---

## Layer 4 — Workflow watchpoints + capture-store (Lobster checkpoint)

*Independently shippable: a user registers a watch on a workflow step; when the
OpenClaw-side `checkpoint` action fires, saiife stores the capture and surfaces
it in the cockpit, offering resume/stop for a halted capture.*

### Task 12: Watchpoint registry

**Files:**
- Modify: `src/main/watchpoints.ts` (replace the Layer-1 stub interface with a class)
- Create: `tests/unit/watchpoints.test.ts`

**Interfaces:**
- Consumes: `Watchpoint`, `CaptureKind` from `operator.ts`; `randomUUID`.
- Produces:
  - `class WatchpointRegistry`:
    - `register(environment, body): Watchpoint | null` — validates
      `{workflow, step, capture[], paneHandle?}`; assigns id; `hit:false`.
    - `list(environment): Watchpoint[]`
    - `get(id): Watchpoint | null`
    - `markHit(id): void`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/watchpoints.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { WatchpointRegistry } from '../../src/main/watchpoints'

describe('WatchpointRegistry', () => {
  it('registers a valid watch and lists it by environment', () => {
    const reg = new WatchpointRegistry()
    const wp = reg.register(1, { workflow: 'style-fix', step: 'verify', capture: ['screenshot', 'output'] })
    expect(wp).not.toBeNull()
    expect(wp!.hit).toBe(false)
    expect(reg.list(1).map((w) => w.id)).toEqual([wp!.id])
    expect(reg.list(2)).toEqual([])
  })

  it('rejects a malformed watch', () => {
    const reg = new WatchpointRegistry()
    expect(reg.register(1, { step: 'verify', capture: [] })).toBeNull()
    expect(reg.register(1, { workflow: 'w', capture: [] })).toBeNull()
    expect(reg.register(1, { workflow: 'w', step: 's', capture: ['bogus'] })).toBeNull()
  })

  it('markHit flips the flag', () => {
    const reg = new WatchpointRegistry()
    const wp = reg.register(1, { workflow: 'w', step: 's', capture: ['envelope'] })!
    reg.markHit(wp.id)
    expect(reg.get(wp.id)!.hit).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/watchpoints.test.ts`
Expected: FAIL — `WatchpointRegistry` is an interface, not a class.

- [ ] **Step 3: Replace `src/main/watchpoints.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { CaptureKind, Watchpoint } from '../shared/operator'

const KINDS: readonly CaptureKind[] = ['envelope', 'screenshot', 'output', 'memory']

/**
 * In-memory registry of workflow watchpoints. The user writes a watch against a
 * workflow + step label + what to capture; when the OpenClaw-side `checkpoint`
 * action fires (POST /captures), the capture ingest marks the matching watch hit.
 * Not persisted across restarts (spec "Out of scope").
 */
export class WatchpointRegistry {
  private byId = new Map<string, Watchpoint>()

  register(environment: number, body: Record<string, unknown>): Watchpoint | null {
    const workflow = body['workflow']
    const step = body['step']
    const capture = body['capture']
    if (typeof workflow !== 'string' || workflow.length === 0) return null
    if (typeof step !== 'string' || step.length === 0) return null
    if (!Array.isArray(capture) || capture.length === 0) return null
    if (!capture.every((k) => (KINDS as readonly string[]).includes(k as string))) return null
    const paneHandle = typeof body['paneHandle'] === 'string' ? (body['paneHandle'] as string) : undefined
    const wp: Watchpoint = {
      id: randomUUID(),
      environment,
      workflow,
      step,
      capture: capture as CaptureKind[],
      paneHandle,
      hit: false
    }
    this.byId.set(wp.id, wp)
    return wp
  }

  list(environment: number): Watchpoint[] {
    return [...this.byId.values()].filter((w) => w.environment === environment)
  }

  get(id: string): Watchpoint | null {
    return this.byId.get(id) ?? null
  }

  markHit(id: string): void {
    const wp = this.byId.get(id)
    if (wp) wp.hit = true
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/watchpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/watchpoints.ts tests/unit/watchpoints.test.ts
git commit -m "feat: workflow watchpoint registry"
```

---

### Task 13: Capture ingest — store envelope/output/screenshot, mark watch hit

**Files:**
- Modify: `src/main/capture-store.ts` (implement `ingest`, wire `store`)
- Create: `tests/unit/capture-ingest.test.ts`
- Modify: `src/main/index.ts` (construct + pass `watchpoints` to the server)

**Interfaces:**
- Consumes: Task 12 `WatchpointRegistry` (`get`, `markHit`); `Capture`.
- Produces:
  - `CaptureStore.ingest(environment, body, watchpoints): Promise<Capture | null>`
    — validates `watchpointId` resolves to a watch in this environment; stores
    `{envelope?, output?, memoryRef?, screenshotPath?, halted, resumeToken?}`; marks
    the watch hit; returns the stored `Capture`.
  - `CaptureStore.list(environment): Capture[]` (new; the cockpit reads it).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/capture-ingest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureStore } from '../../src/main/capture-store'
import { WatchpointRegistry } from '../../src/main/watchpoints'

function store(): CaptureStore {
  return new CaptureStore(mkdtempSync(join(tmpdir(), 'lf-ing-')))
}

describe('CaptureStore.ingest', () => {
  it('stores a capture, marks the watch hit, and is retrievable', async () => {
    const wps = new WatchpointRegistry()
    const wp = wps.register(1, { workflow: 'w', step: 'verify', capture: ['envelope', 'output'] })!
    const cs = store()
    const cap = await cs.ingest(1, {
      watchpointId: wp.id,
      envelope: { status: 'ok' },
      output: ['done'],
      halted: true,
      resumeToken: 'tok-123'
    }, wps)
    expect(cap).not.toBeNull()
    expect(cap!.halted).toBe(true)
    expect(wps.get(wp.id)!.hit).toBe(true)
    expect(cs.get(1, cap!.id)?.output).toEqual(['done'])
    expect(cs.list(1).map((c) => c.id)).toEqual([cap!.id])
  })

  it('rejects a capture for an unknown or foreign-env watchpoint', async () => {
    const wps = new WatchpointRegistry()
    const wp = wps.register(2, { workflow: 'w', step: 's', capture: ['envelope'] })!
    const cs = store()
    expect(await cs.ingest(1, { watchpointId: 'nope' }, wps)).toBeNull()
    // Watch belongs to env 2, ingest scoped to env 1 → rejected.
    expect(await cs.ingest(1, { watchpointId: wp.id }, wps)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/capture-ingest.test.ts`
Expected: FAIL — `ingest` returns null unconditionally; no `list`.

- [ ] **Step 3: Implement `ingest` + `list` in `src/main/capture-store.ts`**

Replace the stub `ingest` and make `store` usable; add `list`:

```ts
  async ingest(
    environment: number,
    body: Record<string, unknown>,
    watchpoints: WatchpointRegistry
  ): Promise<Capture | null> {
    const watchpointId = body['watchpointId']
    if (typeof watchpointId !== 'string') return null
    const wp = watchpoints.get(watchpointId)
    // Scope: the watch must exist AND belong to the ingesting environment.
    if (!wp || wp.environment !== environment) return null
    const capture: Capture = {
      id: randomUUID(),
      environment,
      watchpointId,
      createdAt: Date.now(),
      envelope: body['envelope'],
      output: Array.isArray(body['output']) ? (body['output'] as string[]) : undefined,
      memoryRef: typeof body['memoryRef'] === 'string' ? (body['memoryRef'] as string) : undefined,
      screenshotPath: typeof body['screenshotPath'] === 'string' ? (body['screenshotPath'] as string) : undefined,
      halted: body['halted'] === true,
      resumeToken: typeof body['resumeToken'] === 'string' ? (body['resumeToken'] as string) : undefined
    }
    this.store(capture)
    watchpoints.markHit(watchpointId)
    return capture
  }

  list(environment: number): Capture[] {
    return [...(this.byEnvList(environment))]
  }

  private byEnvList(environment: number): Capture[] {
    return [...(this.byEnv.get(environment)?.values() ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  }
```

Change `store` from `protected` to `private` (it is only used internally now).

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run tests/unit/capture-ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `watchpoints` into the control server**

In `src/main/index.ts`, add `import { WatchpointRegistry } from './watchpoints'`,
construct `const watchpoints = new WatchpointRegistry()`, and add
`watchpoints` to the `startControlServer({ ... })` deps (alongside the existing
`captures: captureStore`).

- [ ] **Step 6: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/capture-store.ts src/main/index.ts tests/unit/capture-ingest.test.ts
git commit -m "feat: capture ingest and watchpoint hit"
```

---

### Task 14: Captures + watchpoints IPC for the cockpit

**Files:**
- Modify: `src/main/index.ts` (`operator:captures`, `operator:watchpoints`, `operator:resume`)
- Modify: `src/shared/api.ts`, `src/preload/index.ts`

**Interfaces:**
- Consumes: `captureStore.list(environment)`, `watchpoints.list(environment)`,
  `captureStore.get`.
- Produces:
  - IPC: `operator:captures` (invoke, `environment` → `Capture[]`),
    `operator:watchpoints` (invoke, `environment` → `Watchpoint[]`),
    `operator:resume` (invoke, `environment`, `captureId`, `approve` → `boolean`).
  - `SaiifeApi.listCaptures(environment): Promise<Capture[]>`,
    `.listWatchpoints(environment): Promise<Watchpoint[]>`,
    `.resumeCapture(environment, captureId, approve): Promise<boolean>`.
  - **Resume semantics:** saiife does not run Lobster; `resumeCapture` marks the
    capture resolved locally (clears `halted`) and returns the `resumeToken` so the
    cockpit can hand it back to the operator out-of-band. It records an activity
    entry (`operator:resume`). Resume ownership stays local by design: saiife
    surfaces the token rather than calling back into OpenClaw, so the feature works
    with no OpenClaw resume endpoint (a one-click OpenClaw-side resume is a possible
    post-v1 enhancement).

- [ ] **Step 1: Add capture-store resolve helper**

In `src/main/capture-store.ts`, add:

```ts
  /** Clear the halted flag once the user resolves a halted capture; returns the resume token. */
  resolve(environment: number, id: string): string | null {
    const cap = this.byEnv.get(environment)?.get(id)
    if (!cap) return null
    cap.halted = false
    return cap.resumeToken ?? null
  }
```

- [ ] **Step 2: IPC in `src/main/index.ts`**

After the `operator:status` handle, add:

```ts
  ipcMain.handle('operator:captures', (_e, environment: number) =>
    captureStore.list(clampEnvironment(environment))
  )
  ipcMain.handle('operator:watchpoints', (_e, environment: number) =>
    watchpoints.list(clampEnvironment(environment))
  )
  ipcMain.handle('operator:resume', (_e, environment: number, captureId: string, approve: boolean) => {
    const env = clampEnvironment(environment)
    const token = captureStore.resolve(env, captureId)
    const log = activity.get(env) ?? []
    log.push({ at: Date.now(), route: 'operator:resume', detail: `${captureId} ${approve ? 'approve' : 'stop'}` })
    activity.set(env, log)
    sendToWindow('operator:activity', env, log[log.length - 1])
    return token !== null
  })
```

- [ ] **Step 3: api + preload**

`src/shared/api.ts` — extend the operator import to add `Capture, Watchpoint`:

```ts
import type { GrantInfo, OperatorStatus, ActivityEntry, Capture, Watchpoint } from './operator'
```

Add to `SaiifeApi`:

```ts
  /** Watchpoint captures stored for an environment, oldest first. */
  listCaptures(environment: number): Promise<Capture[]>
  /** Registered watchpoints for an environment. */
  listWatchpoints(environment: number): Promise<Watchpoint[]>
  /** Resolve a halted capture (approve = continue, false = stop); returns whether a token was cleared. */
  resumeCapture(environment: number, captureId: string, approve: boolean): Promise<boolean>
```

`src/preload/index.ts`:

```ts
  listCaptures: (environment: number) => ipcRenderer.invoke('operator:captures', environment),
  listWatchpoints: (environment: number) => ipcRenderer.invoke('operator:watchpoints', environment),
  resumeCapture: (environment: number, captureId: string, approve: boolean) =>
    ipcRenderer.invoke('operator:resume', environment, captureId, approve),
```

- [ ] **Step 4: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/main/index.ts src/main/capture-store.ts src/shared/api.ts src/preload/index.ts
git commit -m "feat: captures and watchpoints ipc"
```

---

### Task 15: Cockpit captures + watchpoints UI (register, list, resume/stop)

**Files:**
- Modify: `src/renderer/src/components/Cockpit.tsx` (captures list + watchpoint register/list)
- Modify: `src/renderer/src/styles.css` (capture/watchpoint rows)

**Interfaces:**
- Consumes: Task 14 IPC (`listCaptures`, `listWatchpoints`, `resumeCapture`);
  `Capture`, `Watchpoint`.
- Produces: the `.captures-list` / `.capture-row` / `.watchpoints-list` /
  `.watchpoint-row` DOM contract (Global Constraints).

- [ ] **Step 1: Extend `Cockpit.tsx` with captures + watchpoints**

Add state + loads:

```tsx
  const [captures, setCaptures] = useState<Capture[]>([])
  const [watchpoints, setWatchpoints] = useState<Watchpoint[]>([])

  const reloadSub = useCallback(async (): Promise<void> => {
    const [c, w] = await Promise.all([
      window.saiife.listCaptures(environment),
      window.saiife.listWatchpoints(environment)
    ])
    setCaptures(c)
    setWatchpoints(w)
  }, [environment])

  useEffect(() => {
    void reloadSub()
    const iv = setInterval(() => void reloadSub(), 2000)
    return () => clearInterval(iv)
  }, [reloadSub])
```

(Import `Capture, Watchpoint` from `../../../shared/operator`.)

Render, below the activity log, a captures section and a watchpoints section:

```tsx
      <div className="watchpoints-list flex-none border-t border-white/[0.07] px-3 py-2 text-[11px]">
        <div className="mb-1 font-semibold text-gray-300">Watchpoints</div>
        {watchpoints.length === 0 ? (
          <div className="text-gray-500">No watchpoints registered.</div>
        ) : (
          watchpoints.map((w) => (
            <div
              key={w.id}
              className="watchpoint-row flex gap-2 py-0.5 text-gray-300"
              data-watchpoint-id={w.id}
              data-hit={w.hit ? 'true' : 'false'}
            >
              <span className="text-gray-200">{w.workflow}</span>
              <span className="text-gray-500">@ {w.step}</span>
              <span className="text-gray-600">{w.capture.join(',')}</span>
              <span className={w.hit ? 'text-idle' : 'text-gray-500'}>{w.hit ? 'hit' : 'pending'}</span>
            </div>
          ))
        )}
      </div>
      <div className="captures-list flex-none border-t border-white/[0.07] px-3 py-2 text-[11px]">
        <div className="mb-1 font-semibold text-gray-300">Captures</div>
        {captures.length === 0 ? (
          <div className="text-gray-500">No captures yet.</div>
        ) : (
          captures
            .slice()
            .reverse()
            .map((c) => (
              <div
                key={c.id}
                className={`capture-row flex items-center gap-2 py-0.5 text-gray-300 ${c.halted ? 'halted' : ''}`}
                data-capture-id={c.id}
              >
                <span className="text-gray-600">{new Date(c.createdAt).toLocaleTimeString()}</span>
                {c.screenshotPath && <span className="truncate text-gray-500">{c.screenshotPath}</span>}
                {c.output && <span className="text-gray-500">{c.output.length} lines</span>}
                {c.halted ? (
                  <>
                    <button
                      className="capture-resume cursor-pointer rounded border border-white/10 px-1.5 text-idle"
                      onClick={() => void window.saiife.resumeCapture(environment, c.id, true).then(reloadSub)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      Resume
                    </button>
                    <button
                      className="capture-stop cursor-pointer rounded border border-white/10 px-1.5 text-gray-400"
                      onClick={() => void window.saiife.resumeCapture(environment, c.id, false).then(reloadSub)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      Stop
                    </button>
                  </>
                ) : (
                  <span className="text-gray-600">stored</span>
                )}
              </div>
            ))
        )}
      </div>
```

> Watchpoint *registration* is done by the operator over the control API
> (`POST /watchpoints`), so the cockpit lists them read-only in v1. A manual
> "register watch" form is deferred; the spec's registration path is the control
> API. (A UI-driven register is a small additive follow-up: it reuses
> `listWatchpoints` + a new `operator:registerWatch` IPC.)

- [ ] **Step 2: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add src/renderer/src/components/Cockpit.tsx src/renderer/src/styles.css
git commit -m "feat: cockpit captures and watchpoints ui"
```

---

### Task 16: End-to-end — scripted control-API client through the full loop

**Files:**
- Create: `tests/e2e/operator.spec.ts`

**Interfaces:**
- Consumes: the running app under `SAIIFE_E2E=1`; the grant handshake file
  `operator-grant-<env>.json` written by Task 4; a real terminal pane + a real
  browser pane; Node `fetch` as the scripted control-API client.
- Produces: the security + happy-path proof the spec's "Testing" section requires.

- [ ] **Step 1: Write the e2e spec**

Model it on `tests/e2e/smoke.spec.ts` (same `_electron.launch`, `SAIIFE_E2E`
env, `userData`, `readFileSync` of the handshake file). Cover:

```ts
import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// (reuse smoke.spec.ts's launch helper shape: userData temp dir, env, etc.)

test('operator drives a granted environment and is denied cross-env', async () => {
  // 1. Launch, create a terminal session on env 1 and a browser pane on env 1.
  //    Create a second terminal session on env 2 (the foreign environment).
  // 2. In the renderer, enter the Cockpit and click .operator-grant-toggle to
  //    grant env 1. Read operator-grant-1.json for {endpoint, token}.
  // 3. Scripted client: GET /panes → only env-1 handles appear (assert the env-2
  //    handle is absent). This is the isolation guarantee.
  // 4. Foreign-env probe: POST /panes/<env2-handle>/prompt with the env-1 token
  //    → 404.
  // 5. No-token probe: GET /panes with a bogus token → 403.
  // 6. Drive the terminal: POST /panes/<term>/prompt {text:'echo hi'} → 200;
  //    GET /panes/<term>/output → includes 'hi'.
  // 7. Drive the browser: POST /panes/<web>/navigate {url:'http://localhost:...'}
  //    → 200; POST /panes/<web>/screenshot → {path}; assert the PNG exists on disk.
  // 8. Assert the cockpit's .operator-activity shows the routes (navigated,
  //    screenshotted, prompt), and .operator-status[data-connected='true'].
  // 9. Register a watchpoint: POST /watchpoints {workflow, step:'verify',
  //    capture:['output']} → {id}. Fire the checkpoint: POST /captures
  //    {watchpointId, output:['verified'], halted:true, resumeToken:'t'} → 201.
  //    Assert .watchpoint-row[data-hit='true'] and a .capture-row.halted appear.
  //    Click .capture-resume → the row loses .halted.
  // 10. Revoke via .operator-grant-toggle; re-issue GET /panes with the old token
  //     → 403 (immediate revocation).
})
```

> Follow the smoke suite's exact launch/teardown helpers rather than inventing
> new ones; the pseudocode above is the assertion checklist, not final code —
> fill each numbered step with real Playwright + `fetch` calls mirroring the DOM
> selectors in the Global Constraints and the wire format block.

- [ ] **Step 2: Run the e2e**

Run: `npm run e2e -- operator.spec.ts`
Expected: PASS (all assertions).

- [ ] **Step 3: Full check + commit**

Run: `npm run check` — expected PASS.

```bash
git add tests/e2e/operator.spec.ts
git commit -m "test: operator control-api e2e loop"
```

---

## Self-Review

**Spec coverage:**
- Pane control surface (browser navigate/screenshot/cookies/network/act; terminal
  prompt/output) → Tasks 3, 7, 8.
- Stable handles + environment scoping (isolation) → Task 1 (registry), enforced in
  `resolve`, proven in Task 16 steps 3–4.
- Operator grant (mint secret, loopback endpoint, revoke immediately) → Tasks 2, 4.
- Control API (loopback, bearer, env-scoped routes, pinned wire format) → Task 3 +
  the wire-format block.
- Screenshot → terminal handoff (path under a scratch dir) → Task 5, 7.
- Browser control reuses the M3.5 webview, partition-confined reads → Tasks 6–8.
- OpenClaw `saiife` skill (portable SKILL.md + CLI) → Task 9.
- Cockpit (status, action log, captures) → Tasks 10, 15; grant toggle + indicator →
  Tasks 10, 11.
- Watchpoints + capture-store (checkpoint action) → Tasks 12, 13, 14, 15; the
  Lobster checkpoint step is the skill's `checkpoint` verb (Task 9) firing
  `POST /captures`.
- Error handling (403 no/revoked, 404 unknown/closed handle, browser degrade,
  dead-pty no-op, pending watch, capture failure) → Task 3 router + Task 7 degrade
  paths + Task 12 pending flag.
- Security/isolation invariants → Global Constraints + Tasks 1–3 + Task 16 probes.

**Type consistency:** `PaneView`, `Capture`, `Watchpoint`, `ActivityEntry`,
`GrantInfo`, `OperatorStatus`, `CaptureKind` are defined once in
`src/shared/operator.ts` (Task 1) and imported everywhere. `BrowserControl`,
`CaptureStore`, `WatchpointRegistry` are declared as interface stubs in Task 3 and
replaced by classes of the same names in Tasks 5/7, 12/13 (a class is a valid type
for the `type`-only imports in `control-api.ts`).

**Placeholder scan:** No `TBD`/`TODO`. The OpenClaw-side integration decisions the
spec flagged as open are resolved in the section below. The Task 16 e2e body is an
assertion checklist tied to concrete selectors + the wire-format block, per the
smoke-suite convention (the M6 plan uses the same "e2e drives the full path"
approach).

## Design decisions — OpenClaw-side integration

These resolve the integration questions the spec left open. Each keeps saiife
decoupled from OpenClaw internals (it works with no operator present) and treats
plain, hand-editable config as the source of truth.

1. **Skill env injection (Task 9).** The grant's `SAIIFE_ENDPOINT` +
   `SAIIFE_TOKEN` are injected via `skills.entries.saiife.env` in
   `~/.openclaw/openclaw.json` — the plainest, most inspectable field (not a
   `config` block or `apiKey` SecretRef, which add opacity/coupling). saiife
   **auto-writes** that block when it launches a managed OpenClaw session, and
   surfaces exactly what it wrote so the user can inspect and revoke by editing the
   file.
2. **Checkpoint authoring (Task 9/16).** The `checkpoint` step is **authored
   directly** in the user's Lobster workflow YAML, calling
   `node .../saiife-control.mjs checkpoint <id> --halt` as a step `command`.
   This keeps the workflow definition owned by the user (saiife never reaches
   into it) and matches Lobster's per-step approval model
   (`approval: required`, `condition: $approve.approved`).
3. **Lobster invocation channel (Task 9).** The checkpoint step shells out to the
   `saiife-control.mjs` CLI via a step `command` string rather than an
   `openclaw.invoke` tool call, because the OpenClaw docs note `openclaw.invoke`
   "is not currently reliable in the embedded runner."
4. **Resume ownership (Task 14).** saiife does not run Lobster, so
   `resumeCapture` resolves the halted capture **locally** and surfaces the
   `resumeToken` for the operator to resume out-of-band — no dependency on an
   OpenClaw resume endpoint. A one-click OpenClaw-side resume is a possible post-v1
   enhancement.
5. **Remote-CDP stays out of v1 (Global Constraints).** v1 keeps browser control
   fully saiife-implemented and does **not** expose the webview as a remote-CDP
   target for OpenClaw's native `browser` tool. The pane is a human-first browser;
   exposing it via CDP would widen the security surface and couple v1 to OpenClaw.
   Richer native-browser interactions can be revisited post-v1.
