# Flow Edge Conditions — Design

**Date:** 2026-07-17
**Status:** Design (spec) — not started. Design-approval gate for upgrading the
flow engine's routing predicate from a bare boolean equality to a small,
deterministic comparison-operator language.
**Feature:** Replace the flow engine's single edge predicate
`resolveField(context, field) === equals` with a richer, still-pure
`FlowEdgeCondition { field; op; value? }` supporting `eq / ne / gt / gte / lt /
lte / contains / exists / truthy` — so the ecom worker (and every non-trivial
flow) can route on `order.total > 100`, `status == 'unfulfilled'`,
`email contains '@'`. This is the deterministic routing seam the whole hybrid
engine rests on: **boolean, not feelings of LLMs.** Legacy persisted
`{ field, equals }` conditions keep evaluating byte-identically — mandatory
back-compat, normalized at the eval boundary.

This spec owns the new condition shape. It changes exactly one predicate
(`selectEdges`) plus the four surfaces that produce/validate/author that shape;
it reuses the existing `resolveField` dotted-path resolver, the existing
"garbled input matches nothing" safety property, and the existing
author→persist→eval→route data flow verbatim.

---

## 1. Goal + scope

**Goal (one sentence):** Let a flow author express comparison conditions on
router/gate branches (`>`, `>=`, `<`, `<=`, `!=`, `contains`, `exists`,
`truthy`, and equality) that the engine evaluates purely and deterministically,
without breaking a single persisted flow or merged test.

### In scope (MVP)

- The pinned `FlowEdgeCondition` type in `src/shared/flows.ts` (§2), replacing
  the inline `{ field: string; equals: unknown }` on `FlowEdge.condition`.
- A pure `evalCondition(context, condition)` predicate in
  `src/main/flow/context.ts`, consumed by `selectEdges` (`context.ts:88`) — the
  one place edges are evaluated for both `router`/`gate` branches and the
  trigger fan-out (`flow-engine.ts:173`, `flow-engine.ts:300`).
- **Legacy normalization at the boundary:** a persisted
  `{ field, equals }` is treated as `{ field, op: 'eq', value: equals }`. No
  data migration is required for eval to keep working (§2.1).
- Strict validation of the new shape (+ legacy) in `parseEdge`
  (`flow-model.ts:61`) and permissive boundary validation in `isEdge`
  (`flows.ts:104`).
- Canvas authoring: `setEdgeCondition` reducer (`flow-reducer.ts:104`) widened
  to the new shape, and the `RouterForm` / `GateForm` condition editors in
  `NodeConfigPanel.tsx` gain an **op dropdown** between field and value.
- Semantic validation touch in `flow-validate.ts` (a legible warning for an
  incomplete/ill-typed condition — never a hard throw).
- Pure unit tests per op (incl. coercion, legacy back-compat, missing-field-is-
  false) + reducer/validation tests. All offline.

### Out of scope (MVP) — explicitly deferred

- **Migrating** persisted `equals` → `value` on disk (§10.3). Legacy is
  normalized at read/eval time and left on disk as-is; a write-time upgrade is
  an optional phase-2 nicety, not a correctness need.
- **Boolean composition** (`and`/`or`/`not` over multiple conditions on one
  edge). One condition per edge, as today; multi-condition routing is still
  expressed by fanning out multiple router edges. Flagged §10.4.
- **Regex / `startsWith` / `in` / range** operators. The nine ops cover the
  named use cases; more are additive (§11).
- **A typed field picker** (autocomplete of `nodeId.field` from upstream node
  output schemas). The value/field inputs stay free-text in MVP (§10.1).
- The **gate node's `config.condition`** auto-continue path — the `GateForm`
  authors a `node.config.condition` of the same `{ field, equals }` shape, but
  `runGate` (`gate-runner.ts:18`) currently ignores it and always awaits the
  human. The editor is upgraded for shape-consistency; wiring gate
  auto-continue to the new evaluator is flagged (§10.5), not built here.

---

## 2. The pinned shape + back-compat

Pinned VERBATIM (this spec owns it; connectors and flow templates consume it):

```ts
export type FlowConditionOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'exists' | 'truthy'

export interface FlowEdgeCondition {
  field: string
  op: FlowConditionOp
  value?: unknown
}
// FlowEdge.condition?: FlowEdgeCondition
```

