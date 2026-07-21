# Flow Templates + Workers-as-Custom-Agents — Design

**Date:** 2026-07-17
**Status:** Design (spec) — not started. Design-approval gate for the
get-started layer on top of the just-merged Flow Builder (canvas #3 / engine #2 /
hub #1).
**Feature:** Two coupled additions to the flow builder:
1. **Flow templates** — a small set of pre-authored starter flows (an "Ecom
   Support Worker", a "CRM Lead Worker", a blank "Custom") that a user
   instantiates with **one click** and then customizes on the canvas. Today the
   canvas opens **blank** (`FlowCanvas.newFlow` seeds `emptyGraph`); templates
   are the "before it's integrated into whole systems" on-ramp.
2. **Workers as custom agents** — a built/saved worker (a `FlowGraph`) surfaced
   as a **selectable worker to launch** from the create-session flow
   (`Landing.tsx`), alongside the agent presets and the browser pseudo-agent.

Grounded verbatim in the merged code: `src/shared/flows.ts` (the `FlowGraph`
contract a template **is**), `src/main/flow/flow-store.ts` +
`src/main/index.ts`'s `flow:*` IPC (the store a template **instantiates into**),
`src/renderer/src/components/FlowCanvas.tsx` + `flow/*` + `lib/flow-reducer.ts`
(where the picker lands and how nodes get placed), and `src/shared/agents.ts` +
`Landing.tsx` (the preset model + create UX the worker-launch entry reuses).

This spec introduces **no new persisted secret, no new engine capability, and no
change to the pinned `FlowGraph`/`FlowNode`/`FlowEdge` contract.** A template is
just a seed `FlowGraph` shipped in-repo; instantiating it is a deep-clone with
fresh ids.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a user click one of a handful of named starter
workers, get a real editable `FlowGraph` on the canvas in one action, and — once
they've built and saved a worker — pick that worker as a launchable entry from
the New-session flow, all without a template ever carrying a secret.

### In scope (MVP)

- A **`FlowTemplate` model** (`src/shared/flow-templates.ts`) and a small
  **built-in set** shipped as config-as-code (`src/main/flow/builtin-templates.ts`):
  **Ecom Support Worker**, **CRM Lead Worker**, **Blank/Custom**.
- A **"New from template" picker** on the canvas's list surface
  (`FlowList.tsx`), plus a pure **instantiate** transition
  (`instantiateTemplate` in `lib/flow-reducer.ts`) that deep-clones a template's
  `FlowGraph` with **fresh node/edge/flow ids** and a **fresh, de-duplicated
  name**, then opens it on the canvas as a dirty, unsaved draft.
- **Disconnected-integration handling on instantiate:** a template node whose
  integration isn't connected (or isn't even registered yet) surfaces through
  the **existing** `needsSetup` / `integration-not-connected` validation path —
  "connect it in Integrations", never a crash. Reuses `flow-palette.ts`'s
  `needsSetup` and `flow-validate.ts`'s `integration-not-connected` code.
- **Workers as launchable entries:** a saved flow appears as a **"Worker…"
  option** in `Landing.tsx`'s create control (a pseudo-agent select value,
  exactly as `'browser'` already is), which on launch calls the existing
  `runFlow(id)` IPC — **not** a new `AgentPreset`, **not** a new pty binary.
- **No-secret invariant:** a `FlowTemplate` (and every saved `FlowGraph`) carries
  only integration **refs** (`integration: IntegrationId`, `ref: string`) and
  non-secret node `config` — **never** a credential. Secrets stay in the
  Integrations Hub keychain (`safeStorage`), unchanged.
- **Validation of shipped templates:** a pure test asserts every built-in
  template is a structurally valid `FlowGraph` (`isFlowGraph`) and carries no
  secret-looking config key.

### Out of scope (MVP) — explicitly deferred

- **A template marketplace / import-export of user templates.** MVP ships a
  fixed in-repo set; "save this flow as a template" and sharing templates as
  files are phase 2 (§11). The model is shaped so this is additive.
- **The richer `FlowEdgeCondition { field; op; value? }`.** The merged
  `FlowEdge.condition` is the pinned `{ field: string; equals: unknown }`
  (`flows.ts:25`). Templates author against **that** shape today; when the
  richer-condition sibling spec lands, templates adopt it additively (§10.4).
- **A native Shopify/ecom `IntegrationId`.** `IntegrationId` is
  `'linear' | 'email' | 'cloud'` (`integrations.ts:11`) — there is **no**
  `'shopify'` yet. The Ecom template's **shippable** form therefore triggers on
  **`email`** and routes to an `agent` node; the richer Shopify path
  (`order.created` / `getOrder` / `refundOrder`) is authored **when the Shopify
  connector lands** (a forthcoming spec, `2026-07-17-shopify-connector-design.md`,
  not yet on disk). See §3 and §10.2.
