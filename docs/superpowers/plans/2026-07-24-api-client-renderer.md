# API Client Renderer & Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the API client a human surface — curate collections, grant scoped access from the Cockpit — and ship the agent-side skill, so the feature is usable without devtools.

**Architecture:** A new `ApiClient` nav destination for curation (modelled verbatim on `Integrations.tsx`), an "API access" section added to the existing `Cockpit`, a second sidebar indicator, one main-side guard that refuses double-granting a pane that already holds an operator grant, and a sibling `saiife-api` OpenClaw skill mirroring the existing `saiife` control CLI.

**Tech Stack:** React 19 + Tailwind v4 (utility classes inline), Electron preload/IPC, Vitest (unit), Playwright (e2e), a plain-JS ESM skill CLI.

**Spec:** `docs/superpowers/specs/2026-07-23-api-client-wiring-design.md` §3 (curation surface) and §4 (skill).

## Scope of this plan

The renderer surface + the agent skill + the double-grant guard the final review of the wiring milestone deferred here. After this plan the feature is end-to-end usable by a human. Deferred beyond this: `$ref` chaining (engine layer 4), the approval gate (engine layer 5), the response viewer, and persistent history — all their own future specs.

## Global Constraints

- **Commit subject ≤ 50 characters** — commitlint via husky. Conventional Commits.
- Prettier (`.prettierrc.json`): `semi: false`, `singleQuote: true`, `printWidth: 100`, **`trailingComma: "none"`**. The real gate is `prettier --check` + `npm run check` — run those. **Exempt from the 100-char guide, exactly as the shipped codebase already is:** Tailwind `className` string literals and the reused `card`/`rowBtn`/`inputCls` constants (copied verbatim from `Integrations.tsx`/`Settings.tsx`, which already exceed 100 and pass, because Prettier cannot reflow a string). The `awk 'length > 100'` checks in the steps are a guide for *breakable code* — a hit on a Tailwind class string or one of those constants is expected and fine; a hit on ordinary code is not. Do not mangle a class string to satisfy the raw count.
- **`@typescript-eslint/no-explicit-any` is an ERROR**, in `tests/` too. **`noUnusedLocals: true`.**
- **Renderer conventions (verbatim from the codebase):** every component is `export default function X(): React.JSX.Element`. Every clickable adds `onMouseDown={(e) => e.preventDefault()}` to preserve terminal focus. IPC is called directly as `window.saiife.*`, never a wrapper. Every result is the discriminated `{ ok: true; … } | { ok: false; reason }`; the renderer surfaces `reason` into a notice, never throws. Reused class strings are declared at module top with a "Reused verbatim from Settings.tsx so this reads as native saiife." comment.
- **Every interactive/assertable element gets a stable kebab-case class hook** (`api-client-panel`, `api-grant-toggle`, `api-indicator`, …) plus `data-*` for state — the e2e specs select on these, never on text/role except nav buttons.
- **The renderer never receives capability material** — collection views carry `hasSecret` booleans, the grant token is never returned. Do not add any renderer code that references `ApiGrantStore`, `SAIIFE_API_TOKEN`, or `CollectionSecretStore` (a security probe from the wiring plan asserts this; it will fail the build if violated).
- **Tailwind v4 tokens** — use `bg-idle`/`text-idle`/`bg-surface-raised`/`bg-needs-you`/`bg-exited` etc., never raw hex. `prettier-plugin-tailwindcss` sorts classes; let it.
- Unit tests: `tests/unit/*.test.ts`. E2E: `tests/e2e/*.spec.ts`, launched via the `launchApp` helper already at the top of `tests/e2e/api-client.spec.ts`. Full gate: `npm run check`. E2E: `npm run e2e -- tests/e2e/<file>` (~10s/run).

---

### Task 1: Refuse double-granting an operator pane (main-side guard)

The final review of the wiring milestone found: granting API access to a pane that holds a launch-owned operator grant restarts it, which — under the opt-in `operatorRevokeOnExit` flag — silently tears the operator grant down. Decision (with Jonas): **refuse the double-grant.** Enforced in main; the UI mirrors it in Task 5.

**Files:**
- Modify: `src/main/index.ts` (`grantApiAccess`, add a guard near the top)
- Test: `tests/e2e/api-client.spec.ts` (append a test)

**Interfaces:**
- Consumes: `launchTracker` (an `OperatorLaunchTracker`, already constructed in index.ts) — it tracks which pane ids are live operator-launch panes per environment.
- Produces: `grantApiAccess` refuses with reason `'that pane is an operator — grant API access to a different pane'` when the target pane is a live operator-launch pane.

- [ ] **Step 1: Confirm `launchTracker`'s API**

Read `src/main/operator-launch.ts`. Confirm `OperatorLaunchTracker` exposes `trackedIds(): string[]` (or equivalent) returning the currently-tracked operator-launch pane ids. If the accessor has a different name, use the real one and note it in the report. The guard needs "is this paneId a live operator-launch pane?".

- [ ] **Step 2: Write the failing e2e test**

