# localflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS Electron app showing a grid of live terminal panes, each running a real `claude` CLI session, with hook-driven status colors (blue working / yellow needs-you / green idle / gray exited).

**Architecture:** Electron main process spawns one PTY per session via node-pty and runs a localhost-only HTTP listener that receives status events from Claude Code hooks (injected per-session via `--settings`). The renderer (React + xterm.js) shows panes wired over a typed preload IPC bridge. Spec: `docs/superpowers/specs/2026-07-06-localflow-design.md`.

**Tech Stack:** Electron, electron-vite, TypeScript (strict), React, @xterm/xterm, node-pty, Vitest, Playwright, electron-builder, commitlint + husky, GitHub Actions, release-please.

## Global Constraints

- Conventional Commits, subject line **max 50 characters** (commitlint-enforced once Task 2 lands; follow it from Task 1).
- TypeScript `strict: true` everywhere; no `any` except where a third-party type forces it.
- Electron security: `contextIsolation: true`, `nodeIntegration: false`, single typed preload bridge.
- Hook listener binds `127.0.0.1` only, random port, per-run secret token.
- macOS-only for v1 (build targets, CI runners for e2e/build).
- Node ≥ 20. License MIT. No telemetry.
- Status colors: working=blue `#3b82f6`, needs-you=yellow `#eab308`, idle=green `#22c55e`, exited=gray `#6b7280`.
- `claude` binary resolved from `LOCALFLOW_CLAUDE_BIN` env var, falling back to `claude` (tests use a fixture script).

---

### Task 1: Scaffold electron-vite app

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `.gitignore`, `.prettierrc.json`, `eslint.config.mjs`, `LICENSE`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/env.d.ts`

**Interfaces:**
- Produces: a launchable Electron window titled "localflow"; `npm run dev`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run check` all work.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "localflow",
  "version": "0.1.0",
  "description": "Mission control for Claude Code sessions - one window, many agents, glanceable status.",
  "main": "./out/main/index.js",
  "type": "module",
  "license": "MIT",
  "author": "HrRobinson",
  "repository": { "type": "git", "url": "https://github.com/HrRobinson/localflow.git" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write .",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "e2e": "electron-vite build && playwright test",
    "check": "npm run lint && npm run typecheck && npm run test",
    "package": "electron-vite build && electron-builder --dir",
    "dist": "electron-vite build && electron-builder --mac --publish never",
    "postinstall": "electron-builder install-app-deps"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install node-pty @xterm/xterm @xterm/addon-fit react react-dom`
Run: `npm install -D electron electron-vite vite @vitejs/plugin-react typescript @types/react @types/react-dom @types/node eslint @eslint/js typescript-eslint eslint-plugin-react-hooks prettier vitest @playwright/test electron-builder`
Expected: installs succeed; `postinstall` rebuilds node-pty against Electron (this is why `electron-builder install-app-deps` is in postinstall — node-pty is a native module and must match Electron's Node ABI).

- [ ] **Step 3: Create config files**

`electron.vite.config.ts`:
```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
```

`tsconfig.node.json` (main + preload + shared + unit tests):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "tests/unit/**/*", "tests/e2e/**/*", "*.config.ts", "*.config.mjs"]
}
```

`tsconfig.web.json` (renderer):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/renderer/**/*", "src/shared/**/*", "src/preload/index.d.ts"]
}
```

`tsconfig.json` (root, for editors):
```json
{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }
```

`.prettierrc.json`:
```json
{ "semi": false, "singleQuote": true, "printWidth": 100, "trailingComma": "none" }
```

`eslint.config.mjs`:
```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.tsx', 'src/renderer/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  }
)
```

`.gitignore`:
```
node_modules/
out/
dist/
*.log
.DS_Store
playwright-report/
test-results/
```

`LICENSE`: standard MIT license text with `Copyright (c) 2026 HrRobinson`.

- [ ] **Step 4: Create minimal main, preload, renderer**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'localflow',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
```

`src/preload/index.ts`:
```ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('localflow', {})
```

Note: electron-vite emits the preload as `index.cjs` when `"type": "module"` — if `npm run dev` logs a preload load error, check the emitted filename under `out/preload/` and match the `join(__dirname, '../preload/…')` path to it.

`src/renderer/index.html`:
```html
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
<title>localflow</title>
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
```
(electron-vite expects `index.html` at `src/renderer/index.html` with source root `src/renderer/src`.)

`src/renderer/src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

`src/renderer/src/App.tsx`:
```tsx
export default function App(): React.JSX.Element {
  return <h1>localflow</h1>
}
```

`src/renderer/src/env.d.ts`:
```ts
/// <reference types="vite/client" />
```

- [ ] **Step 5: Verify it runs and checks pass**

Run: `npm run build` — Expected: builds main, preload, renderer without errors.
Run: `npm run dev` briefly (then quit) — Expected: window opens titled "localflow" showing the heading.
Run: `npm run lint && npm run typecheck` — Expected: clean. (`npm test` fails with "no tests" until Task 3 — that's fine; don't run `check` yet.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold electron-vite app"
```

---

### Task 2: Commit hygiene — commitlint + husky

**Files:**
- Create: `commitlint.config.mjs`, `.husky/commit-msg`
- Modify: `package.json` (add `prepare` script, dev deps)

**Interfaces:**
- Produces: any commit with a non-conventional or >50-char subject is rejected locally. CI enforcement comes in Task 11.

- [ ] **Step 1: Install and configure**

Run: `npm install -D @commitlint/cli @commitlint/config-conventional husky`

`commitlint.config.mjs`:
```js
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 50]
  }
}
```