- **A new `AgentPreset` kind for workers.** Rejected in §5 — a worker is a graph
  run through the engine, not a binary launched into a pty pane.
- **Auto-running a template on instantiate.** Instantiate = clone + open on
  canvas for editing. Running is still the explicit Save-then-Run the canvas
  already does (`FlowCanvas.run`).

---

## 2. The `FlowTemplate` model

A template **is** a seed `FlowGraph` plus catalog metadata. New shared module
`src/shared/flow-templates.ts` (no I/O — imported by both main and renderer, the
`flows.ts` / `templates.ts` discipline):

```ts
import type { FlowGraph } from './flows'

/** A catalog category for the picker's grouping/badges. */
export type FlowTemplateCategory = 'ecom' | 'crm' | 'custom'

/**
 * A pre-authored starter flow. `graph` is a COMPLETE, structurally valid
 * FlowGraph (isFlowGraph === true) whose ids are TEMPLATE-LOCAL placeholders —
 * they are re-minted on instantiate, never persisted as-is. Carries only
 * integration refs + non-secret node config; NEVER a credential (§4 / §8).
 */
export interface FlowTemplate {
  /** Stable catalog id (e.g. 'ecom-support'), NOT the instantiated flow id. */
  id: string
  /** Card title, e.g. "Ecom Support Worker". */
  name: string
  /** One-line card subtitle — what the worker does, in plain language. */
  description: string
  category: FlowTemplateCategory
  /** The seed graph. Its `graph.id`/`graph.name` are placeholders (§3). */
  graph: FlowGraph
}
```

Notes grounding this in the merged contract:

- `graph` reuses the **pinned** `FlowGraph { id; name; nodes: FlowNode[];
  edges: FlowEdge[] }` (`flows.ts:27`) verbatim — a template is not a new
  document type, so it round-trips through `flow-store` and the canvas with zero
  adaptation once instantiated.
- Template node/edge ids are **placeholders** (`t-trigger`, `t-agent`, …). They
  exist only so intra-graph `FlowEdge.from`/`to` resolve; `instantiateTemplate`
  re-maps every one to a fresh runtime id (§3). This keeps `isFlowGraph`'s
  "every edge endpoint names a present node" invariant (`flows.ts:112`) true in
  both the template and the instance.
