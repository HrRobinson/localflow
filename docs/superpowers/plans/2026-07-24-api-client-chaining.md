# API Client — Path Quoting & `$ref` Chaining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent chain a value from one response into the next request by reference — authenticate → use the token → call the API — without ever seeing the token.

**Architecture:** Two halves, strictly ordered. First the response-path grammar becomes unambiguous (JSONPath bracket-string form), because `$ref` makes a path load-bearing for a *write* and the current ambiguity defences stop working at that point. Then `$ref` resolution lands in the pure request resolver, with every chained value joining that request's scrub set.

**Tech Stack:** TypeScript, Electron main process, Vitest, Playwright, a plain-JS ESM skill CLI.

**Spec:** `docs/superpowers/specs/2026-07-23-agent-api-client-design.md` — §4.4 (chaining), §4.4a (path quoting as the prerequisite), §4.1 (scrub set), Build order layer 4.

## Why the order is not negotiable

Spec §4.4a: the current grammar (`.`, `[N]`, `[*]`, `<redacted:N>`) is unescaped over an alphabet the **remote fully controls**. Ambiguous paths are constructible — `{"a.b":x}` and `{"a":{"b":y}}` both yield `$.a.b`. Today two defences contain it: `findField` prefers the withheld entry (ambiguity fails closed), and `pull` returns scalars only.

**Neither survives `$ref`.** A `$ref` deliberately targets withheld fields, so "prefer withheld" stops disambiguating and the chained value may not be the one the agent named. Quoting makes every path a unique address by construction and demotes both defences to belt-and-braces.

## The new path grammar (pinned)

```
$                        the root
$['key']                 an object member — ALWAYS bracket-quoted
$['a']['b']              nesting
$['data'][0]             a concrete array index — bare, unquoted
$['data'][*]             a collapsed homogeneous array
$['<redacted:1>']        a redacted key placeholder (quoted like any key)
$headers['content-type'] a response header
```

**Escaping inside a quoted segment:** `\` → `\\`, then `'` → `\'`. Nothing else is escaped. A key is therefore always recoverable, and no remote-chosen key can forge a segment boundary.

**This is a clean break** — the old dotted form is not accepted. The feature is unreleased, the old form is exactly the ambiguity being removed, and accepting both would keep the hole open for `$ref`. Every emitted path, every test, and the skill's docs move together.

## The `$ref` form (pinned)

Any **string** value inside `spec` (including `headers` values and string leaves of `body`) or `vars` may instead be an object:

```json
{ "$ref": "<responseId>:<path>" }
```

Resolved main-side at send time, against the sending grant's own environment.

- A **withheld** field CAN be chained — passing a value through is not reading it, so no gate, no refusal (spec §4.4).
- Every resolved value **joins that request's scrub set**, so a chained token cannot come back in the next response (spec §4.1).
- An unknown, evicted, or foreign-environment `responseId`, or a path that does not resolve → a **loud** `{ ok: false }` with "no longer held, re-send" — never a silent empty substitution (spec §Error handling).
- A `$ref` resolving to an object/array is refused, mirroring `pull`'s scalars-only rule (§4.5).

## Global Constraints

- **Commit subject ≤ 50 characters** — commitlint via husky. Conventional Commits.
- Prettier: `semi: false`, `singleQuote: true`, `printWidth: 100`, **`trailingComma: "none"`**. Real gate is `prettier --check` + `npm run check`. Unbreakable string/regex literals over 100 chars are exempt (the codebase already ships several).
- **`@typescript-eslint/no-explicit-any` is an ERROR** (tests too). **`noUnusedLocals: true`.**
- Vitest has **no globals** — `import { describe, it, expect } from 'vitest'`.
- ESLint `preserve-caught-error`: re-throwing in a `catch` passes `{ cause: err }`.
- Unit: `tests/unit/*.test.ts`. E2E: `tests/e2e/*.spec.ts`. Full gate `npm run check`; e2e ~10s/run.
- **No secret or token may cross IPC outbound**, and no renderer/preload file may name `ApiGrantStore`/`SAIIFE_API_TOKEN`/`CollectionSecretStore` — an existing security probe enforces this.

---

### Task 1: The path module

One pure module owning both directions of the grammar, so the emitter and the reader can never drift.

**Files:**
- Create: `src/main/api-client/response-path.ts`
- Test: `tests/unit/api-response-path.test.ts`

