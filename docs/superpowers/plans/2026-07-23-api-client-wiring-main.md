# API Client Wiring — Main Process & IPC Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged API-client engine reachable — construct it, expose curation and grant over IPC, and bind the grant to a pane's life so the engine spec's session-scoped claim becomes true.

**Architecture:** Nine already-built modules in `src/main/api-client/` are constructed in `index.ts` and dropped into the existing `ControlDeps.apiClient` slot. Two new pure modules (`collection-validate`, `grant-binding`) hold the logic that would otherwise be untestable inside `ipcMain.handle` callbacks. The grant token is delivered as per-pane environment variables and revoked when that pane exits.

**Tech Stack:** TypeScript, Electron main + preload, Vitest (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-23-api-client-wiring-design.md`

## Scope of this plan

Spec layers 1–3, **plus the `shared/api.ts` + `preload` bridge**, which is pulled forward so this plan is independently testable: e2e can drive `window.saiife.*` directly with no UI.

**Deferred to the renderer plan:** `ApiClient.tsx`, the nav destination, the Cockpit API section, the sidebar indicator, and `openclaw/skills/saiife-api/`.

At the end of this plan the feature works end-to-end for an agent driven with `curl`; it just has no human UI yet.

## Global Constraints

- **Commit subject max 50 characters** — commitlint via husky. Conventional Commits.
- Prettier (`.prettierrc.json`): `semi: false`, `singleQuote: true`, `printWidth: 100`, **`trailingComma: "none"`**. No line over 100 **characters** (counted as characters, not bytes — Prettier does not reflow string or regex literals, so check separately with `awk`).
- **`@typescript-eslint/no-explicit-any` is an ERROR**, in `tests/` as well as `src/`.
- **`noUnusedLocals: true`** — an unused import fails `typecheck`, not just lint.
- Vitest has **no globals**: every unit test must `import { describe, it, expect } from 'vitest'`.
- ESLint `preserve-caught-error`: re-throwing inside a `catch` must pass `{ cause: err }`.
- Unit tests live in `tests/unit/*.test.ts`; e2e in `tests/e2e/*.spec.ts`.
- Run one unit file: `npx vitest run tests/unit/<file>.test.ts`. Full gate: `npm run check`. E2E: `npm run e2e` (builds first — slow, expect minutes).
- **No secret or token may cross IPC outbound.** Every handler returns `{ ok, reason }` shapes carrying presence booleans only.
- Main-process imports use `./x`; shared uses `../shared/x`. Type-only imports use `import type` or inline `type X`.

---

### Task 1: Shared view types and collection validation

The pure validation that `apiClient:upsertCollection` will be a thin wrapper over. Includes the varSet-secret refusal, which is the safety property this surface exists to enforce.

**Files:**
- Modify: `src/shared/api-client.ts` (append view + result types)
- Create: `src/main/api-client/collection-validate.ts`
- Test: `tests/unit/collection-validate.test.ts`

**Interfaces:**
- Consumes: `Collection`, `CollectionRequest`, `CollectionAuth` from `src/shared/api-client.ts`; `normalizeOrigin` from `src/main/api-client/origins.ts`; `looksLikeSecretLiteral` from `src/main/http/http-node-config.ts`
- Produces: types `CollectionView`, `UpsertCollectionResult`, `RemoveCollectionResult`, `SetCollectionSecretResult`, `ClearCollectionSecretResult`, `ApiGrantResult`, `ApiGrantStatus`; `validateCollection(raw: unknown, environment: number, id: string): { ok: true; collection: Collection } | { ok: false; reason: string }`; `toCollectionView(c: Collection, hasSecret: boolean): CollectionView`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/collection-validate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { validateCollection, toCollectionView } from '../../src/main/api-client/collection-validate'
import type { Collection } from '../../src/shared/api-client'

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Stripe',
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }],
    ...over
  }
}

describe('validateCollection', () => {
  it('accepts a well-formed collection and stamps id + environment', () => {
    const res = validateCollection(raw(), 2, 'col-1')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.id).toBe('col-1')
    expect(res.collection.environment).toBe(2)
    expect(res.collection.name).toBe('Stripe')
  })

  it('normalises origins and strips path/query', () => {
    const res = validateCollection(raw({ origins: ['https://api.stripe.com/v1?a=1'] }), 1, 'c')
    if (!res.ok) throw new Error(res.reason)
    expect(res.collection.origins).toEqual(['https://api.stripe.com'])
  })

  it('rejects an unusable origin, naming the expected form', () => {
    const res = validateCollection(raw({ origins: ['not a url'] }), 1, 'c')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/scheme:\/\/host/)
  })

  it('rejects a non-http(s) origin', () => {
    expect(validateCollection(raw({ origins: ['file:///etc/passwd'] }), 1, 'c').ok).toBe(false)
  })

  it('requires at least one origin', () => {
    expect(validateCollection(raw({ origins: [] }), 1, 'c').ok).toBe(false)
  })

  it('requires a non-empty name', () => {
    expect(validateCollection(raw({ name: '   ' }), 1, 'c').ok).toBe(false)
  })

  it('rejects an unknown auth scheme', () => {
    expect(validateCollection(raw({ auth: { scheme: 'magic' } }), 1, 'c').ok).toBe(false)
  })

  it('requires a secretRef for every scheme except none', () => {
    expect(validateCollection(raw({ auth: { scheme: 'bearer' } }), 1, 'c').ok).toBe(false)
    expect(validateCollection(raw({ auth: { scheme: 'none' } }), 1, 'c').ok).toBe(true)
  })

  it('requires a header name for the header scheme', () => {
    const bad = raw({ auth: { scheme: 'header', secretRef: 'k' } })
    expect(validateCollection(bad, 1, 'c').ok).toBe(false)
    const good = raw({ auth: { scheme: 'header', secretRef: 'k', header: 'X-API-Key' } })
    expect(validateCollection(good, 1, 'c').ok).toBe(true)
  })

  it('REFUSES a secret-shaped varSet value and names secretRef', () => {
    // varSets live in plaintext on disk; a credential belongs in the keychain.
    const bad = raw({ varSets: { test: { key: 'sk_live_abc123' } } })
    const res = validateCollection(bad, 1, 'c')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toMatch(/secretRef/)
      expect(res.reason).toMatch(/test/)
      expect(res.reason).toMatch(/key/)
    }
  })

  it('refuses a Bearer-prefixed varSet value too', () => {
    expect(validateCollection(raw({ varSets: { d: { a: 'Bearer xyz' } } }), 1, 'c').ok).toBe(false)
  })

  it('allows ordinary varSet values', () => {
    const ok = raw({ varSets: { test: { base_url: 'https://api.stripe.com', acct: 'acct_1' } } })
    expect(validateCollection(ok, 1, 'c').ok).toBe(true)
  })

  it('rejects a request with an unpinned method', () => {
    const bad = raw({ requests: [{ id: 'r', name: 'r', method: 'TRACE', path: '/x' }] })
    expect(validateCollection(bad, 1, 'c').ok).toBe(false)
  })

  it('rejects a malformed payload outright', () => {
    expect(validateCollection(null, 1, 'c').ok).toBe(false)
    expect(validateCollection('nope', 1, 'c').ok).toBe(false)
    expect(validateCollection(raw({ varSets: 'nope' }), 1, 'c').ok).toBe(false)
    expect(validateCollection(raw({ requests: 'nope' }), 1, 'c').ok).toBe(false)
  })
})

describe('toCollectionView', () => {
  it('carries presence only, never a secret value', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Stripe',
      environment: 1,
      origins: ['https://api.stripe.com'],
      auth: { scheme: 'bearer', secretRef: 'apiKey' },
      varSets: {},
      requests: []
    }
    const view = toCollectionView(collection, true)
    expect(view.hasSecret).toBe(true)
    expect(JSON.stringify(view)).not.toContain('sk_')
    expect(Object.keys(view)).not.toContain('secret')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/collection-validate.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/collection-validate`

- [ ] **Step 3: Write minimal implementation**

Append to `src/shared/api-client.ts`:

```typescript
// ── Renderer-facing views and IPC results ───────────────────────────────────
// A view NEVER carries secret material: like `IntegrationFieldView`, the
// credential is presence-only. The grant token is likewise never returned.

/** A collection as the renderer sees it. `hasSecret` replaces the value. */
export interface CollectionView {
  id: string
  name: string
  environment: number
  origins: string[]
  auth: CollectionAuth
  /** Presence of the credential named by `auth.secretRef`. Never the value. */
  hasSecret: boolean
  varSets: Record<string, Record<string, string>>
  requests: CollectionRequest[]
}

export type UpsertCollectionResult =
  | { ok: true; view: CollectionView }
  | { ok: false; reason: string }

export type RemoveCollectionResult = { ok: true } | { ok: false; reason: string }

/** Presence only — the value is inbound-only, exactly like `SetSecretResult`. */
export type SetCollectionSecretResult = { ok: true; hasSecret: true } | { ok: false; reason: string }

export type ClearCollectionSecretResult = { ok: true } | { ok: false; reason: string }

/** Grant result. Carries the endpoint and holding pane — NEVER the token. */
export type ApiGrantResult =
  | { ok: true; endpoint: string; paneId: string }
  | { ok: false; reason: string }

/** Grant state for one environment. Presence, holder and scope; no material. */
export interface ApiGrantStatus {
  environment: number
  granted: boolean
  paneId?: string
  collectionIds?: string[]
}
```

Create `src/main/api-client/collection-validate.ts`:

```typescript
import type { Collection, CollectionAuth, CollectionRequest, CollectionView } from '../../shared/api-client'
import { HTTP_METHODS } from '../../shared/api-client'
import { looksLikeSecretLiteral } from '../http/http-node-config'
import { normalizeOrigin } from './origins'

/**
 * PURE validation for `apiClient:upsertCollection`, extracted so it is testable
 * without an Electron IPC harness — the same reason `control-api.ts` is pure
 * over its inputs. The handler is a thin wrapper.
 *
 * The load-bearing rule is the varSet check. varSet values are persisted to
 * `api-collections.json` in PLAINTEXT, while credentials belong in the keychain
 * under `auth.secretRef`. Typing an API key into a varSet is an easy mistake —
 * both are "things you type into a collection" — so a secret-shaped value is
 * REFUSED here, before anything reaches disk. This reuses the same shared
 * prefix table `looksLikeSecretLiteral` applies on the request side.
 */

const AUTH_SCHEMES = ['bearer', 'basic', 'header', 'none'] as const

export type ValidateResult = { ok: true; collection: Collection } | { ok: false; reason: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const fail = (reason: string): ValidateResult => ({ ok: false, reason })

function validateAuth(raw: unknown): { ok: true; auth: CollectionAuth } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: 'auth must be an object' }
  const scheme = raw.scheme
  if (typeof scheme !== 'string' || !(AUTH_SCHEMES as readonly string[]).includes(scheme)) {
    return { ok: false, reason: `auth.scheme must be one of ${AUTH_SCHEMES.join('/')}` }
  }
  if (scheme === 'none') return { ok: true, auth: { scheme: 'none' } }

  const secretRef = raw.secretRef
  if (typeof secretRef !== 'string' || secretRef.trim().length === 0) {
    return { ok: false, reason: `auth.secretRef is required for the "${scheme}" scheme` }
  }
  if (scheme === 'header') {
    const header = raw.header
    if (typeof header !== 'string' || header.trim().length === 0) {
      return { ok: false, reason: 'auth.header is required for the "header" scheme, e.g. X-API-Key' }
    }
    return { ok: true, auth: { scheme: 'header', header: header.trim(), secretRef: secretRef.trim() } }
  }
  return { ok: true, auth: { scheme: scheme as 'bearer' | 'basic', secretRef: secretRef.trim() } }
}