Add to `package.json` scripts: `"prepare": "husky"`.
Run: `npx husky init` then overwrite `.husky/pre-commit` — delete it (we don't want a pre-commit hook; CI covers checks) and create `.husky/commit-msg`:
```
npx --no -- commitlint --edit "$1"
```

- [ ] **Step 2: Verify rejection and acceptance**

Run: `echo "this is a bad long commit message that definitely exceeds the limit" | npx commitlint`
Expected: FAILS (subject-empty/type-empty + header-max-length errors).
Run: `echo "feat: add thing" | npx commitlint`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: enforce conventional commits locally"
```

---

### Task 3: Shared types and session state machine (TDD)

**Files:**
- Create: `src/shared/types.ts`, `src/main/state-machine.ts`, `vitest.config.ts`
- Test: `tests/unit/state-machine.test.ts`

**Interfaces:**
- Produces: `SessionStatus = 'idle' | 'working' | 'needs-you' | 'exited'`; `HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'`; `HookEvent = { paneId: string; event: HookEventName }`; `SessionInfo = { id: string; cwd: string; status: SessionStatus }`; `transition(current: SessionStatus, event: HookEventName | 'pty-exit'): SessionStatus`.

- [ ] **Step 1: Create vitest config**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' }
})
```

- [ ] **Step 2: Write the failing test**

`tests/unit/state-machine.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { transition } from '../../src/main/state-machine'

describe('transition', () => {
  it('goes working on UserPromptSubmit', () => {
    expect(transition('idle', 'UserPromptSubmit')).toBe('working')
  })
  it('goes needs-you on Notification', () => {
    expect(transition('working', 'Notification')).toBe('needs-you')
  })
  it('goes idle on Stop', () => {
    expect(transition('working', 'Stop')).toBe('idle')
    expect(transition('needs-you', 'Stop')).toBe('idle')
  })
  it('goes exited on pty-exit from any state', () => {
    expect(transition('working', 'pty-exit')).toBe('exited')
    expect(transition('idle', 'pty-exit')).toBe('exited')
  })
  it('exited is terminal — late hook events are ignored', () => {
    expect(transition('exited', 'Stop')).toBe('exited')
    expect(transition('exited', 'UserPromptSubmit')).toBe('exited')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `src/main/state-machine`.

- [ ] **Step 4: Write shared types and implementation**

`src/shared/types.ts`:
```ts
export type SessionStatus = 'idle' | 'working' | 'needs-you' | 'exited'

export type HookEventName = 'UserPromptSubmit' | 'Notification' | 'Stop'

export interface HookEvent {
  paneId: string
  event: HookEventName
}

export interface SessionInfo {
  id: string
  cwd: string
  status: SessionStatus
}
```

`src/main/state-machine.ts`:
```ts
import type { HookEventName, SessionStatus } from '../shared/types'

export function transition(
  current: SessionStatus,
  event: HookEventName | 'pty-exit'
): SessionStatus {
  if (current === 'exited') return 'exited'
  switch (event) {
    case 'pty-exit':
      return 'exited'
    case 'UserPromptSubmit':
      return 'working'
    case 'Notification':
      return 'needs-you'
    case 'Stop':
      return 'idle'
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test` — Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add session status state machine"
```

---

### Task 4: Hook event HTTP listener (TDD)

**Files:**
- Create: `src/main/hook-server.ts`
- Test: `tests/unit/hook-server.test.ts`

**Interfaces:**
- Consumes: `HookEvent`, `HookEventName` from `src/shared/types`.
- Produces: `parseHookBody(raw: string): HookEvent | null`; `startHookServer(onEvent: (e: HookEvent) => void): Promise<HookEndpoint>` where `HookEndpoint = { port: number; token: string; close(): void }`. Server accepts only `POST /event` on `127.0.0.1` with header `X-Localflow-Token: <token>`; responds 204 on success, 403 bad token/route, 400 bad body.

- [ ] **Step 1: Write the failing test**

`tests/unit/hook-server.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { parseHookBody, startHookServer, type HookEndpoint } from '../../src/main/hook-server'
import type { HookEvent } from '../../src/shared/types'

describe('parseHookBody', () => {
  it('parses a valid event', () => {
    expect(parseHookBody('{"paneId":"abc","event":"Stop"}')).toEqual({
      paneId: 'abc',
      event: 'Stop'
    })
  })
  it('rejects unknown event names', () => {
    expect(parseHookBody('{"paneId":"abc","event":"Evil"}')).toBeNull()
  })
  it('rejects missing paneId and invalid JSON', () => {
    expect(parseHookBody('{"event":"Stop"}')).toBeNull()
    expect(parseHookBody('not json')).toBeNull()
  })
})

describe('startHookServer', () => {
  let endpoint: HookEndpoint
  afterEach(() => endpoint?.close())

  it('delivers valid events and enforces the token', async () => {
    const received: HookEvent[] = []
    endpoint = await startHookServer((e) => received.push(e))
    const url = `http://127.0.0.1:${endpoint.port}/event`
    const body = JSON.stringify({ paneId: 'p1', event: 'Notification' })

    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': endpoint.token },
      body
    })
    expect(ok.status).toBe(204)
    expect(received).toEqual([{ paneId: 'p1', event: 'Notification' }])

    const badToken = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': 'wrong' },
      body
    })
    expect(badToken.status).toBe(403)

    const badBody = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': endpoint.token },
      body: 'nope'
    })
    expect(badBody.status).toBe(400)
    expect(received).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` — Expected: FAIL, cannot resolve `src/main/hook-server`.

- [ ] **Step 3: Implement**

`src/main/hook-server.ts`:
```ts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { HookEvent } from '../shared/types'

export interface HookEndpoint {
  port: number
  token: string
  close(): void
}

const EVENT_NAMES = ['UserPromptSubmit', 'Notification', 'Stop'] as const

export function parseHookBody(raw: string): HookEvent | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return null
    const { paneId, event } = data as Record<string, unknown>
    if (typeof paneId !== 'string' || paneId.length === 0) return null
    if (typeof event !== 'string' || !(EVENT_NAMES as readonly string[]).includes(event)) {
      return null
    }
    return { paneId, event: event as HookEvent['event'] }
  } catch {
    return null
  }
}