- **Naming disambiguation (important):** saiife **already** has a
  `SessionTemplate` (`src/shared/templates.ts`) — a *pane layout* ("claude +
  browser") surfaced as cards on `Landing.tsx` via `createTemplate`. A
  `FlowTemplate` is a different thing (a *flow graph*), lives in a different
  surface (the canvas list, not Landing's session cards), and instantiates into
  `flows.json`, not into panes. The two never share a type; the spec keeps the
  `Flow`-prefix on every symbol to prevent collision.

### 2.1 The built-in set

Shipped in `src/main/flow/builtin-templates.ts` as a `FlowTemplate[]` constant
(config-as-code, like `AGENT_PRESETS` in `agents.ts` and the descriptor defs in
`src/main/integrations/descriptors/*`). Three templates, one per category:

| id | name | category | shippable seed graph (today's `IntegrationId`s) |
|---|---|---|---|
| `custom-blank` | **Blank / Custom** | `custom` | Zero nodes, zero edges — identical to `emptyGraph(...)`. The "start from scratch" card; makes the blank path a *choice in the picker* rather than the only path. |
| `ecom-support` | **Ecom Support Worker** | `ecom` | `trigger`(`integration:'email'`, ref = the email inbound trigger) → `agent` (drafts a reply / classifies) → `router` with two `FlowEdge`s carrying `condition:{ field, equals }` → one branch to an `action` (`integration:'email'`, reply/send), the other to a **`gate`** (human approval) → `action` (escalated reply). A real, runnable-shaped worker on **connected** integrations today. |
| `crm-lead` | **CRM Lead Worker** | `crm` | `trigger`(`integration:'linear'`, an issue/intake trigger) → `agent` (triage/enrich the lead) → `router` (`condition:{ field:'priority', equals:'high' }`) → `action`(`integration:'linear'`, create/update issue) on one branch, a `gate` then `action` on the other. Mirrors the Linear-integration design's pull→work→route→close loop. |

**Why these three:** they cover the two integration families saiife already
ships descriptors for (`email`, `linear`) plus the blank escape hatch, so the
Ecom and CRM templates are **instantiable and mostly-connectable today** — not
vaporware waiting on an unbuilt connector. The Ecom template's *evolution* to the
richer Shopify vocabulary is a data-only edit to `builtin-templates.ts` once the
Shopify connector adds `'shopify'` to `IntegrationId` (§3, §10.2).

### 2.2 The Ecom template, node by node (illustrative)

To make "a template is just a seed `FlowGraph`" concrete (placeholder ids shown;
`config` values are non-secret refs only):

```
nodes:
  t-trigger  trigger  integration:'email'  ref:'<inbound>'   config:{}          pos:{x,y}
  t-agent    agent                          ref:'reply-draft' config:{ prompt:'…' }
  t-router   router                                           config:{}
  t-reply    action   integration:'email'  ref:'<send>'      config:{}
  t-gate     gate                                             config:{ reason:'refund > $100 needs a human' }
  t-escalate action   integration:'email'  ref:'<send>'      config:{}
edges:
  t-trigger → t-agent
  t-agent   → t-router
  t-router  → t-reply     condition:{ field:'refund', equals:false }
  t-router  → t-gate      condition:{ field:'refund', equals:true }
  t-gate    → t-escalate
```

When the Shopify connector lands, `t-trigger` becomes
`integration:'shopify', ref:'order.created'`, and `t-reply`/`t-escalate` gain
`getOrder`/`refundOrder` action refs — a pure content change to this constant, no
model change. Until then those nodes ship as `email` refs and the richer ones are
omitted, so the shipped template is always valid against the **current** registry.

---

## 3. Architecture

### 3.1 Files (exact paths)

| File | New / edit | Responsibility |
|---|---|---|
| `src/shared/flow-templates.ts` | **new** | The `FlowTemplate` / `FlowTemplateCategory` model + a pure `isFlowTemplate(x)` shape guard (mirrors `isFlowGraph`) used by the validation test and any future import path. No I/O. |
| `src/main/flow/builtin-templates.ts` | **new** | The `BUILTIN_FLOW_TEMPLATES: FlowTemplate[]` constant (the three seed graphs) + a `flowTemplateById(id)` lookup (mirrors `presetFor` in `agents.ts`). Config-as-code, in-repo. |
| `src/renderer/src/lib/flow-reducer.ts` | **edit** | Add pure `instantiateTemplate(template, { flowId, nodeIdFn, edgeIdFn, existingNames })` → a fresh `FlowGraph`. Sits next to `emptyGraph`; reuses the injected-id-source discipline already there. |
| `src/renderer/src/components/flow/FlowList.tsx` | **edit** | Render a **"New from template"** affordance: the template cards (grouped by category) next to the existing "New flow" button. Emits `onInstantiate(templateId)`. |
| `src/renderer/src/components/FlowCanvas.tsx` | **edit** | Fetch templates, own the instantiate handler (clone → `setGraph` → `setDirty(true)` → open), pass `templates` + `onInstantiate` into `FlowList`. |
| `src/shared/api.ts` | **edit** | Add `listFlowTemplates(): Promise<FlowTemplate[]>` to `SaiifeApi` (read-only; mirrors `listTemplates`). |
| `src/main/index.ts` | **edit** | Register `ipcMain.handle('flow:list-templates', () => BUILTIN_FLOW_TEMPLATES)` next to the existing `flow:list` / `flow:get` / `flow:save` handlers (index.ts:1088). |
| `src/preload/*` | **edit** | Bridge `listFlowTemplates` (the existing preload pattern for `listTemplates`). |
| `src/renderer/src/components/Landing.tsx` | **edit** | Add a **"Worker…"** entry to the create control (pseudo-agent select value, like `'browser'`); when picked, list saved flows and launch the chosen one via `runFlow`. (§5.) |

### 3.2 The instantiate transition (pure)

`instantiateTemplate` lives in `flow-reducer.ts` beside `emptyGraph`/`addNode`,
following the file's stated contract: *pure, returns a new `FlowGraph`, never
mutates input, ids injected for deterministic tests* (`flow-reducer.ts:1-21`).
Shape:

```ts
export function instantiateTemplate(
  template: FlowTemplate,
  opts: {
    flowId: string          // fresh flow id (FlowCanvas's flowIds.current())
    nodeIdFn: IdFn          // fresh node ids (nodeIds.current)
    edgeIdFn: IdFn          // fresh edge ids (edgeIds.current)
    existingNames: string[] // for de-dup (§3.3)
  }
): FlowGraph
```

Algorithm (all pure):
1. Build a `Map<oldNodeId, newNodeId>` by calling `nodeIdFn()` once per template
   node.
2. Emit nodes with the new id, a **deep-cloned** `config` (structuredClone /
   JSON round-trip — no shared object references with the template constant) and
   a **copied** `position` (`{ ...position }`, as `addNode` already does).
   `integration`/`ref` are copied verbatim (they're refs, not secrets).
3. Emit edges with `edgeIdFn()` ids and `from`/`to` re-mapped through the map;
   deep-clone any `condition`.
4. Set `id: opts.flowId`, `name: dedupeName(template.name, existingNames)`.

The deep clone is the **clone-integrity + fresh-id invariant** the tests assert
(§6): mutating the returned graph must never touch `BUILTIN_FLOW_TEMPLATES`, and
no id may be shared between template and instance.

### 3.3 Name de-dup on instantiate

`flow-store` keys flows by `id`, and `saveFlow` de-dupes by id
(`index.ts:440` filters out the same id before pushing) — so a fresh `flowId`
already avoids an id collision. But two "Ecom Support Worker" instances would
show two identically-named rows in `FlowList`. `dedupeName` appends a counter
when the base name already exists among `existingNames` (the loaded
`FlowSummary[]` names): `"Ecom Support Worker"`, then
`"Ecom Support Worker 2"`, etc. Pure, unit-tested, no store round-trip. (This is
a display nicety, not a correctness requirement — ids are the real key.)

### 3.4 Where the picker lands on the canvas

`FlowCanvas` renders `FlowList` when no graph is open (`FlowCanvas.tsx:156`).
`FlowList` today has a single "New flow" button (`FlowList.tsx:17`) that calls
`onNew` → `emptyGraph`. The picker replaces/augments that: a row of **template
cards** (reusing the `SessionTemplate` card look from `Landing.tsx` for
consistency — a bordered card with title + `description` subtitle + a small
category badge). Clicking a card calls `onInstantiate(templateId)`;
`FlowCanvas.instantiate` clones and opens it exactly as `openFlow` opens a saved
graph, but with `dirty:true` (unsaved). The **Blank/Custom** card is the
`custom-blank` template, so "start from scratch" is one card among the three —
`onNew`/`emptyGraph` remains as the underlying primitive it clones.

### 3.5 Disconnected / unregistered integrations on instantiate

The merged code **already** handles a node whose integration isn't connected —
this design changes nothing, it just relies on it:

- **Palette / node card:** `buildPalette` marks any row whose descriptor
  `status !== 'connected'` as `needsSetup` (`flow-palette.ts`), and the canvas
  passes a `needsSetup(id)` predicate into `CanvasSurface`
  (`FlowCanvas.tsx:62,195`). An instantiated template node on a not-yet-connected
  integration renders in the same "needs setup" state as one the user dragged in.
- **Validation banner:** `validateFlow` emits `integration-not-connected`
  (`flows.ts:53` `ValidationCode`), a human, actionable, node-named message —
  the `FlowToolbar` shows it as a validation issue, and the `NodeConfigPanel`'s
  "Open Integrations" affordance (`FlowCanvas.tsx:209`) points the user to
  connect it. The flow still **loads and edits** (the lenient list/edit posture,
  `flow-store.ts:5-18`); only **running** an unconnected-integration flow is
  refused, at run time, by the engine's strict parser (`index.ts:1109`).
- **Unregistered id (e.g. `'shopify'` before its connector ships):** because the
  registry simply won't contain that descriptor, `labelFor`/`needsSetup` treat
  it as not-connected (`?? 'needs-config'`, `FlowCanvas.tsx:62`) and the same
  banner fires. **The built-in set never ships a node referencing an
  unregistered id** (§2.1) — but if a *future* template or a user import does,
  the outcome is a legible "connect it in Integrations", never a crash. A
  validation code `integration-unknown` may be added if we want to distinguish
  "registered but not connected" from "no such integration" (§10.3).

### 3.6 Instantiate does NOT auto-save

Instantiate opens the clone as a **dirty, in-memory draft** (`setDirty(true)`),
identical to `newFlow`. It hits `flows.json` only when the user clicks Save
(`FlowCanvas.save` → `flow:save`). Rationale: a user who instantiates and then
navigates away shouldn't accrue orphan saved flows; and Save-then-Run
(`FlowCanvas.run`) already guarantees the engine executes persisted truth
(`index.ts:1108`). This also means the no-secret invariant is enforced at the
same `isFlowGraph` save boundary every flow already passes (`index.ts:433`).

---

## 4. Data flow

### 4.1 Pick a template → editable flow on the canvas

```
FlowCanvas (no graph) renders FlowList
   │  useEffect → window.saiife.listFlowTemplates()  (flow:list-templates IPC)
   │             → main returns BUILTIN_FLOW_TEMPLATES
   ▼
FlowList shows template cards (Blank / Ecom / CRM), grouped by category
   │  user clicks "Ecom Support Worker"  → onInstantiate('ecom-support')
   ▼
FlowCanvas.instantiate('ecom-support'):
   │  template = templates.find(id === 'ecom-support')
   │  graph = instantiateTemplate(template, {
   │            flowId: flowIds.current(),
   │            nodeIdFn: nodeIds.current, edgeIdFn: edgeIds.current,
   │            existingNames: flows.map(f => f.name) })      // pure, deep clone
   ▼
setGraph(graph); setSelectedId(null); setDirty(true)          // opens on canvas
   │  palette + CanvasSurface + validation render exactly as for any graph
   │  nodes on unconnected integrations show needsSetup + a validation banner
   ▼
user customizes (addNode/connect/updateNodeConfig — the existing pure reducer)
   ▼
user clicks Save → window.saiife.saveFlow(graph) → flow:save
   │  main: isFlowGraph(graph) gate → loadFlows filter-by-id → push → atomic write
   ▼
flows.json now has a new, user-owned flow.  (Run = Save-then-Run, unchanged.)
```

The **only** new code on this path is `listFlowTemplates` (a constant read) and
the pure `instantiateTemplate`. Everything downstream — palette, surface,
config panel, validation, save — is the merged canvas untouched.

### 4.2 Build a worker → launch it as a "custom agent"

```
user builds + saves a flow "Refund Triage"  → flows.json
   ▼
Landing.tsx create control: select gains a "Worker…" option (like 'browser')
   │  when selected: window.saiife.listFlows()  (existing flow:list IPC)
   │  → a second select / list of saved flow summaries by name
   ▼
user picks "Refund Triage" + clicks New session
   │  Landing calls a new onLaunchWorker(flowId)  (App wires it to runFlow)
   ▼
window.saiife.runFlow(flowId)  (existing flow:run IPC, index.ts:1099)
   │  main: getFlow(id) → flowEngine.run(graph, seed event)
   ▼
the engine walks the graph (spawns its own panes per the flow-engine design);
run state streams back over flow:run-event, rendered by the canvas overlay
```

**No new engine surface** — `runFlow` already exists and already returns
`{ ok; runId } | { ok:false; error }`. The worker-launch entry is a thin
Landing affordance over it. (§5 argues why this is a launcher entry, not an
`AgentPreset`.)

---

## 5. Workers as custom agents — the recommendation

**Recommendation: a launcher ENTRY that runs the flow (`runFlow`), NOT a new
`AgentPreset` kind.** Add a `'worker'` pseudo-value to `Landing.tsx`'s create
select — exactly parallel to the existing `'browser'` pseudo-value
(`Landing.tsx:433`) — that reveals a saved-flow picker and launches via the
already-merged `runFlow` IPC.

**Why not a new `AgentPreset`:**

- `AgentPreset` (`agents.ts:10`) models a **pty binary**: `bin`, `resumeArgs`,
  `startArgs`, `hookAdapter`. A worker has none of these — it's a `FlowGraph`
  run by the engine, which itself spawns agent panes internally (per the
  flow-engine design). Forcing a worker into `AgentPreset` would mean inventing a
  fake `bin` and an inapplicable `hookAdapter`, and `AgentRegistry.commandFor`
  (the resolver Landing's `resolvedPath`/PATH-detection UI leans on,
  `Landing.tsx:472`) has nothing to resolve.
- `AgentId` (`types.ts:10`) is a **closed union**
  (`'claude'|'codex'|'gemini'|'openclaw'|'shell'|'custom'`) validated by
  `VALID_AGENTS` at every IPC boundary. A worker id is a runtime `flows.json`
  id, not a compile-time union member — it can't be an `AgentId` without either
  widening the union to `string` (loses the boundary check that hardens control
  API + persistence) or minting a fake member.
- The launch **semantics differ**: `onCreate(agentId, customCommand)` opens a
  single pane; a worker launch hands a graph to the engine (`runFlow`), which
  produces a *run* (a `RunSnapshot`, `flows.ts:145`), not a pane. These are
  different verbs with different result shapes.

**Why the launcher-entry fits cleanly:**

- The `'browser'` precedent is exact: Landing already carries a non-`AgentPreset`
  select value (`'browser'`) with its own input (`urlInput`) and its own launch
  verb (`onCreateBrowser`) branched inside `create()` (`Landing.tsx:164`). A
  `'worker'` value with a saved-flow picker and an `onLaunchWorker(flowId)` verb
  is the same pattern, one more branch.
- It reuses `listFlows` + `runFlow` **verbatim** — zero new IPC for the launch
  itself (only the Landing UI changes).
- It keeps workers and agents as distinct concepts in the model, which matches
  how they actually run.

**Alternative considered (flagged, not chosen):** surface saved workers as their
own **card row** on Landing (like the `SessionTemplate` cards at
`Landing.tsx:401`) rather than a select value. Cleaner discovery, but it splits
"start something" across two visual patterns (cards vs the select) for what is
conceptually one launcher. Recommend the select entry for MVP; the card row is a
fast follow if discovery testing wants it (§10.1).

---

## 6. Error handling

Following saiife's principle (the error-message-style memory; demonstrated in
`flow-store.ts`'s legible notices and `saveFlow`'s human errors): **every failure
is human-readable, actionable, and carries the real cause. No silent catch.**

| Failure | Surface | Behavior |
|---|---|---|
| **Template refs a disconnected integration** (e.g. Ecom on an unconnected `email`) | The existing `needsSetup` node state + a `integration-not-connected` validation banner (`FlowToolbar`), and the `NodeConfigPanel` "Open Integrations" hint. | The flow **instantiates and edits fine** (lenient list/edit posture). Only **Run** is refused, at run time, by the engine's strict parser (`index.ts:1109`), with its legible run error. Never a crash. |
| **Template refs an unregistered id** (a future/typo id not in the registry) | Same banner path; treated as not-connected via `?? 'needs-config'` (`FlowCanvas.tsx:62`). The built-in set never ships one; a bad user import degrades gracefully. | Loads, edits, flagged; refused at run. Optional `integration-unknown` code to sharpen the message (§10.3). |
| **Name collision on instantiate** (a flow named "Ecom Support Worker" already exists) | `dedupeName` appends a counter → "Ecom Support Worker 2". No error shown — it's expected. | Ids are always fresh (`flowIds.current()`), so there is never an actual id/storage collision; de-dup is display-only. `saveFlow`'s filter-by-id (`index.ts:440`) is a backstop. |
| **A shipped template is malformed** (a bad seed graph slips into `builtin-templates.ts`) | Caught by the **CI validation test** (§7), not at runtime. Defense in depth: instantiate produces a graph that must still pass `isFlowGraph` at `flow:save`. | The build fails before ship; a runtime `flow:save` of a somehow-malformed clone is refused with the existing "This flow couldn't be saved — malformed…" error (`index.ts:434`). |
| **`listFlowTemplates` IPC fails** (shouldn't — it's a constant) | The picker shows only the "Blank" fallback + a small notice, mirroring `FlowCanvas`'s `setNotice` banner pattern (`FlowCanvas.tsx:159`). | The blank-flow path (`newFlow`) always works, so the canvas is never bricked by a template-fetch failure. |
| **Worker launch: flow deleted between list and launch** | `runFlow` already returns `{ ok:false, error: "That flow couldn't be found — it may have been deleted…" }` (`index.ts:1103`). Landing surfaces it. | The existing, legible run error is forwarded verbatim — no new message minted. |

No path catches-and-drops; where the merged code already has a loud message
(`saveFlow`, `runFlow`, the validation codes), templates **forward that message**
rather than inventing a vaguer one.

---

## 7. Testing strategy

All logic is **pure** (a template is data; instantiate and de-dup are pure
functions; the built-in set is a constant) — testable with **no Electron, no
IPC, no live integration**, matching the canvas's existing pure-reducer /
fixture-descriptor test seams.

- **`instantiateTemplate` — clone integrity + fresh ids (pure).** With injected
  deterministic `IdFn`s (the `flow-reducer.ts` pattern):
  - Every node/edge/flow id in the result differs from the template's placeholder
    ids and is drawn from the injected fns (assert exact ids).
  - Edge `from`/`to` are re-mapped consistently (each references a node present
    in the result — i.e. `isFlowGraph(result) === true`, `flows.ts:112`).
  - **Deep-clone invariant:** mutating a nested `config`/`condition`/`position`
    on the result does **not** mutate `BUILTIN_FLOW_TEMPLATES` (no shared
    references).
  - Node count / edge count / node `type`s / `integration`/`ref` refs are
    preserved exactly.
- **No-secret invariant (pure).** A test scans every built-in template's every
  node `config` (recursively) and asserts no key matches a secret-shaped
  denylist (`/token|secret|key|password|credential|apikey/i`) and no value looks
  like a credential. Regression guard for the global secret rule — a template is
  shareable JSON and must never carry secret material (§8).
- **Shipped-template validity (pure).** For each `t` in
  `BUILTIN_FLOW_TEMPLATES`: `isFlowGraph(t.graph) === true`, `isFlowTemplate(t)
  === true`, `category` is a known value, ids within a template are unique, and
  every `FlowEdge.from`/`to` resolves. (Catches a malformed seed at CI time, §6.)
- **`dedupeName` (pure).** Empty set → base name unchanged; one collision →
  `"… 2"`; a gap-filled set → next free counter. Deterministic.
- **`FlowList` picker (component).** Renders a card per template with title +
  `description` + category badge; clicking a card calls `onInstantiate` with the
  right id; the Blank card maps to `custom-blank`. (React Testing Library, the
  existing renderer-component seam.)
- **Landing worker entry (component).** Selecting `'worker'` reveals the saved-
  flow picker (fed by a mocked `listFlows`); picking a flow + New session calls
  `onLaunchWorker(flowId)`; an empty flow list disables launch with a legible
  hint. `runFlow` is mocked — no engine needed.
- **IPC smoke (main).** `flow:list-templates` returns `BUILTIN_FLOW_TEMPLATES`
  unchanged; a round-trip instantiate → `flow:save` → `flow:list` shows the new
  flow (the existing `flow-store` test harness).

No test requires a connected integration, a running engine, or a credential.

---

## 8. Secret hygiene

A `FlowTemplate` — and every `FlowGraph` it instantiates into — is **shareable
JSON** (it lives in-repo in `builtin-templates.ts` and, once saved, in the
user's `flows.json`). It must carry **only** integration **refs** and non-secret
node config, **never** a secret. This is the global secret rule and the
Integrations-Hub design applied verbatim:

- A node references an integration by **`integration: IntegrationId`** + a
  **`ref: string`** (`flows.ts:16-17`) — an *identifier*, never a credential.
  The actual token/API-key lives **only** in the Hub keychain (`safeStorage`),
  exactly as `integrations.ts` establishes: renderer DTOs "exclude secret values
  by construction" (`integrations.ts:100`), and `config.json` holds "non-secret
  refs only" (`flow-config.ts`). A template holds strictly less than
  `config.json` does.
- **Node `config` (`Record<string, unknown>`) is for non-secret parameters only**
  — a prompt string, a router field name, a gate reason. The no-secret test (§7)
  enforces this on the shipped set; the `isFlowGraph` save boundary
  (`index.ts:433`) is where a user-authored flow is gated before it touches disk.
- **Instantiate deep-clones config** so a template constant and a saved flow
  never share a mutable object — no accidental write-back into the in-repo
  constant, no cross-flow aliasing.
- **A shared/exported template (phase 2) is safe by construction:** because it can
  only ever contain refs + non-secret config, handing a template file to another
  user leaks nothing — the recipient supplies their **own** credentials in their
  **own** Hub. This is the property that makes templates a legitimate sharing
  unit at all, and it is preserved by never widening `FlowNode` to hold a value
  the Hub should own.

---

## 9. What this reuses (by path)

- `src/shared/flows.ts` — the pinned `FlowGraph`/`FlowNode`/`FlowEdge` a template
  **is**; `isFlowGraph` (the save-boundary + validity-test gate); `summarize`
  (the `FlowSummary` the picker de-dups names against); the `ValidationCode`s
  (`integration-not-connected`) a disconnected template node surfaces through.
- `src/main/flow/flow-store.ts` + `src/main/index.ts` `flow:*` — the store an
  instantiated template saves into (`saveFlow` filter-by-id + atomic write) and
  runs from (`runFlow`), both unchanged.
- `src/renderer/src/lib/flow-reducer.ts` — `emptyGraph`/`addNode`/`makeIdFn` +
  the injected-id / pure-transition discipline `instantiateTemplate` joins.
- `src/renderer/src/lib/flow-palette.ts` + `flow-validate.ts` — the
  `needsSetup` / `integration-not-connected` surfacing a template's unconnected
  node reuses with zero new code.
- `src/renderer/src/components/FlowCanvas.tsx` + `flow/FlowList.tsx` — the list
  surface where the picker lands; `openFlow`/`newFlow`/`save` as the model for
  `instantiate`.
- `src/shared/agents.ts` + `src/shared/templates.ts` + `Landing.tsx` — the
  preset model the worker-launch entry deliberately does **not** extend (§5);
  the `SessionTemplate` card look reused for the flow-template cards; the
  `'browser'` pseudo-agent pattern the `'worker'` entry mirrors.

---

## 10. Open decisions (FLAGGED — not resolved here)

1. **Worker-launch surface: select entry vs. card row.** §5 recommends the
   `'worker'` **select entry** (mirrors `'browser'`), with the saved-worker
   **card row** on Landing as the flagged alternative. Discovery-testing
   dependent; both use `listFlows` + `runFlow` underneath, so the choice is UI-
   only and reversible.
2. **When does the Ecom template adopt the Shopify vocabulary?** The shippable
   Ecom template triggers on `email` today (§2.1); the richer
   `shopify:order.created → getOrder → refundOrder` form is a pure data edit to
   `builtin-templates.ts` **once the Shopify connector adds `'shopify'` to
   `IntegrationId`** (forthcoming `2026-07-17-shopify-connector-design.md`, not
   yet on disk). Decide: ship Ecom-on-email now and upgrade later, or hold the
   Ecom template until Shopify lands. Recommendation: **ship on `email` now** —
   the get-started value doesn't wait on a connector.
3. **`integration-unknown` validation code.** Today an unregistered id degrades
   to `needs-config` (indistinguishable from "registered but not connected").
   Worth a distinct code + message ("no such integration '<id>' — it may need a
   connector that isn't installed") only if user-imported templates (phase 2)
   make this common. Deferred.
4. **Rich edge conditions.** Templates author against the **merged**
   `FlowEdge.condition = { field; equals }` (`flows.ts:25`). When the richer
   `FlowEdgeCondition { field; op; value? }` sibling spec lands (so a template's
   edge can carry `order.total > 100`), the built-in set upgrades additively.
   No model change here; flagged so the two specs stay coordinated.
5. **How many built-in templates, and per-category count.** MVP ships **three**
   (one per category: ecom/crm/custom). Whether to add a second per category
   (e.g. an "Ecom Order-Status" alongside "Ecom Support") is a content decision,
   deferred until the three are dogfooded.
6. **"Save this flow as a template."** MVP templates are in-repo only. A user
   "promote my flow to a template" flow (and template import/export as files)
   is the obvious phase-2 extension the model is already shaped for (§2, §8) —
   flagged, not built.

---

## 11. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

1. `FlowTemplate` model (`src/shared/flow-templates.ts`) + `isFlowTemplate`.
2. `BUILTIN_FLOW_TEMPLATES` with the **three** seed graphs (Blank, Ecom-on-email,
   CRM-on-linear) in `src/main/flow/builtin-templates.ts`.
3. `flow:list-templates` IPC + `listFlowTemplates` preload/api.
4. Pure `instantiateTemplate` + `dedupeName` in `flow-reducer.ts`, with tests
   (clone integrity, fresh ids, no-secret, shipped-validity).
5. `FlowList` template-card picker → `FlowCanvas.instantiate` → open-as-draft.

That slice makes the canvas open **to a picker instead of blank**, and a user can
one-click a real Ecom/CRM worker and customize it — the entire get-started value,
end-to-end, on connected integrations today.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton above — templates + picker + instantiate.
- **Phase 2 — workers as custom agents:** the `'worker'` launch entry in
  `Landing.tsx` over `listFlows` + `runFlow` (§5). Deliberately sequenced after
  Phase 1 because it depends on users having **built** workers worth launching.
- **Phase 3 — richer templates:** adopt the Shopify vocabulary in the Ecom
  template once its connector lands (§10.2); adopt rich edge conditions once that
  sibling lands (§10.4); add second-per-category templates if dogfooding wants
  them (§10.5).
- **Phase 4 — user templates:** "save this flow as a template" + template
  import/export as shareable (secret-free, §8) JSON files (§10.6); the
  `integration-unknown` code to make imported-template gaps legible (§10.3).

---

## Appendix — grounding cross-reference

| Claim | Code |
|---|---|
| A template **is** a seed `FlowGraph` | `src/shared/flows.ts:27` (`FlowGraph { id; name; nodes; edges }`) |
| Node carries integration **ref**, not secret | `src/shared/flows.ts:13-20` (`integration?`, `ref?`, `config`) |
| Merged edge condition is `{ field; equals }` | `src/shared/flows.ts:25` |
| Instantiate saves into the existing store | `src/main/index.ts:430-445` (`saveFlow` filter-by-id + atomic) |
| Run is Save-then-Run through the real engine | `src/main/index.ts:1099-1114`; `FlowCanvas.tsx:142-152` |
| Canvas opens blank today | `src/renderer/.../FlowCanvas.tsx:74-78` (`newFlow` → `emptyGraph`) |
| Picker lands on the list surface | `src/renderer/.../FlowCanvas.tsx:156-162`; `flow/FlowList.tsx:12-24` |
| Pure, injected-id reducer discipline | `src/renderer/.../lib/flow-reducer.ts:1-21` |
| Disconnected node already surfaces `needsSetup` | `src/renderer/.../lib/flow-palette.ts` (`needsSetup`); `FlowCanvas.tsx:62,195` |
| Disconnected node validation code | `src/shared/flows.ts:53` (`integration-not-connected`) |
| `'browser'` pseudo-agent precedent for `'worker'` | `src/renderer/.../Landing.tsx:164,433` |
| `AgentPreset` is a pty binary, not a graph | `src/shared/agents.ts:10-32` |
| `AgentId` is a closed, boundary-checked union | `src/shared/types.ts:10,14` |
| `SessionTemplate` is a *different* (pane) template | `src/shared/templates.ts:17`; `Landing.tsx:401-414` |
| Secrets stay in the Hub keychain, refs in config | `src/shared/integrations.ts:100`; `src/main/flow/flow-config.ts` |