**Interfaces:**
- Produces:
  - `quoteSegment(key: string): string` — `a.b` → `['a.b']`, escaping `\` then `'`
  - `appendKey(path: string, key: string): string` — `$` + `a.b` → `$['a.b']`
  - `appendIndex(path: string, index: number | '*'): string` — `$['data']` + `0` → `$['data'][0]`
  - `parsePath(path: string): PathStep[] | null` — `null` when malformed
  - `type PathStep = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wild' }`
  - `collapseIndices(path: string): string` — concrete indices → `[*]`, for shape matching
  - `HEADERS_ROOT = '$headers'`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-response-path.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  appendIndex,
  appendKey,
  collapseIndices,
  parsePath,
  quoteSegment
} from '../../src/main/api-client/response-path'

describe('quoteSegment', () => {
  it('always brackets and quotes a key', () => {
    expect(quoteSegment('id')).toBe("['id']")
  })
  it('keeps a dotted key in one segment', () => {
    expect(quoteSegment('a.b')).toBe("['a.b']")
  })
  it('escapes backslash before quote', () => {
    expect(quoteSegment("it's")).toBe("['it\\'s']")
    expect(quoteSegment('back\\slash')).toBe("['back\\\\slash']")
    expect(quoteSegment("both\\'")).toBe("['both\\\\\\'']")
  })
})

describe('appendKey / appendIndex', () => {
  it('builds nested paths', () => {
    expect(appendKey('$', 'data')).toBe("$['data']")
    expect(appendKey(appendKey('$', 'a'), 'b')).toBe("$['a']['b']")
  })
  it('appends concrete and wildcard indices bare', () => {
    expect(appendIndex(appendKey('$', 'data'), 0)).toBe("$['data'][0]")
    expect(appendIndex(appendKey('$', 'data'), '*')).toBe("$['data'][*]")
  })
})

describe('parsePath', () => {
  it('parses the root', () => {
    expect(parsePath('$')).toEqual([])
  })
  it('parses keys and indices', () => {
    expect(parsePath("$['data'][0]['id']")).toEqual([
      { kind: 'key', key: 'data' },
      { kind: 'index', index: 0 },
      { kind: 'key', key: 'id' }
    ])
  })
  it('round-trips a dotted key without splitting it', () => {
    expect(parsePath("$['a.b']")).toEqual([{ kind: 'key', key: 'a.b' }])
  })
  it('round-trips escaped quotes and backslashes', () => {
    expect(parsePath("$['it\\'s']")).toEqual([{ kind: 'key', key: "it's" }])
    expect(parsePath("$['back\\\\slash']")).toEqual([{ kind: 'key', key: 'back\\slash' }])
  })
  it('parses a wildcard', () => {
    expect(parsePath("$['data'][*]")).toEqual([
      { kind: 'key', key: 'data' },
      { kind: 'wild' }
    ])
  })
  it('parses a redacted placeholder as an ordinary quoted key', () => {
    expect(parsePath("$['<redacted:1>']")).toEqual([{ kind: 'key', key: '<redacted:1>' }])
  })
  it('rejects malformed paths', () => {
    expect(parsePath('')).toBeNull()
    expect(parsePath('data')).toBeNull()
    expect(parsePath('$.data')).toBeNull()
    expect(parsePath("$['unterminated")).toBeNull()
    expect(parsePath('$[]')).toBeNull()
    expect(parsePath('$[abc]')).toBeNull()
    expect(parsePath("$['a']junk")).toBeNull()
  })
  it('a remote-chosen key cannot forge a segment boundary', () => {
    // The whole point of quoting: this is ONE key, not two segments.
    const evil = "a']['b"
    const path = appendKey('$', evil)
    expect(parsePath(path)).toEqual([{ kind: 'key', key: evil }])
  })
})