export function startHookServer(onEvent: (e: HookEvent) => void): Promise<HookEndpoint> {
  const token = randomUUID()
  const server = createServer((req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/event' ||
      req.headers['x-localflow-token'] !== token
    ) {
      res.writeHead(403)
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      const event = parseHookBody(body)
      if (!event) {
        res.writeHead(400)
        res.end()
        return
      }
      onEvent(event)
      res.writeHead(204)
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, token, close: () => server.close() })
    })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add localhost hook event listener"
```

---

### Task 5: Hook settings generator (TDD)

**Files:**
- Create: `src/main/hook-settings.ts`
- Test: `tests/unit/hook-settings.test.ts`

**Interfaces:**
- Consumes: `HookEventName` from shared types.
- Produces: `buildHookSettings(paneId: string, port: number, token: string): object` (Claude Code settings JSON with UserPromptSubmit/Notification/Stop hooks that `curl` the listener); `writeHookSettings(dir: string, paneId: string, port: number, token: string): string` (writes `localflow-hooks-<paneId>.json` into `dir`, returns the path).

- [ ] **Step 1: Write the failing test**

`tests/unit/hook-settings.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHookSettings, writeHookSettings } from '../../src/main/hook-settings'

describe('buildHookSettings', () => {
  it('creates a curl hook for each of the three events', () => {
    const settings = buildHookSettings('p1', 4242, 'tok') as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
    }
    for (const name of ['UserPromptSubmit', 'Notification', 'Stop']) {
      const cmd = settings.hooks[name][0].hooks[0].command
      expect(settings.hooks[name][0].hooks[0].type).toBe('command')
      expect(cmd).toContain('http://127.0.0.1:4242/event')
      expect(cmd).toContain('X-Localflow-Token: tok')
      expect(cmd).toContain(`"paneId":"p1"`)
      expect(cmd).toContain(`"event":"${name}"`)
    }
  })
})

describe('writeHookSettings', () => {
  it('writes valid JSON and returns the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-test-'))
    const file = writeHookSettings(dir, 'p2', 1234, 'tok2')
    expect(file).toBe(join(dir, 'localflow-hooks-p2.json'))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.hooks.Stop).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` — Expected: FAIL, cannot resolve `src/main/hook-settings`.

- [ ] **Step 3: Implement**

`src/main/hook-settings.ts`:
```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEventName } from '../shared/types'

const EVENTS: HookEventName[] = ['UserPromptSubmit', 'Notification', 'Stop']

export function buildHookSettings(paneId: string, port: number, token: string): object {
  const hooks: Record<string, unknown> = {}
  for (const event of EVENTS) {
    const payload = JSON.stringify({ paneId, event })
    const command = `curl -s -m 3 -X POST http://127.0.0.1:${port}/event -H 'Content-Type: application/json' -H 'X-Localflow-Token: ${token}' -d '${payload}'`
    hooks[event] = [{ hooks: [{ type: 'command', command }] }]
  }
  return { hooks }
}