Append to `tests/e2e/api-client.spec.ts` (reuses the file's `launchApp`, `COLLECTION`, `WithSaiife`):

```typescript
test('refuses API access to a pane that holds an operator grant', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apidouble-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (c) => (window as unknown as WithSaiife).saiife.upsertCollection(1, c),
    COLLECTION
  )
  if (!created.ok) throw new Error(created.reason)
  const collectionId = created.view.id

  // Grant an operator on env 1 and launch its openclaw pane, so the pane is a
  // live operator-launch pane. grantOperator + a companion pane is how the app
  // does it; here we drive the IPC the Cockpit toggle uses, then create the
  // openclaw pane the operator owns.
  const opPane = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('openclaw', cwd),
    userData
  )
  if (!opPane) throw new Error('operator pane not created')

  // Attempt to grant API access to that same operator pane — must be refused.
  const refused = await win.evaluate(
    ([pid, cid]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [cid]),
    [opPane.id, collectionId] as const
  )
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.reason).toMatch(/operator/i)

  await app.close()
})
```

Note: if `createSession('openclaw', …)` does not by itself register the pane with `launchTracker` in the e2e harness, the guard still must key off whatever marks a pane as operator-owned. During Step 1, determine the real signal a pane is operator-owned and make both the guard and this test key off it. If the test cannot create a genuinely operator-owned pane in the e2e harness, say so in the report and fall back to a unit-level test of the guard predicate instead — do not ship the guard untested.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts`
Expected: FAIL — with no guard, `grantApiAccess` returns `ok: true` for the operator pane, so `refused.ok` is `true`.

- [ ] **Step 4: Add the guard**

In `src/main/index.ts`, inside `grantApiAccess`, after the existing pane-validity checks and BEFORE the empty-collections check (so an operator pane is refused regardless of collection selection), add:

```typescript
    // Refuse double-granting: if this pane holds an operator grant, granting API
    // access would restart it and — under the opt-in operatorRevokeOnExit flag —
    // silently revoke that operator grant. A pane is an operator XOR an API
    // client, never both. (Decided with Jonas 2026-07-24.)
    if (launchTracker.trackedIds().includes(paneId)) {
      return { ok: false, reason: 'that pane is an operator — grant API access to a different pane' }
    }
```

Use the real accessor name confirmed in Step 1 if it differs.

- [ ] **Step 5: Run it, confirm pass, then commit**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts` (expect the new test + the existing ones green), then `npm run check`.

```bash
git add src/main/index.ts tests/e2e/api-client.spec.ts
git commit -m "feat(api-client): refuse double-granting operator pane"
```

---

### Task 2: The `saiife-api` agent skill

A sibling of `openclaw/skills/saiife/`, mirroring its structure exactly. Pure, self-contained, no renderer dependency — safe to build independently.

**Files:**
- Create: `openclaw/skills/saiife-api/SKILL.md`
- Create: `openclaw/skills/saiife-api/bin/saiife-api.mjs`
- Create: `openclaw/skills/saiife-api/bin/saiife-api.d.mts`
- Test: `tests/unit/saiife-api-cli.test.ts`

**Interfaces:**
- Produces: `buildRequest(base, argv): { method, path, body? }` mapping the four verbs `collections` / `send` / `response` / `pull` onto the `/http/*` routes.

**Contract (verified against `control-api.ts`):** auth is `Authorization: Bearer <SAIIFE_API_TOKEN>` against `<SAIIFE_API_ENDPOINT>` (origin, no path). Routes: `GET /http/collections`, `POST /http/send` (JSON `SendInput` — `{ collectionId, varSet?, requestId?, spec?, vars? }`), `GET /http/responses/:id`, `GET /http/responses/:id/pull?path=<jsonpath>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/saiife-api-cli.test.ts` (mirrors `tests/unit/saiife-cli.test.ts`):

```typescript
import { describe, it, expect } from 'vitest'
import { buildRequest } from '../../openclaw/skills/saiife-api/bin/saiife-api.mjs'

describe('saiife-api buildRequest', () => {
  const base = 'http://127.0.0.1:5000'

  it('maps collections to GET /http/collections', () => {
    expect(buildRequest(base, ['collections'])).toMatchObject({
      method: 'GET',
      path: '/http/collections'
    })
  })

  it('maps send of a saved request to POST /http/send', () => {
    const r = buildRequest(base, ['send', 'stripe', '--request', 'charges', '--varset', 'test'])
    expect(r).toMatchObject({
      method: 'POST',
      path: '/http/send',
      body: { collectionId: 'stripe', requestId: 'charges', varSet: 'test' }
    })
  })

  it('maps send with an inline JSON spec to POST /http/send', () => {
    const spec = JSON.stringify({ method: 'GET', path: '/v1/charges' })
    const r = buildRequest(base, ['send', 'stripe', '--spec', spec])
    expect(r).toMatchObject({
      method: 'POST',
      path: '/http/send',
      body: { collectionId: 'stripe', spec: { method: 'GET', path: '/v1/charges' } }
    })
  })

  it('maps response to GET /http/responses/:id', () => {
    expect(buildRequest(base, ['response', 'r3'])).toMatchObject({
      method: 'GET',
      path: '/http/responses/r3'
    })
  })

  it('maps pull to GET /http/responses/:id/pull with an encoded path query', () => {
    const r = buildRequest(base, ['pull', 'r3', '$.data[0].id'])
    expect(r).toMatchObject({
      method: 'GET',
      path: `/http/responses/r3/pull?path=${encodeURIComponent('$.data[0].id')}`
    })
  })

  it('throws on an unknown verb', () => {
    expect(() => buildRequest(base, ['nope'])).toThrow(/unknown verb/)
  })

  it('throws when send has neither --request nor --spec', () => {
    expect(() => buildRequest(base, ['send', 'stripe'])).toThrow(/--request or --spec/)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/saiife-api-cli.test.ts`
Expected: FAIL — cannot resolve `saiife-api.mjs`.

- [ ] **Step 3: Write the CLI**

Create `openclaw/skills/saiife-api/bin/saiife-api.mjs` (mirrors `saiife-control.mjs`'s structure — exported pure `buildRequest`, `main()` reads env + fetches):

```javascript
#!/usr/bin/env node
/**
 * saiife API-client CLI, wrapped by the OpenClaw `saiife-api` skill. Reads the
 * grant endpoint + token from SAIIFE_API_ENDPOINT / SAIIFE_API_TOKEN (distinct
 * from the operator skill's SAIIFE_ENDPOINT / SAIIFE_TOKEN) and turns a verb
 * into one control-API request against /http/*, printing the JSON response.
 *
 * The credential the request carries is NEVER seen here — the main process
 * substitutes it by reference; responses come back as shape/values-by-pull.
 */

const isFlag = (s) => typeof s === 'string' && s.startsWith('--')

/** Read `--name value` pairs and positionals out of an argv tail. */
function parseFlags(rest) {
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (isFlag(rest[i])) {
      flags[rest[i].slice(2)] = rest[i + 1]
      i++
    } else {
      positional.push(rest[i])
    }
  }
  return { flags, positional }
}

/** Pure verb → request mapping (exported for unit tests). */
export function buildRequest(base, argv) {
  const [verb, ...rest] = argv
  switch (verb) {
    case 'collections':
      return { method: 'GET', path: '/http/collections' }
    case 'send': {
      const { flags, positional } = parseFlags(rest)
      const collectionId = positional[0]
      if (!collectionId) throw new Error('send needs a <collectionId>')
      const body = { collectionId }
      if (flags.varset) body.varSet = flags.varset
      if (flags.request) body.requestId = flags.request
      else if (flags.spec) body.spec = JSON.parse(flags.spec)
      else throw new Error('send needs --request <id> or --spec <json>')
      if (flags.vars) body.vars = JSON.parse(flags.vars)
      return { method: 'POST', path: '/http/send', body }
    }
    case 'response':
      if (!rest[0]) throw new Error('response needs a <responseId>')
      return { method: 'GET', path: `/http/responses/${rest[0]}` }
    case 'pull': {
      const [responseId, jsonPath] = rest
      if (!responseId || !jsonPath) throw new Error('pull needs a <responseId> and a <path>')
      return {
        method: 'GET',
        path: `/http/responses/${responseId}/pull?path=${encodeURIComponent(jsonPath)}`
      }
    }
    default:
      throw new Error(`unknown verb: ${verb}`)
  }
}

async function main() {
  const base = process.env.SAIIFE_API_ENDPOINT
  const token = process.env.SAIIFE_API_TOKEN
  if (!base || !token) throw new Error('SAIIFE_API_ENDPOINT and SAIIFE_API_TOKEN required')
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(String(e) + '\n')
    process.exit(1)
  })
}
```

Create `openclaw/skills/saiife-api/bin/saiife-api.d.mts` (verbatim shape of the existing `.d.mts`):

```typescript
/** Minimal type declaration for the JS CLI, so tsc can type-check the test
 *  that imports it without enabling allowJs on the whole node project. */
export interface ControlRequest {
  method: string
  path: string
  body?: Record<string, unknown>
}

export function buildRequest(base: string, argv: string[]): ControlRequest
```

Create `openclaw/skills/saiife-api/SKILL.md`:

```markdown
---
name: saiife-api
description: Send HTTP requests through a granted saiife API collection — list collections, send saved or ad-hoc requests, read response shapes, and pull individual values. The credential stays on the machine; you work through a reference and never see it.
metadata:
  openclaw:
    requires:
      bins: [node]
      env: [SAIIFE_API_ENDPOINT, SAIIFE_API_TOKEN]
---

# saiife API-client skill

saiife exposes a loopback API-client surface scoped to the ONE environment and
collection set this grant covers. You compose and send HTTP requests against a
curated collection's declared origins; the API credential is substituted by the
main process and NEVER enters your context. Responses come back as a *shape*
(paths, types, sizes — no values); you pull individual scalar values by path.

Auth is the per-grant bearer token in `SAIIFE_API_TOKEN` (distinct from the
operator skill's `SAIIFE_TOKEN`).

Run the wrapped CLI:

    node "$SKILL_DIR/bin/saiife-api.mjs" <verb> [args...]

Verbs:

- `collections` — list the collections this grant can send against, with their
  origins, varSet names, and saved requests.
- `send <collectionId> --request <requestId> [--varset <name>] [--vars <json>]`
  — send a saved request.
- `send <collectionId> --spec <json> [--varset <name>] [--vars <json>]`
  — send an ad-hoc request. `<json>` is `{ "method", "path", "headers"?, "body"? }`;
  `path` is joined to the varSet's `base_url` or a full URL, and must resolve
  inside the collection's declared origins.
- `response <responseId>` — re-read a response's shape.
- `pull <responseId> <path>` — read one scalar value, e.g. `pull r3 '$.data[0].id'`.
  A withheld field returns 403 (chain it by reference instead of reading it); a
  path resolving to an object/array returns 400 (pull a leaf path under it).

A send returns `{ responseId, status, durationMs, shape }`. Read the shape to
find the leaf paths you need, then `pull` them. To use a value from one response
in the next request without ever seeing it, put `{ "$ref": "r3:$.access_token" }`
in a spec/vars field (resolved main-side).
```

- [ ] **Step 4: Run the test, confirm pass**

Run: `npx vitest run tests/unit/saiife-api-cli.test.ts && npx prettier --check openclaw/skills/saiife-api/bin/saiife-api.mjs tests/unit/saiife-api-cli.test.ts && npx tsc --noEmit -p tsconfig.node.json`
Expected: PASS — 7 tests. Confirm `tsconfig.node.json` includes the `.mjs`/test the same way it does the existing `saiife-control` test (the existing `saiife-cli.test.ts` compiles, so the pattern already works).

- [ ] **Step 5: Commit**

```bash
chmod +x openclaw/skills/saiife-api/bin/saiife-api.mjs
git add openclaw/skills/saiife-api tests/unit/saiife-api-cli.test.ts
git commit -m "feat(skill): add the saiife-api agent skill"
```

---

### Task 3: Nav destination + ApiClient curation shell

The new `ApiClient` view: list an environment's collections, create one (name / origins / auth / `allowLocal`), delete one. Credential entry and varSets/requests are Task 4.

**Files:**
- Create: `src/renderer/src/components/ApiClient.tsx`
- Modify: `src/renderer/src/App.tsx` (view union, `enterApiClient`, render branch, Sidebar `view=` ternary + `onApiClient` prop)
- Modify: `src/renderer/src/components/Sidebar.tsx` (`Props`, destructure, a nav button)
- Test: `tests/e2e/api-client-ui.spec.ts` (new)

**Interfaces:**
- Consumes: `window.saiife.listCollections(environment)`, `.upsertCollection(environment, collection)`, `.removeCollection(id)` (return `CollectionView[]`, `UpsertCollectionResult`, `RemoveCollectionResult`).
- Produces: an `ApiClient` component `export default function ApiClient({ environment }: { environment: number }): React.JSX.Element`, rendered at the new `'apiclient'` view.

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/api-client-ui.spec.ts`. Model the launch on `tests/e2e/api-client.spec.ts` (copy its `launchApp`; this file drives the UI via clicks like `operator.spec.ts`):

```typescript
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

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

test('curates a collection through the API client UI', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiui-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  await win.getByRole('button', { name: 'API', exact: true }).click()
  await expect(win.locator('.api-client-view')).toBeVisible()

  // Create a collection.
  await win.locator('.api-client-new').click()
  await win.locator('.api-collection-name').fill('Stripe')
  await win.locator('.api-collection-origins').fill('https://api.stripe.com')
  await win.locator('.api-collection-secretref').fill('apiKey')
  await win.locator('.api-collection-save').click()

  await expect(win.locator('.api-client-panel[data-collection]')).toHaveCount(1)
  await expect(win.locator('.api-client-panel')).toContainText('Stripe')

  await app.close()
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run e2e -- tests/e2e/api-client-ui.spec.ts`
Expected: FAIL — no `API` nav button exists.

- [ ] **Step 3: Wire the nav + write the shell**

**(a) `src/renderer/src/App.tsx`** — add `'apiclient'` to the `view` union (after `'integrations'`):

```tsx
    | 'integrations'
    | 'apiclient'
    | 'flows'
```

Add the enter fn beside `enterIntegrations`:

```tsx
  const enterApiClient = (): void => setView('apiclient')
```

Add a render branch in the `<main>` ternary, after the `view === 'integrations'` branch:

```tsx
        ) : view === 'apiclient' ? (
          <ApiClient environment={environment} />
```

Add `import ApiClient from './components/ApiClient'` at the top with the other component imports. In the `<Sidebar>` `view=` ternary, add the branch nested after `integrations` (one level deeper, matching the existing indentation ladder):

```tsx
                        : view === 'integrations'
                          ? 'integrations'
                          : view === 'apiclient'
                            ? 'apiclient'
                            : view === 'flows'
                              ? 'flows'
                              : 'home'
```

and pass `onApiClient={enterApiClient}` beside `onIntegrations={enterIntegrations}` in the `<Sidebar .../>` props.

**(b) `src/renderer/src/components/Sidebar.tsx`** — add `'apiclient'` to the `Props.view` union (after `integrations`), add `onApiClient: () => void` to `Props` (after `onIntegrations`), destructure `onApiClient` in the same position, and add a nav button after the Integrations button (match the exact button shape):

```tsx
        <button
          className={`${navItemBase}${view === 'apiclient' ? ` ${navItemActive}` : ''}`}
          onClick={onApiClient}
          onMouseDown={(e) => e.preventDefault()}
        >
          API
        </button>
```

**(c) `src/renderer/src/components/ApiClient.tsx`** — the curation shell. Model the page shell + `card`/`rowBtn`/`inputCls` verbatim on `Integrations.tsx`. This step implements list + create + delete only; secrets/varSets/requests are Task 4.

```tsx
import { useEffect, useState } from 'react'
import type { CollectionView } from '../../../shared/api-client'

// Reused verbatim from Settings.tsx so this reads as native saiife.
const card =
  'bg-surface-raised flex flex-col gap-2.5 rounded-[10px] border border-white/10 p-3.5 text-left'
const rowBtn =
  'cursor-pointer rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-xs text-gray-300 hover:bg-white/[0.13] hover:text-white'
const inputCls =
  'bg-surface rounded-md border border-white/[0.14] px-2.5 py-1.5 font-mono text-[11px] text-gray-200 outline-none focus:border-white/40'

interface Props {
  environment: number
}

/**
 * Curate the API-client collections an agent can be granted against, for one
 * environment. A collection owns its origins, auth config, credential (keychain,
 * write-only), varSets and saved requests. The credential value is never read
 * back — the view carries only `hasSecret`. Granting access lives in the Cockpit.
 */
export default function ApiClient({ environment }: Props): React.JSX.Element {
  const [collections, setCollections] = useState<CollectionView[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = (): void => {
    void window.saiife.listCollections(environment).then(setCollections)
  }
  useEffect(() => {
    let cancelled = false
    void window.saiife.listCollections(environment).then((c) => {
      if (!cancelled) setCollections(c)
    })
    return () => {
      cancelled = true
    }
  }, [environment])

  const remove = (id: string): void => {
    void window.saiife.removeCollection(id).then((res) => {
      if (!res.ok) setNotice(res.reason)
      else reload()
    })
  }

  return (
    <div className="api-client-view mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-8 text-left">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">API client</h3>
          <p className="m-0 text-[13px] text-gray-500">
            Collections an agent can be granted to send against · env {environment}
          </p>
        </div>
        <button
          className={`api-client-new ${rowBtn}`}
          onClick={() => setCreating(true)}
          onMouseDown={(e) => e.preventDefault()}
        >
          New collection
        </button>
      </div>

      {creating && (
        <NewCollection
          environment={environment}
          onDone={() => {
            setCreating(false)
            reload()
          }}
          onCancel={() => setCreating(false)}
          onError={setNotice}
        />
      )}

      {collections === null ? (
        <p className="text-[13px] text-gray-500">Loading collections…</p>
      ) : collections.length === 0 && !creating ? (
        <p className="text-[13px] text-gray-500">No collections yet.</p>
      ) : (
        collections.map((c) => (
          <section key={c.id} className={`api-client-panel ${card}`} data-collection={c.id}>
            <div className="flex items-center gap-2">
              <span className="flex-1 font-semibold">{c.name}</span>
              {c.allowLocal && <span className="text-[11px] text-needs-you">local ok</span>}
              <button
                className={`api-collection-delete ${rowBtn}`}
                onClick={() => remove(c.id)}
                onMouseDown={(e) => e.preventDefault()}
              >
                Delete
              </button>
            </div>
            <div className="font-mono text-[11px] text-gray-500">{c.origins.join(', ')}</div>
            <div className="text-[12px] text-gray-400">
              auth: {c.auth.scheme}
              {c.auth.secretRef ? ` · ${c.auth.secretRef}` : ''} ·{' '}
              {c.hasSecret ? 'credential set' : 'no credential'}
            </div>
          </section>
        ))
      )}

      {notice && <p className="api-client-notice m-0 text-[12px] text-red-400">{notice}</p>}
    </div>
  )
}

function NewCollection({
  environment,
  onDone,
  onCancel,
  onError
}: {
  environment: number
  onDone: () => void
  onCancel: () => void
  onError: (reason: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [origins, setOrigins] = useState('')
  const [scheme, setScheme] = useState('bearer')
  const [secretRef, setSecretRef] = useState('')
  const [header, setHeader] = useState('')
  const [allowLocal, setAllowLocal] = useState(false)

  const save = (): void => {
    const auth =
      scheme === 'none'
        ? { scheme: 'none' }
        : scheme === 'header'
          ? { scheme, secretRef, header }
          : { scheme, secretRef }
    const collection = {
      name,
      origins: origins
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
      auth,
      allowLocal,
      varSets: {},
      requests: []
    }
    void window.saiife.upsertCollection(environment, collection).then((res) => {
      if (!res.ok) onError(res.reason)
      else onDone()
    })
  }

  return (
    <section className={`api-client-new-panel ${card}`}>
      <input
        className={`api-collection-name ${inputCls}`}
        placeholder="name, e.g. Stripe"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={`api-collection-origins ${inputCls}`}
        placeholder="origins, comma-separated — https://api.stripe.com"
        value={origins}
        onChange={(e) => setOrigins(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <select
          className={`api-collection-scheme ${inputCls}`}
          value={scheme}
          onChange={(e) => setScheme(e.target.value)}
        >
          <option value="bearer">bearer</option>
          <option value="basic">basic</option>
          <option value="header">header</option>
          <option value="none">none</option>
        </select>
        {scheme !== 'none' && (
          <input
            className={`api-collection-secretref ${inputCls} flex-1`}
            placeholder="secretRef — keychain field name, NOT the secret"
            value={secretRef}
            onChange={(e) => setSecretRef(e.target.value)}
          />
        )}
        {scheme === 'header' && (
          <input
            className={`api-collection-header ${inputCls}`}
            placeholder="header, e.g. X-API-Key"
            value={header}
            onChange={(e) => setHeader(e.target.value)}
          />
        )}
      </div>
      <label className="flex items-center gap-2 text-[12px] text-gray-400">
        <input
          type="checkbox"
          className="api-collection-allowlocal"
          checked={allowLocal}
          onChange={(e) => setAllowLocal(e.target.checked)}
        />
        Allow loopback/LAN targets (localhost) — bypasses the SSRF guard for this
        collection's origins
      </label>
      <div className="flex gap-2">
        <button
          className={`api-collection-save ${rowBtn}`}
          onClick={save}
          onMouseDown={(e) => e.preventDefault()}
          disabled={name.length === 0}
        >
          Save
        </button>
        <button
          className={rowBtn}
          onClick={onCancel}
          onMouseDown={(e) => e.preventDefault()}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Run the e2e, confirm pass**

Run: `npm run e2e -- tests/e2e/api-client-ui.spec.ts`, then `npm run check`, then `awk 'length > 100 {print FILENAME": "FNR": "length}' src/renderer/src/components/ApiClient.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ApiClient.tsx src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx tests/e2e/api-client-ui.spec.ts
git commit -m "feat(api-client): add curation nav + collection CRUD"
```

---

### Task 4: Credential entry, varSets, and saved requests

Extend `ApiClient.tsx` with the write-only credential field (verbatim `SecretField` pattern from `Integrations.tsx`), editable varSets, and saved requests.

**Files:**
- Modify: `src/renderer/src/components/ApiClient.tsx`
- Test: `tests/e2e/api-client-ui.spec.ts` (append)

**Interfaces:**
- Consumes: `window.saiife.setCollectionSecret(collectionId, secretRef, value)`, `.clearCollectionSecret(collectionId, secretRef?)`, and `.upsertCollection` (to persist varSet/request edits — send the full updated collection with its existing `id`).

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/api-client-ui.spec.ts`:

```typescript
test('stores a credential write-only and edits a varSet', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apiui2-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  await win.getByRole('button', { name: 'API', exact: true }).click()
  await win.locator('.api-client-new').click()
  await win.locator('.api-collection-name').fill('Stripe')
  await win.locator('.api-collection-origins').fill('https://api.stripe.com')
  await win.locator('.api-collection-secretref').fill('apiKey')
  await win.locator('.api-collection-save').click()
  await expect(win.locator('.api-client-panel[data-collection]')).toHaveCount(1)

  // Store the credential — write-only. Value must never appear in the DOM.
  await win.locator('.api-secret').fill('sk_live_ui_secret')
  await win.locator('.api-secret-save').click()
  await expect(win.locator('.api-secret-set')).toBeVisible()
  expect(await win.locator('.api-client-view').innerText()).not.toContain('sk_live_ui_secret')

  await app.close()
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run e2e -- tests/e2e/api-client-ui.spec.ts`
Expected: FAIL — no `.api-secret` field.

- [ ] **Step 3: Extend the collection panel**

In `ApiClient.tsx`, add a `SecretField` component (copy the structure verbatim from `Integrations.tsx`'s `SecretField`, adapting the IPC calls and class hooks) and render it inside each `.api-client-panel`, plus varSet and request editors. Key adaptations:

- The stored state renders `<span className="api-secret-set text-idle font-mono text-[12px]">•••• set</span>` + Replace/Clear (`api-secret-replace`, `api-secret-clear`).
- The editing state renders `<input type="password" className="api-secret …">` + Save (`api-secret-save`), disabled when empty.
- `save` calls `window.saiife.setCollectionSecret(collection.id, collection.auth.secretRef, value)`; on `ok` clear the input, exit editing, and `reload()`. `clear` calls `window.saiife.clearCollectionSecret(collection.id, collection.auth.secretRef)`. Only render `SecretField` when `collection.auth.scheme !== 'none'` (a `none`-scheme collection has no secretRef).
- Presence comes from `collection.hasSecret` (initial `editing = !collection.hasSecret`).

For **varSets** — render each named set as a block of key/value rows with add/remove, and a "New varSet" control; on any edit, persist by calling `window.saiife.upsertCollection(environment, { ...collection, varSets: nextVarSets })` (send the whole collection with its `id` so it updates in place). Give the varSet name input `api-varset-name`, key/value inputs `api-var-key`/`api-var-value`.

For **requests** — render each saved request as a row (name, a method `<select>` over `GET/POST/PUT/PATCH/DELETE`, path) with add/remove, persisted the same way via `upsertCollection`. Hooks: `api-request-name`, `api-request-method`, `api-request-path`.

Keep the whole component's lines ≤ 100 chars; extract sub-components (`SecretField`, `VarSetEditor`, `RequestEditor`) as sibling functions in the same file rather than one giant JSX block, so each is holdable in context.

If the credential value is passed as a prop anywhere, it is only the *input* value in local state — it is never read from the view. Do not add a prop that carries a stored secret; there is none.

- [ ] **Step 4: Run the e2e, confirm pass**

Run: `npm run e2e -- tests/e2e/api-client-ui.spec.ts`, then `npm run check`, then the `awk` line-length check on `ApiClient.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/ApiClient.tsx tests/e2e/api-client-ui.spec.ts
git commit -m "feat(api-client): credential, varSets, requests UI"
```

---

### Task 5: Cockpit "API access" section

Grant/revoke API access from the Cockpit, beside the operator grant — a separate section (never merged into one "capabilities" block). Collection multi-select, pane picker (terminal panes only, excluding operator panes per Task 1's guard), status line.

**Files:**
- Modify: `src/renderer/src/components/Cockpit.tsx` (add the section; add a `sessions` prop)
- Modify: `src/renderer/src/App.tsx` (pass `sessions` to `<Cockpit>`)
- Test: `tests/e2e/api-client-ui.spec.ts` (append)

**Interfaces:**
- Consumes: `window.saiife.apiGrantStatus(environment)` → `ApiGrantStatus`; `.grantApiAccess(environment, paneId, collectionIds)` → `ApiGrantResult`; `.revokeApiAccess(environment)`; `.listCollections(environment)`; `sessions: SessionInfo[]` prop.
- Produces: an `.api-access` section with `.api-grant-toggle`, a `.api-collection-select`, a `.api-pane-select`, and a `.api-status` line.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/api-client-ui.spec.ts`:

```typescript
test('grants API access from the Cockpit', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sf-apicockpit-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  // Curate a collection via IPC (fast path; the UI curation is covered elsewhere).
  await win.evaluate(
    (c) =>
      (
        window as unknown as {
          saiife: { upsertCollection: (e: number, col: unknown) => Promise<unknown> }
        }
      ).saiife.upsertCollection(1, c),
    {
      name: 'Stripe',
      origins: ['https://api.stripe.com'],
      auth: { scheme: 'bearer', secretRef: 'apiKey' },
      varSets: {},
      requests: []
    }
  )
  // Create a terminal pane to grant to.
  await win.evaluate(
    (cwd) =>
      (
        window as unknown as {
          saiife: { createSession: (a: string, c?: string) => Promise<unknown> }
        }
      ).saiife.createSession('claude', cwd),
    userData
  )

  await win.getByRole('button', { name: 'Cockpit', exact: true }).click()
  await expect(win.locator('.api-access')).toBeVisible()
  await expect(win.locator('.api-status')).toContainText('No API grant')

  // Select the collection + pane, grant.
  await win.locator('.api-collection-select').selectOption({ index: 0 })
  await win.locator('.api-pane-select').selectOption({ index: 0 })
  await win.locator('.api-grant-toggle').click()

  await expect(win.locator('.api-status')).toContainText('granted', { timeout: 10_000 })
  await expect(win.locator('.api-indicator[data-environment="1"]')).toBeVisible({ timeout: 10_000 })

  await app.close()
})
```

(The `.api-indicator` assertion depends on Task 6; if Task 5 lands first, drop that one line and re-add it in Task 6. Note this in the report.)

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run e2e -- tests/e2e/api-client-ui.spec.ts`
Expected: FAIL — no `.api-access` section.

- [ ] **Step 3: Add the section + the `sessions` prop**

**(a) `src/renderer/src/App.tsx`** — pass sessions to Cockpit. The file already has `const envSessions = sessions.filter((s) => s.environment === environment)`; pass the full `sessions` (Cockpit filters itself, so a later environment switch is reflected):

```tsx
        ) : view === 'cockpit' ? (
          <Cockpit environment={environment} sessions={sessions} />
```

**(b) `src/renderer/src/components/Cockpit.tsx`** — add top-level imports beside the existing ones (the file already imports from `../../../shared/operator`):

```tsx
import type { SessionInfo } from '../../../shared/types'
import type { ApiGrantStatus, CollectionView } from '../../../shared/api-client'
```

extend `Props`:

```tsx
interface Props {
  environment: number
  sessions: SessionInfo[]
}
```

and destructure `sessions` in the function signature. Add API-grant state + a reload, mirroring the operator ones:

```tsx
  const [apiStatus, setApiStatus] = useState<ApiGrantStatus | null>(null)
  const [apiCollections, setApiCollections] = useState<CollectionView[]>([])
  const [pickedCollections, setPickedCollections] = useState<string[]>([])
  const [pickedPane, setPickedPane] = useState('')
  const [apiNotice, setApiNotice] = useState<string | null>(null)

  const reloadApi = useCallback(async (): Promise<void> => {
    setApiStatus(await window.saiife.apiGrantStatus(environment))
    setApiCollections(await window.saiife.listCollections(environment))
  }, [environment])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount / environment change
    void reloadApi()
  }, [reloadApi])
```

Add grant/revoke handlers:

```tsx
  const apiGranted = apiStatus?.granted ?? false

  const grantApi = async (): Promise<void> => {
    const res = await window.saiife.grantApiAccess(environment, pickedPane, pickedCollections)
    if (!res.ok) setApiNotice(res.reason)
    else {
      setApiNotice(null)
      await reloadApi()
    }
  }
  const revokeApi = async (): Promise<void> => {
    await window.saiife.revokeApiAccess(environment)
    await reloadApi()
  }
```

Render the section right after the operator header block (after the `status?.endpoint` block, before the activity log). Terminal panes only, excluding browser panes; the main-side guard also refuses operator panes, so a refused grant surfaces its reason via `apiNotice`:

```tsx
      <div className="api-access flex flex-none flex-col gap-2 border-b border-white/[0.07] px-3 py-2 text-[12px]">
        <div className="flex items-center gap-2">
          <span className="api-status font-semibold">
            {apiGranted
              ? `API granted · ${apiStatus?.collectionIds?.length ?? 0} collection(s)`
              : 'No API grant'}
          </span>
          <span className="text-gray-500">· env {environment}</span>
        </div>
        {apiGranted ? (
          <button
            className="api-grant-toggle self-start rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-gray-200 hover:bg-white/[0.13]"
            onClick={() => void revokeApi()}
            onMouseDown={(e) => e.preventDefault()}
          >
            Revoke API access
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              multiple
              className="api-collection-select bg-surface rounded-md border border-white/[0.14] px-2 py-1 text-[11px]"
              value={pickedCollections}
              onChange={(e) =>
                setPickedCollections(
                  [...e.target.selectedOptions].map((o) => o.value)
                )
              }
            >
              {apiCollections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="api-pane-select bg-surface rounded-md border border-white/[0.14] px-2 py-1 text-[11px]"
              value={pickedPane}
              onChange={(e) => setPickedPane(e.target.value)}
            >
              <option value="">choose a pane…</option>
              {sessions
                .filter((s) => s.environment === environment && s.kind === 'terminal')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <button
              className="api-grant-toggle rounded-md border border-white/10 bg-white/[0.07] px-2.5 py-1 text-gray-200 hover:bg-white/[0.13] disabled:opacity-40"
              onClick={() => void grantApi()}
              onMouseDown={(e) => e.preventDefault()}
              disabled={pickedPane === '' || pickedCollections.length === 0}
            >
              Grant API access (restarts the pane)
            </button>
          </div>
        )}
        {apiNotice && <span className="api-notice text-red-400">{apiNotice}</span>}
      </div>
```

Add `useCallback` to the React import if not present. The inline `import('…')` type expressions avoid extra top-level imports; if the reviewer prefers named imports, hoist them — either is fine.

- [ ] **Step 4: Run the e2e, confirm pass**

Run: `npm run e2e -- tests/e2e/api-client-ui.spec.ts`, then `npm run check`, then the `awk` check on `Cockpit.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Cockpit.tsx src/renderer/src/App.tsx tests/e2e/api-client-ui.spec.ts
git commit -m "feat(api-client): grant API access from the Cockpit"
```

---

### Task 6: Sidebar indicator + App polling

A second per-environment dot (`api-indicator`) beside the operator dot, fed by a poll of `apiGrantStatus` mirroring the existing `grantedEnvs` fan-out.

**Files:**
- Modify: `src/renderer/src/App.tsx` (`apiGrantedEnvs` state + poll; pass to Sidebar)
- Modify: `src/renderer/src/components/Sidebar.tsx` (`Props`, destructure, the dot)
- Test: `tests/e2e/api-client-ui.spec.ts` (re-add the `.api-indicator` assertion from Task 5 if it was dropped)

**Interfaces:**
- Consumes: `window.saiife.apiGrantStatus(environment)`.
- Produces: `apiGrantedEnvs: Set<number>` passed to `Sidebar`; an `.api-indicator[data-environment=n]` dot.

- [ ] **Step 1: Add the poll in `App.tsx`**

Beside `grantedEnvs` (line ~138):

```tsx
  // Which environments currently have an API grant, for the sidebar indicator.
  const [apiGrantedEnvs, setApiGrantedEnvs] = useState<Set<number>>(new Set())
```

Fold it into the existing `grantedEnvs` polling effect's `tick` so both statuses come from one pass (the effect is keyed on `[sessions]`):

```tsx
    const tick = async (): Promise<void> => {
      const envs = [...new Set(sessions.map((s) => s.environment))]
      const [opFlags, apiFlags] = await Promise.all([
        Promise.all(envs.map((e) => window.saiife.operatorStatus(e))),
        Promise.all(envs.map((e) => window.saiife.apiGrantStatus(e)))
      ])
      if (cancelled) return
      setGrantedEnvs(new Set(opFlags.filter((f) => f.granted).map((f) => f.environment)))
      setApiGrantedEnvs(new Set(apiFlags.filter((f) => f.granted).map((f) => f.environment)))
    }
```

Pass `apiGrantedEnvs={apiGrantedEnvs}` to `<Sidebar>` beside `grantedEnvs={grantedEnvs}`.

- [ ] **Step 2: Add the dot in `Sidebar.tsx`**

Add `apiGrantedEnvs: Set<number>` to `Props` (after `grantedEnvs`), destructure it, and render the dot right after the operator-indicator block (before the count span):

```tsx
                {apiGrantedEnvs.has(n) && (
                  <span
                    className="api-indicator bg-working ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                    data-environment={n}
                    data-api-granted="true"
                    title="An agent can send API requests in this environment"
                  />
                )}
```

(Uses `bg-working` — a distinct color from the operator dot's `bg-idle` — so the two are distinguishable at a glance.)

- [ ] **Step 3: Ensure the e2e asserts the dot**

Confirm `tests/e2e/api-client-ui.spec.ts`'s Cockpit-grant test includes the `.api-indicator[data-environment="1"]` visibility assertion (re-add it if Task 5 dropped it). Run: `npm run e2e -- tests/e2e/api-client-ui.spec.ts`.

- [ ] **Step 4: Full gate**

Run: `npm run check`, then `awk 'length > 100 {print FILENAME": "FNR": "length}' src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx tests/e2e/api-client-ui.spec.ts
git commit -m "feat(api-client): sidebar API-grant indicator"
```

---

## Deviations and flags for the reviewer

1. **The plan gives complete code for interface-bearing and novel parts** (the shell, the grant section, the guard, the skill CLI) but references `Integrations.tsx`'s `SecretField` verbatim for the mechanical credential field in Task 4 rather than transcribing 90 lines that would duplicate it. This matches the codebase's own "reused verbatim so it reads as native saiife" convention. If a reviewer wants the full field inlined, that is a Task 4 expansion, not a defect.

2. **Task 1's e2e may not be able to create a genuinely operator-owned pane in the harness.** The `launchTracker` only tracks panes launched through the operator-grant path, and the e2e fake environment may not exercise it. The task says: if a real operator-owned pane can't be created in e2e, fall back to a unit test of the guard predicate. Do not ship the guard untested. Confirm which path was taken in the report.

3. **`apiGrantStatus` is polled per-environment in the sidebar fan-out (Task 6), 3s interval** — the same cost as the existing operator poll, now two calls per environment per tick. For the 1–9 environment range this is negligible; if it ever matters, a combined status IPC is the fix, deferred.

4. **Multi-select UX.** Task 5 uses a native `<select multiple>` for the collection picker — functional and e2e-driveable (`selectOption`), but not the prettiest. If the design wants checkboxes instead, that is a visual refinement on top, not a blocker; keep the `.api-collection-select` hook stable for the e2e either way.

5. **No new security probe is added** — the wiring plan's `api-client-wiring-security.test.ts` already asserts no preload/renderer file references `ApiGrantStore`/`SAIIFE_API_TOKEN`/`CollectionSecretStore`, and it walks `src/renderer`, so it covers `ApiClient.tsx` and the Cockpit changes automatically. Confirm it still passes after each renderer task.