- `value` is optional because `exists` and `truthy` are **unary** — they test
  the resolved field alone and ignore `value` entirely.
- `field` is a dotted path (`order.total`, `triage.category`), resolved by the
  existing `resolveField` (`context.ts:16`), which already walks
  `nodeId.field.sub` and returns `undefined` for any missing/non-object hop.
  **Nested paths therefore already work today** and are not a new capability
  (see §10.2 — the open decision is only how far to *productize* them, e.g.
  array indexing).

### 2.1 Back-compat rule (MANDATORY)

A persisted legacy condition `{ field: F, equals: V }` MUST evaluate identically
to `{ field: F, op: 'eq', value: V }`. This is enforced by **normalizing at the
eval boundary**, in one place:

```ts
function normalizeCondition(c: unknown): FlowEdgeCondition | null {
  if (typeof c !== 'object' || c === null) return null
  const o = c as Record<string, unknown>
  if (typeof o.field !== 'string') return null
  // New shape: has a valid `op`.
  if (typeof o.op === 'string' && VALID_CONDITION_OPS.includes(o.op)) {
    return { field: o.field, op: o.op, value: o.value }
  }
  // Legacy shape: `{ field, equals }` → eq.
  if ('equals' in o) return { field: o.field, op: 'eq', value: o.equals }
  return null // ill-formed → treated as "no condition"? NO — see §5.
}
```

The pinned `flow-context.test.ts` fixtures use the legacy shape verbatim
(`condition: { field: 'triage.category', equals: 'bug' }`,
`flow-context.test.ts:69,74`) — normalization keeps them green with zero test
edits. The `FlowEdge` *type* narrows to `FlowEdgeCondition`, but the *runtime*
accepts both because untrusted/persisted graphs already arrive as `unknown` and
pass through `parseEdge` / `normalizeCondition`.

**Type-level note:** `FlowEdge.condition` is declared as the new
`FlowEdgeCondition`. Legacy documents on disk are `unknown` until parsed; the
normalization step is where legacy is coerced into the declared type, so the
static type and the runtime stay honest.

---

## 3. Architecture — exact files/functions changed

| File | Function / export | Change |
|---|---|---|
| `src/shared/flows.ts` | `FlowEdge` (`:21`) | `condition?: FlowEdgeCondition` (was inline `{ field; equals }`). Add `FlowConditionOp`, `FlowEdgeCondition`, and `VALID_CONDITION_OPS: FlowConditionOp[]` (mirrors `VALID_NODE_TYPES`, `flows.ts:38`). |
| `src/shared/flows.ts` | `isEdge` (`:104`) | Add a **permissive** condition shape check: if `condition` is present it must be an object with a string `field` and either a valid `op` or an `equals` key. Rejects a garbled condition at the IPC save boundary with the structural (not semantic) posture already documented at `flows.ts:80-86`. |
| `src/main/flow/context.ts` | **new** `evalCondition(context, condition)` | The pure per-op predicate + coercion (§4). Exported for unit tests. |
| `src/main/flow/context.ts` | **new** `normalizeCondition(raw)` | Legacy→new boundary normalizer (§2.1). |
| `src/main/flow/context.ts` | `selectEdges` (`:88`) | Predicate at `:91` changes from `resolveField(...) === e.condition.equals` to `!e.condition || evalCondition(context, normalizeCondition(e.condition))`. A `normalizeCondition` returning `null` → edge does **not** fire (§5). `resolveField` (`:16`) is unchanged and reused. |
| `src/main/flow/flow-model.ts` | `parseEdge` (`:61`) | The strict condition gate at `:71-82` (currently `field:string` + `'equals' in condition`) is widened to accept EITHER the new shape (`field:string`, `op ∈ VALID_CONDITION_OPS`, optional `value`) OR the legacy shape (`field:string`, `equals` present), with a loud, specific error otherwise (§5). Persists whichever shape it received (no on-disk migration, §10.3). |
| `src/renderer/src/lib/flow-reducer.ts` | `setEdgeCondition` (`:104`) | Param type widens from `{ field; equals } \| undefined` to `FlowEdgeCondition \| undefined`. Body is otherwise unchanged (spread + delete-on-undefined). |
| `src/renderer/src/components/flow/NodeConfigPanel.tsx` | `RouterForm` (`:246`), `GateForm` (`:198`), `Props.onSetEdgeCondition` (`:16`) | Insert an **op `<select>`** between the `field` and `value` inputs; relabel `equals`→`value`; hide the value input for unary ops (`exists`/`truthy`). New `data-config-field` hooks: `router-op` / `gate-op`, `router-value` / `gate-value` (keep `-field`; migrate `-equals`→`-value`, updating any e2e selectors). |
| `src/renderer/src/components/FlowCanvas.tsx` | `onSetEdgeCondition` wiring (`:206`) | No logic change; forwards the new `FlowEdgeCondition`. |
| `src/renderer/src/lib/flow-validate.ts` | condition check (new) | Add a **warning**-severity issue for an edge whose condition has an empty `field`, or a binary op with a missing/blank `value` — actionable, names the edge. Never blocks (`ok` stays true), mirroring the router-cycle warning posture (`flow-validate.ts:221`). |