export function writeHookSettings(
  dir: string,
  paneId: string,
  port: number,
  token: string
): string {
  const file = join(dir, `localflow-hooks-${paneId}.json`)
  writeFileSync(file, JSON.stringify(buildHookSettings(paneId, port, token), null, 2))
  return file
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: generate per-session claude hook settings"
```

---

### Task 6: Session manager (TDD with injected spawn)

**Files:**
- Create: `src/main/session-manager.ts`
- Test: `tests/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `transition` (Task 3), `writeHookSettings` (Task 5), shared types.
- Produces: `class SessionManager` with:
  - `constructor(opts: { settingsDir: string; port: number; token: string; claudeBin: string; spawnFn?: SpawnFn })`
  - `create(cwd: string): SessionInfo` — spawns `claudeBin --settings <file>` in `cwd`, status starts `'idle'`
  - `restore(id: string, cwd: string): SessionInfo` — registers an exited placeholder (no pty)
  - `restart(id: string): SessionInfo` — respawns an exited session with extra arg `--continue`, keeps the same id
  - `applyHookEvent(e: HookEvent): void`, `write(id, data)`, `resize(id, cols, rows)`, `kill(id)` (kills pty and removes the session), `list(): SessionInfo[]`
  - `onData(cb: (id: string, data: string) => void)`, `onStatus(cb: (id: string, status: SessionStatus) => void)`, `onSessionsChanged(cb: () => void)`
  - `SpawnFn = (bin: string, args: string[], opts: { cwd: string; cols: number; rows: number; name: string; env: NodeJS.ProcessEnv }) => PtyLike` and `PtyLike = { onData(cb: (d: string) => void): void; onExit(cb: () => void): void; write(d: string): void; resize(c: number, r: number): void; kill(): void }`

- [ ] **Step 1: Write the failing test**

`tests/unit/session-manager.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type PtyLike, type SpawnFn } from '../../src/main/session-manager'

class FakePty implements PtyLike {
  dataCb: ((d: string) => void) | null = null
  exitCb: (() => void) | null = null
  written: string[] = []
  killed = false
  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: () => void): void {
    this.exitCb = cb
  }
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  kill(): void {
    this.killed = true
  }
}

describe('SessionManager', () => {
  let spawnCalls: { bin: string; args: string[]; cwd: string }[]
  let ptys: FakePty[]
  let mgr: SessionManager

  beforeEach(() => {
    spawnCalls = []
    ptys = []
    const spawnFn: SpawnFn = (bin, args, opts) => {
      spawnCalls.push({ bin, args, cwd: opts.cwd })
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    }
    mgr = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
      port: 9999,
      token: 'tok',
      claudeBin: 'fake-claude',
      spawnFn
    })
  })

  it('create spawns claude with --settings in the cwd, idle status', () => {
    const info = mgr.create('/some/project')
    expect(info.status).toBe('idle')
    expect(spawnCalls[0].bin).toBe('fake-claude')
    expect(spawnCalls[0].cwd).toBe('/some/project')
    expect(spawnCalls[0].args[0]).toBe('--settings')
    expect(spawnCalls[0].args[1]).toContain(`localflow-hooks-${info.id}.json`)
  })

  it('hook events drive status and notify listeners', () => {
    const info = mgr.create('/p')
    const statuses: string[] = []
    mgr.onStatus((id, s) => id === info.id && statuses.push(s))
    mgr.applyHookEvent({ paneId: info.id, event: 'UserPromptSubmit' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Notification' })
    mgr.applyHookEvent({ paneId: info.id, event: 'Stop' })
    expect(statuses).toEqual(['working', 'needs-you', 'idle'])
    expect(mgr.list()[0].status).toBe('idle')
  })

  it('pty exit marks session exited; restart respawns with --continue', () => {
    const info = mgr.create('/p')
    ptys[0].exitCb?.()
    expect(mgr.list()[0].status).toBe('exited')
    const restarted = mgr.restart(info.id)
    expect(restarted.id).toBe(info.id)
    expect(restarted.status).toBe('idle')
    expect(spawnCalls[1].args).toContain('--continue')
  })

  it('restore registers an exited placeholder without spawning', () => {
    const info = mgr.restore('saved-id', '/old/project')
    expect(info).toEqual({ id: 'saved-id', cwd: '/old/project', status: 'exited' })
    expect(spawnCalls).toHaveLength(0)
  })

  it('spawn failure yields an exited session with an error message', () => {
    const failing = new SessionManager({
      settingsDir: mkdtempSync(join(tmpdir(), 'localflow-sm-')),
      port: 9999,
      token: 'tok',
      claudeBin: 'missing',
      spawnFn: () => {
        throw new Error('ENOENT')
      }
    })
    const messages: string[] = []
    failing.onData((_id, d) => messages.push(d))
    const info = failing.create('/p')
    expect(info.status).toBe('exited')
    expect(messages.join('')).toContain('Could not start')
  })

  it('kill removes the session and kills the pty', () => {
    const info = mgr.create('/p')
    mgr.kill(info.id)
    expect(ptys[0].killed).toBe(true)
    expect(mgr.list()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` — Expected: FAIL, cannot resolve `src/main/session-manager`.

- [ ] **Step 3: Implement**

`src/main/session-manager.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { spawn as ptySpawn } from 'node-pty'
import type { HookEvent, SessionInfo, SessionStatus } from '../shared/types'
import { transition } from './state-machine'
import { writeHookSettings } from './hook-settings'

export interface PtyLike {
  onData(cb: (d: string) => void): void
  onExit(cb: () => void): void
  write(d: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; name: string; env: NodeJS.ProcessEnv }
) => PtyLike

const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const pty = ptySpawn(bin, args, opts)
  return {
    onData: (cb) => pty.onData(cb),
    onExit: (cb) => pty.onExit(() => cb()),
    write: (d) => pty.write(d),
    resize: (c, r) => pty.resize(c, r),
    kill: () => pty.kill()
  }
}

interface Options {
  settingsDir: string
  port: number
  token: string
  claudeBin: string
  spawnFn?: SpawnFn
}

interface Record_ {
  info: SessionInfo
  pty: PtyLike | null
}

export class SessionManager {
  private sessions = new Map<string, Record_>()
  private dataCbs: ((id: string, data: string) => void)[] = []
  private statusCbs: ((id: string, status: SessionStatus) => void)[] = []
  private changedCbs: (() => void)[] = []

  constructor(private opts: Options) {}

  onData(cb: (id: string, data: string) => void): void {
    this.dataCbs.push(cb)
  }
  onStatus(cb: (id: string, status: SessionStatus) => void): void {
    this.statusCbs.push(cb)
  }
  onSessionsChanged(cb: () => void): void {
    this.changedCbs.push(cb)
  }

  create(cwd: string): SessionInfo {
    return this.spawn(randomUUID(), cwd, [])
  }

  restore(id: string, cwd: string): SessionInfo {
    const info: SessionInfo = { id, cwd, status: 'exited' }
    this.sessions.set(id, { info, pty: null })
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  restart(id: string): SessionInfo {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status !== 'exited') throw new Error(`cannot restart session ${id}`)
    return this.spawn(id, rec.info.cwd, ['--continue'])
  }

  private spawn(id: string, cwd: string, extraArgs: string[]): SessionInfo {
    const settingsFile = writeHookSettings(this.opts.settingsDir, id, this.opts.port, this.opts.token)
    const info: SessionInfo = { id, cwd, status: 'idle' }
    let pty: PtyLike | null = null
    try {
      pty = (this.opts.spawnFn ?? defaultSpawn)(
        this.opts.claudeBin,
        ['--settings', settingsFile, ...extraArgs],
        { cwd, cols: 80, rows: 24, name: 'xterm-256color', env: process.env }
      )
    } catch {
      info.status = 'exited'
      this.sessions.set(id, { info, pty: null })
      this.changedCbs.forEach((cb) => cb())
      this.dataCbs.forEach((cb) =>
        cb(
          id,
          `\r\nCould not start '${this.opts.claudeBin}'. Is Claude Code installed and on your PATH?\r\n`
        )
      )
      return info
    }
    this.sessions.set(id, { info, pty })
    pty.onData((d) => this.dataCbs.forEach((cb) => cb(id, d)))
    pty.onExit(() => this.setStatus(id, transition(this.status(id), 'pty-exit')))
    this.changedCbs.forEach((cb) => cb())
    return info
  }

  applyHookEvent(e: HookEvent): void {
    const rec = this.sessions.get(e.paneId)
    if (!rec) return
    this.setStatus(e.paneId, transition(rec.info.status, e.event))
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty?.resize(cols, rows)
  }

  kill(id: string): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    rec.pty?.kill()
    this.sessions.delete(id)
    this.changedCbs.forEach((cb) => cb())
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((r) => ({ ...r.info }))
  }

  private status(id: string): SessionStatus {
    return this.sessions.get(id)?.info.status ?? 'exited'
  }

  private setStatus(id: string, status: SessionStatus): void {
    const rec = this.sessions.get(id)
    if (!rec || rec.info.status === status) return
    rec.info.status = status
    this.statusCbs.forEach((cb) => cb(id, status))
  }
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npm run check` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add pty session manager"
```

---

### Task 7: Persistence + main-process wiring + typed preload bridge

**Files:**
- Create: `src/main/persistence.ts`, `src/shared/api.ts`, `src/preload/index.d.ts`
- Modify: `src/main/index.ts` (full rewrite below), `src/preload/index.ts` (full rewrite below)
- Test: `tests/unit/persistence.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 6), `startHookServer` (Task 4), shared types.
- Produces:
  - `loadSavedSessions(file: string): { id: string; cwd: string }[]` and `saveSessions(file: string, sessions: { id: string; cwd: string }[]): void`
  - `LocalflowApi` on `window.localflow`: `createSession(cwd?: string): Promise<SessionInfo | null>` (no `cwd` → native folder picker; `null` if cancelled), `restartSession(id: string): Promise<SessionInfo>`, `killSession(id: string): Promise<void>`, `listSessions(): Promise<SessionInfo[]>`, `write(id, data): void`, `resize(id, cols, rows): void`, `onData(cb): () => void`, `onStatus(cb): () => void`
  - Env behavior: `LOCALFLOW_USER_DATA` overrides userData path; `LOCALFLOW_E2E=1` writes `endpoint.json` (`{ port, token }`) into userData; `LOCALFLOW_CLAUDE_BIN` overrides the claude binary.