function validateVarSets(
  raw: unknown
): { ok: true; varSets: Record<string, Record<string, string>> } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, varSets: {} }
  if (!isObject(raw)) return { ok: false, reason: 'varSets must be an object of named variable sets' }

  const out: Record<string, Record<string, string>> = {}
  for (const [setName, set] of Object.entries(raw)) {
    if (!isObject(set)) return { ok: false, reason: `varSet "${setName}" must be an object` }
    const vars: Record<string, string> = {}
    for (const [key, value] of Object.entries(set)) {
      if (typeof value !== 'string') {
        return { ok: false, reason: `varSet "${setName}" variable "${key}" must be a string` }
      }
      if (looksLikeSecretLiteral(value)) {
        return {
          ok: false,
          reason:
            `varSet "${setName}" variable "${key}" looks like a credential. varSets are ` +
            'stored in plain text — put the secret in the keychain via auth.secretRef instead.'
        }
      }
      vars[key] = value
    }
    out[setName] = vars
  }
  return { ok: true, varSets: out }
}

function validateRequests(
  raw: unknown
): { ok: true; requests: CollectionRequest[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, requests: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'requests must be an array' }

  const out: CollectionRequest[] = []
  for (const entry of raw) {
    if (!isObject(entry)) return { ok: false, reason: 'each request must be an object' }
    const { id, name, method, path } = entry
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { ok: false, reason: 'each request needs a non-empty id' }
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, reason: `request "${id}" needs a non-empty name` }
    }
    if (typeof method !== 'string' || !(HTTP_METHODS as readonly string[]).includes(method)) {
      return { ok: false, reason: `request "${id}" method must be one of ${HTTP_METHODS.join('/')}` }
    }
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { ok: false, reason: `request "${id}" needs a non-empty path` }
    }
    out.push({ id: id.trim(), name: name.trim(), method: method as CollectionRequest['method'], path: path.trim() })
  }
  return { ok: true, requests: out }
}

