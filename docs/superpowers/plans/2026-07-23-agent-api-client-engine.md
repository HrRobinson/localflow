# Agent API Client — Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the main-process engine that lets an agent compose and send HTTP requests through a scoped, revocable grant without the credential ever entering its context.

**Architecture:** A second caller of the existing `src/main/http/` pipeline — the agent's request is resolved to params, validated by the *existing* `resolveRequest`, origin-checked against its collection, authenticated by an `applyAuth` extracted from `HttpConnector`, and dialled through the *existing* SSRF-guarded `HttpClient`. The response is held in main and returned to the agent as a shape (paths, types, sizes) with no values.

**Tech Stack:** TypeScript, Electron main process, Vitest, Node `crypto` (`timingSafeEqual`), Electron `safeStorage` via the injected `SecretBackend` seam.

**Spec:** `docs/superpowers/specs/2026-07-23-agent-api-client-design.md`

## Scope of this plan

Spec build-order layers **1–3**, main process only. At the end of this plan an agent holding a grant can list collections, send requests, and read response shapes and unclassified values, driven by a scripted control-API client — no renderer work required to test it. This mirrors how the operator spec shipped its own layer 1 (*"No OpenClaw needed to test this layer; a scripted client exercises it"*).

**Deferred to follow-on plans:**
- Renderer surface (collection curation, credential entry, response viewer, grant toggle) — spec §8.
- Chaining by `$ref` (layer 4) and the approval gate (layer 5).

**Consequence for this plan:** a pull of a **withheld** field returns `403 withheld` — the safe intermediate the spec's build order specifies at layer 3. The gate replaces it later.

## Global Constraints

- **Commit subject line max 50 characters** — enforced by commitlint (`header-max-length: [2, 'always', 50]`) via husky. Every commit in this plan is pre-checked against this.
- **Conventional Commits** — `@commitlint/config-conventional`.
- Tests live in `tests/unit/*.test.ts`; `vitest.config.ts` includes only that glob.
- Run a single test file with `npx vitest run tests/unit/<file>.test.ts`.
- Full gate: `npm run check` (eslint + prettier + tsc on both tsconfigs + vitest).
- **No test opens a real socket.** Inject `MockHttpTransport` (`src/main/http/http-client.ts`).
- **No secret ever crosses IPC, enters a log, or lands in an error message.** Errors name state, never values.
- `IntegrationId` (`src/shared/api-client.ts` does NOT touch it) stays unchanged — collection secrets get a dedicated store per spec §7.
- Prettier (`.prettierrc.json`): `semi: false`, `singleQuote: true`, `printWidth: 100`, 2-space indent, and **`trailingComma: "none"`** — Prettier's default is `"all"`, so multi-line literals must have NO trailing comma or `npm run lint` fails. Run `npm run format` if unsure.
- **`@typescript-eslint/no-explicit-any` is an error**, in `tests/` as well as `src/` (there is no test override). Use `unknown` plus narrowing. There are zero `any` occurrences in the repo today.
- **`noUnusedLocals: true`** in `tsconfig.node.json` — an unused import or local fails `typecheck`, not just lint.
- Vitest has **no `globals: true`** — every test file must explicitly `import { describe, it, expect } from 'vitest'`.
- ESLint 10's `preserve-caught-error` is on: when re-throwing inside a `catch`, always pass `{ cause: err }` (every sample in this plan already does).
- Not enforced, so do not add ceremony for them: explicit return types, non-null-assertion bans, import ordering, `no-console`.

---

### Task 1: CollectionSecretStore

The dedicated keychain store for collection credentials. Follows `src/main/hosted/hosted-token-store.ts` exactly — its own sidecar file so `IntegrationId` stays clean and collision with the `http` keyspace is structurally impossible.

**Files:**
- Create: `src/main/api-client/collection-secrets.ts`
- Test: `tests/unit/collection-secrets.test.ts`

**Interfaces:**
- Consumes: `SecretBackend` from `src/main/integrations/credential-store.ts`
- Produces: `collectionSecretKey(collectionId: string, secretRef: string): string`; `class CollectionSecretStore` with `available(): boolean`, `has(collectionId: string, secretRef: string): boolean`, `set(collectionId: string, secretRef: string, value: string): void`, `clear(collectionId: string, secretRef?: string): void`, `revealSecret(collectionId: string, secretRef: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/collection-secrets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretBackend } from '../../src/main/integrations/credential-store'
import {
  CollectionSecretStore,
  collectionSecretKey
} from '../../src/main/api-client/collection-secrets'

const SECRET = 'sk_live_collection_secret_value'

// Reversible fake so a test can inspect the sidecar. Encrypts as base64 so the
// plaintext is NOT recoverable from the raw file bytes.
const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

function store(): { store: CollectionSecretStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-col-sec-'))
  const file = join(dir, 'collection-secrets.enc')
  return { store: new CollectionSecretStore({ backend, file }), file }
}

describe('collectionSecretKey', () => {
  it('length-prefixes so two pairs can never collide', () => {
    // Without the length prefix both of these join to the same string.
    expect(collectionSecretKey('orders', 'stripe:key')).not.toBe(
      collectionSecretKey('orders:stripe', 'key')
    )
  })
})

describe('CollectionSecretStore', () => {
  it('round-trips a secret via the main-only reveal exit', () => {
    const { store: s } = store()
    expect(s.has('col1', 'token')).toBe(false)
    s.set('col1', 'token', SECRET)
    expect(s.has('col1', 'token')).toBe(true)
    expect(s.revealSecret('col1', 'token')).toBe(SECRET)
  })

  it('scopes secrets per collection', () => {
    const { store: s } = store()
    s.set('col1', 'token', SECRET)
    expect(s.has('col2', 'token')).toBe(false)
  })

  it('clears one ref, or every ref for a collection', () => {
    const { store: s } = store()
    s.set('col1', 'token', SECRET)
    s.set('col1', 'other', SECRET)
    s.clear('col1', 'token')
    expect(s.has('col1', 'token')).toBe(false)
    expect(s.has('col1', 'other')).toBe(true)
    s.clear('col1')
    expect(s.has('col1', 'other')).toBe(false)
  })

  it('never writes plaintext to disk', () => {
    const { store: s, file } = store()
    s.set('col1', 'token', SECRET)
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
  })

  it('surfaces a legible error (never ciphertext) when absent', () => {
    const { store: s } = store()
    expect(() => s.revealSecret('col1', 'token')).toThrow(/no credential/i)
    expect(() => s.revealSecret('col1', 'token')).toThrow(/token/)
  })

  it('surfaces a legible re-enter error on decrypt failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-sec-'))
    const file = join(dir, 'collection-secrets.enc')
    const broken: SecretBackend = {
      ...backend,
      decryptString: () => {
        throw new Error('bad key')
      }
    }
    const s = new CollectionSecretStore({ backend: broken, file })
    s.set('col1', 'token', SECRET)
    expect(() => s.revealSecret('col1', 'token')).toThrow(/re-enter/i)
  })

  it('refuses to store when encryption is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-sec-'))
    const file = join(dir, 'collection-secrets.enc')
    const off: SecretBackend = { ...backend, isEncryptionAvailable: () => false }
    const s = new CollectionSecretStore({ backend: off, file })
    expect(() => s.set('col1', 'token', SECRET)).toThrow(/secure storage/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/collection-secrets.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/api-client/collection-secrets"`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/collection-secrets.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { SecretBackend } from '../integrations/credential-store'

/**
 * DEDICATED keychain store for API-client collection credentials (design §7).
 * It is its OWN tiny store (not `CredentialStore`) for the same reason
 * `HostedTokenStore` is: a collection is not an integration and must not leak
 * into descriptor/registry enumeration, and a separate sidecar file makes
 * collision with the `http` per-node keyspace structurally impossible rather
 * than carefully avoided.
 *
 * Mirrors `CredentialStore`'s discipline: the `SecretBackend` seam keeps it
 * unit-testable, writes are atomic (temp + rename), and `revealSecret` is the
 * sole plaintext exit and is MAIN-PROCESS-ONLY (a grep test asserts it has zero
 * IPC/renderer callers). A decrypt failure surfaces the legible "re-enter it"
 * error, never the ciphertext.
 */

/**
 * Build the composite sidecar key for one collection's secret. LENGTH-PREFIXES
 * the `collectionId` segment so the boundary is unambiguous even when either
 * segment contains `:` — the same reasoning as `httpSecretKey`.
 */
export function collectionSecretKey(collectionId: string, secretRef: string): string {
  return `${collectionId.length}:${collectionId}:${secretRef}`
}

type SecretMap = Record<string, string>

export class CollectionSecretStore {
  private readonly backend: SecretBackend
  private readonly file: string
  private map: SecretMap

  constructor(deps: { backend: SecretBackend; file: string }) {
    this.backend = deps.backend
    this.file = deps.file
    this.map = load(deps.file)
  }

  available(): boolean {
    return this.backend.isEncryptionAvailable()
  }

  /** Presence only — never decrypts. */
  has(collectionId: string, secretRef: string): boolean {
    return collectionSecretKey(collectionId, secretRef) in this.map
  }

  set(collectionId: string, secretRef: string, value: string): void {
    if (!this.available()) {
      throw new Error(
        "Secure storage isn't available on this machine (safeStorage: encryption " +
          `unavailable). The "${secretRef}" credential can't be saved, so this ` +
          'collection stays unusable.'
      )
    }
    let ciphertext: Buffer
    try {
      ciphertext = this.backend.encryptString(value)
    } catch (err) {
      throw new Error(
        `Couldn't encrypt the "${secretRef}" credential — ${(err as Error).message}. ` +
          'Nothing was stored; try again.',
        { cause: err }
      )
    }
    this.persist({
      ...this.map,
      [collectionSecretKey(collectionId, secretRef)]: ciphertext.toString('base64')
    })
  }

  /** Clear one ref, or every ref for a collection when `secretRef` is omitted. */
  clear(collectionId: string, secretRef?: string): void {
    const next: SecretMap = {}
    const prefix = `${collectionId.length}:${collectionId}:`
    for (const [k, v] of Object.entries(this.map)) {
      const exact = secretRef !== undefined ? collectionSecretKey(collectionId, secretRef) : null
      if (exact !== null ? k === exact : k.startsWith(prefix)) continue
      next[k] = v
    }
    this.persist(next)
  }

  /**
   * MAIN-PROCESS-ONLY plaintext exit. MUST NEVER be routed to IPC, a log, or a
   * peek. Named to grep distinctly.
   */
  revealSecret(collectionId: string, secretRef: string): string {
    const b64 = this.map[collectionSecretKey(collectionId, secretRef)]
    if (b64 === undefined) {
      throw new Error(
        `No credential "${secretRef}" is stored for this collection — set it in the API client.`
      )
    }
    try {
      return this.backend.decryptString(Buffer.from(b64, 'base64'))
    } catch (err) {
      throw new Error(
        `The stored "${secretRef}" credential can't be decrypted (safeStorage: ` +
          `${(err as Error).message}) — re-enter it in the API client.`,
        { cause: err }
      )
    }
  }