- [ ] **Step 1: Write the failing persistence test**

`tests/unit/persistence.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSavedSessions, saveSessions } from '../../src/main/persistence'

describe('persistence', () => {
  it('round-trips sessions and tolerates a missing file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'localflow-p-')), 'sessions.json')
    expect(loadSavedSessions(file)).toEqual([])
    saveSessions(file, [{ id: 'a', cwd: '/x' }])
    expect(loadSavedSessions(file)).toEqual([{ id: 'a', cwd: '/x' }])
  })
  it('returns [] on corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'localflow-p-'))
    const file = join(dir, 'sessions.json')
    saveSessions(file, [])
    require('node:fs').writeFileSync(file, 'garbage')
    expect(loadSavedSessions(file)).toEqual([])
  })
})
```
(Replace the `require` line with `import { writeFileSync } from 'node:fs'` at the top and call `writeFileSync(file, 'garbage')` — no `require` in ESM.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` — Expected: FAIL, cannot resolve `src/main/persistence`.

- [ ] **Step 3: Implement persistence**

`src/main/persistence.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs'

export interface SavedSession {
  id: string
  cwd: string
}

export function loadSavedSessions(file: string): SavedSession[] {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(data)) return []
    return data.filter(
      (s): s is SavedSession =>
        typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.cwd === 'string'
    )
  } catch {
    return []
  }
}

export function saveSessions(file: string, sessions: SavedSession[]): void {
  writeFileSync(file, JSON.stringify(sessions, null, 2))
}
```

Run: `npm test` — Expected: PASS.

- [ ] **Step 4: Define the API contract**

`src/shared/api.ts`:
```ts
import type { SessionInfo, SessionStatus } from './types'

export interface LocalflowApi {
  createSession(cwd?: string): Promise<SessionInfo | null>
  restartSession(id: string): Promise<SessionInfo>
  killSession(id: string): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onData(cb: (id: string, data: string) => void): () => void
  onStatus(cb: (id: string, status: SessionStatus) => void): () => void
}
```

`src/preload/index.d.ts`:
```ts
import type { LocalflowApi } from '../shared/api'

declare global {
  interface Window {
    localflow: LocalflowApi
  }
}

export {}
```

- [ ] **Step 5: Implement preload bridge**

`src/preload/index.ts` (full replacement):
```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LocalflowApi } from '../shared/api'
import type { SessionStatus } from '../shared/types'

const api: LocalflowApi = {
  createSession: (cwd?: string) => ipcRenderer.invoke('session:create', cwd),
  restartSession: (id: string) => ipcRenderer.invoke('session:restart', id),
  killSession: (id: string) => ipcRenderer.invoke('session:kill', id),
  listSessions: () => ipcRenderer.invoke('session:list'),
  write: (id: string, data: string) => ipcRenderer.send('session:write', id, data),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('session:resize', id, cols, rows),
  onData: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string, data: string): void => cb(id, data)
    ipcRenderer.on('session:data', listener)
    return () => ipcRenderer.removeListener('session:data', listener)
  },
  onStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string, status: SessionStatus): void =>
      cb(id, status)
    ipcRenderer.on('session:status', listener)
    return () => ipcRenderer.removeListener('session:status', listener)
  }
}

contextBridge.exposeInMainWorld('localflow', api)
```

- [ ] **Step 6: Wire the main process**

`src/main/index.ts` (full replacement):
```ts
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { startHookServer } from './hook-server'
import { SessionManager } from './session-manager'
import { loadSavedSessions, saveSessions } from './persistence'

if (process.env['LOCALFLOW_USER_DATA']) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'])
}

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'localflow',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const sessionsFile = join(userData, 'sessions.json')

  const endpoint = await startHookServer((e) => manager.applyHookEvent(e))
  if (process.env['LOCALFLOW_E2E'] === '1') {
    writeFileSync(
      join(userData, 'endpoint.json'),
      JSON.stringify({ port: endpoint.port, token: endpoint.token })
    )
  }

  const manager = new SessionManager({
    settingsDir: userData,
    port: endpoint.port,
    token: endpoint.token,
    claudeBin: process.env['LOCALFLOW_CLAUDE_BIN'] ?? 'claude'
  })

  manager.onData((id, data) => win?.webContents.send('session:data', id, data))
  manager.onStatus((id, status) => win?.webContents.send('session:status', id, status))
  manager.onSessionsChanged(() =>
    saveSessions(
      sessionsFile,
      manager.list().map(({ id, cwd }) => ({ id, cwd }))
    )
  )

  for (const saved of loadSavedSessions(sessionsFile)) {
    manager.restore(saved.id, saved.cwd)
  }

  ipcMain.handle('session:create', async (_e, cwd?: string) => {
    let dir = cwd
    if (!dir) {
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose a project folder for the new Claude session'
      })
      if (result.canceled || result.filePaths.length === 0) return null
      dir = result.filePaths[0]
    }
    return manager.create(dir)
  })
  ipcMain.handle('session:restart', (_e, id: string) => manager.restart(id))
  ipcMain.handle('session:kill', (_e, id: string) => manager.kill(id))
  ipcMain.handle('session:list', () => manager.list())
  ipcMain.on('session:write', (_e, id: string, data: string) => manager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows)
  )

  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
