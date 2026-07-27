# Flow Builder Canvas — Design

**Date:** 2026-07-16
**Status:** Design (spec) — not started. Design-approval gate for the marquee
"pilot" UI. Sub-project **#3 of 3** in the visual-flows program
(**#1 Integrations Hub** → **#2 Flow Engine** → **#3 Flow Canvas**).
**Feature:** A Shopify-Flow-style drag-and-drop editor — a new saiife **VIEW**
where the user drops nodes from a **palette** (trigger / agent / action / gate /
router), positions them, draws **arrows** (edges) between them, configures each
node in a **side panel**, and **saves/loads** a `FlowGraph` that the hybrid Flow
Engine (#2) runs. Jonas's words: *"a drag and drop component setup that creates
an agent and connects integrations, point arrows between them, just like Shopify
Flows, user-based."*

This sub-project **produces** a `FlowGraph`. It **consumes** two pinned
interfaces owned by the other sub-projects: the `IntegrationDescriptor` registry
(#1) supplies the trigger/action palette, and the `FlowGraph` model + engine (#2)
consume what the canvas saves. Both interfaces are treated as fixed contracts
(§8), with stubs (§9) so this can be built before they land.

It reuses saiife's existing seams verbatim — the `view` union + view-switch in
`App.tsx`, the `Sidebar` nav pattern, the typed IPC surface
(`api.ts` → `preload` → `ipcMain.handle`), the atomic-write / corrupt-file
persistence discipline of `persistence.ts`, the status-color design system in
`styles.css`, and the operator control API (`POST /panes`) as the engine's arm
into real agent panes — it does **not** reinvent any of them.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a user visually author a flow — drop nodes, wire
arrows, configure each node against connected integrations — and save it as a
`FlowGraph` that the Flow Engine runs, all inside a new saiife view that looks
and behaves like the rest of the app.

### In scope (MVP — the "walking skeleton")

- A new **`flows` view** in `App.tsx` (peer of `home` / `environment` /
  `cockpit` / `settings`) and a **"Flows"** nav button in `Sidebar.tsx`.
- A **`FlowCanvas`** renderer component: a left **node palette**, a center
  **canvas surface** (pan/zoom, node placement, edge drawing), a right
  **per-node config panel**, and a top **toolbar** (flow name, Save, Run, new
  flow, validation summary).
- **Palette** with the five `FlowNodeType`s. `trigger` and `action` entries are
  generated from the `IntegrationDescriptor` registry (#1) — one palette row per
  integration trigger/action; `agent` / `gate` / `router` are built-in.
- **Node placement** by drag-from-palette-drop-on-canvas (or click-to-add),
  writing a `FlowNode` with a `position: {x, y}`.
- **Edge drawing** by dragging from one node's out-handle to another's
  in-handle, writing a `FlowEdge { from, to }`.
- **Per-node config panel**: type-specific fields — integration + trigger/action
  `ref` selection, `agent` prompt/agentId/environment, `gate` condition, `router`
  branch conditions — writing into `FlowNode.config` and `FlowEdge.condition`.
  **Secret** integration fields are shown but **never persisted into the
  `FlowGraph`** (§6.4, honoring the global secret rule).
- **Save / load** of a `FlowGraph` to/from persistence via new IPC
  (`flow:save` / `flow:list` / `flow:get` / `flow:delete`), stored under
  `userData/flows/` with the exact atomic-write + corrupt-file discipline of
  `persistence.ts`.
- **Run** wiring: a `flow:run` IPC hands the saved `FlowGraph` to the Flow Engine
  (#2, or its stub §9) — the engine, not the canvas, spawns agent panes via the
  operator `POST /panes` surface.
- **Pure, unit-testable graph-edit reducers** (`flow-reducer.ts`) and **pure
  validation** (`flow-validate.ts`) fully separated from rendering (§7).
- **Opt-in:** the view exists but is inert with no flows and no integrations; it
  never changes saiife's "works with nothing configured" guarantee.

### Out of scope (MVP) — explicitly deferred

- **Live-run overlay** — painting the engine's live per-node status back onto the
  canvas (reusing the `--working`/`--needs-you`/`--idle` status colors). The data
  path exists (engine reuses `onStatus`/`onActivity`); the overlay is phase 2
  (§10.3, §11).
- **Undo/redo** — the reducer is designed to make this a thin add (pure
  transitions over an immutable graph), but the history stack is phase 2.
- **Node grouping / sub-flows / templates gallery** — a flat single-graph editor
  only.
- **Multi-select / box-select / bulk move / copy-paste** — single-node select in
  MVP.
- **Auto-layout** — manual positions only (the engine never needs layout; it
  reads topology, not geometry).
- **Owning integration credential entry** — secret capture lives in the
  Integrations Hub (#1). The config panel *links to* it; it does not duplicate it
  (§6.4).
- **Owning execution** — the engine (#2) owns run semantics, scheduling,
  branching evaluation. The canvas only authors + hands off the graph.

---

## 2. The Shopify-Flow model → saiife primitives

Shopify Flow is *trigger → condition → action*. saiife generalizes it to a
five-node graph, and every node type maps onto an existing saiife primitive so
nothing is invented:

| `FlowNodeType` | What it is | saiife primitive it maps to |
|---|---|---|
| `trigger` | Entry point — an integration event starts the flow. Palette-sourced from `IntegrationDescriptor.triggers`. | A `FlowGraph` must have ≥1 (§5 validation). At run time the engine (#2) subscribes it; the canvas only records `{ integration, ref }`. |
| `agent` | "Creates an agent" — spawns a saiife terminal pane running a chosen agent with a prompt. | The engine spawns it via `POST /panes` (`kind:'terminal'`, an `OPERATOR_TERMINAL_AGENTS` agent) then `POST /panes/:h/prompt` — the same guarded operator surface Linear/OpenClaw use. Config = `{ agentId, environment, prompt }`. |
| `action` | A side-effecting integration call. Palette-sourced from `IntegrationDescriptor.actions`. | The engine invokes the integration's action; config = `{ integration, ref, ...fields }`. Secret fields are references only (§6.4). |
| `gate` | Human-in-the-loop / condition checkpoint — "pause for approval" or "only continue if". | Reuses the `needs-you` primitive — a `gate` an agent hits surfaces as `needs-you`, resolvable by `ApproveButton` exactly as today. Config = `{ condition: {field, equals} }` or `{ manual: true }`. |
| `router` | Fan-out on a condition — different downstream edges taken per outcome. | Realized purely as `FlowEdge.condition {field, equals}` on the outgoing edges; the node marks the branch point. |

The canvas is deliberately **topology-authoring only**: it never runs a node, never
evaluates a condition, never touches a secret payload. It records intent
(`FlowGraph`) and hands it to the engine.

---

## 3. Architecture in saiife

### 3.1 Where it sits

A new **renderer view** plus a thin **main-process store**, wired exactly like
every other saiife view/IPC pair:

- **Renderer:** a `flows` value added to `App.tsx`'s `view` union (currently
  `'home' | 'environment' | 'settings' | 'changes' | 'activity' | 'cockpit'`,
  `App.tsx:93`), a render branch that mounts `<FlowCanvas/>` (alongside the
  `view === 'cockpit' ? <Cockpit/>` branch, `App.tsx:963`), an `enterFlows`
  handler, and a **"Flows"** button in `Sidebar.tsx`'s `<nav>` (next to
  "Cockpit", `Sidebar.tsx:128`). `Sidebar`'s `view` prop union widens by one
  value; the mapping in `App.tsx:811` gains a `view === 'flows' ? 'flows'` arm.
- **Main:** a `flow-store.ts` peer of `persistence.ts`, plus IPC handlers in
  `index.ts` next to the existing `session:*` / `operator:*` handlers, exposed
  through `preload/index.ts` and typed in `shared/api.ts` — the identical
  three-file pattern every other call follows.

Everything the engine needs to actually *run* a flow is the engine's (#2). The
canvas's main-process footprint is only **persistence + a run hand-off**.

### 3.2 New modules (named, with real paths)

**Renderer — rendering (impure, manual/e2e-tested):**

| Module | Responsibility |
|---|---|
| `src/renderer/src/components/FlowCanvas.tsx` | The view container. Owns the in-memory editor state (current `FlowGraph`, selected node id, validation result), wires palette + surface + config panel + toolbar, and drives the save/load/run IPC. The one stateful component; delegates every graph *mutation* to the pure reducer (§3.3). |
| `src/renderer/src/components/flow/NodePalette.tsx` | Left rail. Renders built-in node types + integration-sourced trigger/action rows (from `flow-palette.ts`). Each row is a drag source (HTML5 DnD) and a click-to-add fallback. |
| `src/renderer/src/components/flow/CanvasSurface.tsx` | The pan/zoom drawing surface: renders `FlowNode`s as cards and `FlowEdge`s as arrows, hosts the drop target, and emits interaction intents (`add`, `move`, `connect`, `select`) up to `FlowCanvas`. **This is the only module that touches the canvas library** (§10.1) — it's the swappable adapter. |
| `src/renderer/src/components/flow/FlowNodeCard.tsx` | One node's visual: type icon, label, integration badge, per-node validation badge, and the in/out connection handles. Reuses the status-color tokens for its border (live-run overlay, phase 2). |
| `src/renderer/src/components/flow/NodeConfigPanel.tsx` | Right rail. Renders the selected node's type-specific form (§6.3), writing edits back through the reducer. Renders integration secret fields as managed-by-Hub (§6.4). |
| `src/renderer/src/components/flow/FlowToolbar.tsx` | Top bar: flow name (rename), Save, Run, New, and the validation summary chip (§5). |
| `src/renderer/src/components/flow/FlowList.tsx` | The "open a flow" surface (list of saved flows from `flow:list`, + "New flow"). Shown when no flow is open, mirroring `Landing`'s role for the environment view. |

**Renderer — pure logic (unit-tested, no React, no DOM):**

| Module | Responsibility |
|---|---|
| `src/renderer/src/lib/flow-reducer.ts` | **The heart of the sub-project.** Pure graph-edit transitions over an immutable `FlowGraph`: `addNode`, `removeNode` (cascades incident edges), `moveNode`, `updateNodeConfig`, `connect` (rejects self-loops, duplicate edges, unknown endpoints), `disconnect`, `setEdgeCondition`, `renameFlow`. Id generation is injected (`idFn`) exactly as `SessionManager` injects its clock — deterministic in tests. Every function returns a new `FlowGraph`; never mutates. |
| `src/renderer/src/lib/flow-validate.ts` | Pure validation → a typed `ValidationResult` (§5): missing trigger, unreachable node, dangling edge, unconfigured integration node, disallowed cycle. Table-driven, mirrors `state-machine.ts`'s purity. |
| `src/renderer/src/lib/flow-palette.ts` | Builds the palette model from the `IntegrationDescriptor` registry (#1) + the built-in node types. Pure over its `IntegrationDescriptor[]` input, so it's testable with fixture descriptors. |

**Shared:**

| Module | Responsibility |
|---|---|
| `src/shared/flow.ts` | The pinned `FlowGraph` / `FlowNode` / `FlowEdge` / `FlowNodeType` types (§8, VERBATIM), plus canvas-local additions: `ValidationResult`/`ValidationIssue` (§5), `FlowSummary` (list-view row: `{id, name, nodeCount, updatedAt}`), and `VALID_NODE_TYPES` for boundary validation (mirrors `VALID_AGENTS` in `types.ts`). Imported by both renderer and main. |

**Main:**

| Module | Responsibility |
|---|---|
| `src/main/flow-store.ts` | Persistence peer of `persistence.ts`: `listFlows` / `loadFlow(id)` / `saveFlow(graph)` / `deleteFlow(id)`, one JSON file per flow under `userData/flows/<id>.json`, **atomic tmp+rename**, **corrupt-file backup + `safeToPersist`** and a **save-failure notice pushed** to the renderer — all copied from `persistence.ts` (§4.3), not re-invented. |

### 3.3 The pure-core / rendering split (the load-bearing decision)

All graph *meaning* lives in `flow-reducer.ts` + `flow-validate.ts` — pure
functions over `FlowGraph`. `FlowCanvas.tsx` holds the graph in `useState` and,
on every interaction, calls a reducer to get the next graph. `CanvasSurface.tsx`
is a *projection* of the graph, never the source of truth.

This is the same discipline the codebase already rewards: `state-machine.ts`,
`close-focus.ts`, `group-order.ts`, `pane-nav.ts`, and `order.ts` are all pure
modules with heavy unit tests while the React shell stays thin. It buys three
things: (1) the whole graph-edit surface is unit-testable without a DOM or a
canvas library; (2) the canvas library (§10.1) is a swappable rendering adapter,
not an architectural dependency — because it never owns state; (3) undo/redo and
autosave become trivial phase-2 adds (snapshot the immutable graph).

---

## 4. Data flow

### 4.1 The authoring loop (palette → place → wire → configure → save → engine)

```
┌──────────────────────────── FlowCanvas.tsx (renderer) ─────────────────────────────┐
│                                                                                      │
│  NodePalette ──drag/drop or click──► intent{addNode, type, integration?, position}   │
│        │  (trigger/action rows built by flow-palette.ts from IntegrationDescriptor[])│
│        ▼                                                                              │
│  flow-reducer.addNode(graph, ...) ──► new FlowGraph (node appended, injected id)      │
│        │                                                                              │
│  CanvasSurface renders nodes+edges ──drag out-handle→in-handle──► intent{connect}     │
│        ▼                                                                              │
│  flow-reducer.connect(graph, from, to) ──► new FlowGraph (+FlowEdge, or rejected)     │
│        │                                                                              │
│  select node ──► NodeConfigPanel(form) ──edit──► flow-reducer.updateNodeConfig(...)   │
│        │                                          (integration ref, agent prompt, …)  │
│        ▼                                                                              │
│  flow-validate(graph) ──► ValidationResult ──► inline node badges + toolbar chip      │
│        │                                                                              │
│  Toolbar "Save" ──► window.saiife.saveFlow(graph) ─IPC─► flow-store (atomic write) │
│  Toolbar "Run"  ──► window.saiife.runFlow(graph.id) ─IPC─► Flow Engine (#2 / stub) │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                                              │ engine, at run time:
                                                              ▼
                        control-api  POST /panes (kind:terminal, agentId, groupId)
                                     POST /panes/:handle/prompt   (saiifeguard-guarded)
                                     ──► SessionManager.create ──► real agent pane
```

Key properties:
- Every mutation is `graph → reducer → graph'`; React state is set to `graph'`.
  The surface re-projects. No interaction path bypasses the reducer.
- The canvas hands the engine a **graph id** (`runFlow(id)`), and the engine
  loads the just-saved graph from `flow-store` — so a Run always executes
  persisted truth, never unsaved editor state (Run is disabled while dirty, or
  saves-then-runs; see §10.2).
- The engine, not the canvas, is the only thing that spawns panes. The canvas has
  **no** operator grant and **never** calls `POST /panes` itself — keeping the
  capability boundary (`OPERATOR_TERMINAL_AGENTS`, saiifeguard) entirely on the engine
  side.

### 4.2 Save / load path (IPC)

New IPC, following the exact `api.ts` → `preload` → `ipcMain.handle` shape:

```ts
// shared/api.ts (added to SaiifeApi)
/** All saved flows as lightweight summaries (list view). */
listFlows(): Promise<FlowSummary[]>
/** Full graph by id; null if unknown/unreadable. */
getFlow(id: string): Promise<FlowGraph | null>
/** Persists a flow (atomic). ok:false carries a human error (disk full, etc.). */
saveFlow(graph: FlowGraph): Promise<{ ok: true; summary: FlowSummary } | { ok: false; error: string }>
/** Removes a saved flow. */
deleteFlow(id: string): Promise<void>
/** Hands the saved graph to the Flow Engine (#2). Returns a run id or a legible error. */
runFlow(id: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }>
/** Pushed when a later flow save fails (mirrors onPersistenceNotice). */
onFlowPersistenceNotice(cb: (message: string) => void): () => void
```

```ts
// preload/index.ts   (identical wrapper shape to the existing entries)
listFlows: () => ipcRenderer.invoke('flow:list'),
getFlow:   (id) => ipcRenderer.invoke('flow:get', id),
saveFlow:  (g)  => ipcRenderer.invoke('flow:save', g),
deleteFlow:(id) => ipcRenderer.invoke('flow:delete', id),
runFlow:   (id) => ipcRenderer.invoke('flow:run', id),
// onFlowPersistenceNotice: ipcRenderer.on('flow:notice', …) — same pattern as persistence:notice
```

```ts
// main/index.ts   (next to the session:* / operator:* handlers)
ipcMain.handle('flow:list',  () => flowStore.listFlows())
ipcMain.handle('flow:get',   (_e, id: string) => flowStore.loadFlow(id))
ipcMain.handle('flow:save',  (_e, g: unknown) => flowStore.saveFlow(g))   // validates shape at boundary
ipcMain.handle('flow:delete',(_e, id: string) => flowStore.deleteFlow(id))
ipcMain.handle('flow:run',   (_e, id: string) => engine.run(id))          // engine = #2 or stub (§9)
```

`flow:save` **re-validates the graph shape at the IPC boundary** before writing
(untrusted renderer input, exactly as `persistence.ts`'s `filterSessions` /
`isGroup` guards and the control-API's body parsing do) — a malformed node type,
a non-object config, or an edge referencing an unknown node is rejected with a
legible error rather than persisted.

### 4.3 Persistence shape

`flow-store.ts` copies `persistence.ts`'s discipline verbatim — this is a
non-negotiable house pattern (see the `LoadedState.safeToPersist` doctrine):

- One file per flow: `userData/flows/<flowId>.json`. (`userData` via
  `app.getPath('userData')`, `index.ts:188`; `flows/` created with `mkdir -p`
  semantics on first save.)
- **Atomic write:** `writeFileSync(tmp)` then `renameSync(tmp, file)` — a crash
  mid-write never truncates a flow (copied from `saveState`).
- **Corrupt/unreadable on load:** a file that exists but won't parse is **backed
  up aside** (`.corrupt-<iso>`) and the load returns a legible notice, never a
  silent empty — and it is **not** overwritten unless the backup rename succeeded
  (`safeToPersist`). A read error (EACCES/EBUSY) leaves the file untouched and
  flagged not-safe-to-persist. This is `parseCorruptStateFor` /
  `readErrorStateFor` applied per-flow.
- **Save-failure telemetry:** a later save failure (disk full, permission
  revoked) is **pushed** to the renderer as a notice
  (`onFlowPersistenceNotice`), mirroring `onPersistenceNotice` — the editor keeps
  working in memory, the user is warned the on-disk copy is stale. Rendered as a
  dismissible banner, same shape as `persistenceNotice` in `App.tsx:796`.

---

## 5. Validation model

`flow-validate.ts` is pure: `(graph: FlowGraph, registry: IntegrationDescriptor[])
→ ValidationResult`.

```ts
type ValidationSeverity = 'error' | 'warning'
interface ValidationIssue {
  severity: ValidationSeverity
  nodeId?: string          // badge target; absent = graph-level
  edgeId?: string
  code: 'no-trigger' | 'unreachable' | 'dangling-edge' | 'missing-config'
      | 'integration-not-connected' | 'cycle' | 'empty-graph'
  message: string          // human, actionable, names the node/integration
}
interface ValidationResult { ok: boolean; issues: ValidationIssue[] }
```

Rules (each an `error` unless noted):

| code | Condition | Message shape (human + actionable) |
|---|---|---|
| `empty-graph` (warning) | zero nodes | "This flow is empty — drop a trigger from the palette to start." |
| `no-trigger` | no `trigger` node | "A flow needs a trigger to start it — add a trigger node." |
| `unreachable` (warning) | node with no path from any `trigger` | "This <type> node isn't reachable from any trigger — connect an arrow into it, or remove it." |
| `dangling-edge` | edge whose `from`/`to` names a missing node | "An arrow points at a node that no longer exists — reconnect or delete it." (self-heals: the reducer already cascades edges on `removeNode`; this catches imported/corrupt graphs.) |
| `missing-config` | integration node with no `ref`, or a required non-secret field empty | "The <label> <trigger/action> needs configuring — open it and pick the <field>." |
| `integration-not-connected` | node's integration `status()` is `'needs-config'`/`'error'` | "<Integration label> isn't connected — finish setup in Integrations. (<real status>)" |
| `cycle` | a cycle through non-`router` nodes (routers may loop by design — flagged §10.2) | "This flow loops back on itself through <node> — remove the arrow or route it through a router." |

Validation runs **live** on every reducer result (cheap — small graphs), feeding
(a) per-node badges on `FlowNodeCard` and (b) a summary chip in the toolbar
("2 issues"). Whether an `error` **blocks Save vs only Run** is a flagged UX
decision (§10.2); the MVP default is **Save always allowed (drafts are valid on
disk), Run blocked on any `error`** with the issue list surfaced.

---

## 6. The config panel (per-node)

`NodeConfigPanel.tsx` renders a form keyed on the selected node's `type`. Every
edit calls `flow-reducer.updateNodeConfig(graph, nodeId, patch)`.

### 6.1 Node-type forms

| type | Fields | Writes |
|---|---|---|
| `trigger` | integration select (registry) → trigger select (`descriptor.triggers`) → the descriptor's non-secret `configFields` | `node.integration`, `node.ref` (trigger id), `node.config[field.key]` |
| `agent` | agent select (`OPERATOR_TERMINAL_AGENTS`: claude/codex/gemini), environment (1–9), prompt (textarea) | `node.config = { agentId, environment, prompt }` |
| `action` | integration select → action select (`descriptor.actions`) → non-secret `configFields` | `node.integration`, `node.ref` (action id), `node.config[...]` |
| `gate` | mode: manual approval (`needs-you`) *or* condition `{field, equals}` | `node.config = { manual }` or `{ condition }` |
| `router` | one row per outgoing edge: `{field, equals}` for that branch | `edge.condition` on each `FlowEdge` leaving this node (via `setEdgeCondition`) |

### 6.2 Palette ↔ registry binding

`flow-palette.ts` turns each `IntegrationDescriptor` into palette rows: one
`trigger` row per `descriptor.triggers[]` and one `action` row per
`descriptor.actions[]`, tagged with `descriptor.id` + `descriptor.label`. The
built-in `agent`/`gate`/`router` rows are static. When an integration's
`status()` is not `'connected'`, its rows still appear but are marked "needs
setup" (draggable — you can author against a not-yet-connected integration; the
validator flags it, §5).

### 6.3 Config-field rendering

Non-secret `configFields` render as labeled inputs (text, with `placeholder`),
required ones marked; empty required fields drive a `missing-config` issue (§5).
This reuses the visual language of `Settings.tsx`'s agent-override inputs (the
`card` / labeled-input pattern) so the panel looks native.

### 6.4 Secrets — never durable (global rule, applied)

`IntegrationDescriptor.configFields[].secret === true` fields are **the
integration's**, not the flow's. The `FlowGraph` is persisted as **plain JSON on
disk** (§4.3) and is savable/shareable — so a secret must never enter
`FlowNode.config`.

- The canvas **never writes a secret value into `FlowNode.config`.** A node
  references an integration by `id` + `ref`; the secret credential lives in the
  Integrations Hub's keychain-backed store (#1), exactly as Linear's tokens live
  in `safeStorage` and `config.json` holds only a reference.
- The config panel renders secret fields **read-only**, as a
  managed-by-Integrations affordance: "Managed in Integrations — <status>", with
  a link/button to open the Hub (#1). It does **not** offer an input that would
  capture the secret into the graph.
- This is the global CLAUDE.md rule ("secret material must never be rendered into
  anything durable — a file, a commit, a message") applied to the FlowGraph as a
  durable artifact. A saved/exported flow contains only references; it can be
  shared without leaking anything.

---

## 7. Testing strategy

Mirrors saiife's existing seams — **pure logic is exhaustively unit-tested;
rendering is manual + e2e** (the split §3.3 exists precisely to make this
possible).

**Unit (vitest, no DOM):**

- **`flow-reducer.test.ts`** — the core. `addNode` places with the given
  position and an injected id; `removeNode` cascades every incident edge;
  `connect` rejects self-loops, duplicate edges, and unknown endpoints, accepts
  valid ones; `moveNode` updates only position; `updateNodeConfig` is a shallow
  merge and never touches other nodes; `disconnect`/`setEdgeCondition` behave;
  every function returns a **new** object and mutates nothing (assert referential
  inequality). Ids injected (`idFn`) for determinism — the `SessionManager`
  injected-clock pattern.
- **`flow-validate.test.ts`** — table-driven, one case per §5 rule plus the
  happy path: fixture graphs → expected `ValidationResult`. Style copied from
  `state-machine.ts`'s transition tests.
- **`flow-palette.test.ts`** — fixture `IntegrationDescriptor[]` → expected
  palette rows (built-ins + one row per trigger/action, correct "needs setup"
  marking from `status()`).
- **`flow-store.test.ts`** (main) — round-trip save/load; atomic write; a
  corrupt file is backed up and load returns a notice + `safeToPersist`; a read
  error leaves the file untouched and not-safe-to-persist; a save failure returns
  `ok:false` with a legible error. Directly mirrors the existing
  `persistence.test.ts` cases.
- **Boundary test** — `flow:save` with a malformed graph (bad node type,
  non-object config, edge to a missing node) is rejected, not written.

**Manual + e2e (Playwright, `electron-vite build && playwright test`):**

- e2e happy path: open Flows → drag a trigger from the palette onto the canvas →
  drag an agent node → draw an edge between them → configure the agent's prompt →
  Save → reload the app → reopen the flow → assert the graph round-tripped
  (nodes, edge, config present). Selectors via stable `data-*` hooks
  (`data-node-id`, `data-flow-node-type`, `data-edge-id`) — the same
  `data-pane-id` / `data-nav-session` convention the existing e2e relies on.
- **e2e caution (from the dogfood backlog):** drag-drop and edge-draw are
  pointer-sequence-heavy and historically flaky under Playwright (cf. the
  hardened browser-pane e2e, commit `b4851b2`). Prefer driving node
  add/connect through a **deterministic test hook** (a click-to-add + a
  click-source-then-click-target connect path that doesn't depend on precise
  pixel drag) for the CI e2e, and keep pixel-accurate drag as a manual check.
- Rendering correctness (edge routing, pan/zoom, handle hit-targets) is a
  **manual** check — it is not unit-tested, by design.

No test needs a real integration, a real engine, or credentials: the palette is
fed fixture descriptors, and `flow:run` targets the engine **stub** (§9).

---

## 8. Interfaces (consumed + produced)

**Produced — the pinned `FlowGraph` (owned by #2, used VERBATIM):**

```ts
type FlowNodeType = 'trigger' | 'agent' | 'action' | 'gate' | 'router'
interface FlowNode { id: string; type: FlowNodeType; integration?: IntegrationId; ref?: string; config: Record<string, unknown>; position: { x: number; y: number } }
interface FlowEdge { id: string; from: string; to: string; condition?: { field: string; equals: unknown } }
interface FlowGraph { id: string; name: string; nodes: FlowNode[]; edges: FlowEdge[] }
```

The canvas's reducers operate on exactly this shape; `flow-store` persists exactly
this shape (round-trippable JSON). `position` is canvas-only (the engine ignores
it, reading topology); it lives in the model so a saved flow re-opens laid out as
the user left it.

**Consumed — the pinned `IntegrationDescriptor` registry (owned by #1, used
VERBATIM):**

```ts
type IntegrationId = 'linear' | 'email' | 'cloud'
interface IntegrationDescriptor { id: IntegrationId; label: string; configFields:{key:string;label:string;secret:boolean;required:boolean;placeholder?:string}[]; triggers:{id:string;label:string}[]; actions:{id:string;label:string}[]; status():'connected'|'needs-config'|'error' }
```

The registry supplies the trigger/action palette (§6.2), the config-panel fields
(§6.3), the secret-field marking (§6.4), and the connectedness for validation
(§5). The canvas reads it via #1's IPC (expected `listIntegrations():
Promise<IntegrationDescriptor[]>`; note `status()` is a method — over IPC it is
resolved to a value at fetch time, i.e. the renderer receives
`{...descriptor, status: 'connected'}`; `flow-palette.ts` / `flow-validate.ts`
accept the resolved shape).

**Dependency direction:** #1 (registry) and #2 (engine + FlowGraph type) are
upstream; the canvas depends on both and is depended on by neither. It is the
last of the three to integrate.

---

## 9. Stubbing #1 and #2 (building before they land)

Neither the Integrations Hub (#1) nor the Flow Engine (#2) exists in the repo
yet. The canvas is built against **stubs** behind the exact pinned interfaces, so
the real modules drop in with no canvas changes:

- **`src/shared/flow.ts`** carries the pinned `FlowGraph`/`FlowNode`/`FlowEdge`/
  `FlowNodeType` types now (they're this sub-project's output contract anyway).
  When #2 lands, if #2 owns these types, `flow.ts` re-exports from #2's module —
  a one-line change, since the shapes are identical by fiat.
- **Integration registry stub** — `src/shared/integrations.ts` (a stub owned
  transiently here, handed to #1 when it lands) exports the `IntegrationId` /
  `IntegrationDescriptor` types and a fixture `listIntegrations()` returning
  descriptors for `linear` / `email` / `cloud` with a couple of triggers/actions
  each and `status: () => 'needs-config'`. The canvas consumes it through the
  IPC seam (§8); swapping the stub IPC handler for #1's real one is a
  main-process edit, invisible to the renderer.
- **Engine stub** — the `flow:run` handler targets an `engine` object with a
  `run(id)` method. The stub loads the graph via `flow-store`, runs
  `flow-validate`, and — instead of executing — logs a run summary to the console
  bus and returns `{ ok: true, runId }` (or a legible validation error). This
  proves the save→run hand-off end-to-end without #2. When #2 lands, the stub is
  replaced by the real engine's `run`; the IPC signature is unchanged.

The seam is explicit and one-file-per-dependency, so "built before they land" is
a swap, not a rewrite.

---

## 10. Open decisions (FLAGGED — not resolved here)

### 10.1 Canvas library — React Flow vs hand-rolled SVG/DOM

**The biggest technical fork.** `package.json` currently has **no** canvas/graph
dependency (deps are only `@xterm/*`, `node-pty`, `react`, `react-dom`). The two
options:

- **`@xyflow/react` (React Flow v12).** Purpose-built for exactly this: node
  dragging, drag-to-connect handles, bezier edge routing, pan/zoom, selection,
  optional minimap — the fiddly, well-solved interaction layer. Supports React
  19. **Cost:** it is saiife's *first heavy renderer dependency* — it pulls
  `d3-zoom`/`d3-drag`/`d3-selection` + `zustand` and adds ~100–150 KB gzipped to
  the renderer bundle. That's a bundle/tree concern, not a runtime-RAM one (a
  small graph is cheap), but it cuts against the repo's conspicuously lean dep
  tree and hand-rolled ethos (the project hand-rolls its shell tokenizer, pane
  navigation, order reconciliation).
- **Hand-rolled SVG/DOM.** Nodes as absolutely-positioned divs inside a
  `transform: scale/translate` viewport; edges as SVG bezier `<path>`s;
  connection-drag and pan/zoom as pointer handlers. **Cost:** re-implementing
  edge routing, hit-testing, and zoom correctly is real, error-prone work — the
  precise part React Flow already gets right.

**Recommendation: adopt `@xyflow/react` for MVP, but confine it entirely to
`CanvasSurface.tsx` as a swappable rendering adapter** (§3.3). Because the
`FlowGraph` and all mutation logic live in pure library-agnostic reducers,
React Flow never owns state — it's a projection with an `onNodesChange`/
`onConnect` callback that we translate into reducer calls. This gets the hard
interaction right *now*, keeps the door open to rip it out later (the adapter is
one file, ~a few hundred lines), and quarantines the dependency. **Still flagged,
not unilaterally resolved** — a reviewer who weights the lean-deps ethos over
build speed can choose the hand-rolled path with zero change to reducers,
validation, store, IPC, or tests (they're all library-agnostic by design). The
decision is genuinely reversible; that's the point of §3.3.

### 10.2 Validation UX + when Save/Run are allowed

- **Save-while-invalid:** MVP default = drafts save freely, Run blocks on any
  `error`. Alternative = block Save too. (Drafts-save is friendlier and matches
  "your work is never lost"; flagged.)
- **Run-while-dirty:** save-then-run automatically, or disable Run until saved?
  (Leaning save-then-run so `flow:run` always executes persisted truth, §4.1.)
- **Cycles:** are back-edges through a `router` legitimate (loops/retries) or
  always an error? MVP treats non-router cycles as errors and router cycles as
  allowed-but-warned — needs #2's engine semantics to confirm.
- **When to validate:** live-on-every-edit (chosen, cheap for small graphs) vs
  on-save-only.

### 10.3 Live-run overlay

When the engine runs a flow it spawns agent panes whose status flows through the
existing `onStatus`/`onActivity` taps. Painting that back onto the canvas
(coloring each `agent` node's border with the `--working`/`--needs-you`/`--idle`
tokens the whole app already uses, and a "running" pulse) is the obvious phase-2
"pilot" moment. Open: how the engine reports **per-node** run state back to the
renderer (a new `onFlowRun(runId, nodeId, status)` push, presumably owned by #2),
and whether the canvas subscribes directly or via a run-scoped view. Designed-for
(node cards already carry a status-border slot) but deferred.

### 10.4 Multiple flows / list UX

`FlowList` vs a flows section in the `Sidebar` (like environments/sessions). MVP
= a simple list surface; a richer sidebar tree is phase 2. Flow id generation and
name uniqueness (dupe names allowed? id is the key) to settle.

---

## 11. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One flow, trigger → agent, drawn and saved and handed to a stub engine:**

1. `flows` view + "Flows" nav button; `<FlowCanvas/>` mounts, shows `FlowList`
   (empty) + "New flow".
2. Palette with built-in nodes + fixture-integration trigger/action rows
   (registry stub §9).
3. Drop a `trigger` and an `agent` node (reducer `addNode`); draw an edge
   between them (reducer `connect`).
4. Configure the agent node (agentId + environment + prompt) in the config
   panel; configure the trigger's integration `ref`.
5. Save → `flow-store` writes `userData/flows/<id>.json` atomically; reload →
   the flow round-trips.
6. Run → `flow:run` → engine **stub** validates + logs a run summary + returns a
   run id (or a legible validation error). No real pane yet — that's the engine's
   job, wired when #2 lands.

That slice proves the entire author→save→hand-off loop and is dogfoodable (Jonas
builds a flow visually and watches it validate + persist + hand off).

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton above. React Flow behind the adapter
  (§10.1). Pure reducers + validation fully tested. Stubs for #1/#2.
- **Phase 2 — real integration + real engine:** swap the registry stub for #1's
  IPC; swap the engine stub for #2's `run`; agent nodes spawn real panes via
  `POST /panes`. Add the **live-run overlay** (§10.3) — node borders colored by
  live status. Add gate → `needs-you` round-trip via `ApproveButton`.
- **Phase 3 — editor polish:** undo/redo (trivial given immutable graphs),
  multi-select + box-select + copy/paste, node search in the palette, auto-layout
  (tidy button), keyboard nav on the canvas.
- **Phase 4 — flow management:** a flows tree in the sidebar, flow templates
  (starter graphs), import/export (safe — no secrets, §6.4), duplication,
  enable/disable a flow.
- **Phase 5 — scheduling/observability:** run history per flow, scheduled/
  event-driven triggers surfaced, a run inspector (which node ran, its pane, its
  output) tying the canvas to the Activity/Console surfaces.

---

## Appendix — reused saiife surfaces (by path)

- `src/renderer/src/App.tsx` — the `view` union + view-switch (`:93`, `:963`) the
  `flows` view slots into; the dismissible-notice banner pattern (`:796`,
  `persistenceNotice`) reused for `onFlowPersistenceNotice`; the
  `getX-on-mount + onXChanged-push` effect shape.
- `src/renderer/src/components/Sidebar.tsx` — the `<nav>` button pattern (`:128`)
  the "Flows" nav item copies; the `view` prop union widened by one.
- `src/renderer/src/components/Cockpit.tsx` / `Settings.tsx` — the full-view
  layout + labeled-input/`card` form idiom the config panel and toolbar match, so
  the canvas view looks native.
- `src/main/persistence.ts` — the atomic tmp+rename write, corrupt-file backup,
  `safeToPersist` no-clobber invariant, and pushed save-failure notice that
  `flow-store.ts` copies per-flow.
- `src/shared/api.ts` + `src/preload/index.ts` + `src/main/index.ts` — the
  three-file typed-IPC pattern (`invoke`/`handle` for requests, `on` for pushes)
  every `flow:*` call follows; boundary validation of untrusted renderer input
  (`filterSessions`/`isGroup`).
- `src/main/control-api.ts` — `POST /panes` (`OPERATOR_TERMINAL_AGENTS`,
  `kind:'terminal'`, `groupId`) + `POST /panes/:handle/prompt` (saiifeguard-guarded):
  the surface the **engine** (#2) uses to turn an `agent` node into a real pane.
  The canvas never calls it directly.
- `src/shared/types.ts` — `VALID_AGENTS` as the model for `VALID_NODE_TYPES`
  boundary validation; `AgentId` (`OPERATOR_TERMINAL_AGENTS` subset) for the
  agent-node selector.
- `src/renderer/src/styles.css` — the status-color design system
  (`--working`/`--needs-you`/`--idle`/`--running`/`--exited`, `--surface`,
  `--font-mono`) reused for node-card borders (live-run overlay) and canvas
  chrome, so nodes speak the same visual status language as panes.
- `src/main/state-machine.ts`, `src/renderer/src/lib/{order,pane-nav,close-focus}`
  — precedent for the pure-module + heavy-unit-test discipline `flow-reducer.ts`
  / `flow-validate.ts` follow.
- `src/renderer/src/components/ApproveButton.tsx` + `src/main/peek.ts` — the
  `needs-you` approval primitive a `gate` node reuses at run time (phase 2).