Everything else — `router-runner.ts`, `flow-engine.ts` routing (`applyOutcome`,
`isComplete`), `RunSnapshot.context`, the trigger fan-out — is untouched: they
call `selectEdges`, which is the single seam. `router-runner.ts:7` documents
routing as `resolveField === equals`; that comment is updated to reference
`evalCondition`.

---

## 4. Eval semantics (pure, deterministic)

`evalCondition(context, condition)` resolves `left = resolveField(context,
condition.field)` once, then dispatches on `op`. It is a **pure function of
`(context, condition)`** — no I/O, no clock, no LLM — the same purity contract
`resolveField` / `selectEdges` already hold (`context.ts:6-7`).

**Coercion helper (the one policy knob — see §10.1):** a *numeric-preferring*
compare. For the ordering ops (`gt/gte/lt/lte`) and equality (`eq/ne`), if
**both** `left` and `value` "look numeric" (a JS `number`, or a `string` that
`Number()` parses to a finite number and is non-blank), compare as numbers;
otherwise compare as strings via `String()`. This makes `order.total > 100`
work whether `order.total` arrived as `130` (number) or `"130"` (string, e.g.
from a templated/JSON field) — the common real case — while `status ==
'unfulfilled'` stays a string compare.

| Op | Behavior | Coercion / type rules |
|---|---|---|
| `eq` | `left` equals `value` | If both look numeric → numeric `===`. Else strict `===` first, then a `String(left) === String(value)` fallback so `"bug" == "bug"` and `130 == "130"` both hold. Legacy `equals` normalizes here, so legacy `===` semantics are preserved for the primitive cases the tests cover. |
| `ne` | logical negation of `eq` | Same coercion as `eq`. `ne` on a missing field is **false** (missing ⇒ predicate false, §5 — `ne` does NOT invert missing-is-false into a spurious match). |
| `gt` | `left > value` | Numeric compare when both look numeric; else string (lexicographic) compare. If `left` is missing/`undefined`/`null`, or is a non-numeric non-string (object/array/bool) against a numeric `value` → **false** (never throws, never NaN-routes). |
| `gte` | `left >= value` | As `gt`. |
| `lt` | `left < value` | As `gt`. |
| `lte` | `left <= value` | As `gt`. |
| `contains` | membership | If `left` is a **string** → `left.includes(String(value))`. If `left` is an **array** → `left.some(x => x === value || String(x) === String(value))`. Any other `left` type (number/object/missing) → **false**. `email contains '@'` ⇒ string case. |
| `exists` | field present & non-null | `left !== undefined && left !== null`. `value` ignored. `false` / `0` / `''` **exist** (they are present) — this tests presence, not truthiness. |
| `truthy` | JS-truthy | `Boolean(left)`. `value` ignored. `0`, `''`, `false`, `null`, `undefined`, `NaN` → false; everything else → true. The "did the agent emit a positive fact" test. |

**Invariants (the safety property, §5):**
- A missing field (`resolveField` → `undefined`) makes **every** op false —
  including `ne` and `truthy`/`exists` (both correctly false for absent) — so
  garbled/absent input matches nothing and never picks an arbitrary branch.
- No op throws. Comparisons that can't be made (type mismatch, NaN) resolve to
  **false**, not an exception and not a random branch.
- Determinism: same `(context, condition)` ⇒ same boolean, always.

---

## 5. Error handling (all deterministic, legible)