```

- [ ] **Step 7: Verify**

Run: `npm run check` — Expected: all pass.
Run: `npm run dev`, then quit — Expected: window still opens without console errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire sessions over typed ipc bridge"
```

---

### Task 8: Renderer UI — grid, terminal panes, status colors, enlarge

**Files:**
- Create: `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/styles.css`
- Modify: `src/renderer/src/App.tsx` (full rewrite below), `src/renderer/src/main.tsx` (add css import)
- Create: `tests/fixtures/fake-claude.sh`

**Interfaces:**
- Consumes: `window.localflow` (`LocalflowApi` from Task 7), `SessionInfo`, `SessionStatus`.
- Produces: pane DOM contract used by the e2e test — each pane root has `class="pane"`, `data-pane-id="<id>"`, `data-status="<status>"`; the new-session button has `class="new-session"`.

- [ ] **Step 1: Create the test fixture**

`tests/fixtures/fake-claude.sh`:
```sh
#!/bin/sh
# Stands in for the claude CLI in dev/e2e. Prints its args and stays alive.
echo "fake-claude started in $PWD with args: $@"
sleep 600
```
Run: `chmod +x tests/fixtures/fake-claude.sh`

- [ ] **Step 2: Styles**

`src/renderer/src/styles.css`:
```css
:root {
  --working: #3b82f6;
  --needs-you: #eab308;
  --idle: #22c55e;
  --exited: #6b7280;
  --bg: #111318;
  --pane-bg: #1a1b1e;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: #e5e7eb; font-family: system-ui, sans-serif; }
#root { height: 100vh; display: flex; flex-direction: column; }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.toolbar h1 { font-size: 14px; margin: 0; flex: 1; font-weight: 600; }
.new-session { background: #2563eb; color: white; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.grid { flex: 1; display: grid; gap: 10px; padding: 0 12px 12px; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); grid-auto-rows: minmax(300px, 1fr); overflow: auto; }
.pane { display: flex; flex-direction: column; border: 2px solid var(--exited); border-radius: 8px; background: var(--pane-bg); overflow: hidden; min-height: 0; }
.pane[data-status='working'] { border-color: var(--working); }
.pane[data-status='needs-you'] { border-color: var(--needs-you); }
.pane[data-status='idle'] { border-color: var(--idle); }
.pane[data-status='exited'] { border-color: var(--exited); opacity: 0.75; }
.pane.enlarged { position: fixed; inset: 12px; z-index: 10; opacity: 1; }
.pane-header { display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; user-select: none; background: rgba(255, 255, 255, 0.04); }
.pane-header .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--exited); }
.pane[data-status='working'] .dot { background: var(--working); }
.pane[data-status='needs-you'] .dot { background: var(--needs-you); }
.pane[data-status='idle'] .dot { background: var(--idle); }
.pane-header .cwd { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-header button { background: none; border: 0; color: #9ca3af; cursor: pointer; font-size: 12px; }
.pane-header button:hover { color: white; }
.term-host { flex: 1; min-height: 0; padding: 4px; }
.restart-overlay { display: flex; flex: 1; align-items: center; justify-content: center; }
.restart-overlay button { background: #374151; color: white; border: 0; border-radius: 6px; padding: 8px 16px; cursor: pointer; }
```

- [ ] **Step 3: TerminalPane component**

`src/renderer/src/components/TerminalPane.tsx`:
```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionInfo } from '../../../shared/types'

interface Props {
  session: SessionInfo
  enlarged: boolean
  onToggleEnlarge: () => void
  onRestart: () => void
  onClose: () => void
}

export default function TerminalPane({
  session,
  enlarged,
  onToggleEnlarge,
  onRestart,
  onClose
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const alive = session.status !== 'exited'

  useEffect(() => {
    if (!alive || !hostRef.current) return
    const term = new Terminal({ fontSize: 12, theme: { background: '#1a1b1e' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    window.localflow.resize(session.id, term.cols, term.rows)
    const offData = window.localflow.onData((id, data) => {
      if (id === session.id) term.write(data)
    })
    const onInput = term.onData((d) => window.localflow.write(session.id, d))
    const ro = new ResizeObserver(() => {
      fit.fit()
      window.localflow.resize(session.id, term.cols, term.rows)
    })
    ro.observe(hostRef.current)
    return () => {
      offData()
      onInput.dispose()
      ro.disconnect()
      term.dispose()
    }
  }, [session.id, alive])

  const name = session.cwd.split('/').filter(Boolean).pop() ?? session.cwd
  return (
    <div
      className={`pane${enlarged ? ' enlarged' : ''}`}
      data-pane-id={session.id}
      data-status={session.status}
    >
      <div className="pane-header" onDoubleClick={onToggleEnlarge}>
        <span className="dot" />
        <span className="cwd" title={session.cwd}>
          {name}
        </span>
        <button onClick={onToggleEnlarge}>{enlarged ? 'shrink' : 'enlarge'}</button>
        <button onClick={onClose}>close</button>
      </div>
      {alive ? (
        <div className="term-host" ref={hostRef} />
      ) : (
        <div className="restart-overlay">
          <button onClick={onRestart}>Restart (resume) session</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: App shell**

`src/renderer/src/App.tsx` (full replacement):
```tsx
import { useCallback, useEffect, useState } from 'react'
import TerminalPane from './components/TerminalPane'
import type { SessionInfo } from '../../shared/types'