  /** Atomic write (temp + rename) so a failed write leaves no half-written blob. */
  private persist(next: SecretMap): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't save the credential — ${(err as Error).message}. Nothing was stored; try again.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage sidecar is the normal first-run case — start empty. */
function load(file: string): SecretMap {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: SecretMap = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/collection-secrets.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/collection-secrets.ts tests/unit/collection-secrets.test.ts
git commit -m "feat(api-client): add collection secret store"
```

---

### Task 2: Shared types and CollectionStore

Non-secret collection data, environment-owned. `get` refuses a foreign-environment collection — the isolation guarantee lives here, not in the UI.

**Files:**
- Create: `src/shared/api-client.ts`
- Create: `src/main/api-client/collection-store.ts`
- Test: `tests/unit/collection-store.test.ts`

**Interfaces:**
- Consumes: `HttpMethod`, `HttpAuthScheme` from `src/shared/http.ts`
- Produces: types `CollectionRequest`, `CollectionAuth`, `Collection`, `ShapeField`, `ResponseView`; `class CollectionStore` with `list(environment: number): Collection[]`, `get(id: string, environment: number): Collection | undefined`, `upsert(c: Collection): void`, `remove(id: string): void`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/collection-store.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import type { Collection } from '../../src/shared/api-client'

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: 'stripe-test',
    name: 'Stripe (test)',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'List charges', method: 'GET', path: '/v1/charges' }],
    ...over
  }
}

function store(): CollectionStore {
  const dir = mkdtempSync(join(tmpdir(), 'sf-col-'))
  return new CollectionStore({ file: join(dir, 'collections.json') })
}

describe('CollectionStore', () => {
  it('upserts and reads back within the owning environment', () => {
    const s = store()
    s.upsert(collection())
    expect(s.get('stripe-test', 1)?.name).toBe('Stripe (test)')
    expect(s.list(1)).toHaveLength(1)
  })

  it('refuses a collection from a foreign environment', () => {
    const s = store()
    s.upsert(collection())
    // The isolation guarantee: env 2 cannot see env 1's collection at all.
    expect(s.get('stripe-test', 2)).toBeUndefined()
    expect(s.list(2)).toHaveLength(0)
  })

  it('replaces on upsert of the same id', () => {
    const s = store()
    s.upsert(collection())
    s.upsert(collection({ name: 'Renamed' }))
    expect(s.list(1)).toHaveLength(1)
    expect(s.get('stripe-test', 1)?.name).toBe('Renamed')
  })

  it('removes a collection', () => {
    const s = store()
    s.upsert(collection())
    s.remove('stripe-test')
    expect(s.get('stripe-test', 1)).toBeUndefined()
  })

  it('persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-'))
    const file = join(dir, 'collections.json')
    new CollectionStore({ file }).upsert(collection())
    expect(new CollectionStore({ file }).get('stripe-test', 1)?.name).toBe('Stripe (test)')
  })

  it('starts empty when the file is missing or garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-col-'))
    expect(new CollectionStore({ file: join(dir, 'nope.json') }).list(1)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/collection-store.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/collection-store`

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/api-client.ts`:

```typescript
import type { HttpAuthScheme, HttpMethod } from './http'

/**
 * Shared agent-API-client vocabulary (design §1, §2). No I/O and NO secret — a
 * collection carries only a non-secret `secretRef` (a keychain field name); the
 * ciphertext lives in `CollectionSecretStore`'s own sidecar.
 */

/** A request saved in a collection by the human curator. */
export interface CollectionRequest {
  id: string
  name: string
  method: HttpMethod
  /** A path joined to the varSet's `base_url`, or a fully-qualified URL. */
  path: string
  headers?: Record<string, string>
  body?: unknown
  /** Present so a `CollectionRequest` and a `SendSpec` are structurally
   *  interchangeable in `resolveSendInput` — without it, reading
   *  `source.timeoutMs` off the union fails to typecheck. */
  timeoutMs?: number
}

/** How the collection's credential is applied. `secretRef` is a NAME, not a secret. */
export interface CollectionAuth {
  scheme: HttpAuthScheme
  /** For the `header` scheme, e.g. "X-API-Key". */
  header?: string
  secretRef?: string
}

/**
 * One API. Owns its origins, auth config, saved requests, and credentials.
 * `environment` is the owning saiife environment (design §1) — a collection is
 * reachable ONLY from its own environment, which is what extends the M3.5
 * isolation guarantee to credentials.
 */
export interface Collection {
  id: string
  name: string
  environment: number
  /** `scheme://host[:port]` only — no paths, no wildcards (design §2). */
  origins: string[]
  auth: CollectionAuth
  /** Named substitution variable sets, e.g. `test` / `live`. NOT an environment. */
  varSets: Record<string, Record<string, string>>
  requests: CollectionRequest[]
}

/** One field of a response shape — path, type, size. NEVER a value (design §4.3). */
export interface ShapeField {
  path: string
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  /** String length, array length, or object key count. */
  size?: number
  /** Present iff the field is classified sensitive (design §4.2). */
  withheld?: true
}

/** What the agent receives for a send or a response read. Carries no values. */
export interface ResponseView {
  responseId: string
  status: number
  durationMs: number
  contentType: string
  truncated: boolean
  shape: ShapeField[]
}
```

Create `src/main/api-client/collection-store.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { Collection } from '../../shared/api-client'

/**
 * Non-secret collection data (design §1), persisted as JSON in userData. Holds
 * NO secret — only `auth.secretRef`, a keychain field NAME.
 *
 * `get`/`list` are ENVIRONMENT-SCOPED: a collection is invisible outside its
 * owning environment, so an agent granted in environment A can never reach a
 * collection owned by B. This is the M3.5 isolation guarantee applied to
 * credentials, enforced in the store rather than the UI.
 */
export class CollectionStore {
  private readonly file: string
  private map: Record<string, Collection>

  constructor(deps: { file: string }) {
    this.file = deps.file
    this.map = load(deps.file)
  }

  list(environment: number): Collection[] {
    return Object.values(this.map).filter((c) => c.environment === environment)
  }

  /** Undefined when absent OR owned by a different environment — never leaks
   *  a foreign collection's existence. */
  get(id: string, environment: number): Collection | undefined {
    const c = this.map[id]
    return c && c.environment === environment ? c : undefined
  }

  upsert(collection: Collection): void {
    this.persist({ ...this.map, [collection.id]: collection })
  }

  remove(id: string): void {
    const next = { ...this.map }
    delete next[id]
    this.persist(next)
  }

  private persist(next: Record<string, Collection>): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (err) {
      throw new Error(
        `Couldn't save collections — ${(err as Error).message}. Nothing was stored; try again.`,
        { cause: err }
      )
    }
    this.map = next
  }
}

/** A missing/garbage file is the normal first-run case — start empty. */
function load(file: string): Record<string, Collection> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, Collection>
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/collection-store.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/shared/api-client.ts src/main/api-client/collection-store.ts tests/unit/collection-store.test.ts
git commit -m "feat(api-client): add collection store"
```

---

### Task 3: Origin allowlist

The scope enforcement. Runs on the *resolved* URL, never the template.

**Files:**
- Create: `src/main/api-client/origins.ts`
- Test: `tests/unit/api-origins.test.ts`

**Interfaces:**
- Produces: `normalizeOrigin(raw: string): string | null`, `originAllowed(url: string, origins: string[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-origins.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { normalizeOrigin, originAllowed } from '../../src/main/api-client/origins'

describe('normalizeOrigin', () => {
  it('reduces a URL to scheme://host[:port]', () => {
    expect(normalizeOrigin('https://api.stripe.com/v1/charges?a=1')).toBe('https://api.stripe.com')
    expect(normalizeOrigin('https://api.stripe.com:8443/x')).toBe('https://api.stripe.com:8443')
  })

  it('drops the default port so it matches the bare form', () => {
    expect(normalizeOrigin('https://api.stripe.com:443')).toBe('https://api.stripe.com')
  })

  it('rejects a non-http(s) scheme and an unparseable string', () => {
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
  })
})

describe('originAllowed', () => {
  const origins = ['https://api.stripe.com', 'https://files.stripe.com']

  it('allows a URL inside a declared origin', () => {
    expect(originAllowed('https://api.stripe.com/v1/charges', origins)).toBe(true)
    expect(originAllowed('https://files.stripe.com/x', origins)).toBe(true)
  })

  it('rejects a different host, scheme, or port', () => {
    expect(originAllowed('https://evil.com/v1', origins)).toBe(false)
    expect(originAllowed('http://api.stripe.com/v1', origins)).toBe(false)
    expect(originAllowed('https://api.stripe.com:8443/v1', origins)).toBe(false)
  })

  it('does NOT treat a subdomain or a prefix as a match', () => {
    expect(originAllowed('https://evil.api.stripe.com/v1', origins)).toBe(false)
    expect(originAllowed('https://api.stripe.com.evil.com/v1', origins)).toBe(false)
  })

  it('rejects an unparseable URL and an empty allowlist', () => {
    expect(originAllowed('not a url', origins)).toBe(false)
    expect(originAllowed('https://api.stripe.com/v1', [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-origins.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/origins`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/origins.ts`:

```typescript
/**
 * The collection's origin allowlist (design §2, §3) — the scope enforcement
 * that makes a grant mean "you may act as THIS API's client".
 *
 * An origin is `scheme://host[:port]` ONLY: no paths, no wildcards, exact match
 * after normalisation. Deliberately strict — a prefix or suffix match would let
 * `https://api.stripe.com.evil.com` pass an `https://api.stripe.com` allowlist.
 *
 * ALWAYS called on the RESOLVED url, after templating, for the same reason the
 * SSRF guard is: a `{{base_url}}` that resolves outside the allowlist must be
 * caught on the resolved string, not the template.
 */

/** Reduce a URL to `scheme://host[:port]`, or null if it isn't a usable http(s) URL. */
export function normalizeOrigin(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // `URL.origin` already omits the default port for http/https.
  return u.origin
}

/** Whether a resolved URL falls inside one of the collection's declared origins. */
export function originAllowed(url: string, origins: string[]): boolean {
  const target = normalizeOrigin(url)
  if (target === null) return false
  return origins.some((o) => normalizeOrigin(o) === target)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-origins.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/origins.ts tests/unit/api-origins.test.ts
git commit -m "feat(api-client): add origin allowlist check"
```

---

### Task 4: Request resolution

Turns an agent's send input plus its collection into the `params` object the *existing* `resolveRequest` validates.

**Files:**
- Create: `src/main/api-client/request-resolve.ts`
- Test: `tests/unit/api-request-resolve.test.ts`

**Interfaces:**
- Consumes: `Collection`, `CollectionRequest` (Task 2); `originAllowed` (Task 3); `HttpActionId` and `HttpMethod` from `src/shared/http.ts`
- Produces: `interface SendSpec { method: HttpMethod; path: string; headers?: Record<string,string>; body?: unknown; timeoutMs?: number }`; `interface SendInput { collectionId: string; varSet?: string; requestId?: string; spec?: SendSpec; vars?: Record<string,string> }`; `substitute(input: string, vars: Record<string,string>): string`; `resolveSendInput(collection: Collection, input: SendInput): { actionId: HttpActionId; params: Record<string, unknown> }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-request-resolve.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveSendInput, substitute } from '../../src/main/api-client/request-resolve'
import type { Collection } from '../../src/shared/api-client'

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: 'stripe',
    name: 'Stripe',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com', acct: 'acct_123' } },
    requests: [
      { id: 'charges', name: 'List charges', method: 'GET', path: '/v1/charges' },
      { id: 'acct', name: 'Account', method: 'GET', path: '/v1/accounts/{{acct}}' }
    ],
    ...over
  }
}

describe('substitute', () => {
  it('replaces {{name}} from the variable map', () => {
    expect(substitute('/v1/a/{{id}}/b', { id: '42' })).toBe('/v1/a/42/b')
  })

  it('throws legibly on an unknown variable', () => {
    expect(() => substitute('/v1/{{nope}}', {})).toThrow(/nope/)
  })
})

describe('resolveSendInput', () => {
  it('resolves a saved request against the varSet base_url', () => {
    const { actionId, params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(actionId).toBe('http.get')
    expect(params.url).toBe('https://api.stripe.com/v1/charges')
    expect(params.auth).toEqual({ scheme: 'bearer', secretRef: 'apiKey' })
  })

  it('substitutes variables in a saved request path', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'acct'
    })
    expect(params.url).toBe('https://api.stripe.com/v1/accounts/acct_123')
  })

  it('lets per-send vars override the varSet', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'acct',
      vars: { acct: 'acct_999' }
    })
    expect(params.url).toBe('https://api.stripe.com/v1/accounts/acct_999')
  })

  it('resolves an ad-hoc spec and picks http.send for a mutating verb', () => {
    const { actionId, params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'POST', path: '/v1/charges', body: { amount: 100 } }
    })
    expect(actionId).toBe('http.send')
    expect(params.method).toBe('POST')
    expect(params.body).toEqual({ amount: 100 })
  })

  it('accepts a fully-qualified URL inside the origins', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: 'https://api.stripe.com/v1/x' }
    })
    expect(params.url).toBe('https://api.stripe.com/v1/x')
  })

  it('rejects a resolved URL outside the collection origins', () => {
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: 'https://evil.com/v1/x' }
      })
    ).toThrow(/outside/i)
  })

  it('rejects a base_url that resolves outside the origins', () => {
    const c = collection({ varSets: { bad: { base_url: 'https://evil.com' } } })
    expect(() =>
      resolveSendInput(c, { collectionId: 'stripe', varSet: 'bad', requestId: 'charges' })
    ).toThrow(/outside/i)
  })

  it('requires exactly one of requestId or spec', () => {
    expect(() => resolveSendInput(collection(), { collectionId: 'stripe' })).toThrow(/exactly one/i)
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        requestId: 'charges',
        spec: { method: 'GET', path: '/x' }
      })
    ).toThrow(/exactly one/i)
  })

  it('rejects an unknown requestId and an unknown varSet', () => {
    expect(() =>
      resolveSendInput(collection(), { collectionId: 'stripe', requestId: 'nope' })
    ).toThrow(/nope/)
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'nope',
        requestId: 'charges'
      })
    ).toThrow(/nope/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-request-resolve.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/request-resolve`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/request-resolve.ts`:

```typescript
import type { Collection, CollectionRequest } from '../../shared/api-client'
import type { HttpActionId, HttpMethod } from '../../shared/http'
import { originAllowed } from './origins'

/**
 * PURE resolution (design §3): an agent's send input + its collection → the
 * `params` object the EXISTING `resolveRequest` validates. Holds NO secret — it
 * carries only the collection's non-secret `auth` (scheme + secretRef); the
 * value is revealed later, main-only, in `send.ts`.
 *
 * Validate-at-the-boundary, matching `http-node-config.ts`: an unknown variable,
 * an unknown saved request, an unknown varSet, or a URL outside the collection's
 * origins is a LOUD throw, never a silent default.
 */

/** An ad-hoc request the agent composed. */
export interface SendSpec {
  method: HttpMethod
  /** A path joined to the varSet's `base_url`, or a fully-qualified URL. */
  path: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/** The body of `POST /http/send`. Exactly one of `requestId` / `spec`. */
export interface SendInput {
  collectionId: string
  varSet?: string
  requestId?: string
  spec?: SendSpec
  vars?: Record<string, string>
}

const TEMPLATE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/** Replace every `{{name}}` from `vars`; an unknown name is a loud throw. */
export function substitute(input: string, vars: Record<string, string>): string {
  return input.replace(TEMPLATE, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(
        `Unknown variable "{{${name}}}" — add it to the collection's varSet or pass it in \`vars\`.`
      )
    }
    return value
  })
}