localflow's principle (error-message-style memory; demonstrated in
`flow-model.ts` where `parseFlowGraphResult` "carries a specific, loud reason
naming the offending field"): **no silent catch, no bare "invalid", every
message names the offending edge/field and is actionable.** Conditions add
three failure surfaces, each with a defined, deterministic outcome:

| Failure | Where caught | Deterministic outcome |
|---|---|---|
| **Missing / absent field at eval** (`resolveField` → `undefined`) | `evalCondition` (runtime) | Predicate is **false** — the edge simply does not fire. Never throws, never routes arbitrarily. This is the preserved "garbled input matches nothing" property. Not an error surface — it is normal, expected routing. |
| **Type mismatch at eval** (`gt` on an object; `contains` on a number) | `evalCondition` (runtime) | Predicate is **false**. No throw. A run does not fail because a comparison was nonsensical — the branch is just not taken. |
| **Unknown / ill-typed `op` in a persisted graph** | `normalizeCondition` (eval) + `parseEdge` (strict load) | `normalizeCondition` returns `null` for an unrecognized `op` with no legacy `equals` fallback ⇒ `selectEdges` treats the edge as **not firing** (fail-closed, never fail-open). Independently, `parseFlowGraphResult` REJECTS the load at the boundary with a loud, specific error: `edge '<id>' has an invalid condition op '<op>' (expected one of eq, ne, gt, …)` — surfaced by `flow-store.ts` (design parity with `flow-model.ts:79`). So a bad op never silently runs; it is caught loudly at load, and fail-closed at eval if it ever slips through. |
| **Incomplete condition in the editor** (empty `field`, or binary op with blank `value`) | `flow-validate.ts` (live, on every reducer result) | A **warning** issue (`ok` stays true, does not block save) naming the edge: `Branch → <to> has an operator but no value — set a value or remove the condition.` Mirrors the non-blocking router-cycle warning (`flow-validate.ts:221`). Editing is never interrupted; the author sees a badge. |

Fail-closed everywhere: a malformed or unknown condition NEVER causes an edge to
fire and NEVER throws mid-run. The worst case is a branch that doesn't route,
which is visible (the run's node status shows `skipped`, and the incomplete
condition raised an editor warning at author time).

---

## 6. Data flow (author → persist → engine eval → route)

```
AUTHOR (canvas, renderer)
  NodeConfigPanel RouterForm/GateForm
    field input ─┐
    op <select> ─┼─► onSetEdgeCondition(edgeId, { field, op, value })
    value input ─┘        │
                          ▼
  FlowCanvas apply(setEdgeCondition(graph, edgeId, condition))   [flow-reducer.ts:104]
                          │  (pure graph transform; spread/replace one edge)
                          ▼
  flow-validate(graph)  ──► warning badge if field empty / value missing  [flow-validate.ts]
                          │
                          ▼  IPC flow:save
PERSIST (main)
  isFlowGraph(graph)  ──► permissive structural gate (condition shape)   [flows.ts:104]
                          │
                          ▼  write flow JSON to disk (new OR legacy shape as-is)
─────────────────────────────────────────────────────────────────────────────
ENGINE (main, at run time)
  flow-store load ──► parseFlowGraphResult(raw)                            [flow-model.ts:86]
                          │  STRICT: parseEdge validates condition (new + legacy), else loud reject
                          ▼
  flow-engine runNode(node)                                               [flow-engine.ts:300]
                          │
                          ▼
  selectEdges(graph, nodeId, context)                                     [context.ts:88]
     for each out-edge:
        !condition                       → fire (unconditional)
        normalizeCondition(condition)    → legacy {field,equals} → {field,op:'eq',value:equals}
        null (unknown op)                → do NOT fire (fail-closed)
        evalCondition(context, cond)     → left = resolveField(context, field); per-op boolean
                          ▼
  applyOutcome(graph, state, nodeId, 'done', selectedEdgeIds)             [flow-engine.ts:301]
     matching edges' targets → pending;  non-matching branches → skipped
```

The author→persist→eval→route path is **unchanged in shape** — only the
predicate at the eval node (`selectEdges` / `evalCondition`) and the value
authored by the editor are richer. Every other stage (reducer purity, IPC
boundary, strict load, `applyOutcome`, run-state fan-out) is byte-for-byte the
existing pipeline.

---

## 7. Testing strategy (all offline, pure)