export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [enlarged, setEnlarged] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setSessions(await window.localflow.listSessions())
  }, [])

  useEffect(() => {
    void refresh()
    const offStatus = window.localflow.onStatus((id, status) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEnlarged(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offStatus()
      window.removeEventListener('keydown', onKey)
    }
  }, [refresh])

  const createSession = async (): Promise<void> => {
    const created = await window.localflow.createSession()
    if (created) await refresh()
  }
  const restart = async (id: string): Promise<void> => {
    await window.localflow.restartSession(id)
    await refresh()
  }
  const close = async (id: string): Promise<void> => {
    await window.localflow.killSession(id)
    setEnlarged((cur) => (cur === id ? null : cur))
    await refresh()
  }

  return (
    <>
      <div className="toolbar">
        <h1>localflow</h1>
        <button className="new-session" onClick={() => void createSession()}>
          + New session
        </button>
      </div>
      <div className="grid">
        {sessions.map((s) => (
          <TerminalPane
            key={s.id}
            session={s}
            enlarged={enlarged === s.id}
            onToggleEnlarge={() => setEnlarged((cur) => (cur === s.id ? null : s.id))}
            onRestart={() => void restart(s.id)}
            onClose={() => void close(s.id)}
          />
        ))}
      </div>
    </>
  )
}
```

Add to the top of `src/renderer/src/main.tsx`: `import './styles.css'`

- [ ] **Step 5: Manual verification with the fixture**

Run: `LOCALFLOW_CLAUDE_BIN="$PWD/tests/fixtures/fake-claude.sh" npm run dev`
Expected: click "+ New session", pick a folder → a pane appears with green (idle) border showing the fake-claude output; typing echoes into the pty; double-click header enlarges; Escape shrinks; close removes the pane. Then verify the real thing: `npm run dev` (no env var), create a session in a real project → actual Claude Code runs in the pane; submit a prompt → border turns blue, then yellow on a permission ask, green when the turn ends.

- [ ] **Step 6: Checks and commit**

Run: `npm run check` — Expected: pass.

```bash
git add -A
git commit -m "feat: terminal pane grid with status colors"
```

---

### Task 9: E2E smoke test (Playwright + Electron)

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: DOM contract from Task 8 (`.pane`, `data-pane-id`, `data-status`, `.new-session`), env behavior from Task 7 (`LOCALFLOW_E2E`, `LOCALFLOW_USER_DATA`, `LOCALFLOW_CLAUDE_BIN`, `endpoint.json`).

- [ ] **Step 1: Playwright config**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  use: { trace: 'retain-on-failure' }
})
```

- [ ] **Step 2: Write the smoke test**

`tests/e2e/smoke.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('panes render and hook events change status colors', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'localflow-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      LOCALFLOW_E2E: '1',
      LOCALFLOW_USER_DATA: userData,
      LOCALFLOW_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh')
    }
  })
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const info = await win.evaluate(
    (cwd) => (window as unknown as { localflow: { createSession(c: string): Promise<{ id: string }> } }).localflow.createSession(cwd),
    userData
  )
  const pane = win.locator(`[data-pane-id="${info!.id}"]`)
  await expect(pane).toBeVisible()
  await expect(pane).toHaveAttribute('data-status', 'idle')

  const { port, token } = JSON.parse(readFileSync(join(userData, 'endpoint.json'), 'utf8'))
  const post = (event: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Localflow-Token': token },
      body: JSON.stringify({ paneId: info!.id, event })
    })

  await post('UserPromptSubmit')
  await expect(pane).toHaveAttribute('data-status', 'working')
  await post('Notification')
  await expect(pane).toHaveAttribute('data-status', 'needs-you')
  await post('Stop')
  await expect(pane).toHaveAttribute('data-status', 'idle')

  await app.close()
})
```

Note: `createSession(cwd)` bypasses the folder-picker dialog because a `cwd` argument is provided (Task 7 behavior) — nothing blocks on a native dialog in CI.

Gotcha: `App.tsx` refreshes its session list only after `createSession()` resolves *from the button click*. Because the e2e calls `window.localflow.createSession` directly, the pane appears only if the renderer re-lists. Fix as part of this task: in `App.tsx`'s `useEffect`, also poll once per second:
```tsx
const iv = setInterval(() => void refresh(), 1000)
```
and add `clearInterval(iv)` to the cleanup. This also keeps the UI honest if main-process state changes for any other reason.

- [ ] **Step 3: Run it**

Run: `npm run e2e`
Expected: 1 passed. If the pane never appears, check the interval refresh was added; if status never changes, check `endpoint.json` exists in the temp userData dir.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: e2e smoke for panes and statuses"
```

---

### Task 10: CI workflows — checks, CodeQL, Dependabot

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`, `.github/workflows/codeql.yml`, `.github/dependabot.yml`, `.github/pull_request_template.md`

**Interfaces:**
- Consumes: npm scripts from Task 1 (`lint`, `typecheck`, `test`, `e2e`, `package`), commitlint config from Task 2.

- [ ] **Step 1: Main CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  commitlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: wagoid/commitlint-github-action@v6

  pr-title:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck

  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm test

  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run package
```

- [ ] **Step 2: Path-filtered e2e workflow**

`.github/workflows/e2e.yml`:
```yaml
name: e2e
on:
  pull_request:
    paths: ['src/**', 'tests/**', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'playwright.config.ts']
  push:
    branches: [main]
    paths: ['src/**', 'tests/**', 'package.json', 'package-lock.json', 'electron.vite.config.ts', 'playwright.config.ts']

jobs:
  e2e:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-traces, path: test-results/ }