/**
 * Validate a renderer-supplied collection payload. `id` and `environment` are
 * supplied by the CALLER, never trusted from the payload: the id is minted
 * main-side on create and carried through on update, and the environment comes
 * from the clamped IPC argument.
 */
export function validateCollection(raw: unknown, environment: number, id: string): ValidateResult {
  if (!isObject(raw)) return fail('collection must be an object')

  const name = raw.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return fail('collection needs a non-empty name')
  }

  if (!Array.isArray(raw.origins) || raw.origins.length === 0) {
    return fail('collection needs at least one origin (scheme://host[:port])')
  }
  const origins: string[] = []
  for (const entry of raw.origins) {
    if (typeof entry !== 'string') return fail('each origin must be a string')
    const normalized = normalizeOrigin(entry)
    if (normalized === null) {
      return fail(`"${entry}" is not a usable origin — expected scheme://host[:port] over http(s)`)
    }
    origins.push(normalized)
  }

  const auth = validateAuth(raw.auth)
  if (!auth.ok) return fail(auth.reason)

  const varSets = validateVarSets(raw.varSets)
  if (!varSets.ok) return fail(varSets.reason)

  const requests = validateRequests(raw.requests)
  if (!requests.ok) return fail(requests.reason)

  return {
    ok: true,
    collection: {
      id,
      name: name.trim(),
      environment,
      origins,
      auth: auth.auth,
      varSets: varSets.varSets,
      requests: requests.requests
    }
  }
}

/** Project a stored collection into its renderer view — presence, never value. */
export function toCollectionView(collection: Collection, hasSecret: boolean): CollectionView {
  return {
    id: collection.id,
    name: collection.name,
    environment: collection.environment,
    origins: collection.origins,
    auth: collection.auth,
    hasSecret,
    varSets: collection.varSets,
    requests: collection.requests
  }
}
```

`HTTP_METHODS` does not exist yet — add it to `src/shared/api-client.ts` above the view types, so validation and the renderer share one list:

```typescript
/** The pinned methods a collection request may use — mirrors `HttpMethod`. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/collection-validate.test.ts`
Expected: PASS — 16 tests

- [ ] **Step 5: Commit**

```bash
git add src/shared/api-client.ts src/main/api-client/collection-validate.ts tests/unit/collection-validate.test.ts
git commit -m "feat(api-client): validate collection upserts"
```

---

### Task 2: Grant binding

Environment → the pane holding the grant, plus the collection set it was minted with (needed to re-mint on restart).

**Files:**
- Create: `src/main/api-client/grant-binding.ts`
- Test: `tests/unit/api-grant-binding.test.ts`

**Interfaces:**
- Produces: `interface ApiGrantBindingRecord { paneId: string; collectionIds: string[] }`; `class ApiGrantBinding` with `bind(environment: number, paneId: string, collectionIds: string[]): void`, `unbind(environment: number): void`, `get(environment: number): ApiGrantBindingRecord | undefined`, `environmentForPane(paneId: string): number | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-grant-binding.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ApiGrantBinding } from '../../src/main/api-client/grant-binding'

describe('ApiGrantBinding', () => {
  it('binds an environment to a pane and its collection set', () => {
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    expect(b.get(1)).toEqual({ paneId: 'pane-a', collectionIds: ['stripe'] })
  })

  it('resolves the environment a pane holds the grant for', () => {
    const b = new ApiGrantBinding()
    b.bind(3, 'pane-a', ['stripe'])
    expect(b.environmentForPane('pane-a')).toBe(3)
    expect(b.environmentForPane('pane-b')).toBeNull()
  })

  it('unbinds', () => {
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    b.unbind(1)
    expect(b.get(1)).toBeUndefined()
    expect(b.environmentForPane('pane-a')).toBeNull()
  })

  it('moving the grant to a second pane releases the first', () => {
    // ApiGrantStore mints one token per environment, so a second grant MOVES it.
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    b.bind(1, 'pane-b', ['stripe', 'internal'])
    expect(b.environmentForPane('pane-a')).toBeNull()
    expect(b.environmentForPane('pane-b')).toBe(1)
    expect(b.get(1)?.collectionIds).toEqual(['stripe', 'internal'])
  })

  it('keeps environments independent', () => {
    const b = new ApiGrantBinding()
    b.bind(1, 'pane-a', ['stripe'])
    b.bind(2, 'pane-b', ['other'])
    b.unbind(1)
    expect(b.environmentForPane('pane-b')).toBe(2)
    expect(b.get(2)?.collectionIds).toEqual(['other'])
  })

  it('copies the collection set so a caller cannot mutate it afterwards', () => {
    const b = new ApiGrantBinding()
    const ids = ['stripe']
    b.bind(1, 'pane-a', ids)
    ids.push('smuggled')
    expect(b.get(1)?.collectionIds).toEqual(['stripe'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-grant-binding.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/grant-binding`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/grant-binding.ts`:

```typescript
/**
 * Which pane holds the API grant for each environment, and the collection set
 * it was minted with.
 *
 * `OperatorLaunchTracker` was considered and rejected: its semantics are
 * operator-specific (it tracks whether saiife LAUNCHED the pane, and carries a
 * `revokeOnExit` config flag). This answers a different, simpler question, so
 * bending that module would make one module serve two masters.
 *
 * The collection set is retained because restarting a pane must RE-MINT the
 * same scope — the binding always revokes on exit, so the restart handler
 * re-grants rather than the exit path guessing at intent.
 */