Matches localflow's existing seams — pure functions, injected context, fixture
graphs. New/extended files: `tests/unit/flow-context.test.ts`,
`tests/unit/flow-model.test.ts`, `tests/unit/flow-reducer.test.ts`,
`tests/unit/flow-validate.test.ts`.

- **`evalCondition` per-op unit tests** (the core). One `describe` per op:
  - `eq` / `ne`: string equal, numeric equal, `130 == "130"` cross-type,
    `ne` false on missing field.
  - `gt/gte/lt/lte`: numeric (`order.total: 130 > 100` → true; `50 > 100` →
    false); string-numeric (`"130" > "100"` numeric-coerced → true);
    lexicographic when non-numeric (`"b" > "a"`); `gte`/`lte` boundary
    equality; non-number `left` vs numeric `value` → false (no NaN route).
  - `contains`: string (`"a@b" contains "@"` → true; `"abc" contains "z"` →
    false); array (`['bug','ui'] contains 'bug'` → true); non-string/array
    `left` → false.
  - `exists`: present-and-non-null true; `false`/`0`/`''` exist → true;
    missing/`null` → false.
  - `truthy`: `Boolean(left)` truth table; missing → false.
- **Missing-field-is-false matrix** — a parametrized test asserting **every**
  op returns false when `resolveField` yields `undefined` (the safety
  property). Guards against a future op accidentally NaN/undefined-routing.
- **Legacy back-compat** — the existing `selectEdges` tests
  (`flow-context.test.ts:80-86`, legacy `{ field, equals }` fixtures) MUST pass
  unedited. Add explicit tests that `{ field, equals: 'bug' }` and
  `{ field, op: 'eq', value: 'bug' }` produce identical `selectEdges` output on
  the same context.
- **`normalizeCondition` unit tests** — legacy→`eq`; new shape pass-through;
  unknown `op` → `null`; non-object/absent-field → `null`.
- **`parseEdge` / `parseFlowGraphResult` tests** (`flow-model.test.ts`) —
  accept new shape; accept legacy shape; reject unknown `op` with the exact
  loud message; reject a non-string `field`. Round-trip preserves the authored
  shape (no silent migration).
- **`setEdgeCondition` reducer tests** (`flow-reducer.test.ts`) — set a new
  `{ field, op, value }`; clear with `undefined` (delete branch); immutability
  (input graph unchanged). Unary op stored without a `value`.
- **`flow-validate` tests** — empty-field and missing-value conditions produce
  a **warning** (not error), `ok` stays true, message names the edge target.

No test requires a running Electron app, a pane, or a network — the whole
condition layer is pure (`context.ts` purity contract) and unit-testable in
isolation, exactly like `state-machine.ts`.

---

## 8. Open decisions (FLAGGED — not resolved here)

1. **Numeric-vs-string coercion policy (§4).** MVP proposes *numeric-preferring*
   compare: numeric when both sides look numeric, string otherwise. Alternatives
   considered: (a) **strict typed** — never coerce; `order.total > 100` fails if
   the field is the string `"130"` (safer but surprises authors, since JSON /
   templated fields often arrive as strings); (b) **explicit typed value in the
   editor** — the author declares number vs string per condition (most precise,
   most UI). Recommendation: ship numeric-preferring (matches author intent for
   the ecom `order.total > 100` case), revisit if it bites. **Decide before
   locking `evalCondition`.**
2. **Nested field paths — how far.** `resolveField` (`context.ts:16`) *already*
   walks `nodeId.field.sub` and the tests already use `triage.category`, so
   dotted object paths are **not new**. The open question is only whether to
   productize **array indexing** (`items.0.sku`) and to add a **typed field
   picker** in the editor. MVP keeps free-text dotted paths (works today);
   array indices and a picker are additive (§10.1). No engine change needed for
   basic nesting.
3. **Keep vs migrate the legacy `equals`.** MVP **keeps** legacy on disk and
   normalizes at eval — zero-risk, no migration pass, existing files untouched.
   Option: a **write-time upgrade** (rewrite `{field,equals}` → `{field,op:'eq',
   value}` on the next `flow:save`) so the corpus converges on one shape and the
   legacy branch can eventually be retired. Recommendation: normalize-only for
   MVP; add opportunistic write-time upgrade in phase 2, retire the legacy
   parse branch only once no persisted flow uses it.