describe('collapseIndices', () => {
  it('turns concrete indices into wildcards', () => {
    expect(collapseIndices("$['data'][0]['n']")).toBe("$['data'][*]['n']")
  })
  it('leaves an index-shaped key alone', () => {
    // `[0]` inside quotes is a KEY, not an index — it must not be collapsed.
    expect(collapseIndices("$['[0]']")).toBe("$['[0]']")
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/api-response-path.test.ts`
Expected: FAIL — cannot resolve `../../src/main/api-client/response-path`

- [ ] **Step 3: Write the module**

Create `src/main/api-client/response-path.ts`:

```typescript
/**
 * The response-path grammar, in one place so the emitter (`response-shape.ts`)
 * and the reader (`response-store.ts`) can never drift.
 *
 * Paths are JSONPath bracket-string form — every object key is quoted, array
 * indices are bare:
 *
 *     $                        the root
 *     $['key']                 an object member
 *     $['data'][0]             a concrete index
 *     $['data'][*]             a collapsed homogeneous array
 *     $['<redacted:1>']        a redacted key placeholder
 *     $headers['content-type'] a response header
 *
 * WHY quoted (design §4.4a): the key alphabet is REMOTE-CONTROLLED. Unquoted,
 * `{"a.b":x}` and `{"a":{"b":y}}` produce the same path, and a remote can plant
 * a key that forges a segment boundary. Quoting makes every path a unique
 * address by construction — which `$ref` needs, because a chained path is
 * load-bearing for a WRITE into the next request, where "prefer the withheld
 * entry on a tie" no longer disambiguates anything.
 */

export const HEADERS_ROOT = '$headers'

export type PathStep =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wild' }

/** `a.b` → `['a.b']`. Escapes `\` first, then `'`. */
export function quoteSegment(key: string): string {
  return `['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
}

export function appendKey(path: string, key: string): string {
  return `${path}${quoteSegment(key)}`
}

export function appendIndex(path: string, index: number | '*'): string {
  return `${path}[${index}]`
}

/**
 * Parse a path into steps, or null when malformed. Strict: anything that is not
 * exactly this grammar is rejected rather than coerced, so a bad path can never
 * be silently reinterpreted as a different address.
 */
export function parsePath(path: string): PathStep[] | null {
  let i = 0
  if (path.startsWith(HEADERS_ROOT)) i = HEADERS_ROOT.length
  else if (path.startsWith('$')) i = 1
  else return null

  const steps: PathStep[] = []
  while (i < path.length) {
    if (path[i] !== '[') return null
    i++
    if (path[i] === "'") {
      i++
      let key = ''
      let closed = false
      while (i < path.length) {
        const c = path[i]
        if (c === '\\') {
          if (i + 1 >= path.length) return null
          key += path[i + 1]
          i += 2
          continue
        }
        if (c === "'") {
          closed = true
          i++
          break
        }
        key += c
        i++
      }
      if (!closed || path[i] !== ']') return null
      i++
      steps.push({ kind: 'key', key })
      continue
    }
    if (path[i] === '*') {
      if (path[i + 1] !== ']') return null
      i += 2
      steps.push({ kind: 'wild' })
      continue
    }
    let digits = ''
    while (i < path.length && path[i] >= '0' && path[i] <= '9') {
      digits += path[i]
      i++
    }
    if (digits.length === 0 || path[i] !== ']') return null
    i++
    steps.push({ kind: 'index', index: Number(digits) })
  }
  return steps
}

/**
 * Concrete indices → `[*]`, for matching a pulled path against a shape whose
 * homogeneous array collapsed. Operates on PARSED steps, never a regex over the
 * raw string, so an index-shaped KEY (`$['[0]']`) is never rewritten.
 */
export function collapseIndices(path: string): string {
  const steps = parsePath(path)
  if (steps === null) return path
  const root = path.startsWith(HEADERS_ROOT) ? HEADERS_ROOT : '$'
  return steps.reduce((acc, step) => {
    if (step.kind === 'key') return appendKey(acc, step.key)
    return appendIndex(acc, '*')
  }, root)
}
```

- [ ] **Step 4: Run it, confirm pass**

Run: `npx vitest run tests/unit/api-response-path.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/response-path.ts tests/unit/api-response-path.test.ts
git commit -m "feat(api-client): add quoted response-path grammar"
```

---

### Task 2: Emit quoted paths from the shape

**Files:**
- Modify: `src/main/api-client/response-shape.ts` (every path construction site)
- Test: `tests/unit/api-response-shape.test.ts` (update expected paths)

**Interfaces:**
- Consumes: `appendKey`, `appendIndex`, `HEADERS_ROOT` (Task 1)

- [ ] **Step 1: Update the test to the new grammar first**

In `tests/unit/api-response-shape.test.ts`, rewrite every expected path to bracket form — `$.data` → `$['data']`, `$.data[*].id` → `$['data'][*]['id']`, `$headers.set-cookie` → `$headers['set-cookie']`, `$.<redacted:0>` → `$['<redacted:0>']`. Leave `$` alone. Add one new case proving the ambiguity is gone:

```typescript
  it('a dotted key and a nested path no longer collide', () => {
    const flat = shapeOf(JSON.stringify({ 'a.b': 'x' }), 'application/json', {})
    const nested = shapeOf(JSON.stringify({ a: { b: 'y' } }), 'application/json', {})
    expect(find(flat, "$['a.b']")).toBeDefined()
    expect(find(nested, "$['a']['b']")).toBeDefined()
    // The two addresses are now distinct — previously both were `$.a.b`.
    expect(find(flat, "$['a']['b']")).toBeUndefined()
    expect(find(nested, "$['a.b']")).toBeUndefined()
  })
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/unit/api-response-shape.test.ts`
Expected: FAIL — the emitter still produces dotted paths.

- [ ] **Step 3: Switch the emitter to the path module**

In `src/main/api-client/response-shape.ts`, import `appendKey`, `appendIndex`, `HEADERS_ROOT` from `./response-path` and replace every template-literal path construction:

- `` `${path}[*]` `` → `appendIndex(path, '*')`
- `` `${path}[${i}]` `` → `appendIndex(path, i)`
- `` `${path}.${k}` `` → `appendKey(path, k)`
- `` `${path}.<redacted:${i}>` `` → `appendKey(path, `<redacted:${i}>`)`
- `` `$headers.${lower}` `` → `appendKey(HEADERS_ROOT, lower)`

Change nothing else — not the classification, not the depth cap, not the collapse logic. The redacted placeholder stays the same *string*; it is now quoted like any other key, which is what makes a remote-planted `<redacted:N>` literal key harmless by construction rather than by the tie-break.

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/unit/api-response-shape.test.ts`
Expected: PASS. Then `npm run check` — other suites that assert on shape paths (`api-response-store`, `api-send`, `api-client-security`) will now fail; that is expected and Task 3 fixes them. **Do not fix them here** — commit the emitter alone so the reader migration is reviewable on its own.

If `npm run check` failing is unacceptable mid-plan, run only the two suites above for this task's gate and note it in the report.

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/response-shape.ts tests/unit/api-response-shape.test.ts
git commit -m "feat(api-client): emit quoted shape paths"
```

---

### Task 3: Read quoted paths, and update the agent-facing docs

**Files:**
- Modify: `src/main/api-client/response-store.ts` (`findField`, `readPath`)
- Modify: `tests/unit/api-response-store.test.ts`, `tests/unit/api-send.test.ts`, `tests/unit/api-client-security.test.ts`, `tests/e2e/api-client.spec.ts` (paths in assertions)
- Modify: `openclaw/skills/saiife-api/SKILL.md` (the `pull` example)

**Interfaces:**
- Consumes: `parsePath`, `collapseIndices`, `HEADERS_ROOT` (Task 1)

- [ ] **Step 1: Update the reader's tests to the new grammar**

In `tests/unit/api-response-store.test.ts`, rewrite pull paths to bracket form (`$.id` → `$['id']`, `$.data[0].n` → `$['data'][0]['n']`, `$headers.content-type` → `$headers['content-type']`). Add:

```typescript
  it('refuses a malformed path rather than coercing it', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, 1, '$.id')).toEqual({ ok: false, reason: 'nopath' })
    expect(s.pull(responseId, 1, 'garbage')).toEqual({ ok: false, reason: 'nopath' })
  })

  it('reads a dotted key without treating it as nesting', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input({ body: JSON.stringify({ 'a.b': 'flat' }) }))
    expect(s.pull(responseId, 1, "$['a.b']")).toEqual({ ok: true, value: 'flat' })
  })
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/unit/api-response-store.test.ts`
Expected: FAIL — the reader still parses the dotted form.

- [ ] **Step 3: Switch the reader to the path module**

In `src/main/api-client/response-store.ts`:

Replace `findField`'s collapse with the parsed version, keeping the withheld tie-break (now belt-and-braces, per §4.4a):

```typescript
function findField(shape: ShapeField[], path: string): ShapeField | undefined {
  // The withheld tie-break stays as defence in depth. With quoted segments a
  // remote can no longer construct two entries sharing a path, so this should
  // never fire — but it fails closed if anything ever does.
  const exacts = shape.filter((f) => f.path === path)
  const exact = exacts.find((f) => f.withheld) ?? exacts[0]
  if (exact !== undefined) return exact
  const collapsed = collapseIndices(path)
  const collapsedMatches = shape.filter((f) => f.path === collapsed)
  return collapsedMatches.find((f) => f.withheld) ?? collapsedMatches[0]
}
```

Replace `readPath`'s hand-rolled parser with `parsePath`. Keep the JSON/string gating and the `<redacted:N>` recovery exactly as they are — only the *stepping* changes:

```typescript
function readPath(stored: StoredResponse, path: string): unknown {
  const steps = parsePath(path)
  if (steps === null) return undefined

  const isHeaders = path.startsWith(HEADERS_ROOT)
  if (isHeaders) {
    if (steps.length !== 1 || steps[0].kind !== 'key') return undefined
    return stored.headers[steps[0].key]
  }

  const isJson = stored.contentType.toLowerCase().includes('json')
  let current: unknown
  if (isJson) {
    try {
      current = JSON.parse(stored.body)
    } catch {
      return steps.length === 0 ? stored.body : undefined
    }
  } else {
    return steps.length === 0 ? stored.body : undefined
  }
  if (steps.length === 0) return current

  for (const step of steps) {
    if (current === null || current === undefined) return undefined
    if (step.kind === 'wild') return undefined
    if (Array.isArray(current)) {
      if (step.kind !== 'index') return undefined
      current = current[step.index]
      continue
    }
    if (typeof current !== 'object') return undefined
    if (step.kind !== 'key') return undefined
    const obj = current as Record<string, unknown>
    // A `<redacted:N>` segment came from `response-shape.ts` walking THIS same
    // object's entries in order and redacting entry N's key, so
    // `Object.keys(obj)[N]` recovers the real property name. This does NOT make
    // the value readable — `pull` checks the shape's `withheld` mark first.
    const redacted = /^<redacted:(\d+)>$/.exec(step.key)
    current = redacted ? obj[Object.keys(obj)[Number(redacted[1])]] : obj[step.key]
  }
  return current
}
```

Import `parsePath`, `collapseIndices`, `HEADERS_ROOT` from `./response-path`.

Then update the remaining suites' paths (`api-send`, `api-client-security`, `tests/e2e/api-client.spec.ts`) and the `pull` example in `openclaw/skills/saiife-api/SKILL.md` (`pull r3 '$.data[0].id'` → `pull r3 "\$['data'][0]['id']"`), plus its prose describing the path form.

- [ ] **Step 4: Full gate**

Run: `npm run check` — everything must be green again, and `npm run e2e -- tests/e2e/api-client.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/response-store.ts tests/unit openclaw/skills/saiife-api/SKILL.md tests/e2e/api-client.spec.ts
git commit -m "feat(api-client): read quoted response paths"
```

---

### Task 4: `$ref` resolution and the scrub set

**Files:**
- Modify: `src/main/api-client/request-resolve.ts` (resolve refs; new dependency on a resolver callback)
- Modify: `src/main/api-client/send.ts` (supply the resolver; join chained values to the scrub set)
- Test: `tests/unit/api-request-resolve.test.ts`, `tests/unit/api-send.test.ts`

**Interfaces:**
- Consumes: `ResponseStore.pull` (Task 3's reader)
- Produces:
  - `type RefResolver = (responseId: string, path: string) => { ok: true; value: string } | { ok: false; reason: string }`
  - `resolveSendInput(collection, input, resolveRef?)` — the third argument is optional so existing callers/tests keep working; a `$ref` with no resolver supplied is a loud throw.
  - `resolveSendInput` additionally returns `refValues: string[]` — every value substituted from a `$ref`, for the scrub set.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/api-request-resolve.test.ts`:

```typescript
const okResolver = (id: string, path: string) =>
  id === 'r1' && path === "$['access_token']"
    ? ({ ok: true, value: 'tok_chained' } as const)
    : ({ ok: false, reason: 'no longer held, re-send' } as const)

describe('resolveSendInput $ref', () => {
  it('substitutes a ref in a header value and reports it for scrubbing', () => {
    const { params, refValues } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: { 'x-auth': { $ref: "r1:$['access_token']" } as unknown as string }
        }
      },
      okResolver
    )
    expect((params.headers as Record<string, string>)['x-auth']).toBe('tok_chained')
    expect(refValues).toEqual(['tok_chained'])
  })

  it('substitutes a ref in a body leaf', () => {
    const { params } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'POST',
          path: '/v1/charges',
          body: { token: { $ref: "r1:$['access_token']" } as unknown as string }
        }
      },
      okResolver
    )
    expect(params.body).toEqual({ token: 'tok_chained' })
  })

  it('substitutes a ref in vars', () => {
    const { params } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/a/{{t}}' },
        vars: { t: { $ref: "r1:$['access_token']" } as unknown as string }
      },
      okResolver
    )
    expect(params.url).toBe('https://api.stripe.com/v1/a/tok_chained')
  })

  it('throws loudly on an unresolvable ref — never a silent empty substitution', () => {
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: { method: 'GET', path: '/v1/a', headers: { x: { $ref: 'gone:$' } as unknown as string } }
        },
        okResolver
      )
    ).toThrow(/no longer held/)
  })

  it('throws on a malformed ref string', () => {
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: { method: 'GET', path: '/a', headers: { x: { $ref: 'nocolon' } as unknown as string } }
        },
        okResolver
      )
    ).toThrow(/\$ref/)
  })

  it('throws when a ref appears with no resolver supplied', () => {
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/a', headers: { x: { $ref: 'r1:$' } as unknown as string } }
      })
    ).toThrow(/\$ref/)
  })
})
```

Append to `tests/unit/api-send.test.ts` a test proving the chained value is scrubbed out of the NEXT response and that a withheld field is chainable without a gate:

```typescript
it('chains a withheld value without reading it, and scrubs it from the next response', async () => {
  // First send: the upstream returns a withheld access_token.
  const { sender, responses } = harness(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: 'tok_secret_value' })
  }))
  const first = await sender.send(grant, {
    collectionId: 'stripe',
    varSet: 'test',
    requestId: 'charges'
  })
  if (!first.ok) throw new Error('expected ok')
  const rid = first.view.responseId
  // The agent cannot READ it...
  expect(responses.pull(rid, 1, "$['access_token']")).toEqual({
    ok: false,
    reason: 'withheld'
  })
  // ...but CAN chain it, ungated, and it is scrubbed from the echo that follows.
  const second = await sender.send(grant, {
    collectionId: 'stripe',
    varSet: 'test',
    spec: {
      method: 'GET',
      path: '/v1/charges',
      headers: { 'x-auth': { $ref: `${rid}:$['access_token']` } as unknown as string }
    }
  })
  if (!second.ok) throw new Error('expected ok')
  expect(JSON.stringify(second.view)).not.toContain('tok_secret_value')
})
```

(Adjust the harness so the second send's canned response echoes the chained token, so the scrub assertion is meaningful — mirror how `api-send.test.ts`'s existing echo test is built.)

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run tests/unit/api-request-resolve.test.ts tests/unit/api-send.test.ts`
Expected: FAIL — `$ref` objects are not recognised.