/** Deep-substitute a JSON body's string leaves (keys are left untouched). */
function substituteBody(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return substitute(value, vars)
  if (Array.isArray(value)) return value.map((v) => substituteBody(v, vars))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteBody(v, vars)
    return out
  }
  return value
}

function isAbsolute(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

export function resolveSendInput(
  collection: Collection,
  input: SendInput
): { actionId: HttpActionId; params: Record<string, unknown> } {
  const hasRequestId = input.requestId !== undefined
  const hasSpec = input.spec !== undefined
  if (hasRequestId === hasSpec) {
    throw new Error('Send exactly one of `requestId` (a saved request) or `spec` (an ad-hoc one).')
  }

  let varSet: Record<string, string> = {}
  if (input.varSet !== undefined) {
    const found = collection.varSets[input.varSet]
    if (found === undefined) {
      const known = Object.keys(collection.varSets).join(', ') || '(none)'
      throw new Error(`Unknown varSet "${input.varSet}" — this collection has: ${known}.`)
    }
    varSet = found
  }
  const vars = { ...varSet, ...(input.vars ?? {}) }

  let source: CollectionRequest | SendSpec
  if (hasRequestId) {
    const found = collection.requests.find((r) => r.id === input.requestId)
    if (found === undefined) {
      throw new Error(`Unknown requestId "${input.requestId}" in collection "${collection.id}".`)
    }
    source = found
  } else {
    source = input.spec as SendSpec
  }

  const path = substitute(source.path, vars)
  let url: string
  if (isAbsolute(path)) {
    url = path
  } else {
    const base = vars.base_url
    if (base === undefined) {
      throw new Error(
        `"${source.path}" is a relative path but no \`base_url\` variable is set — ` +
          'add one to the varSet or send a fully-qualified URL.'
      )
    }
    url = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  }

  if (!originAllowed(url, collection.origins)) {
    throw new Error(
      `Refusing to send to "${url}" — it resolves outside collection "${collection.id}"'s ` +
        `declared origins (${collection.origins.join(', ')}).`
    )
  }

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(source.headers ?? {})) headers[k] = substitute(v, vars)

  const params: Record<string, unknown> = {
    url,
    method: source.method,
    headers,
    auth: collection.auth,
    // v1 never opts past the SSRF guard for an agent-composed request.
    allowLocal: false
  }
  if (source.body !== undefined) params.body = substituteBody(source.body, vars)
  if (source.timeoutMs !== undefined) params.timeoutMs = source.timeoutMs

  return { actionId: source.method === 'GET' ? 'http.get' : 'http.send', params }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-request-resolve.test.ts`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/request-resolve.ts tests/unit/api-request-resolve.test.ts
git commit -m "feat(api-client): resolve agent send requests"
```

---

### Task 5: Extract applyAuth

One auth code path, two owners. The *reveal* stays at the caller so each owns its keyspace.

**Files:**
- Create: `src/main/http/apply-auth.ts`
- Modify: `src/main/http/http-connector.ts` (replace the private `applyAuth` body)
- Test: `tests/unit/apply-auth.test.ts`

**Interfaces:**
- Consumes: `ResolvedRequest` from `src/shared/http.ts`
- Produces: `applyAuth(request: ResolvedRequest, secret: string): ResolvedRequest`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/apply-auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { applyAuth } from '../../src/main/http/apply-auth'
import type { ResolvedRequest } from '../../src/shared/http'

function request(auth: ResolvedRequest['auth']): ResolvedRequest {
  return {
    method: 'GET',
    url: 'https://x.test/y',
    headers: { accept: 'json' },
    auth,
    allowLocal: false
  }
}

describe('applyAuth', () => {
  it('applies the bearer scheme', () => {
    const r = applyAuth(request({ scheme: 'bearer', secretRef: 'k' }), 'S3CRET')
    expect(r.headers.authorization).toBe('Bearer S3CRET')
  })

  it('base64-encodes the basic scheme', () => {
    const r = applyAuth(request({ scheme: 'basic', secretRef: 'k' }), 'u:p')
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  it('places the secret in the named header', () => {
    const r = applyAuth(request({ scheme: 'header', header: 'X-API-Key', secretRef: 'k' }), 'S')
    expect(r.headers['X-API-Key']).toBe('S')
  })

  it('falls back to authorization when the header scheme names none', () => {
    const r = applyAuth(request({ scheme: 'header', secretRef: 'k' }), 'S')
    expect(r.headers.authorization).toBe('S')
  })

  it('returns the request untouched for scheme none', () => {
    const original = request({ scheme: 'none' })
    expect(applyAuth(original, 'S')).toBe(original)
  })

  it('does not mutate the input request', () => {
    const original = request({ scheme: 'bearer', secretRef: 'k' })
    applyAuth(original, 'S')
    expect(original.headers.authorization).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/apply-auth.test.ts`
Expected: FAIL — cannot resolve `../../src/main/http/apply-auth`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/http/apply-auth.ts`:

```typescript
import type { ResolvedRequest } from '../../shared/http'

/**
 * Apply a revealed secret to a resolved request per its auth scheme — the ONE
 * place auth headers are built, shared by the canvas `HttpConnector` and the
 * agent API client (design §7).
 *
 * The REVEAL deliberately stays at the caller: the connector reveals via
 * `HttpTokenStore(nodeId)`, the API client via `CollectionSecretStore(collectionId)`,
 * so each owns its own keyspace while sharing one auth code path. The secret
 * never appears in a log, an error, or an echoed request (§9).
 */
export function applyAuth(request: ResolvedRequest, secret: string): ResolvedRequest {
  const { scheme, header } = request.auth
  if (scheme === 'none') return request

  const headers = { ...request.headers }
  switch (scheme) {
    case 'bearer':
      headers['authorization'] = `Bearer ${secret}`
      break
    case 'basic':
      headers['authorization'] = `Basic ${Buffer.from(secret).toString('base64')}`
      break
    case 'header':
      headers[header ?? 'authorization'] = secret
      break
  }
  return { ...request, headers }
}
```

Modify `src/main/http/http-connector.ts` — add the import at the top:

```typescript
import { applyAuth } from './apply-auth'
```

and replace the entire private `applyAuth` method — doc comment included — with this. It is the existing comment plus one sentence pointing at the shared module:

```typescript
  /** Reveal the per-node secret (main-only) and apply it to the request headers
   *  per the auth scheme. The secret NEVER appears in a log, an error, or the
   *  resolved request that is echoed anywhere (§9). The header-building itself
   *  lives in the shared `apply-auth.ts`, which the API client also uses. */
  private applyAuth(request: ResolvedRequest, nodeId: string): ResolvedRequest {
    const { scheme, secretRef } = request.auth
    if (scheme === 'none' || secretRef === undefined) return request
    return applyAuth(request, this.reveal(nodeId, secretRef))
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/apply-auth.test.ts tests/unit/http-connector.test.ts`
Expected: PASS — the new file plus the *existing* connector suite unchanged. The connector tests are the regression proof that the extraction preserved behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/main/http/apply-auth.ts src/main/http/http-connector.ts tests/unit/apply-auth.test.ts
git commit -m "refactor(http): extract applyAuth for reuse"
```

---

### Task 6: HttpClient.sendRaw

`send()` rejects on non-2xx and embeds a 500-char body excerpt in the error. For an agent that is both wrong (a 404 is a normal result) and unsafe (the excerpt bypasses the redaction model). `sendRaw` returns the raw response for any status; `send` is refactored to call it so behaviour is provably unchanged.

**Files:**
- Modify: `src/main/http/http-client.ts`
- Test: `tests/unit/http-client.test.ts` (append)

**Interfaces:**
- Produces: `HttpClient.sendRaw(req: ResolvedRequest): Promise<HttpRawResponse>`
- Unchanged: `HttpClient.send(req: ResolvedRequest): Promise<HttpRawResponse>`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/http-client.test.ts`:

```typescript
describe('HttpClient.sendRaw', () => {
  const request = {
    method: 'GET' as const,
    url: 'https://api.test/x',
    headers: {},
    auth: { scheme: 'none' as const },
    allowLocal: false
  }

  it('returns a non-2xx as a normal value instead of rejecting', async () => {
    const transport = new MockHttpTransport(() => ({
      status: 404,
      headers: {},
      body: '{"error":"no such charge"}'
    }))
    const res = await new HttpClient({ transport }).sendRaw(request)
    expect(res.status).toBe(404)
    expect(res.body).toBe('{"error":"no such charge"}')
  })

  it('returns a 429 as a normal value too', async () => {
    const transport = new MockHttpTransport(() => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: 'slow down'
    }))
    const res = await new HttpClient({ transport }).sendRaw(request)
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBe('30')
  })

  it('still enforces the SSRF guard before dialling', async () => {
    const transport = new MockHttpTransport(() => ({ status: 200, headers: {}, body: '' }))
    await expect(
      new HttpClient({ transport }).sendRaw({ ...request, url: 'https://127.0.0.1/x' })
    ).rejects.toThrow()
    expect(transport.requests).toHaveLength(0)
  })

  it('still maps a transport failure to the legible reject', async () => {
    const transport = new MockHttpTransport(() => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
    })
    await expect(new HttpClient({ transport }).sendRaw(request)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('send() still rejects on non-2xx (unchanged for the connector)', async () => {
    const transport = new MockHttpTransport(() => ({ status: 500, headers: {}, body: 'nope' }))
    await expect(new HttpClient({ transport }).send(request)).rejects.toThrow(/500/)
  })
})
```

**No import change is needed.** The existing file already imports `HttpClient` and `MockHttpTransport` from `'../../src/main/http/http-client'` (verified), and the appended block uses nothing else. Do not add imports — `noUnusedLocals` turns a surplus one into a build failure.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/http-client.test.ts`
Expected: FAIL — `client.sendRaw is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/main/http/http-client.ts`, replace the body of `send` and add `sendRaw` above it:

```typescript
  /**
   * Guard → dial → return the raw response for ANY status (design §7). The
   * agent API client uses this instead of `send`: a 404 is a normal, informative
   * result it must iterate on, and `send`'s rejection message embeds a body
   * excerpt that would route raw response content around the redaction model.
   * Still enforces the SSRF guard before a socket opens, and still maps a
   * transport failure to the pinned legible reject.
   */
  async sendRaw(req: ResolvedRequest): Promise<HttpRawResponse> {
    guardUrl(req.url, req.allowLocal)

    try {
      return await this.transport.send({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs,
        allowLocal: req.allowLocal
      })
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).message
      throw new Error(
        `Couldn't reach ${hostOf(req.url)} (${code}) — check the URL and that the host is reachable.`,
        { cause: err }
      )
    }
  }

  /**
   * Guard → dial → map the result. Resolves the raw response on a 2xx; REJECTS
   * on a non-2xx (status + body excerpt), a 429 (the remote's `Retry-After`
   * verbatim), or a transport error (the Node error code). Never returns a
   * non-2xx as a resolved value; never renders a secret.
   */
  async send(req: ResolvedRequest): Promise<HttpRawResponse> {
    const res = await this.sendRaw(req)

    if (res.status === 429) {
      const retryAfter = res.headers['retry-after']
      const hint = retryAfter ? `; Retry-After: ${retryAfter}` : ''
      throw new Error(`${req.url} is rate-limited (429${hint}) — the remote asked us to back off.`)
    }

    if (res.status < 200 || res.status > 299) {
      throw new Error(`${req.method} ${req.url} returned ${res.status} — ${excerpt(res.body)}`)
    }

    return res
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/http-client.test.ts tests/unit/http-connector.test.ts tests/unit/http-flow-integration.test.ts`
Expected: PASS — the new cases plus every existing `send()` test, which is the regression proof.

- [ ] **Step 5: Commit**

```bash
git add src/main/http/http-client.ts tests/unit/http-client.test.ts
git commit -m "feat(http): add sendRaw for any-status responses"
```

---

### Task 7: Credential scrub

The absolute tier. Exact-match, so it is fully testable.

**Files:**
- Create: `src/main/api-client/redact.ts`
- Test: `tests/unit/api-redact.test.ts`

**Interfaces:**
- Produces: `scrubForms(secret: string): string[]`, `scrub(text: string, secrets: string[]): string`, `REDACTED: '[redacted]'`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-redact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { scrub, scrubForms, REDACTED } from '../../src/main/api-client/redact'

const SECRET = 'sk_live_abc123'

describe('scrubForms', () => {
  it('includes the raw, base64 and url-encoded forms', () => {
    const forms = scrubForms('a b+c')
    expect(forms).toContain('a b+c')
    expect(forms).toContain(Buffer.from('a b+c', 'utf8').toString('base64'))
    expect(forms).toContain(encodeURIComponent('a b+c'))
  })

  it('returns nothing for an empty secret', () => {
    expect(scrubForms('')).toEqual([])
  })
})

describe('scrub', () => {
  it('replaces every occurrence of the raw secret', () => {
    const body = `{"echo":"${SECRET}","again":"${SECRET}"}`
    expect(scrub(body, scrubForms(SECRET))).toBe(`{"echo":"${REDACTED}","again":"${REDACTED}"}`)
    expect(scrub(body, scrubForms(SECRET))).not.toContain(SECRET)
  })

  it('replaces the base64 form', () => {
    const b64 = Buffer.from(SECRET, 'utf8').toString('base64')
    expect(scrub(`{"basic":"${b64}"}`, scrubForms(SECRET))).not.toContain(b64)
  })

  it('replaces the url-encoded form', () => {
    const secret = 'tok/with+chars'
    const enc = encodeURIComponent(secret)
    expect(scrub(`?t=${enc}`, scrubForms(secret))).not.toContain(enc)
  })

  it('handles regex metacharacters in the secret literally', () => {
    const secret = 'a.*b(c)[d]'
    expect(scrub(`x${secret}y`, scrubForms(secret))).toBe(`x${REDACTED}y`)
    // Must not have been treated as a pattern.
    expect(scrub('aXXXbc', scrubForms(secret))).toBe('aXXXbc')
  })

  it('scrubs the longest form first so no partial survives', () => {
    // 'abc' is a substring of 'abcdef'; replacing the short one first would
    // leave 'def' dangling next to a [redacted].
    expect(scrub('abcdef', ['abc', 'abcdef'])).toBe(REDACTED)
  })

  it('is a no-op for an empty secret list', () => {
    expect(scrub('untouched', [])).toBe('untouched')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-redact.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/redact`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/redact.ts`:

```typescript
/**
 * The ABSOLUTE tier of the response guarantee (design §4.1): the exact value of
 * the credential injected into a request is replaced in the stored body at
 * ingest, before anything can read it. Not withheld, not gate-able —
 * unreachable by any path. There is no legitimate reason for an agent to read
 * back the credential it just sent.
 *
 * Exact-match by construction (`split`/`join`, never a regex), so a secret
 * containing regex metacharacters is handled literally and the whole tier is
 * fully testable.
 */

export const REDACTED = '[redacted]'

/** Every encoding of a secret that could appear in a response body. */
export function scrubForms(secret: string): string[] {
  if (secret.length === 0) return []
  const forms = new Set<string>([secret])
  forms.add(Buffer.from(secret, 'utf8').toString('base64'))
  forms.add(encodeURIComponent(secret))
  return [...forms].filter((f) => f.length > 0)
}

/**
 * Replace every occurrence of every form with `[redacted]`. Longest-first so a
 * form that is a substring of another can never leave a partial behind.
 */
export function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue
    out = out.split(secret).join(REDACTED)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-redact.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/redact.ts tests/unit/api-redact.test.ts
git commit -m "feat(api-client): add exact-value credential scrub"
```

---

### Task 8: Response shape and classification

Paths, types and sizes — never values. Reuses `looksLikeSecretLiteral`, which must be exported.

**Files:**
- Modify: `src/main/http/http-node-config.ts` (export `looksLikeSecretLiteral`)
- Create: `src/main/api-client/response-shape.ts`
- Test: `tests/unit/api-response-shape.test.ts`

**Interfaces:**
- Consumes: `ShapeField` (Task 2); `looksLikeSecretLiteral` from `src/main/http/http-node-config.ts`
- Produces: `shapeOf(body: string, contentType: string, headers: Record<string,string>): ShapeField[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-response-shape.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { shapeOf } from '../../src/main/api-client/response-shape'
import type { ShapeField } from '../../src/shared/api-client'

const find = (shape: ShapeField[], path: string): ShapeField | undefined =>
  shape.find((f) => f.path === path)

describe('shapeOf', () => {
  it('emits paths, types and sizes but never values', () => {
    const body = JSON.stringify({ id: 'ch_123456', amount: 100, live: true, note: null })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, '$.id')).toMatchObject({ type: 'string', size: 9 })
    expect(find(shape, '$.amount')).toMatchObject({ type: 'number' })
    expect(find(shape, '$.live')).toMatchObject({ type: 'boolean' })
    expect(find(shape, '$.note')).toMatchObject({ type: 'null' })
    expect(JSON.stringify(shape)).not.toContain('ch_123456')
  })

  it('collapses a homogeneous array to [*]', () => {
    const body = JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, '$.data')).toMatchObject({ type: 'array', size: 3 })
    expect(find(shape, '$.data[*].id')).toMatchObject({ type: 'string' })
    expect(find(shape, '$.data[0].id')).toBeUndefined()
  })

  it('indexes a heterogeneous array element-by-element', () => {
    const body = JSON.stringify({ mixed: ['a', 1] })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, '$.mixed[0]')).toMatchObject({ type: 'string' })
    expect(find(shape, '$.mixed[1]')).toMatchObject({ type: 'number' })
  })

  it('withholds a field whose KEY looks sensitive', () => {
    const body = JSON.stringify({ access_token: 'x', refresh_token: 'y', api_key: 'z', id: 'ok' })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, '$.access_token')?.withheld).toBe(true)
    expect(find(shape, '$.refresh_token')?.withheld).toBe(true)
    expect(find(shape, '$.api_key')?.withheld).toBe(true)
    expect(find(shape, '$.id')?.withheld).toBeUndefined()
  })

  it('withholds a field whose VALUE looks like a credential', () => {
    const body = JSON.stringify({ harmless_name: 'sk_live_abc123' })
    expect(find(shapeOf(body, 'application/json', {}), '$.harmless_name')?.withheld).toBe(true)
  })

  it('does not descend into a withheld object', () => {
    const body = JSON.stringify({ credentials: { inner: 'x' } })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, '$.credentials')?.withheld).toBe(true)
    expect(find(shape, '$.credentials.inner')).toBeUndefined()
  })

  it('withholds sensitive headers and lists the rest', () => {
    const shape = shapeOf('{}', 'application/json', {
      'content-type': 'application/json',
      'set-cookie': 'session=abc',
      authorization: 'Bearer x'
    })
    expect(find(shape, '$headers.content-type')?.withheld).toBeUndefined()
    expect(find(shape, '$headers.set-cookie')?.withheld).toBe(true)
    expect(find(shape, '$headers.authorization')?.withheld).toBe(true)
    expect(JSON.stringify(shape)).not.toContain('session=abc')
  })

  it('models a non-JSON body as a single $ string field', () => {
    const shape = shapeOf('<html>hi</html>', 'text/html', {})
    expect(find(shape, '$')).toMatchObject({ type: 'string', size: 15 })
  })

  it('models unparseable JSON as a single $ string field', () => {
    const shape = shapeOf('{not json', 'application/json', {})
    expect(find(shape, '$')).toMatchObject({ type: 'string' })
  })

  it('handles an empty body and an empty array', () => {
    expect(find(shapeOf('', 'text/plain', {}), '$')).toMatchObject({ type: 'string', size: 0 })
    const shape = shapeOf(JSON.stringify({ data: [] }), 'application/json', {})
    expect(find(shape, '$.data')).toMatchObject({ type: 'array', size: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-response-shape.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/response-shape`

- [ ] **Step 3: Write minimal implementation**

In `src/main/http/http-node-config.ts`, change the `looksLikeSecretLiteral` declaration to be exported (the doc comment above it stays as-is):

```typescript
export function looksLikeSecretLiteral(value: string): boolean {
```

Create `src/main/api-client/response-shape.ts`:

```typescript
import type { ShapeField } from '../../shared/api-client'
import { looksLikeSecretLiteral } from '../http/http-node-config'

/**
 * PURE: a raw response → its SHAPE (design §4.3). Paths, types and sizes only —
 * a value NEVER appears in the output, which is what lets the shape be handed
 * to an agent verbatim.
 *
 * Classification (design §4.2) has three rules, and rule 3 deliberately reuses
 * the SAME prefix table `looksLikeSecretLiteral` uses on the request side: one
 * table, one place to add a vendor prefix, both directions covered.
 */

const SENSITIVE_HEADERS = new Set(['set-cookie', 'authorization', 'proxy-authorization'])

const SENSITIVE_KEY =
  /(token|secret|password|credential|api[_-]?key|private[_-]?key|client[_-]?secret|refresh|session|signature)/i

/** Rule 2 + rule 3: a sensitive key name, or a value that looks like a credential. */
function sensitive(key: string | undefined, value: unknown): boolean {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return true
  if (typeof value === 'string' && looksLikeSecretLiteral(value)) return true
  return false
}

/** Whether every element shares a structural kind, so the array can collapse to `[*]`. */
function homogeneous(values: unknown[]): boolean {
  const kind = (v: unknown): string =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
  const first = kind(values[0])
  return values.every((v) => kind(v) === first)
}

function walk(value: unknown, path: string, key: string | undefined, out: ShapeField[]): void {
  const withheld = sensitive(key, value)
  const mark = withheld ? { withheld: true as const } : {}

  if (value === null) {
    out.push({ path, type: 'null', ...mark })
    return
  }
  if (Array.isArray(value)) {
    out.push({ path, type: 'array', size: value.length, ...mark })
    // A withheld container is not descended into — its children are sensitive
    // too, and their shape would itself be a hint.
    if (withheld || value.length === 0) return
    if (homogeneous(value)) {
      walk(value[0], `${path}[*]`, key, out)
    } else {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, key, out))
    }
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    out.push({ path, type: 'object', size: entries.length, ...mark })
    if (withheld) return
    for (const [k, v] of entries) walk(v, `${path}.${k}`, k, out)
    return
  }
  if (typeof value === 'string') {
    out.push({ path, type: 'string', size: value.length, ...mark })
    return
  }
  if (typeof value === 'number') {
    out.push({ path, type: 'number', ...mark })
    return
  }
  out.push({ path, type: 'boolean', ...mark })
}

/**
 * The full shape: header fields under `$headers.<name>`, then body fields under
 * `$`. One uniform path space, so a pull uses the same syntax for either.
 */
export function shapeOf(
  body: string,
  contentType: string,
  headers: Record<string, string>
): ShapeField[] {
  const out: ShapeField[] = []

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    const withheld = SENSITIVE_HEADERS.has(lower) || looksLikeSecretLiteral(value)
    out.push({
      path: `$headers.${lower}`,
      type: 'string',
      size: value.length,
      ...(withheld ? { withheld: true as const } : {})
    })
  }

  if (contentType.toLowerCase().includes('json')) {
    try {
      walk(JSON.parse(body), '$', undefined, out)
      return out
    } catch {
      // Fall through — an unparseable JSON body is modelled as a plain string.
    }
  }
  walk(body, '$', undefined, out)
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-response-shape.test.ts tests/unit/http-node-config.test.ts`
Expected: PASS — the new suite plus the existing node-config suite (the export change must not disturb it).

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/response-shape.ts src/main/http/http-node-config.ts tests/unit/api-response-shape.test.ts
git commit -m "feat(api-client): add response shape + classify"
```

---

### Task 9: ResponseStore

Full bodies held in main, environment-scoped, LRU-bounded. Ingest applies the scrub and builds the shape.

**Files:**
- Create: `src/main/api-client/response-store.ts`
- Test: `tests/unit/api-response-store.test.ts`

**Interfaces:**
- Consumes: `scrub` (Task 7 — the module imports only `scrub`; the *test* also uses `scrubForms`), `shapeOf` (Task 8), `ShapeField`/`ResponseView` (Task 2)
- Produces: `interface IngestInput { environment: number; collectionId: string; status: number; durationMs: number; headers: Record<string,string>; body: string; secrets: string[] }`; `type PullResult = { ok: true; value: unknown } | { ok: false; reason: 'unknown' | 'withheld' | 'nopath' }`; `class ResponseStore` with `ingest(input: IngestInput): ResponseView`, `view(id: string, environment: number): ResponseView | undefined`, `pull(id: string, environment: number, path: string): PullResult`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-response-store.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ResponseStore, type IngestInput } from '../../src/main/api-client/response-store'
import { scrubForms } from '../../src/main/api-client/redact'

const SECRET = 'sk_live_abc123'

function input(over: Partial<IngestInput> = {}): IngestInput {
  return {
    environment: 1,
    collectionId: 'stripe',
    status: 200,
    durationMs: 12,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ch_1', access_token: 'tok_secret', data: [{ n: 1 }, { n: 2 }] }),
    secrets: scrubForms(SECRET),
    ...over
  }
}

describe('ResponseStore', () => {
  it('returns a view with a shape and no values', () => {
    const view = new ResponseStore({}).ingest(input())
    expect(view.status).toBe(200)
    expect(view.responseId).toBeTruthy()
    expect(JSON.stringify(view)).not.toContain('ch_1')
    expect(JSON.stringify(view)).not.toContain('tok_secret')
  })

  it('pulls an unclassified value', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, 1, '$.id')).toEqual({ ok: true, value: 'ch_1' })
  })

  it('refuses to pull a withheld field', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, 1, '$.access_token')).toEqual({ ok: false, reason: 'withheld' })
  })

  it('maps a concrete index onto a collapsed [*] shape path', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, 1, '$.data[0].n')).toEqual({ ok: true, value: 1 })
  })

  it('pulls a header, and refuses a sensitive one', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(
      input({ headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } })
    )
    expect(s.pull(responseId, 1, '$headers.content-type')).toEqual({
      ok: true,
      value: 'application/json'
    })
    expect(s.pull(responseId, 1, '$headers.set-cookie')).toEqual({ ok: false, reason: 'withheld' })
  })

  it('scrubs the injected credential out of the stored body entirely', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(
      input({ body: JSON.stringify({ echoed: SECRET }), secrets: scrubForms(SECRET) })
    )
    const pulled = s.pull(responseId, 1, '$.echoed')
    expect(pulled).toEqual({ ok: true, value: '[redacted]' })
  })

  it('is environment-scoped', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input({ environment: 1 }))
    expect(s.view(responseId, 2)).toBeUndefined()
    expect(s.pull(responseId, 2, '$.id')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('reports an unknown path distinctly from an unknown response', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, 1, '$.nope')).toEqual({ ok: false, reason: 'nopath' })
    expect(s.pull('no-such-id', 1, '$.id')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('evicts the oldest response past maxEntries', () => {
    const s = new ResponseStore({ maxEntries: 2 })
    const first = s.ingest(input()).responseId
    s.ingest(input())
    s.ingest(input())
    expect(s.view(first, 1)).toBeUndefined()
  })

  it('truncates an oversized body and marks it', () => {
    const s = new ResponseStore({ maxBodyBytes: 10 })
    const big = input({ body: 'x'.repeat(50), headers: { 'content-type': 'text/plain' } })
    expect(s.ingest(big).truncated).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-response-store.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/response-store`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/response-store.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type { ResponseView, ShapeField } from '../../shared/api-client'
import { scrub } from './redact'
import { shapeOf } from './response-shape'

/**
 * Full response bodies, held in MAIN memory only (design §4). The agent never
 * receives a body — it receives a `ResponseView` (shape, no values) and pulls
 * individual paths. Environment-scoped, so a grant on A can never read a
 * response produced in B. LRU-bounded and process-lifetime: bodies NEVER persist
 * to disk (history metadata does, elsewhere).
 *
 * `ingest` applies the credential scrub BEFORE anything is stored, so the
 * absolute tier holds even against a later code path that reads `body` directly.
 */

export interface IngestInput {
  environment: number
  collectionId: string
  status: number
  durationMs: number
  headers: Record<string, string>
  body: string
  /** Every encoding of the credential injected into the request (`scrubForms`). */
  secrets: string[]
}

export type PullResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'unknown' | 'withheld' | 'nopath' }

interface StoredResponse {
  id: string
  environment: number
  status: number
  durationMs: number
  contentType: string
  truncated: boolean
  headers: Record<string, string>
  /** Already scrubbed at ingest. */
  body: string
  shape: ShapeField[]
}

const DEFAULT_MAX_ENTRIES = 50
const DEFAULT_MAX_BODY_BYTES = 1_000_000

export class ResponseStore {
  // Insertion-ordered, so the first key is always the oldest — LRU by age.
  private readonly entries = new Map<string, StoredResponse>()
  private readonly maxEntries: number
  private readonly maxBodyBytes: number

  constructor(deps: { maxEntries?: number; maxBodyBytes?: number }) {
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  }

  ingest(input: IngestInput): ResponseView {
    const scrubbed = scrub(input.body, input.secrets)
    const truncated = Buffer.byteLength(scrubbed) > this.maxBodyBytes
    const body = truncated ? scrubbed.slice(0, this.maxBodyBytes) : scrubbed

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.headers)) {
      headers[k.toLowerCase()] = scrub(v, input.secrets)
    }
    const contentType = headers['content-type'] ?? ''

    const stored: StoredResponse = {
      id: randomUUID(),
      environment: input.environment,
      status: input.status,
      durationMs: input.durationMs,
      contentType,
      truncated,
      headers,
      body,
      shape: shapeOf(body, contentType, headers)
    }

    this.entries.set(stored.id, stored)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }

    return toView(stored)
  }

  view(id: string, environment: number): ResponseView | undefined {
    const stored = this.resolve(id, environment)
    return stored ? toView(stored) : undefined
  }

  pull(id: string, environment: number, path: string): PullResult {
    const stored = this.resolve(id, environment)
    if (stored === undefined) return { ok: false, reason: 'unknown' }

    const field = findField(stored.shape, path)
    if (field === undefined) return { ok: false, reason: 'nopath' }
    if (field.withheld) return { ok: false, reason: 'withheld' }

    const value = readPath(stored, path)
    return value === undefined ? { ok: false, reason: 'nopath' } : { ok: true, value }
  }

  private resolve(id: string, environment: number): StoredResponse | undefined {
    const stored = this.entries.get(id)
    return stored && stored.environment === environment ? stored : undefined
  }
}

function toView(s: StoredResponse): ResponseView {
  return {
    responseId: s.id,
    status: s.status,
    durationMs: s.durationMs,
    contentType: s.contentType,
    truncated: s.truncated,
    shape: s.shape
  }
}

/**
 * Match a concrete pull path against the shape, which may have collapsed a
 * homogeneous array to `[*]`. An agent reads `$.data[*].n` in the shape and
 * pulls `$.data[0].n`, so a concrete index must find the collapsed field.
 */
function findField(shape: ShapeField[], path: string): ShapeField | undefined {
  const exact = shape.find((f) => f.path === path)
  if (exact !== undefined) return exact
  const collapsed = path.replace(/\[\d+\]/g, '[*]')
  return shape.find((f) => f.path === collapsed)
}

/** Read a concrete path out of the stored headers or body. */
function readPath(stored: StoredResponse, path: string): unknown {
  if (path.startsWith('$headers.')) return stored.headers[path.slice('$headers.'.length)]
  if (path === '$') return stored.body

  let current: unknown
  try {
    current = JSON.parse(stored.body)
  } catch {
    return undefined
  }

  // `$.a.b[0].c` → ['a', 'b', 0, 'c']
  const steps = path
    .slice(1)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0)

  for (const step of steps) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(step)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[step]
  }
  return current
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-response-store.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/response-store.ts tests/unit/api-response-store.test.ts
git commit -m "feat(api-client): add main-only response store"
```

---

### Task 10: ApiGrantStore

The capability. Separate from `OperatorGrantStore` with separate tokens, so an operator grant never silently confers API-send.

**Files:**
- Create: `src/main/api-client/api-grant.ts`
- Test: `tests/unit/api-grant.test.ts`

**Interfaces:**
- Produces: `interface ApiGrant { environment: number; collections: ReadonlySet<string> }`; `class ApiGrantStore` with `grant(environment: number, collectionIds: string[]): string`, `revoke(environment: number): void`, `resolve(token: string): ApiGrant | null`, `isGranted(environment: number): boolean`, `scopeFor(environment: number): string[] | undefined`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-grant.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { ApiGrantStore } from '../../src/main/api-client/api-grant'

describe('ApiGrantStore', () => {
  it('mints a token that resolves to its environment and scope', () => {
    const s = new ApiGrantStore()
    const token = s.grant(1, ['stripe', 'internal'])
    const grant = s.resolve(token)
    expect(grant?.environment).toBe(1)
    expect([...(grant?.collections ?? [])].sort()).toEqual(['internal', 'stripe'])
  })

  it('returns null for an unknown, empty, or non-string token', () => {
    const s = new ApiGrantStore()
    s.grant(1, ['stripe'])
    expect(s.resolve('nope')).toBeNull()
    expect(s.resolve('')).toBeNull()
    expect(s.resolve(undefined as unknown as string)).toBeNull()
  })

  it('stops resolving immediately on revoke', () => {
    const s = new ApiGrantStore()
    const token = s.grant(1, ['stripe'])
    s.revoke(1)
    expect(s.resolve(token)).toBeNull()
    expect(s.isGranted(1)).toBe(false)
  })

  it('re-granting the same environment returns the existing token', () => {
    const s = new ApiGrantStore()
    expect(s.grant(1, ['stripe'])).toBe(s.grant(1, ['stripe']))
  })

  it('mints distinct tokens per environment', () => {
    const s = new ApiGrantStore()
    const a = s.grant(1, ['stripe'])
    const b = s.grant(2, ['stripe'])
    expect(a).not.toBe(b)
    expect(s.resolve(b)?.environment).toBe(2)
  })

  it('reports the scope for an environment', () => {
    const s = new ApiGrantStore()
    s.grant(1, ['stripe'])
    expect(s.scopeFor(1)).toEqual(['stripe'])
    expect(s.scopeFor(2)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-grant.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/api-grant`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/api-grant.ts`:

```typescript
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest()
}

/** What a resolved API token authorises: one environment, a fixed collection set. */
export interface ApiGrant {
  environment: number
  collections: ReadonlySet<string>
}

/**
 * Per-environment API-client grants (design §6). A grant mints a bearer secret
 * and names the COLLECTION SET it may send within — "act as this API's client",
 * not "make HTTP calls". The control API resolves an incoming token back to its
 * grant in CONSTANT TIME. Revocation drops it so the token stops resolving
 * immediately. All in-memory: the grant's lifetime is the session that holds it,
 * and nothing survives a restart.
 *
 * DELIBERATELY separate from `OperatorGrantStore`, with separate tokens: hanging
 * collection scope on the operator grant would silently give every operator
 * API-send capability. No token authenticates both surfaces.
 */
export class ApiGrantStore {
  private byEnv = new Map<number, { token: string; collections: Set<string> }>()

  grant(environment: number, collectionIds: string[]): string {
    const existing = this.byEnv.get(environment)
    if (existing) return existing.token
    const token = randomUUID()
    this.byEnv.set(environment, { token, collections: new Set(collectionIds) })
    return token
  }

  revoke(environment: number): void {
    this.byEnv.delete(environment)
  }

  /** Constant-time token match; null when no grant currently holds it. */
  resolve(token: string): ApiGrant | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const probe = sha256(token)
    for (const [environment, grant] of this.byEnv) {
      if (timingSafeEqual(probe, sha256(grant.token))) {
        return { environment, collections: grant.collections }
      }
    }
    return null
  }

  isGranted(environment: number): boolean {
    return this.byEnv.has(environment)
  }

  scopeFor(environment: number): string[] | undefined {
    const grant = this.byEnv.get(environment)
    return grant ? [...grant.collections] : undefined
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-grant.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/api-grant.ts tests/unit/api-grant.test.ts
git commit -m "feat(api-client): add scoped API grant store"
```

---

### Task 11: Send orchestration

The one place the credential is revealed and applied. Everything before it holds a ref; everything after it holds a scrubbed body.

**Files:**
- Create: `src/main/api-client/send.ts`
- Test: `tests/unit/api-send.test.ts`

**Interfaces:**
- Consumes: `CollectionStore` (2), `CollectionSecretStore` (1), `resolveSendInput`/`SendInput` (4), `applyAuth` (5), `HttpClient.sendRaw` (6), `scrubForms` (7), `ResponseStore` (9), `ApiGrant` (10); `resolveRequest` from `src/main/http/http-node-config.ts`
- Produces: `type SendResult = { ok: true; view: ResponseView } | { ok: false; status: number; error: string }`; `class ApiSender` with `send(grant: ApiGrant, input: SendInput): Promise<SendResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-send.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiSender } from '../../src/main/api-client/send'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import { CollectionSecretStore } from '../../src/main/api-client/collection-secrets'
import { ResponseStore } from '../../src/main/api-client/response-store'
import { HttpClient, MockHttpTransport, type HttpRequest } from '../../src/main/http/http-client'
import type { SecretBackend } from '../../src/main/integrations/credential-store'
import type { Collection } from '../../src/shared/api-client'

const SECRET = 'sk_live_abc123'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: 'stripe',
    name: 'Stripe',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }],
    ...over
  }
}

type Canned = { status: number; headers: Record<string, string>; body: string }

function harness(
  responder: (req: HttpRequest) => Canned,
  col: Collection = collection()
): { sender: ApiSender; transport: MockHttpTransport; responses: ResponseStore } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-send-'))
  const collections = new CollectionStore({ file: join(dir, 'collections.json') })
  collections.upsert(col)
  const secrets = new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') })
  secrets.set(col.id, 'apiKey', SECRET)
  const transport = new MockHttpTransport(responder)
  const responses = new ResponseStore({})
  return {
    sender: new ApiSender({
      collections,
      secrets,
      client: new HttpClient({ transport }),
      responses
    }),
    transport,
    responses
  }
}

const grant = { environment: 1, collections: new Set(['stripe']) }

describe('ApiSender', () => {
  it('applies the credential to the outgoing request', async () => {
    const { sender, transport } = harness(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"ch_1"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result.ok).toBe(true)
    expect(transport.requests[0].headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(transport.requests[0].url).toBe('https://api.stripe.com/v1/charges')
  })

  it('returns a shape with no values', async () => {
    const { sender } = harness(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"ch_secret_value"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(JSON.stringify(result)).not.toContain('ch_secret_value')
  })

  it('returns a non-2xx as a normal result, not an error', async () => {
    const { sender } = harness(() => ({
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"no such charge"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.view.status).toBe(404)
  })

  it('never lets a non-2xx body reach the caller as text', async () => {
    const { sender } = harness(() => ({
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: '{"leaked":"sensitive-error-detail"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(JSON.stringify(result)).not.toContain('sensitive-error-detail')
  })

  it('scrubs an echoed credential out of the stored response', async () => {
    const { sender, responses } = harness(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ echoed: SECRET })
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!result.ok) throw new Error('expected ok')
    expect(responses.pull(result.view.responseId, 1, '$.echoed')).toEqual({
      ok: true,
      value: '[redacted]'
    })
  })

  it('refuses a collection outside the grant scope', async () => {
    const { sender } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(
      { environment: 1, collections: new Set(['other']) },
      { collectionId: 'stripe', varSet: 'test', requestId: 'charges' }
    )
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('gives identical wording for out-of-scope and non-existent', async () => {
    const { sender } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const outOfScope = await sender.send(
      { environment: 1, collections: new Set(['other']) },
      { collectionId: 'stripe', varSet: 'test', requestId: 'charges' }
    )
    const missing = await sender.send(
      { environment: 1, collections: new Set(['ghost']) },
      { collectionId: 'ghost', varSet: 'test', requestId: 'charges' }
    )
    if (outOfScope.ok || missing.ok) throw new Error('expected failures')
    expect(outOfScope.error).toBe(missing.error)
  })

  it('refuses a foreign-environment collection', async () => {
    const { sender } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(
      { environment: 2, collections: new Set(['stripe']) },
      { collectionId: 'stripe', varSet: 'test', requestId: 'charges' }
    )
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('rejects an agent-authored secret literal header', async () => {
    const { sender, transport } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: {
        method: 'GET',
        path: '/v1/charges',
        headers: { authorization: 'Bearer sk_live_stolen' }
      }
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(transport.requests).toHaveLength(0)
  })

  it('rejects a URL outside the collection origins without dialling', async () => {
    const { sender, transport } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: 'https://evil.com/x' }
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(transport.requests).toHaveLength(0)
  })

  it('surfaces a missing credential legibly and never dials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-send-'))
    const collections = new CollectionStore({ file: join(dir, 'collections.json') })
    collections.upsert(collection())
    const transport = new MockHttpTransport(() => ({ status: 200, headers: {}, body: '{}' }))
    const sender = new ApiSender({
      collections,
      // No secret was ever set.
      secrets: new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') }),
      client: new HttpClient({ transport }),
      responses: new ResponseStore({})
    })
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    if (!result.ok) expect(result.error).toMatch(/no credential/i)
    expect(transport.requests).toHaveLength(0)
  })

  it('never renders the credential in an error message', async () => {
    const { sender } = harness(() => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
    })
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-send.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/send`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/api-client/send.ts`:

```typescript
import type { ResponseView } from '../../shared/api-client'
import type { HttpClient } from '../http/http-client'
import { applyAuth } from '../http/apply-auth'
import { resolveRequest } from '../http/http-node-config'
import type { ApiGrant } from './api-grant'
import type { CollectionSecretStore } from './collection-secrets'
import type { CollectionStore } from './collection-store'
import { scrubForms } from './redact'
import { resolveSendInput, type SendInput } from './request-resolve'
import type { ResponseStore } from './response-store'

/**
 * Send orchestration (design §3) — the ONE place a collection credential is
 * revealed and applied. Everything upstream holds only a `secretRef`; everything
 * downstream holds only a scrubbed body.
 *
 * Uses `HttpClient.sendRaw`, NOT `send`: a non-2xx is a normal result the agent
 * must iterate on, and `send`'s rejection embeds a body excerpt that would route
 * raw response content around the shape/withhold model (§7).
 *
 * Every failure is a `{ ok: false, status, error }` value rather than a throw, so
 * the route maps it without a second try/catch — and the error text NEVER
 * contains a secret.
 */

export type SendResult =
  | { ok: true; view: ResponseView }
  | { ok: false; status: number; error: string }

/** One wording for "not yours", whether it is out of scope, foreign, or absent —
 *  never leak a foreign collection's existence (mirrors `unknown group`). */
const NO_COLLECTION = 'unknown collection'

export class ApiSender {
  private readonly collections: CollectionStore
  private readonly secrets: CollectionSecretStore
  private readonly client: HttpClient
  private readonly responses: ResponseStore

  constructor(deps: {
    collections: CollectionStore
    secrets: CollectionSecretStore
    client: HttpClient
    responses: ResponseStore
  }) {
    this.collections = deps.collections
    this.secrets = deps.secrets
    this.client = deps.client
    this.responses = deps.responses
  }

  async send(grant: ApiGrant, input: SendInput): Promise<SendResult> {
    if (!grant.collections.has(input.collectionId)) {
      return { ok: false, status: 403, error: NO_COLLECTION }
    }
    const collection = this.collections.get(input.collectionId, grant.environment)
    if (collection === undefined) {
      return { ok: false, status: 403, error: NO_COLLECTION }
    }

    // Resolution + the EXISTING validator. Both throw legibly at the boundary;
    // neither has ever seen a secret.
    let request
    try {
      const { actionId, params } = resolveSendInput(collection, input)
      request = resolveRequest(actionId, params)
    } catch (err) {
      return { ok: false, status: 400, error: (err as Error).message }
    }

    // The single reveal. Kept as narrow as possible: read at call time, applied
    // immediately, never stored on `this`.
    let secret = ''
    if (request.auth.scheme !== 'none' && request.auth.secretRef !== undefined) {
      try {
        secret = this.secrets.revealSecret(collection.id, request.auth.secretRef)
      } catch (err) {
        return { ok: false, status: 400, error: (err as Error).message }
      }
    }

    const started = Date.now()
    let raw
    try {
      raw = await this.client.sendRaw(secret === '' ? request : applyAuth(request, secret))
    } catch (err) {
      // `sendRaw` rejects only for the SSRF guard or a transport failure, and
      // neither message contains the secret.
      return { ok: false, status: 502, error: (err as Error).message }
    }

    return {
      ok: true,
      view: this.responses.ingest({
        environment: grant.environment,
        collectionId: collection.id,
        status: raw.status,
        durationMs: Date.now() - started,
        headers: raw.headers,
        body: raw.body,
        secrets: scrubForms(secret)
      })
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/api-send.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/send.ts tests/unit/api-send.test.ts
git commit -m "feat(api-client): orchestrate agent sends"
```

---

### Task 12: Control-API routes

The `/http/*` block, authenticated against `ApiGrantStore`. No token authenticates both surfaces.

**Files:**
- Modify: `src/main/control-api.ts`
- Test: `tests/unit/api-client-routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–11
- Produces: `ControlDeps.apiClient?: { grants: ApiGrantStore; sender: ApiSender; collections: CollectionStore; responses: ResponseStore }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-client-routes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest, type ControlDeps } from '../../src/main/control-api'
import { PaneRegistry } from '../../src/main/pane-registry'
import { OperatorGrantStore } from '../../src/main/operator-grant'
import { ApiGrantStore } from '../../src/main/api-client/api-grant'
import { ApiSender } from '../../src/main/api-client/send'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import { CollectionSecretStore } from '../../src/main/api-client/collection-secrets'
import { ResponseStore } from '../../src/main/api-client/response-store'
import { HttpClient, MockHttpTransport } from '../../src/main/http/http-client'
import type { SecretBackend } from '../../src/main/integrations/credential-store'

const SECRET = 'sk_live_abc123'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

function harness(): { deps: ControlDeps; apiToken: string; operatorToken: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-routes-'))
  const collections = new CollectionStore({ file: join(dir, 'collections.json') })
  collections.upsert({
    id: 'stripe',
    name: 'Stripe',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }]
  })
  const secrets = new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') })
  secrets.set('stripe', 'apiKey', SECRET)

  const grants = new OperatorGrantStore()
  const apiGrants = new ApiGrantStore()
  const responses = new ResponseStore({})
  const transport = new MockHttpTransport(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ch_1', access_token: 'tok' })
  }))

  // `PaneRegistry` takes a `SessionSource` ({ list, get }) — it is NOT no-arg.
  // The existing control-api suite uses one fake object as both the registry
  // source and `deps.manager`; do the same.
  const manager = {
    list: () => [],
    get: () => null,
    write: () => {},
    peek: () => [],
    getGroup: () => null,
    emitNotice: () => {}
  }

  const deps: ControlDeps = {
    registry: new PaneRegistry(manager),
    grants,
    manager,
    panes: { create: () => null },
    apiClient: {
      grants: apiGrants,
      collections,
      responses,
      sender: new ApiSender({
        collections,
        secrets,
        client: new HttpClient({ transport }),
        responses
      })
    }
  }
  return { deps, apiToken: apiGrants.grant(1, ['stripe']), operatorToken: grants.grant(1) }
}

describe('control-api /http/* routes', () => {
  it('lists only in-scope collections, with no secret material', async () => {
    const { deps, apiToken } = harness()
    const res = await handleRequest(deps, 'GET', '/http/collections', apiToken, '')
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).not.toContain(SECRET)
    expect(JSON.stringify(res.json)).not.toContain('apiKey')
  })

  it('sends and returns a shape', async () => {
    const { deps, apiToken } = harness()
    const body = JSON.stringify({ collectionId: 'stripe', varSet: 'test', requestId: 'charges' })
    const res = await handleRequest(deps, 'POST', '/http/send', apiToken, body)
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.json)).not.toContain('ch_1')
  })

  it('pulls an unclassified value and refuses a withheld one', async () => {
    const { deps, apiToken } = harness()
    const sent = await handleRequest(
      deps,
      'POST',
      '/http/send',
      apiToken,
      JSON.stringify({ collectionId: 'stripe', varSet: 'test', requestId: 'charges' })
    )
    const id = (sent.json as { responseId: string }).responseId
    const pullUrl = `/http/responses/${id}/pull?path=$.id`
    const ok = await handleRequest(deps, 'GET', pullUrl, apiToken, '')
    expect(ok.json).toMatchObject({ value: 'ch_1' })
    const denied = await handleRequest(
      deps,
      'GET',
      `/http/responses/${id}/pull?path=$.access_token`,
      apiToken,
      ''
    )
    expect(denied.status).toBe(403)
  })

  it('rejects a missing or unknown API token', async () => {
    const { deps } = harness()
    expect((await handleRequest(deps, 'GET', '/http/collections', '', '')).status).toBe(403)
    expect((await handleRequest(deps, 'GET', '/http/collections', 'nope', '')).status).toBe(403)
  })

  it('refuses an operator token on /http/* and an API token on /panes', async () => {
    const { deps, apiToken, operatorToken } = harness()
    expect((await handleRequest(deps, 'GET', '/http/collections', operatorToken, '')).status).toBe(
      403
    )
    expect((await handleRequest(deps, 'GET', '/panes', apiToken, '')).status).toBe(403)
  })

  it('404s the whole surface when the API client is not wired', async () => {
    const { deps, apiToken } = harness()
    const without: ControlDeps = { ...deps, apiClient: undefined }
    const res = await handleRequest(without, 'GET', '/http/collections', apiToken, '')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-client-routes.test.ts`
Expected: FAIL — every `/http/*` assertion fails (the routes do not exist yet, so the existing fallback returns `404 not found`, and the auth-separation cases return the operator path's `403 no grant`). Note vitest transpiles without typechecking, so the missing `apiClient` field on `ControlDeps` surfaces only under `npm run typecheck`, not here.

- [ ] **Step 3: Write minimal implementation**

In `src/main/control-api.ts`, add the imports:

```typescript
import type { ApiGrantStore } from './api-client/api-grant'
import type { ApiSender } from './api-client/send'
import type { CollectionStore } from './api-client/collection-store'
import type { ResponseStore } from './api-client/response-store'
import type { SendInput } from './api-client/request-resolve'
```

Add to the `ControlDeps` interface:

```typescript
  /**
   * The agent API client (design §2). Authenticated against its OWN grant store
   * with its OWN tokens — an operator token must never confer API-send, and an
   * API token must never drive panes. Absent ⇒ every /http/* route 404s.
   */
  apiClient?: {
    grants: ApiGrantStore
    sender: ApiSender
    collections: CollectionStore
    responses: ResponseStore
  }
```

Insert this block in `handleRequest` **immediately after the `CONTROL_MAX_BODY_BYTES` check and before `deps.grants.environmentForToken(token)`** (currently line 134).

**This placement is required, not incidental.** The operator check 403s any token it cannot resolve, so an API token placed after it would be rejected before ever reaching these routes. Resolving `/http/*` first is what makes "no token authenticates both surfaces" work in both directions.

**Constraint that comes with it:** the router's helpers `environment`, `parsed`, `path`, `record`, and `readBody` are all declared *after* this insertion point. The block below must not reference any of them — it parses its own pathname and uses the `body` parameter directly. Only the module-scope `json()` helper is available. This block is still fully authenticated: it resolves its own grant before doing anything.

```typescript
  // ── Agent API client (/http/*) ──────────────────────────────────────────────
  // A separate authority with separate tokens, resolved here and returned from
  // here, so no operator token can reach these routes and no API token can fall
  // through to the pane routes below. Declared BEFORE the operator-grant check,
  // so it must not use `parsed`/`path`/`record`/`readBody` (declared later).
  const apiUrl = new URL(url, 'http://127.0.0.1')
  const apiPath = apiUrl.pathname
  if (apiPath.startsWith('/http/')) {
    if (!deps.apiClient) return json(404, { error: 'not enabled' })
    const api = deps.apiClient

    const grant = api.grants.resolve(token)
    if (grant === null) {
      // Never log token material — route + reason only, matching the operator path.
      const reason = token.length === 0 ? 'missing bearer token' : 'unknown token'
      console.warn(`control-api: 403 ${method} ${apiPath} — ${reason}`)
      return json(403, { error: 'no grant' })
    }

    if (method === 'GET' && apiPath === '/http/collections') {
      const visible = api.collections
        .list(grant.environment)
        .filter((c) => grant.collections.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          origins: c.origins,
          varSets: Object.keys(c.varSets),
          requests: c.requests.map((r) => ({
            id: r.id,
            name: r.name,
            method: r.method,
            path: r.path
          }))
        }))
      return json(200, { collections: visible })
    }

    if (method === 'POST' && apiPath === '/http/send') {
      let input: SendInput
      try {
        input = JSON.parse(body) as SendInput
      } catch {
        return json(400, { error: 'invalid JSON body' })
      }
      if (typeof input?.collectionId !== 'string') {
        return json(400, { error: 'collectionId required' })
      }
      const result = await api.sender.send(grant, input)
      return result.ok ? json(200, result.view) : json(result.status, { error: result.error })
    }

    const pullMatch = /^\/http\/responses\/([^/]+)\/pull$/.exec(apiPath)
    if (pullMatch && method === 'GET') {
      // Named `pullPath`, not `path`, so it never reads as the router's own
      // later-declared `path` binding.
      const pullPath = apiUrl.searchParams.get('path')
      if (pullPath === null || pullPath.length === 0) return json(400, { error: 'path required' })
      const pulled = api.responses.pull(pullMatch[1], grant.environment, pullPath)
      if (pulled.ok) return json(200, { path: pullPath, value: pulled.value })
      if (pulled.reason === 'withheld') {
        // Layer 3 hard-refuses; the approval gate replaces this in a later plan.
        return json(403, {
          error:
            'withheld — this field is classified sensitive. You can chain it by ' +
            'reference into another request without reading it.'
        })
      }
      return json(404, { error: pulled.reason === 'unknown' ? 'unknown response' : 'unknown path' })
    }

    const viewMatch = /^\/http\/responses\/([^/]+)$/.exec(apiPath)
    if (viewMatch && method === 'GET') {
      const view = api.responses.view(viewMatch[1], grant.environment)
      return view ? json(200, view) : json(404, { error: 'unknown response' })
    }

    return json(404, { error: 'not found' })
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/api-client-routes.test.ts tests/unit/control-api.test.ts`
Expected: PASS — the new suite plus the *existing* control-api suite, which proves the operator routes are undisturbed.

- [ ] **Step 5: Commit**

```bash
git add src/main/control-api.ts tests/unit/api-client-routes.test.ts
git commit -m "feat(api-client): add /http control API routes"
```

---

### Task 13: Security probes

The tests that make the spec's claims real. Each maps to a sentence in spec §Security & isolation.

**Files:**
- Test: `tests/unit/api-client-security.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–12

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-client-security.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiSender } from '../../src/main/api-client/send'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import { CollectionSecretStore } from '../../src/main/api-client/collection-secrets'
import { ResponseStore } from '../../src/main/api-client/response-store'
import { HttpClient, MockHttpTransport } from '../../src/main/http/http-client'
import type { SecretBackend } from '../../src/main/integrations/credential-store'

const SECRET = 'sk_live_abc123'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

// Matches the established convention in `tests/unit/integration-secret-safety.test.ts`
// (which asserts the same property for `revealForConnector`): a small PRIVATE
// generator per test file — there is no shared test util — that recurses and
// filters by extension. The extension filter is required: `src/renderer` has
// subdirectories and a non-TS `index.html`.
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) yield full
  }
}

describe('security probe: the reveal exit is main-process-only', () => {
  it('has zero callers in preload or renderer', () => {
    const root = join(__dirname, '..', '..', 'src')
    for (const dir of ['preload', 'renderer']) {
      for (const file of walk(join(root, dir))) {
        const source = readFileSync(file, 'utf8')
        expect(source, `${file} must not reveal plaintext`).not.toContain('revealSecret')
        expect(source, `${file} must not import the secret store`).not.toContain(
          'CollectionSecretStore'
        )
      }
    }
  })
})

describe('security probe: an echoed credential never reaches the agent', () => {
  it('is absent from the shape, every pull, and every error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-sec-'))
    const collections = new CollectionStore({ file: join(dir, 'collections.json') })
    collections.upsert({
      id: 'echo',
      name: 'Echo',
      environment: 1,
      origins: ['https://api.test'],
      auth: { scheme: 'bearer', secretRef: 'apiKey' },
      varSets: { d: { base_url: 'https://api.test' } },
      requests: [{ id: 'r', name: 'r', method: 'GET', path: '/echo' }]
    })
    const secrets = new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') })
    secrets.set('echo', 'apiKey', SECRET)
    const responses = new ResponseStore({})

    // A deliberately hostile response: it echoes the credential in the body, in
    // a header, and in base64 and url-encoded forms.
    const transport = new MockHttpTransport(() => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-echo': SECRET
      },
      body: JSON.stringify({
        raw: SECRET,
        b64: Buffer.from(SECRET, 'utf8').toString('base64'),
        url: encodeURIComponent(SECRET),
        nested: { deep: [SECRET] }
      })
    }))

    const sender = new ApiSender({
      collections,
      secrets,
      client: new HttpClient({ transport }),
      responses
    })
    const result = await sender.send(
      { environment: 1, collections: new Set(['echo']) },
      { collectionId: 'echo', varSet: 'd', requestId: 'r' }
    )
    if (!result.ok) throw new Error('expected ok')

    // 1. Not in the shape.
    expect(JSON.stringify(result.view)).not.toContain(SECRET)

    // 2. Not in any pull, in any encoding.
    for (const path of ['$.raw', '$.b64', '$.url', '$.nested.deep[0]', '$headers.x-echo']) {
      const pulled = responses.pull(result.view.responseId, 1, path)
      expect(JSON.stringify(pulled), `${path} leaked the credential`).not.toContain(SECRET)
    }

    // 3. Not in the whole-body read either.
    expect(JSON.stringify(responses.pull(result.view.responseId, 1, '$'))).not.toContain(SECRET)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/api-client-security.test.ts`
Expected: FAIL if any probe is unmet. If both pass immediately, that is the correct outcome — these assert properties Tasks 1–12 were built to hold. Confirm they are genuinely exercised by temporarily returning `input.body` unscrubbed from `ResponseStore.ingest` and re-running: the echo probe MUST fail. Revert the sabotage before continuing.

- [ ] **Step 3: Fix anything the probes caught**

If a probe fails, the defect is in the module it names, not in the probe — fix the module, never the assertion. The two failure modes and their fixes:

- *Reveal probe fails* — a preload/renderer file references `revealSecret` or `CollectionSecretStore`. That file must go through an IPC handler in `src/main/index.ts` that returns a presence boolean, never the value. Remove the reference.
- *Echo probe fails* — `ResponseStore.ingest` is storing something before scrubbing it. Confirm `scrub(input.body, input.secrets)` runs before the value is assigned to `stored.body`, and that header values are scrubbed in the same pass (`scrub(v, input.secrets)` in the header loop).

- [ ] **Step 4: Run the full suite**

Run: `npm run check`
Expected: PASS — eslint, prettier, both tsconfigs, and the entire vitest suite.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/api-client-security.test.ts
git commit -m "test(api-client): add security probes"
```

---

## Deviations and flags for the reviewer

Raise these when the plan is reviewed; none blocks implementation.

1. **`allowLocal` is hard-coded `false`** (Task 4). An agent-composed request never opts past the SSRF guard. The spec does not cover it, and the safe default is correct for v1 — but "point the API client at `http://localhost:3000`" is a mainstream API-client use case and will be the first thing users ask for. It needs a deliberate decision (a per-collection opt-in mirroring the `http` node's) rather than arriving by accident.

2. **Withheld pulls hard-refuse.** This is the spec's own layer-3 intermediate, replaced by the approval gate in a later plan. Until then the agent has no route to a classified field at all — including the legitimate chain-forward case, which needs layer 4.

3. **`resolveRequest` forces `GET` for `http.get`.** A `spec` claiming `GET` with a body will have the body silently dropped by the existing resolver. Acceptable (a GET body is nonstandard), but it is a silent drop rather than a loud reject, which is against the house convention.

4. **History metadata persistence is not in this plan.** Spec §4 says history persists as the audit trail while bodies do not. Only the in-memory store is built here; the persistent history record belongs with the cockpit work in the renderer plan.

5. **The grant is not yet session-bound — this is a real gap against spec §6.** The spec pins the grant's lifetime to *the session that holds it*; `ApiGrantStore` as built here is per-environment and in-memory, so it dies on app restart but NOT when the holding pane exits. Closing that gap needs a session-lifecycle hook in `src/main/index.ts` (revoke on pane exit), which is outside every task here because nothing else in this plan touches app wiring. Until it lands, the honest claim is "revocable and gone on restart", not "session-bound". It should be the first task of the renderer/wiring plan, and the spec's §6 wording should not be quoted in user-facing copy before then.