export interface ApiGrantBindingRecord {
  paneId: string
  collectionIds: string[]
}

export class ApiGrantBinding {
  private byEnv = new Map<number, ApiGrantBindingRecord>()

  /** Bind an environment's grant to a pane. Replaces any existing binding —
   *  `ApiGrantStore` mints one token per environment, so a second grant MOVES
   *  the capability rather than adding one. */
  bind(environment: number, paneId: string, collectionIds: string[]): void {
    this.byEnv.set(environment, { paneId, collectionIds: [...collectionIds] })
  }

  unbind(environment: number): void {
    this.byEnv.delete(environment)
  }

  get(environment: number): ApiGrantBindingRecord | undefined {
    return this.byEnv.get(environment)
  }

  /** The environment this pane holds the grant for, or null. */
  environmentForPane(paneId: string): number | null {
    for (const [environment, record] of this.byEnv) {
      if (record.paneId === paneId) return environment
    }
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-grant-binding.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/grant-binding.ts tests/unit/api-grant-binding.test.ts
git commit -m "feat(api-client): bind grants to a holding pane"
```

---

### Task 3: Construct the engine and expose curation over IPC

Wires the nine existing modules into `ControlDeps.apiClient` and adds the five curation handlers plus their bridge. After this task `/http/collections` returns real data.

**Files:**
- Modify: `src/main/index.ts` (imports; construction before line 931; `controlDeps` literal; five `ipcMain.handle` registrations)
- Modify: `src/shared/api.ts` (five `SaiifeApi` methods)
- Modify: `src/preload/index.ts` (five bridge methods)
- Test: `tests/e2e/api-client.spec.ts` (new)

**Interfaces:**
- Consumes: `validateCollection`, `toCollectionView` (Task 1)
- Produces: `window.saiife.listCollections(environment)`, `.upsertCollection(environment, collection)`, `.removeCollection(id)`, `.setCollectionSecret(collectionId, secretRef, value)`, `.clearCollectionSecret(collectionId, secretRef)`

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/api-client.spec.ts`. The launch harness is copied from `tests/e2e/operator.spec.ts` verbatim — it is the established shape:

```typescript
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Same launch shape as operator.spec.ts. */
function launchApp(userData: string): Promise<ElectronApplication> {
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ agentPaths: { codex: '/nonexistent/codex', gemini: '/nonexistent/gemini' } })
  )
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      SAIIFE_E2E: '1',
      SAIIFE_USER_DATA: userData,
      SAIIFE_CLAUDE_BIN: join(here, '../fixtures/fake-claude.sh'),
      SAIIFE_OPENCLAW_CONFIG: join(userData, 'openclaw.json'),
      SAIIFE_LAZYGIT_BIN: '/nonexistent/lazygit',
      SAIIFE_EDITOR_BIN: '/nonexistent/code',
      SAIIFE_E2E_GO: join(userData, 'e2e-go')
    }
  })
}

const COLLECTION = {
  name: 'Stripe',
  origins: ['https://api.stripe.com'],
  auth: { scheme: 'bearer', secretRef: 'apiKey' },
  varSets: { test: { base_url: 'https://api.stripe.com' } },
  requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }]
}

test('curates a collection and stores its credential', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiclient-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  // Create.
  const created = await win.evaluate(
    (c) => window.saiife.upsertCollection(1, c),
    COLLECTION
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.reason)
  const id = created.view.id
  expect(id.length).toBeGreaterThan(0)
  expect(created.view.hasSecret).toBe(false)
  expect(created.view.environment).toBe(1)

  // List is environment-scoped.
  expect(await win.evaluate(() => window.saiife.listCollections(1))).toHaveLength(1)
  expect(await win.evaluate(() => window.saiife.listCollections(2))).toHaveLength(0)

  // Secret is write-only: the result carries presence, never the value.
  const stored = await win.evaluate(
    (cid) => window.saiife.setCollectionSecret(cid, 'apiKey', 'sk_live_e2e_secret'),
    id
  )
  expect(stored).toEqual({ ok: true, hasSecret: true })
  const afterStore = await win.evaluate(() => window.saiife.listCollections(1))
  expect(afterStore[0].hasSecret).toBe(true)
  expect(JSON.stringify(afterStore)).not.toContain('sk_live_e2e_secret')

  // A secret-shaped varSet value is refused before it reaches disk.
  const refused = await win.evaluate(
    (c) => window.saiife.upsertCollection(1, { ...c, varSets: { test: { k: 'sk_live_leak' } } }),
    COLLECTION
  )
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.reason).toMatch(/secretRef/)

  // Clear, then remove.
  expect(await win.evaluate((cid) => window.saiife.clearCollectionSecret(cid, 'apiKey'), id)).toEqual({ ok: true })
  expect(await win.evaluate((cid) => window.saiife.removeCollection(cid), id)).toEqual({ ok: true })
  expect(await win.evaluate(() => window.saiife.listCollections(1))).toHaveLength(0)

  await app.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts`
Expected: FAIL — `window.saiife.upsertCollection is not a function`

- [ ] **Step 3: Write minimal implementation**

**(a)** Add imports to `src/main/index.ts`, beside the existing api-client-adjacent ones (after line 96):

```typescript
import { ApiGrantStore } from './api-client/api-grant'
import { ApiGrantBinding } from './api-client/grant-binding'
import { ApiSender } from './api-client/send'
import { CollectionSecretStore } from './api-client/collection-secrets'
import { CollectionStore } from './api-client/collection-store'
import { ResponseStore } from './api-client/response-store'
import { toCollectionView, validateCollection } from './api-client/collection-validate'
```

**(b)** Construct, immediately after `const watchpoints = new WatchpointRegistry()` (line 925) and before the `controlDeps` comment at 927:

```typescript
  // The agent API client (design 2026-07-23). Same split as everywhere else:
  // `.enc` sidecar behind safeStorage for keychain material, plain JSON for the
  // non-secret collection data. `apiGrantBinding` records which pane holds each
  // environment's grant so pty exit can revoke it.
  const apiCollections = new CollectionStore({ file: join(userData, 'api-collections.json') })
  const apiSecrets = new CollectionSecretStore({
    backend: safeStorage,
    file: join(userData, 'api-secrets.enc')
  })
  const apiResponses = new ResponseStore({})
  const apiSender = new ApiSender({
    collections: apiCollections,
    secrets: apiSecrets,
    client: new HttpClient({ transport: new FetchHttpTransport() }),
    responses: apiResponses
  })
  const apiGrants = new ApiGrantStore()
  const apiGrantBinding = new ApiGrantBinding()
```

**(c)** Add to the `controlDeps` literal, after `onGuardBlock` (line 948):

```typescript
    ,
    apiClient: {
      grants: apiGrants,
      sender: apiSender,
      collections: apiCollections,
      responses: apiResponses
    }
```

(Write it as a normal trailing property — `onGuardBlock: …,` then `apiClient: { … }` — Prettier's `trailingComma: "none"` means no comma after the final property.)

**(d)** Add the five handlers next to the `integrations:*` block (after line 1730):

```typescript
  // ── Agent API client curation ───────────────────────────────────────────────
  // The renderer never receives secret material: collection views carry
  // `hasSecret`, and `setCollectionSecret` echoes presence only.
  const collectionViewsFor = (environment: number): CollectionView[] =>
    apiCollections
      .list(environment)
      .map((c) =>
        toCollectionView(
          c,
          c.auth.secretRef !== undefined && apiSecrets.has(c.id, c.auth.secretRef)
        )
      )

  ipcMain.handle('apiClient:listCollections', (_e, environment: number): CollectionView[] =>
    collectionViewsFor(clampEnvironment(environment))
  )

  ipcMain.handle(
    'apiClient:upsertCollection',
    (_e, environment: number, raw: unknown): UpsertCollectionResult => {
      const env = clampEnvironment(environment)
      // The id is minted main-side on create and never trusted from the payload.
      // It is immutable because the keychain key is derived from it — deriving
      // it from the name would orphan every stored credential on rename.
      const existing =
        typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
          ? apiCollections.get((raw as { id: string }).id, env)
          : undefined
      const id = existing?.id ?? randomUUID()

      const validated = validateCollection(raw, env, id)
      if (!validated.ok) return { ok: false, reason: validated.reason }
      apiCollections.upsert(validated.collection)
      const secretRef = validated.collection.auth.secretRef
      return {
        ok: true,
        view: toCollectionView(
          validated.collection,
          secretRef !== undefined && apiSecrets.has(id, secretRef)
        )
      }
    }
  )

  ipcMain.handle('apiClient:removeCollection', (_e, id: string): RemoveCollectionResult => {
    if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'id must be a string' }
    // Refuse while a live grant covers it: the agent would otherwise start
    // getting `unknown collection` with no way to learn why.
    for (const [, record] of [...Array(9).keys()].map((i) => [i + 1, apiGrantBinding.get(i + 1)] as const)) {
      if (record?.collectionIds.includes(id)) {
        return { ok: false, reason: 'a live API grant covers this collection — revoke it first' }
      }
    }
    apiCollections.remove(id)
    return { ok: true }
  })

  ipcMain.handle(
    'apiClient:setCollectionSecret',
    (_e, collectionId: string, secretRef: string, value: string): SetCollectionSecretResult => {
      if (typeof collectionId !== 'string' || typeof secretRef !== 'string' || typeof value !== 'string') {
        return { ok: false, reason: 'collectionId, secretRef and value must be strings' }
      }
      if (value.length === 0) return { ok: false, reason: 'the credential cannot be empty' }
      try {
        apiSecrets.set(collectionId, secretRef, value)
      } catch (err) {
        return { ok: false, reason: (err as Error).message }
      }
      return { ok: true, hasSecret: true }
    }
  )

  ipcMain.handle(
    'apiClient:clearCollectionSecret',
    (_e, collectionId: string, secretRef?: string): ClearCollectionSecretResult => {
      if (typeof collectionId !== 'string') return { ok: false, reason: 'collectionId must be a string' }
      apiSecrets.clear(collectionId, typeof secretRef === 'string' ? secretRef : undefined)
      return { ok: true }
    }
  )
```

Add `randomUUID` to the `node:crypto` import at the top of `index.ts` (or add `import { randomUUID } from 'node:crypto'` if none exists), and add the type import:

```typescript
import type {
  ClearCollectionSecretResult,
  CollectionView,
  RemoveCollectionResult,
  SetCollectionSecretResult,
  UpsertCollectionResult
} from '../shared/api-client'
```

**(e)** Add to `SaiifeApi` in `src/shared/api.ts`, after the integrations block (line 255):

```typescript
  /**
   * Collections for one environment, as views: `hasSecret` presence booleans,
   * never a credential value.
   */
  listCollections(environment: number): Promise<CollectionView[]>
  /** Creates (no `id`) or updates (with `id`) a collection. Refuses a secret-shaped varSet value. */
  upsertCollection(environment: number, collection: unknown): Promise<UpsertCollectionResult>
  /** Removes a collection; refused while a live API grant covers it. */
  removeCollection(id: string): Promise<RemoveCollectionResult>
  /** Stores a collection credential in the keychain (value INBOUND only). */
  setCollectionSecret(
    collectionId: string,
    secretRef: string,
    value: string
  ): Promise<SetCollectionSecretResult>
  /** Clears one credential, or every credential for the collection when omitted. */
  clearCollectionSecret(
    collectionId: string,
    secretRef?: string
  ): Promise<ClearCollectionSecretResult>
```

and import the types at the top of `src/shared/api.ts`:

```typescript
import type {
  ClearCollectionSecretResult,
  CollectionView,
  RemoveCollectionResult,
  SetCollectionSecretResult,
  UpsertCollectionResult
} from './api-client'
```

**(f)** Add to `src/preload/index.ts`, after the integrations block (line 162):

```typescript
  listCollections: (environment: number) => ipcRenderer.invoke('apiClient:listCollections', environment),
  upsertCollection: (environment: number, collection: unknown) =>
    ipcRenderer.invoke('apiClient:upsertCollection', environment, collection),
  removeCollection: (id: string) => ipcRenderer.invoke('apiClient:removeCollection', id),
  setCollectionSecret: (collectionId: string, secretRef: string, value: string) =>
    ipcRenderer.invoke('apiClient:setCollectionSecret', collectionId, secretRef, value),
  clearCollectionSecret: (collectionId: string, secretRef?: string) =>
    ipcRenderer.invoke('apiClient:clearCollectionSecret', collectionId, secretRef),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts`
Expected: PASS — 1 test

Then `npm run check` to confirm lint, typecheck and the unit suite are still clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/shared/api.ts src/shared/api-client.ts src/preload/index.ts tests/e2e/api-client.spec.ts
git commit -m "feat(api-client): wire the engine and curation IPC"
```

---

### Task 4: Grant, revoke and status

Mints the grant, injects it into a pane's spec env, restarts the pane so the env lands, and exposes status.

**Files:**
- Modify: `src/main/index.ts` (a `grantApiAccess` helper + three handlers)
- Modify: `src/shared/api.ts`, `src/preload/index.ts` (three methods)
- Test: `tests/e2e/api-client.spec.ts` (append a test)

**Interfaces:**
- Consumes: `ApiGrantBinding` (Task 2), the stores constructed in Task 3
- Produces: `window.saiife.grantApiAccess(environment, paneId, collectionIds)`, `.revokeApiAccess(environment)`, `.apiGrantStatus(environment)`

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/api-client.spec.ts`:

```typescript
test('grants API access to a pane and the token reaches it', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apigrant-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate((c) => window.saiife.upsertCollection(1, c), COLLECTION)
  if (!created.ok) throw new Error(created.reason)
  const collectionId = created.view.id

  const session = await win.evaluate(() => window.saiife.createSession('claude'))
  if (!session) throw new Error('createSession returned null')
  const paneId = session.id

  expect(await win.evaluate(() => window.saiife.apiGrantStatus(1))).toMatchObject({ granted: false })

  const granted = await win.evaluate(
    ([pid, cid]) => window.saiife.grantApiAccess(1, pid, [cid]),
    [paneId, collectionId] as const
  )
  expect(granted.ok).toBe(true)
  if (!granted.ok) throw new Error(granted.reason)
  expect(granted.paneId).toBe(paneId)
  expect(granted.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  // The token is NEVER returned to the renderer.
  expect(JSON.stringify(granted)).not.toMatch(/token/i)

  const status = await win.evaluate(() => window.saiife.apiGrantStatus(1))
  expect(status).toMatchObject({ granted: true, paneId, collectionIds: [collectionId] })

  // Granting with no collections is meaningless and refused.
  const empty = await win.evaluate((pid) => window.saiife.grantApiAccess(1, pid, []), paneId)
  expect(empty.ok).toBe(false)

  // Granting to an unknown pane is refused.
  const ghost = await win.evaluate(() => window.saiife.grantApiAccess(1, 'no-such-pane', ['x']))
  expect(ghost.ok).toBe(false)

  await win.evaluate(() => window.saiife.revokeApiAccess(1))
  expect(await win.evaluate(() => window.saiife.apiGrantStatus(1))).toMatchObject({ granted: false })

  await app.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts`
Expected: FAIL — `window.saiife.apiGrantStatus is not a function`

- [ ] **Step 3: Write minimal implementation**

Add after `grantOpenclawPane` (line 1110) in `src/main/index.ts`:

```typescript
  /**
   * Mint an API grant for one environment and hand it to a pane as process env.
   *
   * The token reaches the agent ONLY as `SAIIFE_API_TOKEN` on that pane —
   * deliberately distinct from the operator's `SAIIFE_TOKEN`, because reusing
   * that variable would hand every operator-aware agent an API capability by
   * accident. It is never returned over IPC.
   *
   * `updateSpecEnv` only mutates the stored spec, so a RUNNING pane must be
   * restarted for the variables to land — same constraint the openclaw re-grant
   * in `session:restart` works around. `restart(id, false)` keeps the agent's
   * resume args, so a coding agent resumes rather than losing its conversation.
   */
  const grantApiAccess = (
    environment: number,
    paneId: string,
    collectionIds: string[]
  ): ApiGrantResult => {
    const pane = manager.get(paneId)
    if (!pane || pane.kind !== 'terminal') {
      return { ok: false, reason: 'that pane is not a terminal pane in this environment' }
    }
    if (pane.environment !== environment) {
      return { ok: false, reason: 'that pane is not a terminal pane in this environment' }
    }
    if (collectionIds.length === 0) {
      return { ok: false, reason: 'choose at least one collection — an empty grant does nothing' }
    }
    for (const id of collectionIds) {
      if (!apiCollections.get(id, environment)) {
        return { ok: false, reason: 'unknown collection' }
      }
    }

    // A second grant MOVES the capability: ApiGrantStore mints one token per
    // environment, so revoke first to guarantee a fresh mint with this scope
    // (re-granting an existing environment would otherwise keep the old scope).
    apiGrants.revoke(environment)
    const token = apiGrants.grant(environment, collectionIds)
    const endpoint = `http://127.0.0.1:${control.port}`
    manager.updateSpecEnv(paneId, { SAIIFE_API_ENDPOINT: endpoint, SAIIFE_API_TOKEN: token })
    apiGrantBinding.bind(environment, paneId, collectionIds)

    if (pane.status !== 'exited') {
      try {
        manager.restart(paneId, false)
      } catch (err) {
        // Never leave a live token that no pane holds.
        apiGrants.revoke(environment)
        apiGrantBinding.unbind(environment)
        return { ok: false, reason: `couldn't restart the pane to inject the credential — ${(err as Error).message}` }
      }
    }
    return { ok: true, endpoint, paneId }
  }

  const revokeApiAccess = (environment: number): void => {
    apiGrants.revoke(environment)
    apiGrantBinding.unbind(environment)
  }
```

Add the three handlers beside the curation ones:

```typescript
  ipcMain.handle(
    'apiClient:grant',
    (_e, environment: number, paneId: string, collectionIds: unknown): ApiGrantResult => {
      if (typeof paneId !== 'string' || paneId.length === 0) {
        return { ok: false, reason: 'paneId must be a string' }
      }
      if (!Array.isArray(collectionIds) || collectionIds.some((c) => typeof c !== 'string')) {
        return { ok: false, reason: 'collectionIds must be an array of strings' }
      }
      return grantApiAccess(clampEnvironment(environment), paneId, collectionIds as string[])
    }
  )

  ipcMain.handle('apiClient:revoke', (_e, environment: number): void =>
    revokeApiAccess(clampEnvironment(environment))
  )

  ipcMain.handle('apiClient:status', (_e, environment: number): ApiGrantStatus => {
    const env = clampEnvironment(environment)
    const record = apiGrantBinding.get(env)
    const granted = apiGrants.isGranted(env)
    return granted && record
      ? { environment: env, granted: true, paneId: record.paneId, collectionIds: record.collectionIds }
      : { environment: env, granted: false }
  })
```

Add to `SaiifeApi` in `src/shared/api.ts`:

```typescript
  /**
   * Grants scoped API access to one terminal pane. The token is injected into
   * that pane's process env and is NEVER returned here. Restarts a running
   * pane so the variables land.
   */
  grantApiAccess(
    environment: number,
    paneId: string,
    collectionIds: string[]
  ): Promise<ApiGrantResult>
  /** Revokes an environment's API grant; the token stops resolving immediately. */
  revokeApiAccess(environment: number): Promise<void>
  /** Grant presence, holding pane and scope for one environment. Never material. */
  apiGrantStatus(environment: number): Promise<ApiGrantStatus>
```

extending that file's `./api-client` type import with `ApiGrantResult` and `ApiGrantStatus`, and the same two into `index.ts`'s type import.

Add to `src/preload/index.ts`:

```typescript
  grantApiAccess: (environment: number, paneId: string, collectionIds: string[]) =>
    ipcRenderer.invoke('apiClient:grant', environment, paneId, collectionIds),
  revokeApiAccess: (environment: number) => ipcRenderer.invoke('apiClient:revoke', environment),
  apiGrantStatus: (environment: number) => ipcRenderer.invoke('apiClient:status', environment),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts`
Expected: PASS — 2 tests. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/shared/api.ts src/preload/index.ts tests/e2e/api-client.spec.ts
git commit -m "feat(api-client): grant scoped access to a pane"
```

---

### Task 5: Revoke the grant when its pane is deleted

Ties the grant's life to the pane's existence, matching the operator grant's own
default (`index.ts:1161-1168`). This is what makes the engine spec's
session-scoped claim true — a grant cannot outlive the pane that holds it.

**Files:**
- Modify: `src/main/api-client/grant-binding.ts` (add an `environments()` accessor)
- Modify: `tests/unit/api-grant-binding.test.ts` (one test for it)
- Modify: `src/main/index.ts` (one `manager.onSessionsChanged` subscriber)
- Test: `tests/e2e/api-client.spec.ts` (append a test)

**Interfaces:**
- Consumes: `revokeApiAccess`, `apiGrantBinding` (Task 4); `ENVIRONMENT_MIN`/`ENVIRONMENT_MAX` from `src/shared/environment.ts` (already imported in index.ts)
- Produces: `ApiGrantBinding.environments(): number[]`

**Why this is now simple.** The revoke-on-exit-plus-re-mint design was dropped
(see the wiring spec §2). `grantApiAccess` closes and restarts a running pane to
inject the token; that close is an *exit*, not a *deletion*, so revoking on
deletion leaves it completely alone. No `pendingApiRegrant`, no re-mint, no
suppression, no `session:restart` change.

- [ ] **Step 1: Write the failing unit test for the accessor**

Append to `tests/unit/api-grant-binding.test.ts`, inside the `describe('ApiGrantBinding', ...)` block:

```typescript
  it('lists the environments that currently hold a grant', () => {
    const b = new ApiGrantBinding()
    expect(b.environments()).toEqual([])
    b.bind(1, 'pane-a', ['stripe'])
    b.bind(4, 'pane-b', ['other'])
    expect(b.environments().sort((x, y) => x - y)).toEqual([1, 4])
    b.unbind(1)
    expect(b.environments()).toEqual([4])
  })
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/api-grant-binding.test.ts`
Expected: FAIL — `b.environments is not a function`

- [ ] **Step 3: Add the accessor**

In `src/main/api-client/grant-binding.ts`, add this method to `ApiGrantBinding`
(after `environmentForPane`):

```typescript
  /** The environments that currently hold a grant. Used by the delete hook to
   *  reconcile bindings against the live session list. */
  environments(): number[] {
    return [...this.byEnv.keys()]
  }
```

- [ ] **Step 4: Confirm the unit test passes**

Run: `npx vitest run tests/unit/api-grant-binding.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Write the failing e2e test**

Append to `tests/e2e/api-client.spec.ts`. It reuses the file's existing
`launchApp`, `COLLECTION` and `WithSaiife` cast — do not redefine them.

```typescript
test('the grant dies when its pane is deleted, and survives a restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apidelete-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  if (!created.ok) throw new Error(created.reason)
  const collectionId = created.view.id

  const session = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('claude', cwd),
    userData
  )
  if (!session) throw new Error('createSession returned null')
  const paneId = session.id

  const granted = await win.evaluate(
    ([pid, cid]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [cid]),
    [paneId, collectionId] as const
  )
  expect(granted.ok).toBe(true)
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))
  ).toMatchObject({ granted: true, paneId, collectionIds: [collectionId] })

  // Granting restarted the pane (to inject the env). The grant SURVIVES that —
  // a restart is an exit, not a deletion.
  await win.evaluate((pid) => (window as unknown as WithSaiife).saiife.restartSession(pid, false), paneId)
  expect(
    await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))
  ).toMatchObject({ granted: true, paneId })

  // Deleting the pane revokes WITHOUT an explicit revoke call.
  await win.evaluate((pid) => (window as unknown as WithSaiife).saiife.deleteSession(pid), paneId)
  await expect
    .poll(
      async () =>
        (await win.evaluate(() => (window as unknown as WithSaiife).saiife.apiGrantStatus(1))).granted,
      { timeout: 10_000 }
    )
    .toBe(false)

  await app.close()
})
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts`
Expected: FAIL — deleting the pane leaves `apiGrantStatus(1).granted` true (no delete hook yet), so the poll times out.

- [ ] **Step 7: Add the delete hook**

Register a new subscriber alongside the existing `manager.onSessionsChanged(...)`
(the operator one at `index.ts:1161`). A separate registration keeps the API
concern isolated from the operator/persistence reconciliation in that handler:

```typescript
  // Revoke an API grant when the pane holding it is DELETED (not merely exited).
  // Mirrors the operator grant's own default reconciliation directly above:
  // when a bound pane's id is no longer in the session list, its grant dies.
  // A restart is an exit, not a deletion, so grantApiAccess's own close+restart
  // is deliberately untouched by this.
  manager.onSessionsChanged(() => {
    const currentIds = new Set(manager.list().map((s) => s.id))
    for (const env of apiGrantBinding.environments()) {
      const record = apiGrantBinding.get(env)
      if (record && !currentIds.has(record.paneId)) revokeApiAccess(env)
    }
  })
