# Flow Engine — Design

**Date:** 2026-07-16
**Status:** Design (spec) — not started. Sub-project **#2 of 3** in localflow's
visual-flow product direction (Integrations Hub → **Flow Engine** → Flow Canvas).
Brainstorm-approved 2026-07-16.
**Feature:** A **headless, hybrid** execution engine that runs user-authored
visual flows (Shopify-Flow style). The engine owns the **routing between systems**
and the **gating** — both deterministic/boolean — while agent panes do the
**content/judgment inside nodes** and humans approve at **gates**. **No LLM decides
routing.** It reuses the pane model, the hook-driven status feed, the operator
control API + grant, `peek`/`ApproveButton`, and lfguard — it does **not** reinvent
any of them, and it invents no new external-integration code (that is sub-project
#1's Integrations Hub).

Interface basis (pinned, brainstorm-approved): this sub-project **owns** the
`FlowGraph` model (sub-project #3's canvas *produces* it; the engine *consumes*
it) and **consumes** `IntegrationDescriptor` + an `IntegrationRegistry` from
sub-project #1. House-style/depth basis:
`docs/superpowers/specs/2026-07-16-linear-integration-design.md`.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Given a user-authored `FlowGraph`, deterministically
walk it — start a run from an integration **trigger**, drive **agent** panes for
content, invoke integration **action** write-backs, hold at **gate** nodes for
human approval, and branch at **router** nodes on **boolean** edge conditions —
with every routing/gating decision made by the engine (not an LLM), and prove the
whole thing headlessly against mocks with an injected clock.

### The hybrid contract (non-negotiable — "boolean, not feelings of LLMs")

| Concern | Owner | Determinism |
|---|---|---|
| **Routing** between nodes/systems | the engine (router nodes + edge conditions) | boolean, no LLM |
| **Gating** (proceed / stop) | the engine + a **human** at gate nodes | boolean approve/reject |
| **Content / judgment** inside a node | an **agent pane** (claude/codex/gemini) | free-form; the engine reduces its outcome to a boolean before routing on it |
| **Write-backs** to external systems | sub-project #1 connectors, invoked by the engine | deterministic API calls |

The engine never asks an LLM "which node next?". An agent produces content; the
engine extracts a **boolean/typed fact** from it (§3.4, open decision §10.4) and
routes on that fact. This is the whole point of the hybrid split.

### In scope (MVP — the headless foundation slice)

- A new **main-process module set** under `src/main/flow/` (peer of the operator
  subsystem, wired in `src/main/index.ts` next to `startControlServer` /
  `startHookServer`). **Opt-in**: absent flow config, the engine never starts and
  localflow's "works with no integration/flow configured" guarantee is untouched
  — exactly the posture the Linear connector and OpenClaw operator launch took.
- The **`FlowGraph` persistence model** (§7): flows stored as **config-as-code**
  JSON, **validated at the boundary** (the `parseOperatorRevokeOnExit` /
  `loadSavedState` discipline — garbage disables a flow, never throws).
- A **headless execution engine** (`flow-engine.ts`) that executes a
  **trigger → agent → action → gate → router** graph, driven entirely by:
  - a **mock `IntegrationRegistry`** (canned trigger events; recording
    `invokeAction`) — no live external calls;
  - the **real `SessionManager` + `spawnFn` fake-pty seam** (`src/main/session-manager.ts`)
    driven through the **real `handleRequest` control-API router**
    (`src/main/control-api.ts`, pure over its inputs);
  - a **mock `ApprovalPort`** for gates;
  - an **injected clock** (`now: () => number`, exactly as `SessionManager`
    injects it) so every run is deterministic.
- **Per-run state** (`run-state.ts`): each node's status, held **in-memory**
  (mirroring the operator grants / issue↔pane map — in-memory, not surviving
  restart), with the run observable through the **existing status feed** (the
  agent panes it spawns already report to `manager.onStatus`/`onActivity`).
- The five **node-type runners** (§3), each a dependency-injected, unit-testable
  function (the `pane-ops.ts` / `state-machine.ts` purity pattern).
- The **consumed interface from #1** (§8.2) and the **produced interface for #3**
  (§8.3) defined explicitly.
- Errors **human-readable, actionable, carrying the real exception**, no silent
  catch (`error-message-style`, demonstrated throughout `session-manager.ts`).

### Out of scope (MVP) — explicitly deferred

- **Live integration wiring.** MVP runs against the mock registry only; wiring to
  #1's real Linear/email/cloud connectors is phase 2 (§11). The *seam* is defined
  now (§8.2) so it's an additive swap, not a rewrite.
- **Consuming #3's canvas output live.** MVP hand-authors `FlowGraph` JSON /
  fixtures; the canvas round-trip is phase 4. The model #3 produces is pinned now.
- **Run durability across restart** (a persisted run journal + resume). MVP runs
  are in-memory like grants (§10.1).
- **Retry/backoff** on a failed node (§10.3), **per-flow concurrency policy**
  beyond a RAM-safe cap (§10.2), **scheduled/cron triggers** (only integration
  triggers in MVP), **sub-flows / reusable node groups**.
- Any **new external-API code** — that is sub-project #1's Integrations Hub. The
  engine only *invokes* the registry.
- Any **new approval UI primitive** — gates reuse `needs-you` + `peek` +
  `ApproveButton` (the exact surface reused vs a first-class run surface is
  §10.5).

---

## 2. Architecture in localflow

### 2.1 Where it sits

`src/main/flow/` is a peer of the operator subsystem. Like the Linear connector,
it is **an in-process operator client**: it does **not** reach into
`SessionManager` privately to spawn/drive panes — it goes through the **same
control-API surface** OpenClaw and Linear use (`src/main/control-api.ts`), so the
capability boundary (`OPERATOR_TERMINAL_AGENTS`), the prompt **guard** (lfguard
via `operatorGuard`), and per-environment isolation all apply to flow-driven work
identically. It obtains a grant via the existing `OperatorGrantStore.grant(env)`
and calls the router in-process (`handleRequest` is documented as pure over its
inputs — `control-api.ts:119-124` — precisely so an in-process caller needs no
socket).

### 2.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/shared/flow.ts` | **Owned** shared types: `FlowNodeType`, `FlowNode`, `FlowEdge`, `FlowGraph` (pinned §8.1), plus the run-state types **produced** for #3 (`NodeRunStatus`, `RunStatus`, `RunSnapshot`, `RunEvent`). Needed by both main and any renderer/#3 surface. |
| `src/main/flow/flow-model.ts` | **Pure validator** `parseFlowGraph(raw: unknown): FlowGraph \| null` + graph invariants (exactly one `trigger` node; every edge `from`/`to` resolves to a node; no orphan nodes; conditions well-typed). Mirrors `state-machine.ts` / `operator-config.ts` purity. The Developer-Preview blast radius for the model shape. |
| `src/main/flow/flow-store.ts` | Persistence: load/save `flows.json` **config-as-code**, atomically (the `writeFileSync(tmp)`+`renameSync` pattern in `persistence.ts`), each flow validated through `parseFlowGraph` at the read boundary — an invalid flow is disabled with a loud notice, never crashes load. |
| `src/main/flow/flow-config.ts` | Reads the `flows` block from `config.json` (which flows enabled, environment scoping) — the config-as-code pattern of `operator-config.ts` / `editor-config.ts`. Non-secret refs only. |
| `src/main/flow/flow-engine.ts` | **The orchestrator.** Owns run lifecycle, the **deterministic graph walk**, the run registry, and the `onRunStatus`/`onNodeStatus`/`onRunActivity` fan-out (mirrors `SessionManager`'s callback fan-out). The one place the walk lives. |
| `src/main/flow/run-state.ts` | **Pure** per-run state + a reducer: `NodeRunStatus` per node, `readyNodes(graph, state)` (all inbound edges satisfied), `advance(state, nodeId, outcome)`. Unit-testable in isolation like `state-machine.ts`. |
| `src/main/flow/trigger-subscriber.ts` | Subscribes to the `IntegrationRegistry` trigger stream (§8.2); matches an inbound `TriggerEvent` to the `trigger` node of an enabled flow (`node.integration === event.integrationId && node.ref === event.triggerId` + config filter); starts a run seeded with the event payload. |
| `src/main/flow/pane-driver.ts` | The agent-node driver: holds/obtains the environment's operator grant, calls `handleRequest` for `POST /panes` (terminal) + `POST /panes/:handle/prompt`, and watches `manager.onStatus` for **that pane's** transitions to know when the node is done/needs-you/failed. The in-process control-API client. |
| `src/main/flow/node-runners/agent-runner.ts` | Runs an `agent` node: spawn+prompt via `pane-driver`, resolve on pane `idle` (done) / `exited` (fail, forwarding the real instant-exit tail), surface `needs-you` on the existing feed. |
| `src/main/flow/node-runners/action-runner.ts` | Runs an `action` node: `registry.invokeAction(integrationId, actionId, params)` (params templated from run context), writes the result into run context, fails legibly on a rejected/needs-config integration. |
| `src/main/flow/node-runners/gate-runner.ts` | Runs a `gate` node: requests approval via the injected `ApprovalPort` (bound to the `needs-you`/`ApproveButton` primitive in production, a mock in tests); a **boolean** approve/reject drives routing. Never auto-proceeds. |
| `src/main/flow/node-runners/router-runner.ts` | Runs a `router` node: **pure** evaluation of each out-edge `condition` (`{field, equals}`) against the run context; routes to matching edges. No LLM, no side effects. |
| `src/main/flow/context.ts` | The run-scoped **context** (a `Record<string, unknown>` keyed by node id) + a pure `resolveField(context, path)` / `applyTemplate(str, context)` used by conditions and action params. Deterministic; boolean/typed only. |

### 2.3 Wiring point

In `src/main/index.ts`, next to `startControlServer` (line ~298) and the
`manager.onStatus`/`onActivity` taps (lines ~405/420), the engine is constructed
with: the `SessionManager`, an `OperatorGrantStore` grant source, the
`handleRequest` control deps, the `IntegrationRegistry` (from #1), and the
injected `now`. The engine **joins as an additional subscriber** on the two
existing status taps — a fourth subscriber alongside the renderer IPC, the
console bus, and (when present) the Linear connector:

```
manager.onStatus((id, status) => { ...renderer + console + linear... ; flowEngine.onPaneStatus(id, status) })
```

The engine never registers its own pty listeners — it reuses the one feed.

---

## 3. The five node types (execution semantics)

Every node runner is dependency-injected and returns a **`NodeOutcome`**
(`{ status: 'done' | 'failed' | 'rejected'; context?: Record<string, unknown>;
message?: string }`). The engine (`flow-engine.ts`) is a small event-driven state
machine over `run-state.ts`: it computes `readyNodes`, dispatches each to its
runner by `node.type`, and on each outcome advances the run and re-computes ready
nodes. Agent and gate nodes **suspend** (async, resolve later on a pane/approval
event); trigger/action/router resolve promptly.

### 3.1 `trigger` — start a run

- `node.integration` = an `IntegrationId`; `node.ref` = a trigger id from that
  integration's `IntegrationDescriptor.triggers[].id`.
- The `trigger-subscriber` matches an inbound `TriggerEvent` to this node and
  **starts the run** — the trigger node is immediately `done`, its payload written
  to context under the node id (e.g. `context[triggerNodeId] = { from, subject,
  body, threadId }`). Optional `node.config` holds boolean **filter predicates**
  (e.g. `{ labelEquals: 'support' }`) evaluated deterministically before a run
  starts — a non-matching event simply starts no run.
- Trigger events come from #1's connectors: Linear `AgentSessionEvent`
  (`created`/`prompted`), email inbound (Pub/Sub/watch), devops (none in MVP —
  devops is action/agent-side). See the connector specs (§ Appendix).

### 3.2 `agent` — content/judgment inside a pane

- `node.ref` = an `AgentId` that **must be in `OPERATOR_TERMINAL_AGENTS`**
  (`control-api.ts:64` — `claude`/`codex`/`gemini`; the engine is an operator
  client and inherits that capability boundary verbatim — `shell`/`openclaw`/
  `custom` are rejected upstream in `parseOperatorPaneRequest`).
- `node.config` carries `{ promptTemplate, environment (1-9), groupId? }`.
  `pane-driver` grants the environment, `POST /panes` (`kind: terminal`,
  `agentId: node.ref`, `groupId`), then `POST /panes/:handle/prompt` with the
  template rendered against run context (`applyTemplate`). The prompt is **guarded
  by lfguard** exactly like any operator prompt (`control-api.ts:227-241`).
- **Completion = pane `idle`** (a `Stop` hook → `state-machine.ts` `Stop→idle`).
  The engine watches `onPaneStatus` for that pane id and resolves the node `done`.
- **`needs-you` inside an agent node** (the agent asking a question, not a routing
  gate) is surfaced on the existing feed (`ApproveButton` + `peek`); the human
  answers in the cockpit; the pane returns to `working`→`idle`; the node then
  completes. This is distinct from a `gate` node (§3.4).
- **Instant-exit** (the `INSTANT_EXIT_MS` path in `session-manager.ts`) → node
  `failed`, `message` = the pane's real `info.message` (the instant-exit tail),
  **forwarded verbatim** — the engine never mints a vaguer error.
- **Outcome extraction (the hybrid seam):** to route on what the agent decided,
  the engine reduces the pane's output to a typed fact — MVP reads a **sentinel
  line** from `manager.peek()` (the same peek `ApproveButton` shows) and parses it
  into `context[nodeId]` (e.g. a `FLOW_RESULT: {"category":"bug"}` line). The
  agent produces content; the **engine** turns it into a boolean/typed value; the
  router routes on that. Exact extraction mechanism is open (§10.4).

### 3.3 `action` — integration write-back

- `node.integration` = an `IntegrationId`; `node.ref` = an action id from
  `IntegrationDescriptor.actions[].id`; `node.config` = params (templated from
  context).
- Runner calls `registry.invokeAction(integration, ref, params)` (§8.2) and writes
  the returned `ActionResult` into `context[nodeId]`. Examples the flagship needs:
  Linear `createIssue` / `issueUpdate` (→ Review) / `comment`; email `sendDraft`
  (the never-auto-send send call — but **only** reachable *after* a gate, §3.4);
  cloud `applyPlan`.
- A **rejected** integration (`descriptor.status() !== 'connected'`) fails the node
  legibly *before* any call ("Linear is not connected — connect it in Settings"),
  not a silent no-op.

### 3.4 `gate` — human approval to route (boolean)

- The engine requests approval via the injected **`ApprovalPort`**:
  `requestApproval({ runId, nodeId, prompt, peek }): Promise<boolean>`.
  In production the port binds to the **existing `needs-you` primitive** — the
  human peeks the pending content (`peek` = the draft body / the plan / the
  question) and clicks `ApproveButton` to approve or an explicit reject; the exact
  binding (reuse the driving pane's `needs-you`, or a first-class flow-run
  approval surface on the Overview) is **open, §10.5**. In tests the port is a
  mock that resolves `true`/`false`.
- A **`true`** routes to the gate's approve out-edge; a **`false`** routes to its
  reject out-edge, or — if none — ends the run cleanly as **`rejected`** (a human
  "no" is not a failure). **The engine never auto-proceeds past a gate.**
- This is the **never-auto-send gate** in the flagship: the customer reply draft
  sits behind a gate; only a human approve reaches the email `sendDraft` action.
  It is also the **devops plan→apply gate** and the Linear `elicitation` pause.

### 3.5 `router` — boolean branch

- **Pure.** For each out-edge, evaluate its `condition?: { field; equals }`
  against run context (`resolveField(context, field) === equals`, a deterministic
  value compare — no LLM). An edge with **no** condition is unconditional (always
  taken). The run advances along every matching edge (fan-out); the matching set
  is deterministic given the context. Multi-match vs first-match-only is a
  config-level choice (§10.8).

---

## 4. Data flow — the flagship loop, node by node

Flagship scenario: **customer email → agent triages → create Linear issue → hook
to git+CI/CD (cloud) → status streams back onto the Linear issue (needs-you →
elicitation) → on done → move issue to Review → customer reply only through the
never-auto-send gate.** As a `FlowGraph`:

```
[T email:inbound] → [A triage(claude)] → [R route(category)] ──bug──► [Ac linear.createIssue]
                                                        │                        │
                                                        └──other──► [Ac linear.comment]     ▼
                                                                            [A cloud.deploy(claude)]  ← runs git+CI/CD in a pane
                                                                                     │  (pane needs-you at plan)
                                                                                     ▼
                                                                            [G plan-apply gate] ──approve──► [Ac cloud.applyPlan]
                                                                                     │ reject                        │
                                                                                     ▼                               ▼
                                                                               (run rejected)          [Ac linear.issueUpdate → Review]
                                                                                                                     │
                                                                                                                     ▼
                                                                                                        [A draft-reply(claude)]
                                                                                                                     │
                                                                                                                     ▼
                                                                                              [G never-auto-send gate] ──approve──► [Ac email.sendDraft]
                                                                                                                     │ reject
                                                                                                                     ▼
                                                                                                               (run rejected)
```

Walk (each ► names the engine mechanism):

1. **`T` email:inbound** — #1's email connector fires a `TriggerEvent`
   (`integrationId:'email', triggerId:'inbound', payload:{from,subject,body,threadId}`).
   ► `trigger-subscriber` matches the trigger node, starts a run, writes the
   payload to context. Node `done`.
2. **`A` triage (claude)** — ► `pane-driver` grants env, `POST /panes` (terminal,
   claude) + `POST /panes/:h/prompt` with the templated triage instruction
   (guarded by lfguard). Pane goes `working` (`UserPromptSubmit→working`) then
   `idle` (`Stop→idle`). ► engine peeks a `FLOW_RESULT:{"category":...}` sentinel
   into context. Node `done`.
3. **`R` route(category)** — ► `router-runner` evaluates each out-edge condition
   (`{field:'<triageNode>.category', equals:'bug'}`) against context — **boolean,
   no LLM**. Routes to `linear.createIssue` (bug) or `linear.comment` (other).
4. **`Ac` linear.createIssue** — ► `registry.invokeAction('linear','createIssue',
   {title,body})`. Returns `{issueId}` into context.
5. **`A` cloud.deploy (claude)** — ► another agent pane runs the git+CI/CD work in
   the configured cloud environment (short-lived creds injected by #1's cloud
   connector's spawn env; the engine only prompts the pane). As it works, its
   `working`/`needs-you`/`idle` transitions are on the existing feed. **Status
   streams back onto the Linear issue** via #1's Linear connector, which is *also*
   a subscriber on `onStatus` — the engine does not duplicate that; it shares the
   one feed. When the pane hits `needs-you` at the plan boundary, that is the gate.
6. **`G` plan-apply gate** — ► `gate-runner` requests approval (peek = the plan /
   the `needs-you` question). Human approves → route to apply; rejects → run
   `rejected`. This is the devops plan→apply gate.
7. **`Ac` cloud.applyPlan** — ► `registry.invokeAction('cloud','applyPlan',…)`
   (only reached post-gate). Result to context.
8. **`Ac` linear.issueUpdate → Review** — ► on the deploy branch completing,
   `registry.invokeAction('linear','issueUpdate',{stateId:'Review'})`.
9. **`A` draft-reply (claude)** — ► agent drafts the customer reply (email
   `gmail.compose` scope creates a *draft*, never sends). Pane `idle`.
10. **`G` never-auto-send gate** — ► `gate-runner` requests approval (peek = the
    draft body). **Only** a human approve advances. Hard invariant honored: the
    send is on the human side of the gate.
11. **`Ac` email.sendDraft** — ► `registry.invokeAction('email','sendDraft',
    {draftId})` — the single send call, reached only through the gate. Run `done`.

**Mapping the run onto the status feed:** the run is observable *through its
panes* — each agent node's pane already reports `working`/`needs-you`/`idle` to
`manager.onStatus`, surfaced in the cockpit + console + (if connected) Linear. The
engine additionally derives a **run-level status** (`running` if any node
running/waiting; `needs-you` if any gate awaiting; `done`/`failed`/`rejected`
terminal) and fans it out via `onRunStatus`/`onNodeStatus`/`onRunActivity` — the
same callback-registration shape `SessionManager` uses (`onStatus`/`onActivity`).
Whether a run gets its own cockpit row or is seen purely through its panes is
§10.7 (a #3 concern).

---

## 5. Per-run state & the resumable posture

`run-state.ts` holds, per run:

```
interface RunSnapshot {
  runId: string
  flowId: string
  triggerEventId: string
  status: RunStatus                       // 'running' | 'needs-you' | 'done' | 'failed' | 'rejected'
  nodes: Record<string, NodeRunStatus>    // 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped'
  context: Record<string, unknown>        // node-id-keyed outputs; boolean/typed facts only
  startedAt: number; endedAt?: number     // via injected clock
  message?: string                        // terminal failure/reject reason (carries the real exception)
}
```

- **In-memory, like grants.** Runs live in a `Map<runId, RunSnapshot>` inside
  `flow-engine.ts`. They **do not survive a restart** — mirroring
  `OperatorGrantStore` ("All in-memory — grants do not survive a restart") and the
  Linear issue↔pane map ("On app restart the map is empty").
- **What *does* survive:** the **durable panes** the agent nodes spawned survive
  restart as `exited` sessions (the durable-session model) — re-drivable by hand.
  After a restart, in-flight runs are lost but their work isn't orphaned; the
  panes remain in the cockpit. Full run **durability/resume across restart** is
  the connectors' known gap and is **open (§10.1)**.
- **Injected clock.** All timestamps and any debounce/stale/timeout logic use
  `this.opts.now?.() ?? Date.now` — the exact seam `SessionManager` exposes
  (`opts.now`) — so integration tests are deterministic.
- **Concurrency:** one run per matched trigger event. A RAM-safe **cap on
  concurrent live agent panes** is required (the dev-machine memory note: an 8 GB
  Mac; panes + Electron + Claude compete for RAM). Cap policy is §10.2.

---

## 6. (reserved — see §8 for interfaces)

---

## 7. Config & data model

Two config surfaces, both **config-as-code, validated at the boundary**, **no
secrets** (secrets stay in the keychain via #1's connectors; the engine never
holds a credential):

### 7.1 `flows.json` — the flow definitions (owned by this sub-project)

Stored in `userData`, loaded/saved atomically by `flow-store.ts` (the
`writeFileSync(tmp)`+`renameSync` atomic pattern from `persistence.ts:169-173`).
Each flow is a `FlowGraph` (§8.1) — the exact document #3's canvas produces:

```jsonc
{
  "flows": [
    {
      "id": "support-triage",
      "name": "Customer email → triage → Linear → deploy → reply",
      "nodes": [ /* FlowNode[] — trigger/agent/action/gate/router */ ],
      "edges": [ /* FlowEdge[] — with boolean conditions on router out-edges */ ]
    }
  ]
}
```

Every flow is validated through `parseFlowGraph` (§2.2) on read: a malformed flow
(bad node type, dangling edge `to`, missing trigger, ill-typed condition) is
**disabled with a loud, specific notice** naming the offending field — never a
throw, never a silent drop (the `operator-config.ts` "only well-typed values are
honored; garbage disables the feature" discipline).

### 7.2 `config.json` — the `flows` enablement block (non-secret refs)

```jsonc
{
  "flows": {
    "enabled": true,
    "environment": 1,          // default localflow env (1-9) hosting flow-driven panes
    "maxConcurrentPanes": 2    // RAM-safe cap (dev-machine memory constraint)
  }
}
```

Absent or `enabled:false` → the engine never starts (opt-in). Read fresh like
`loadOperatorRevokeOnExit`. Contains **only** references and non-secret ints —
never a token (the global never-render-secrets rule; `config.json` = non-secret
refs only).

---

## 8. Interfaces

### 8.1 OWNED — the `FlowGraph` model (pinned, VERBATIM)

This sub-project **owns** these types (`src/shared/flow.ts`). Sub-project #3's
canvas **produces** them; the engine **consumes** them. Reproduced verbatim from
the brainstorm-pinned interface — the canvas and engine must agree byte-for-byte:

```ts
type FlowNodeType = 'trigger' | 'agent' | 'action' | 'gate' | 'router'
interface FlowNode { id: string; type: FlowNodeType; integration?: IntegrationId; ref?: string; config: Record<string, unknown>; position: { x: number; y: number } }
interface FlowEdge { id: string; from: string; to: string; condition?: { field: string; equals: unknown } }
interface FlowGraph { id: string; name: string; nodes: FlowNode[]; edges: FlowEdge[] }
```

Field usage by node type (the engine's read of the shared model): `integration` +
`ref` name a trigger (trigger node) / an action (action node); `ref` alone names
an `AgentId` (agent node) — never used by router; `config` carries the
per-node params (prompt template, env, filter predicate, gate prompt); `position`
is #3's concern (the engine ignores it). `FlowEdge.condition` is the **boolean**
routing predicate the router evaluates.

**Produced *for* #3** (also `src/shared/flow.ts`) — the run-state types the canvas
renders as a live overlay: `RunStatus`, `NodeRunStatus`, `RunSnapshot` (§5), and
the `RunEvent` union emitted by the engine's fan-out
(`{kind:'run-status'|'node-status'|'run-activity', runId, …}`).

### 8.2 CONSUMED — `IntegrationDescriptor` + `IntegrationRegistry` (from #1)

`IntegrationDescriptor` is consumed **verbatim** (pinned):

```ts
type IntegrationId = 'linear' | 'email' | 'cloud'
interface IntegrationDescriptor { id: IntegrationId; label: string; configFields: {key:string;label:string;secret:boolean;required:boolean;placeholder?:string}[]; triggers:{id:string;label:string}[]; actions:{id:string;label:string}[]; status():'connected'|'needs-config'|'error' }
```

The engine additionally depends on a small **`IntegrationRegistry`** surface that
#1 exposes (the runtime companion to the descriptors). This is a **co-owned
seam** with #1 (§10.9) — the minimal contract the engine needs:

```ts
interface TriggerEvent { integrationId: IntegrationId; triggerId: string; eventId: string; payload: Record<string, unknown> }
interface ActionResult { ok: boolean; output?: Record<string, unknown>; error?: string }
interface IntegrationRegistry {
  list(): IntegrationDescriptor[]                         // for validation: does node.integration/ref exist?
  describe(id: IntegrationId): IntegrationDescriptor | null
  onTrigger(cb: (event: TriggerEvent) => void): void     // #1 connectors fire; trigger-subscriber matches → start run
  invokeAction(id: IntegrationId, actionId: string, params: Record<string, unknown>): Promise<ActionResult>
}
```

The engine uses `list()`/`describe()` at flow-validation time (reject a flow
referencing an unknown trigger/action id or an `integration` whose
`status()` is `needs-config`), `onTrigger` to start runs, and `invokeAction` at
action nodes. **The engine writes no external-API code** — every write-back and
every inbound event goes through this registry. For MVP the registry is a **mock**
(canned `onTrigger` fires; `invokeAction` records calls and returns a scripted
`ActionResult`); phase 2 swaps in #1's real implementation with **no engine
change** (§11).

### 8.3 CONSUMED — the control-API drive seam (existing)

The engine drives panes through `handleRequest(deps, method, url, token, body)`
(`control-api.ts`) — `POST /panes` and `POST /panes/:handle/prompt` — under an
`OperatorGrantStore` grant, exactly as the Linear connector's "Option A"
(in-process, no socket; the guard still runs). No new drive surface is built.

---

## 9. Error handling

localflow's principle (`error-message-style`; demonstrated in `session-manager.ts`
— instant-exit surfaces the *real tail*, the guard *emits a visible notice*,
`control-api` logs *route + reason*, never token material): **every failure is
human-readable, actionable, and carries the real underlying exception. No silent
catch. No bare "failed".** Where the code already has a loud message (spawn
failure, guard block, instant-exit tail, registry error), the engine **forwards
that message** rather than minting a vaguer one.

| Failure | Engine behavior | Surface (real detail carried) |
|---|---|---|
| **A node fails** (action `invokeAction.ok=false`, or an agent pane errors) | Node → `failed`; run → `failed`; downstream nodes `skipped` (not silently run). | Run-activity + console `flow` row: "Flow ‘<name>’ node ‘<id>’ failed: `<ActionResult.error / real exception>`." If a connector already surfaces it (e.g. Linear `error` activity), the engine does not duplicate — it shares the feed. |
| **An agent pane instant-exits** (`INSTANT_EXIT_MS` in `session-manager.ts`) | Node → `failed` with `message = pane.info.message` (the real instant-exit tail, e.g. "Exited right away (exit code 1) — last output: …"). | That verbatim message on the run + console. The engine adds no vaguer wrapper. |
| **A gate is rejected** | Route to reject edge; if none, run → **`rejected`** (a clean human "no", **not** `failed`). No auto-proceed, ever. | Run-activity: "Flow ‘<name>’ stopped at gate ‘<id>’ — rejected by <who>." Distinct wording from a failure. |
| **A trigger fires with no matching flow** | **No run starts** — this is the opt-in default (works with no flow configured), *not* an error. | Debug-level notice only ("email:inbound — no enabled flow subscribes"); never a loud error, never a crash. |
| **An action targets a not-connected integration** (`descriptor.status()!=='connected'`) | Node → `failed` **before** any call. | "Flow ‘<name>’ needs <label> connected — action ‘<ref>’ can't run. Connect it in Settings." (Actionable, names the fix.) |
| **lfguard blocks a flow-sourced prompt** at an agent node | The existing guard path fires unchanged (`control-api.ts` `emitNotice("⛔ …")` + a `guard` console row). Node → `failed`. | The canonical `guardDenyMessage(pack, reason)` (one string, names the pack + next step) + a run-activity noting the block. |
| **Invalid `FlowGraph` at load** | `parseFlowGraph` returns null → that flow **disabled**, others load. | "Flow ‘<id>’ disabled — `<specific reason: e.g. edge e3 → unknown node n9>`. Fix flows.json." Loud, specific, non-fatal. |
| **Control-API rejects the drive** (e.g. `POST /panes` 400 unknown group, 409 pane exited, 403 no grant) | Node → `failed`, carrying the router's own `{error}` body + status. | "Flow ‘<name>’ couldn't drive a pane: `<status> <error>`." Uses the router's exact message (single contract). |

The engine **never** catches-and-drops. Every `catch` re-surfaces the caught
exception's real message.

---

## 10. Open decisions (FLAGGED — not resolved here)

1. **Run durability across restart.** MVP runs are in-memory like grants; an
   in-flight run is lost on restart (its panes survive as `exited`). A durable
   **run journal** (append-only, atomic like `sessions.json`) enabling **resume**
   is the phase-3 candidate — but resuming a half-run agent pane, a mid-flight
   action, or a pending gate has real subtleties (idempotency of `invokeAction`,
   re-establishing a pane↔node link). Flagged, not resolved.
2. **Concurrency policy.** One run per trigger event is settled; the open question
   is the **cap** — global `maxConcurrentPanes` (§7.2, RAM-driven) vs per-flow
   limits vs a queue with backpressure. The 8 GB dev machine makes an unbounded
   fan-out unsafe. MVP: a simple global cap; runs beyond it queue.
3. **Retry / backoff on a failed node.** MVP fails the node (no retry). Which
   failures are **retryable** (a transient `RATELIMITED` from a connector) vs
   terminal (a guard block, a bad flow), and the backoff shape, is deferred — the
   connector specs already do per-connector backoff; whether the *engine* also
   retries is the open part.
4. **Extracting a typed outcome from an agent pane (the hybrid seam).** MVP peeks
   a **sentinel line** (`FLOW_RESULT:{…}`) from `manager.peek()`. Alternatives: a
   dedicated tool the agent calls that the engine observes; a structured
   `needs-you` elicitation; a file the agent writes the engine reads. This is the
   crux of "agent content → engine boolean" and deserves its own decision. Flagged.
5. **Gate surface.** Does a gate reuse the **driving pane's** `needs-you` +
   `ApproveButton` (works when a pane is mid-flight, e.g. plan-apply), or does a
   **standalone** gate (no pane, e.g. approving before any pane spawns) need a
   **first-class flow-run approval surface** on the Overview `needs-you` list? MVP
   models both behind the `ApprovalPort`; the production binding is open.
6. **Gate timeout.** Does an unanswered gate hold forever (MVP) or auto-reject
   after N (injected-clock) minutes? A forever-hold is safest for the
   never-auto-send invariant; a timeout helps unattended runs. Flagged.
7. **Run-level cockpit surface.** Is a run its own row (a new UI object) or seen
   purely through its panes + console? Primarily a #3 concern; the engine already
   emits `onRunStatus`/`onNodeStatus` so either is additive.
8. **Multi-match routing.** When several router out-edges match, fan out to all
   (parallel branches) or take only the first (priority order)? MVP: all matching
   (deterministic); a `mode:'first'` config is the additive alternative.
9. **The exact `IntegrationRegistry` API** (§8.2) is a **co-owned seam with #1**.
   The shape above is the engine's minimal need; #1 may expose more. Must be pinned
   jointly before phase-2 wiring.

---

## 11. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton" — headless, deterministic)

**One hand-authored flow, the flagship shape, all five node types, mocks + fake
pty, injected clock:**

1. `src/shared/flow.ts` (owned `FlowGraph` + run-state types) and `flow-model.ts`
   (`parseFlowGraph` + invariants), fully unit-tested.
2. `flow-store.ts` + `flow-config.ts`: load a `flows.json` fixture, validate at
   the boundary, honor the `flows` enablement block (opt-in, off by default).
3. `run-state.ts` (pure reducer: `readyNodes`, `advance`) + `context.ts`
   (`resolveField`/`applyTemplate`), unit-tested.
4. The five node runners + `pane-driver`, wired into `flow-engine.ts`.
5. An **integration test** driving the full flagship loop deterministically:
   - a **mock `IntegrationRegistry`** (fires a canned email `TriggerEvent`;
     `invokeAction` records calls + returns scripted results);
   - a **real `SessionManager`** with the **`spawnFn` fake-pty seam** + injected
     `now`, driven through the **real `handleRequest`** router + a real
     `OperatorGrantStore` grant;
   - a **mock `ApprovalPort`** scripted to approve/reject;
   - assert, step by step: trigger starts a run → pane created (`POST /panes`) +
     prompted (`POST /panes/:h/prompt`) → push fake hook events
     (`manager.applyHookEvent`: `UserPromptSubmit`→working, `Stop`→idle) → sentinel
     peek → router branches on the boolean → `invokeAction('linear','createIssue')`
     called with expected params → push `needs-you` → gate waits → resolve approval
     → `email.sendDraft` reached only after approve. **No live external calls; no
     wall-clock waits.**

That slice proves the flagship loop's **mechanics** end-to-end, deterministically,
with zero external dependencies — the hybrid backbone.

### Phased roadmap

- **Phase 1 (MVP):** the headless walking skeleton above. Mock registry + fake
  pty + injected clock. Opt-in, off by default. Owned model pinned; consumed
  registry seam mocked.
- **Phase 2 — live integration wiring:** swap the mock `IntegrationRegistry` for
  #1's real one (Linear/email/cloud connectors) with **no engine change**; the
  engine joins the real `onStatus`/`onActivity` taps in `index.ts`; the
  `ApprovalPort` binds to the real `needs-you`/`ApproveButton` primitive (§10.5).
- **Phase 3 — durability & resilience:** the run journal + resume across restart
  (§10.1); the concurrency cap/queue (§10.2); retry/backoff (§10.3).
- **Phase 4 — canvas round-trip:** consume #3's canvas-authored `FlowGraph`s live
  (the shared model is already pinned §8.1); render run state back onto the canvas
  via `RunEvent` (§8.1).
- **Phase 5 — richer flows:** sub-flows / reusable node groups; scheduled/cron
  triggers (beyond integration triggers); richer condition types (numeric/exists,
  still boolean-resolving — never an LLM).

---

## Appendix — reused localflow surfaces (by path)

- `src/main/control-api.ts` — `handleRequest` (pure over inputs — the in-process
  drive seam); `POST /panes` / `POST /panes/:handle/prompt`;
  `OPERATOR_TERMINAL_AGENTS` (the capability boundary the engine inherits); the
  prompt guard (`deps.guard.check` → `guardDenyMessage`).
- `src/main/operator-grant.ts` — `OperatorGrantStore.grant/environmentForToken`;
  the in-memory, non-restart-surviving posture the run registry mirrors.
- `src/main/session-manager.ts` — `create` / `onStatus` / `onActivity` / `peek`
  (the sentinel-outcome + gate peek source) / `applyHookEvent` (the test seam that
  pushes hook events) / `emitNotice`; the **`spawnFn` fake-pty seam** and **`now`
  clock injection**; the `INSTANT_EXIT_MS` message the engine forwards to a node
  failure.
- `src/main/state-machine.ts` — `UserPromptSubmit→working`,
  `Notification→needs-you`, `Stop→idle`, `pty-exit→exited`: the pane transitions
  the agent/gate runners key off (working→idle = node done; needs-you = gate/ask).
- `src/main/persistence.ts` — the atomic `writeFileSync(tmp)`+`renameSync` +
  parse-at-boundary pattern `flow-store.ts` mirrors for `flows.json`.
- `src/main/operator-config.ts` — the config-as-code "validate at the boundary;
  garbage disables the feature" pattern `flow-config.ts`/`flow-model.ts` follow.
- `src/main/pane-ops.ts` — the pure, dependency-injected `operatorCreatePane`
  binding the control server uses; the purity pattern the node runners follow.
- `src/main/index.ts` — the wiring point (next to `startControlServer` /
  `startHookServer`) and the `onStatus`/`onActivity` taps the engine joins as an
  additional subscriber.
- `src/renderer/src/components/ApproveButton.tsx` + `src/main/peek.ts` — the
  `needs-you` approval primitive the `ApprovalPort` binds to (peek = the gate's
  approval content; `\r` = the in-cockpit approve). No new approval primitive.
- The three connector specs (§ trigger/action/gate shapes):
  `2026-07-16-linear-integration-design.md` (`AgentSessionEvent` triggers;
  `agentActivity`/`issueUpdate` actions; `elicitation` gate),
  `2026-07-16-email-execution-design.md` (inbound trigger; `sendDraft` action
  behind the **never-auto-send `draft-gate`**),
  `2026-07-16-devops-cloud-execution-design.md` (the **plan → apply** gate;
  `applyPlan` action).