- [ ] **Step 3: Implement**

In `request-resolve.ts`:

- Export `type RefResolver`.
- Add a `isRef(v: unknown): v is { $ref: string }` guard — an object with exactly a string `$ref`.
- Add `resolveRefValue(raw, resolveRef)`: parse `"<responseId>:<path>"` by splitting on the FIRST `:` only (a path may contain `:`), throw legibly on a malformed ref or a missing resolver, call the resolver, throw with the resolver's reason on `ok: false`, and collect the value.
- Thread it through the existing `substitute`/`substituteBody`/header/vars paths: wherever a **string** is expected, a `$ref` object is resolved to its string first. Vars are resolved before templating so `{{t}}` sees the resolved value.
- Accumulate every resolved value into a `refValues: string[]` and return it alongside `{ actionId, params }`.

In `send.ts`:

- Pass a resolver backed by the response store, **scoped to the grant's environment** (so a `$ref` cannot reach another environment's response — spec §Security):

```typescript
    const resolveRef: RefResolver = (responseId, path) => {
      const pulled = this.responses.pullForChain(responseId, grant.environment, path)
      return pulled.ok
        ? { ok: true, value: String(pulled.value) }
        : { ok: false, reason: 'no longer held, re-send' }
    }
```

- Add `ResponseStore.pullForChain(id, environment, path)` — **identical to `pull` except it does NOT refuse a withheld field** (chaining is ungated by design, §4.4), while still refusing containers and unknown responses. Do NOT relax `pull` itself.
- Join `refValues` into the scrub set: `secrets: [...scrubForms(secret), ...refValues.flatMap(scrubForms)]`.
- A thrown resolve error becomes the existing `{ ok: false, status: 400, error }` path.