```

- [ ] **Step 8: Confirm the e2e passes**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts`
Expected: PASS — 3 tests. Then `npm run check`.

- [ ] **Step 9: Commit**

```bash
git add src/main/api-client/grant-binding.ts tests/unit/api-grant-binding.test.ts src/main/index.ts tests/e2e/api-client.spec.ts
git commit -m "feat(api-client): revoke grant on pane deletion"
```

---

### Task 6: Security probes

The tests that make this milestone's claims real, in the category this project already uses.

**Files:**
- Test: `tests/unit/api-client-wiring-security.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-client-wiring-security.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Private walker per file, matching tests/unit/integration-secret-safety.test.ts
// and email-never-send.test.ts — this repo has no shared test util, and the
// extension filter is required because src/renderer has nested directories and
// a non-TS index.html.
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) yield full
  }
}

const root = join(__dirname, '..', '..', 'src')

describe('security probe: capability material stays in main', () => {
  it('no preload or renderer file references the grant store or its token', () => {
    for (const dir of ['preload', 'renderer']) {
      for (const file of walk(join(root, dir))) {
        const source = readFileSync(file, 'utf8')
        expect(source, `${file} must not name the grant store`).not.toContain('ApiGrantStore')
        expect(source, `${file} must not name the token variable`).not.toContain('SAIIFE_API_TOKEN')
        expect(source, `${file} must not reach the secret store`).not.toContain('CollectionSecretStore')
      }
    }
  })

  it('the API token variable is written in exactly one place', () => {
    const hits: string[] = []
    for (const file of walk(join(root, 'main'))) {
      if (readFileSync(file, 'utf8').includes('SAIIFE_API_TOKEN')) hits.push(file)
    }
    expect(hits).toEqual([join(root, 'main', 'index.ts')])
  })

  it('SAIIFE_API_TOKEN is distinct from the operator SAIIFE_TOKEN', () => {
    // Reusing the operator's variable would hand every operator-aware agent an
    // API capability by accident — the reason two grant stores exist at all.
    const launch = readFileSync(join(root, 'main', 'operator-launch.ts'), 'utf8')
    expect(launch).toContain('SAIIFE_TOKEN')
    expect(launch).not.toContain('SAIIFE_API_TOKEN')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-client-wiring-security.test.ts`