4. **Boolean composition (`and`/`or`/`not`).** One condition per edge in MVP;
   multi-condition routing is expressed by multiple edges. A future
   `{ all: [...] } / { any: [...] }` composite on an edge is the natural
   extension but multiplies editor + eval + validation surface. Deferred;
   flagged so the shape isn't accidentally foreclosed.
5. **Gate auto-continue.** `GateForm` authors a `node.config.condition` of the
   same shape, but `runGate` (`gate-runner.ts:18`) ignores it and always awaits
   a human. Decide whether the gate's "Continue only if…" mode should actually
   evaluate via the new `evalCondition` (auto-proceed when the condition holds,
   else await the human) — a real behavior change to the gate — or whether that
   UI affordance should be removed as dead. Out of scope to *build*; flagged to
   *resolve*.

---

## 9. MVP slice + roadmap

### Smallest first shippable slice (the "walking skeleton")

1. Add `FlowConditionOp` / `FlowEdgeCondition` / `VALID_CONDITION_OPS` to
   `flows.ts`; point `FlowEdge.condition` at the new type.
2. Add `evalCondition` + `normalizeCondition` to `context.ts`; rewire the one
   predicate in `selectEdges`. Legacy tests stay green (proof of back-compat).
3. Widen `parseEdge` to accept new + legacy, reject unknown op loudly.
4. Widen `setEdgeCondition` + add the op `<select>` to `RouterForm`/`GateForm`;
   add the `flow-validate` incomplete-condition warning.
5. Full per-op + coercion + missing-field + legacy unit tests.

That slice makes `order.total > 100`, `status == 'unfulfilled'`, and
`email contains '@'` authorable, persistable, and deterministically routable —
end to end — without touching the engine's routing, run-state, or any persisted
flow.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton above. Nine ops, numeric-preferring
  coercion, normalize-only legacy, one condition per edge, free-text field.
- **Phase 2 — authoring polish:** typed field picker (autocomplete
  `nodeId.field` from upstream output shapes), array indexing in paths,
  opportunistic write-time legacy→new upgrade (§10.3), gate auto-continue
  decision (§10.5) if "yes".
- **Phase 3 — expressiveness:** boolean composition (`all`/`any`/`not`),
  additional ops (`startsWith`, `in`, `matches`/regex, numeric range), and a
  per-condition explicit type declaration if numeric-preferring proves too
  loose (§10.1).

---

## Appendix — reused localflow surfaces (by path + line)

- `src/shared/flows.ts:21-26` — `FlowEdge` (the pinned shape being upgraded);
  `:38` `VALID_NODE_TYPES` (the pattern `VALID_CONDITION_OPS` mirrors);
  `:104-108` `isEdge` (permissive boundary gate); `:80-86` the
  structural-vs-semantic validation doctrine.
- `src/main/flow/context.ts:16-23` — `resolveField` (dotted-path resolver,
  reused unchanged; already returns `undefined` for missing hops); `:88-93`
  `selectEdges` (the single eval seam; predicate at `:91`).
- `src/main/flow/flow-engine.ts:173,300` — the two `selectEdges` call sites
  (trigger fan-out + `runNode` routing); `:301` `applyOutcome` fan-out.
- `src/main/flow/flow-model.ts:61-84` — `parseEdge` (strict condition gate at
  `:71-82`); `:86` `parseFlowGraphResult` (the loud-reason validation posture).
- `src/main/flow/node-runners/router-runner.ts:7` — the comment documenting
  routing as boolean `resolveField === equals` (updated to `evalCondition`);
  `gate-runner.ts:18` — `runGate` (the gate auto-continue open decision, §10.5).
- `src/renderer/src/lib/flow-reducer.ts:104-122` — `setEdgeCondition` (pure
  edge-condition transform, param type widened).
- `src/renderer/src/components/flow/NodeConfigPanel.tsx:198-244` `GateForm`,
  `:246-292` `RouterForm` — the condition editors gaining an op dropdown.
- `src/renderer/src/components/FlowCanvas.tsx:206-207` — the `onSetEdgeCondition`
  wiring (unchanged in logic).
- `src/renderer/src/lib/flow-validate.ts:221` — the non-blocking router-cycle
  warning (the posture the incomplete-condition warning mirrors).
- `tests/unit/flow-context.test.ts:63-86` — the existing legacy `selectEdges`
  tests that MUST stay green (the back-compat proof).