- [ ] **Step 4: Run, confirm pass, then the full gate**

Run: `npx vitest run tests/unit/api-request-resolve.test.ts tests/unit/api-send.test.ts` then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/main/api-client/request-resolve.ts src/main/api-client/send.ts src/main/api-client/response-store.ts tests/unit
git commit -m "feat(api-client): resolve \$ref chains at send time"
```

---

### Task 5: Document chaining, and prove it end to end

**Files:**
- Modify: `openclaw/skills/saiife-api/SKILL.md` (re-add `$ref`, now that it exists)
- Test: `tests/e2e/api-client.spec.ts` (the canonical auth→use→call chain)
- Test: `tests/unit/api-client-security.test.ts` (chaining probes)

- [ ] **Step 1: Write the failing e2e + probes**

**The e2e needs a real upstream.** The app under Playwright uses the real `FetchHttpTransport`, so this test spins a local `http.createServer` and points the collection at it with `allowLocal: true` — the same "no external network, no flake" pattern `tests/e2e/operator.spec.ts` already uses. Append to `tests/e2e/api-client.spec.ts`:

```typescript
test('chains a withheld token into a second request without reading it', async () => {
  const seen: string[] = []
  const upstream = createServer((req, res) => {
    seen.push(req.headers['x-auth'] as string | undefined ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'tok_e2e_secret', ok: true }))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

  const userData = mkdtempSync(join(tmpdir(), 'sf-apichain-'))
  const app = await launchApp(userData)
  const win = await app.firstWindow()
  await expect(win.locator('.new-session')).toBeVisible()

  const created = await win.evaluate(
    (o) =>
      (window as unknown as WithSaiife).saiife.upsertCollection(1, {
        name: 'Local',
        origins: [o],
        allowLocal: true,
        auth: { scheme: 'none' },
        varSets: { dev: { base_url: o } },
        requests: [{ id: 'r', name: 'r', method: 'GET', path: '/first' }]
      }),
    origin
  )
  if (!created.ok) throw new Error(created.reason)
  const cid = created.view.id

  const session = await win.evaluate(
    (cwd) => (window as unknown as WithSaiife).saiife.createSession('claude', cwd),
    userData
  )
  if (!session) throw new Error('no session')
  await win.evaluate(
    ([pid, c]) => (window as unknown as WithSaiife).saiife.grantApiAccess(1, pid, [c]),
    [session.id, cid] as const
  )

  // Send #1, then chain its withheld token into send #2 — both through the
  // control API, exactly as the agent would.
  const chained = await win.evaluate(
    async ([c, o]) => {
      const w = window as unknown as WithSaiife
      const first = await w.saiife.__e2eSend({ collectionId: c, varSet: 'dev', requestId: 'r' })
      const second = await w.saiife.__e2eSend({
        collectionId: c,
        varSet: 'dev',
        spec: {
          method: 'GET',
          path: '/second',
          headers: { 'x-auth': { $ref: `${first.responseId}:$['access_token']` } }
        }
      })
      return { first, second }
    },
    [cid, origin] as const
  )

  expect(seen[1]).toBe('tok_e2e_secret') // upstream got the chained value
  expect(JSON.stringify(chained)).not.toContain('tok_e2e_secret') // agent never did
  upstream.close()
  await app.close()
})
```

**`__e2eSend` does not exist** — there is no renderer IPC for sending (sending is the agent's surface, over the loopback control API, deliberately not exposed to the renderer). Do **not** add one. Instead drive the two sends with `fetch` from inside `win.evaluate` against the control endpoint, using the token — but the token is not returned by `grantApiAccess` either, by design.

**So: implement this e2e by driving the real `saiife-api` skill CLI from the Playwright process** (`execFile`, async — a sync child would deadlock the in-process control server), reading the endpoint from `grantApiAccess`'s result and the token from the granted pane's env. If the token cannot be obtained from outside the pane in the harness, **fall back to covering the chain at the unit level only** (the `api-send.test.ts` test from Task 4 plus the probes below) and say so plainly in the report. Do not invent an IPC that leaks the token to make a test pass.

Append to `tests/unit/api-client-security.test.ts` — real assertions, no stubs:

```typescript
describe('security probe: chaining never reveals the chained value', () => {
  it('a chained token reaches the wire but never the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-chain-'))
    const collections = new CollectionStore({ file: join(dir, 'c.json') })
    collections.upsert({
      id: 'chain',
      name: 'Chain',
      environment: 1,
      origins: ['https://api.test'],
      auth: { scheme: 'none' },
      varSets: { d: { base_url: 'https://api.test' } },
      requests: [{ id: 'r', name: 'r', method: 'GET', path: '/first' }]
    })
    const responses = new ResponseStore({})
    let sentAuth = ''
    const transport = new MockHttpTransport((req) => {
      if (req.url.endsWith('/second')) {
        sentAuth = req.headers['x-auth'] ?? ''
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'tok_chain_secret' })
      }
    })
    const sender = new ApiSender({
      collections,
      secrets: new CollectionSecretStore({ backend, file: join(dir, 's.enc') }),
      client: new HttpClient({ transport }),
      responses
    })
    const grant = { environment: 1, collections: new Set(['chain']) }

    const first = await sender.send(grant, { collectionId: 'chain', varSet: 'd', requestId: 'r' })
    if (!first.ok) throw new Error('first failed')
    const rid = first.view.responseId

    // The agent cannot read it.
    expect(responses.pull(rid, 1, "$['access_token']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
    // But it can chain it.
    const second = await sender.send(grant, {
      collectionId: 'chain',
      varSet: 'd',
      spec: {
        method: 'GET',
        path: '/second',
        headers: { 'x-auth': { $ref: `${rid}:$['access_token']` } as unknown as string }
      }
    })
    if (!second.ok) throw new Error('second failed')

    expect(sentAuth).toBe('tok_chain_secret') // reached the wire
    expect(JSON.stringify(second.view)).not.toContain('tok_chain_secret') // not the agent
    expect(JSON.stringify(first.view)).not.toContain('tok_chain_secret')
  })

  it('a $ref to a foreign-environment response is refused, not silently empty', async () => {
    // Ingest a response for environment 2, then attempt to chain it from a
    // grant scoped to environment 1.
    const responses = new ResponseStore({})
    const foreign = responses.ingest({
      environment: 2,
      collectionId: 'chain',
      status: 200,
      durationMs: 1,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: 'tok_foreign' }),
      secrets: []
    })
    expect(responses.pullForChain(foreign.responseId, 1, "$['access_token']")).toMatchObject({
      ok: false
    })
  })
})
```

Import whatever the file does not already have (`CollectionStore`, `ResponseStore`, `ApiSender`, `CollectionSecretStore`, `HttpClient`, `MockHttpTransport`, `mkdtempSync`, `tmpdir`, `join`, and the `backend` fake) — the file already defines a `backend` fake for its echo probe; reuse it rather than declaring a second.

- [ ] **Step 2: Run and confirm they fail**

Run: `npm run e2e -- tests/e2e/api-client.spec.ts` and `npx vitest run tests/unit/api-client-security.test.ts`.

- [ ] **Step 3: Make them pass; re-add the docs**

Implementation should already satisfy them from Task 4 — if a probe fails, the defect is in the module it names, not the probe. Do not weaken an assertion.

Then re-add `$ref` to `openclaw/skills/saiife-api/SKILL.md` (it was deliberately removed while unimplemented). Use the **quoted** path form:

```markdown
To use a value from one response in the next request without ever seeing it, put
`{ "$ref": "<responseId>:<path>" }` in any string field of a `--spec` or `--vars`
— for example `{ "$ref": "r3:$['access_token']" }`. It resolves in the main
process at send time. A **withheld** field can be chained this way: passing a
value through is not reading it, so no approval is needed. The chained value is
also scrubbed from the response that comes back.
```

- [ ] **Step 4: Full gate**

Run: `npm run check` and `npm run e2e -- tests/e2e/api-client.spec.ts tests/e2e/api-client-ui.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add openclaw/skills/saiife-api/SKILL.md tests
git commit -m "feat(api-client): document and prove \$ref chaining"
```

---

## Deviations and flags for the reviewer

1. **Task 2 deliberately leaves the tree red.** Switching the emitter breaks the reader's suites until Task 3. The alternative — one giant emitter+reader task — would be unreviewable. Task 2's gate is its own two suites; `npm run check` goes green again at Task 3. If the implementer finds this unacceptable, merging Tasks 2 and 3 is a legitimate call, but say so in the report.

2. **Clean break on path syntax, no back-compat.** The dotted form is rejected outright rather than accepted-and-normalised. Accepting both would preserve exactly the ambiguity `$ref` cannot tolerate. The feature is unreleased, so no deployed agent depends on the old form — but every test and the skill docs must move together, which is why Task 3 touches four test files.

3. **`pullForChain` deliberately bypasses the withheld refusal** — that is the whole point of chaining (§4.4), and it is why the scrub-set join in Task 4 is not optional: without it, a chained token could return in the next response body. The two must land together, which is why they share a task.

4. **The `$ref` value is coerced with `String(...)`.** A ref pointing at a number or boolean becomes its string form, since it is being substituted into a header/URL/body-string position. A ref to a container is already refused by `pullForChain`. Worth a reviewer's eye on whether a non-string scalar should instead be a loud refusal.