Expected: PASS if Tasks 3–5 were built correctly — these assert properties those tasks were built to hold.

Confirm the probes genuinely bite before trusting them: temporarily add `SAIIFE_API_TOKEN` to a `src/preload/index.ts` comment and re-run. The first probe MUST fail. Revert before continuing, and confirm with `git diff` that only the new test file is staged.

- [ ] **Step 3: Fix anything the probes caught**

If probe 1 fails, a preload/renderer file reaches capability material — route it through an IPC handler that returns a presence boolean instead, per Task 3's `CollectionView`. If probe 2 fails, the token variable is written in more than one main-process file; consolidate it into `index.ts`'s `grantApiAccess`, which is the single injection point.

- [ ] **Step 4: Run the full gate**

Run: `npm run check`
Expected: PASS — eslint, prettier, both tsconfigs, and the whole vitest suite.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/api-client-wiring-security.test.ts
git commit -m "test(api-client): probe the wiring capability boundary"
```

---

## Deviations and flags for the reviewer

1. **`removeCollection` scans environments 1–9 by construction.** `ApiGrantBinding` is keyed by environment with no enumeration method, and environments are a fixed 1–9 range (`ENVIRONMENT_MIN/MAX` in `src/shared/environment.ts`). If a reviewer prefers, add an `entries()` method to `ApiGrantBinding` in Task 2 and iterate that instead — cleaner, but it widens a module that is otherwise deliberately tiny.

2. **Grant lifetime was changed from revoke-on-exit to revoke-on-deletion during execution** (decided with Jonas after Task 4). The original Task 5 revoked on `'exited'` and re-minted on restart. Implementing Task 4 showed that `grantApiAccess` closes and restarts a running pane to inject the token, so the close would fire `'exited'` and self-revoke the grant mid-grant — and the direct `manager.restart` bypasses the `session:restart` re-mint. Revoke-on-deletion (`onSessionsChanged`) ties the grant to the pane's existence, matches the operator grant's own default, and makes the running-pane grant work with zero special handling. The wiring spec §2 was updated to match. The exposure window is now "the pane exists" rather than "the pane's agent is running" — a token on an exited pane lives only in that pane's spec env, unreadable by any process until relaunch, so the practical exposure is identical.

3. **E2E cost is low — measured, not assumed.** `npm run build` is 3.1s and a real spec (`tests/e2e/operator.spec.ts`) runs in 5.3s, so a full cycle is **~9 seconds**. Tasks 3–5 each need one; that is a cheap price for testing IPC handlers that live inline in an 1800-line `index.ts`, and it removes any argument for extracting every handler body into a pure module just to make it unit-testable. Once the build is warm, iterate with `npx playwright test tests/e2e/api-client.spec.ts` and skip the rebuild unless main-process code changed.

4. **`grantApiAccess` restarts a running pane.** This is spec'd and intentional, but it means Task 4's e2e creates a pane and restarts it — if the fake-claude fixture behaves unexpectedly on restart, that test is where it will surface first.

5. **The plan contradicts the spec on one error case, deliberately.** Spec §Error handling says *"Grant to a pane that exited between picking and granting → refused, 'pane no longer running.'"* This plan **allows** granting to an exited pane, and must: the re-mint path in Task 5 grants to a pane that is exited by definition, so refusing would break restart. Granting to an exited pane is also harmless and useful — env vars land on its next launch, and no restart is needed. **The spec's error case is wrong and should be struck** rather than the plan bent to match it. Flagging rather than editing the spec unilaterally, since it is the human's document.