```

- [ ] **Step 3: CodeQL + Dependabot + PR template**

`.github/workflows/codeql.yml`:
```yaml
name: codeql
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  schedule: [{ cron: '30 5 * * 1' }]

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with: { languages: javascript-typescript }
      - uses: github/codeql-action/analyze@v3
```

`.github/dependabot.yml`:
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

`.github/pull_request_template.md`:
```markdown
## What & why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] Commits follow Conventional Commits (subject ≤ 50 chars)
- [ ] `npm run check` passes locally
- [ ] New behavior is covered by tests
```

- [ ] **Step 4: Commit and verify on GitHub**

```bash
git add -A
git commit -m "ci: add checks, codeql, dependabot"
git push
```
Expected: on GitHub, the `ci` and `codeql` workflows run on main and pass (e2e runs too since `src/**` changed recently). Fix any red job before proceeding.

---

### Task 11: Release automation — release-please + electron-builder

**Files:**
- Create: `.github/workflows/release-please.yml`, `.github/workflows/release.yml`, `electron-builder.yml`

**Interfaces:**
- Consumes: `npm run dist` (Task 1), conventional commit history.
- Produces: an automated release PR; on merge, a GitHub Release with unsigned macOS `.dmg` and `.zip` artifacts.

- [ ] **Step 1: electron-builder config**

`electron-builder.yml`:
```yaml
appId: dev.hrrobinson.localflow
productName: localflow
directories:
  output: dist
files:
  - out/**
mac:
  target:
    - dmg
    - zip
  identity: null
```
(`identity: null` = explicitly unsigned for v1, per spec.)

- [ ] **Step 2: release-please workflow**

`.github/workflows/release-please.yml`:
```yaml
name: release-please
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          release-type: node
```

- [ ] **Step 3: Release build workflow**

`.github/workflows/release.yml`:
```yaml
name: release
on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  mac-artifacts:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run dist
      - run: gh release upload "$TAG" dist/*.dmg dist/*.zip --clobber
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ github.event.release.tag_name }}
```

- [ ] **Step 4: Verify packaging locally, then commit**

Run: `npm run package`
Expected: `dist/mac-arm64/localflow.app` exists and launches (`open dist/mac-arm64/localflow.app`).

```bash
git add -A
git commit -m "ci: automate releases with release-please"
git push
```
Expected: release-please opens a "chore(main): release 0.1.0"-style PR on GitHub. Don't merge it yet — finish Task 12 first so the first release includes docs.

---

### Task 12: Docs — README, CONTRIBUTING

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`

**Interfaces:**
- Consumes: everything above (documents it).

- [ ] **Step 1: Write README.md**

Sections (write real prose, not placeholders):
- **localflow** — one-paragraph pitch: mission control for Claude Code sessions; grid of real terminals; glanceable status colors (blue working / yellow needs you / green done / gray exited).
- **How it works** — 3 bullets: real `claude` CLI in PTYs; status via Claude Code's own hooks POSTing to a localhost listener (random port, secret token, 127.0.0.1 only); no telemetry.
- **Install** — download the `.dmg` from Releases (unsigned for now: right-click → Open on first launch), or build from source: `git clone`, `npm install`, `npm run dev`. Requires Node ≥ 20 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed.
- **Usage** — + New session → pick folder; double-click header to enlarge, Escape to shrink; Restart resumes a dead session with `claude --continue`.
- **Development** — `npm run dev`, `npm run check`, `npm run e2e` (uses a fake claude fixture; no API access needed).
- **Contributing** — link to CONTRIBUTING.md.
- **License** — MIT.

- [ ] **Step 2: Write CONTRIBUTING.md**

```markdown
# Contributing to localflow

Thanks for wanting to help! A few hard rules keep this repo pleasant.

## Commits

- **Conventional Commits are enforced by CI** (commitlint): `feat:`, `fix:`, `docs:`,
  `chore:`, `test:`, `ci:`, `refactor:` — subject line **max 50 characters**,
  imperative mood, explain the *why* in the body if needed.
- Releases and the CHANGELOG are generated from commit types by release-please,
  so mislabelled commits produce wrong changelogs — please take the prefix seriously.
- Using Claude Code or another AI agent? Install
  [caveman](https://github.com/juliusbrussee/caveman) and use `/caveman-commit`
  to get compliant messages for free. Any tool (or none) is fine — only the
  format is enforced.

## Pull requests

- Keep PRs small and focused — one concern per PR.
- `npm run check` (lint + typecheck + unit tests) must pass locally and in CI.
- New behavior needs a test. Bug fixes need a test that fails without the fix.
- PR titles must also be Conventional Commit formatted (squash merges use them).

## Dev setup

Node ≥ 20. `npm install`, then `npm run dev`. To run the app without a real
Claude session: `LOCALFLOW_CLAUDE_BIN="$PWD/tests/fixtures/fake-claude.sh" npm run dev`.
```

- [ ] **Step 3: Commit and push**

```bash
git add -A
git commit -m "docs: add readme and contributing guide"
git push
```
Expected: repo front page on GitHub renders the README. Now the release-please PR from Task 11 can be merged when the user wants the first release.

---

## Self-Review Notes

- Spec coverage: grid+enlarge+colors (T8), hooks/status (T4/T5/T6), folder picker + restart/resume (T7/T8), persistence/relaunch (T7), claude-missing error (T6), Electron hardening (T1/T7), unit+e2e tests (T3–T6, T9), commitlint hard CI (T2/T10), 7 CI checks + Dependabot (T10), release-please + mac artifacts (T11), README/CONTRIBUTING/PR template (T10/T12). No gaps found.
- Type consistency: `SessionStatus`/`SessionInfo`/`HookEvent` defined once in T3 and imported everywhere; DOM contract (`data-pane-id`, `data-status`, `.new-session`) defined in T8 and consumed in T9; env var names identical across T7/T8/T9.
- Known judgment call: `sandbox: false` is required because the preload uses ESM imports bundled to CJS with `contextBridge`; context isolation still holds. Documented in T1.
