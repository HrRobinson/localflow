// The FlowGraph model — the pinned cross-project contract. The four core types
// (`FlowNodeType` / `FlowNode` / `FlowEdge` / `FlowGraph`) are OWNED by the Flow
// Engine (sub-project #2) and PRODUCED by the Flow Canvas (#3): the canvas
// authors these documents, the engine consumes them. They are pinned VERBATIM
// (brainstorm-approved) so canvas and engine agree byte-for-byte. This one
// canonical file carries three concerns: the pinned graph model, the canvas's
// boundary/semantic validation helpers (#3), and the engine's run-state types
// (#2, produced back for the canvas to render as a live overlay).
import type { IntegrationId, IntegrationStatus } from './integrations'

// --- PINNED (verbatim) -------------------------------------------------------
export type FlowNodeType = 'trigger' | 'agent' | 'action' | 'gate' | 'router'
export interface FlowNode {
  id: string
  type: FlowNodeType
  integration?: IntegrationId
  ref?: string
  config: Record<string, unknown>
  position: { x: number; y: number }
}
/** The comparison operators an edge condition may use. `exists`/`truthy` are
 *  unary (they ignore `value`); the rest are binary. Pinned VERBATIM — connectors
 *  and flow templates consume this shape. */
export type FlowConditionOp =
  'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'truthy'

/** A router/gate branch predicate: resolve `field` (a dotted path) against run
 *  context and compare it to `value` under `op`. `value` is optional because
 *  `exists`/`truthy` are unary. Evaluated purely + deterministically by
 *  `evalCondition` (main/flow/context.ts). */
export interface FlowEdgeCondition {
  field: string
  op: FlowConditionOp
  value?: unknown
}

/** The legacy persisted condition shape (`{ field, equals }`). Still accepted on
 *  disk and in older fixtures; normalized to `{ field, op:'eq', value: equals }`
 *  at the single eval boundary (`normalizeCondition`). Kept in the union so
 *  legacy documents type-check without an on-disk migration (design §2.1). */
export interface LegacyEdgeCondition {
  field: string
  equals: unknown
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  condition?: FlowEdgeCondition | LegacyEdgeCondition
}
export interface FlowGraph {
  id: string
  name: string
  nodes: FlowNode[]
  edges: FlowEdge[]
}
// --- /PINNED -----------------------------------------------------------------

/** Every `FlowNodeType`, for validating untrusted input (IPC bodies) at the
 *  boundary before it's cast to the narrower type — mirrors `VALID_AGENTS` in
 *  types.ts. */
export const VALID_NODE_TYPES: FlowNodeType[] = ['trigger', 'agent', 'action', 'gate', 'router']

/** Every `FlowConditionOp`, for validating an untrusted/persisted edge condition
 *  at the boundary. Mirrors `VALID_NODE_TYPES`. */
export const VALID_CONDITION_OPS: FlowConditionOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
  'truthy'
]

/** Node types that source their `ref`/config from an integration descriptor. */
export const INTEGRATION_NODE_TYPES: FlowNodeType[] = ['trigger', 'action']

/** Built-in node types (not integration-sourced) shown as static palette rows. */
export const BUILTIN_NODE_TYPES: FlowNodeType[] = ['agent', 'gate', 'router']

// --- Validation (canvas-local, §5) -------------------------------------------
export type ValidationSeverity = 'error' | 'warning'
export type ValidationCode =
  | 'empty-graph'
  | 'no-trigger'
  | 'unreachable'
  | 'dangling-edge'
  | 'missing-config'
  | 'integration-not-connected'
  | 'cycle'
  | 'incomplete-condition'
  | 'ungated-customer-facing'
export interface ValidationIssue {
  severity: ValidationSeverity
  /** Badge target; absent = graph-level. */
  nodeId?: string
  edgeId?: string
  code: ValidationCode
  /** Human, actionable, names the node/integration. */
  message: string
}
export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

// --- List view (canvas-local) ------------------------------------------------
/** Lightweight row for the "open a flow" list surface. */
export interface FlowSummary {
  id: string
  name: string
  nodeCount: number
  /** Epoch ms of the file's last write. */
  updatedAt: number
}

// --- Boundary shape validation (structural, not semantic) --------------------
// Mirrors persistence.ts's `filterSessions`/`isGroup`: an untrusted graph
// arriving over `flow:save` is shape-checked here before it is written, so a
// malformed node type, a non-object config, or an edge referencing a missing
// node is rejected with a legible error rather than persisted. This is distinct
// from the SEMANTIC `flow-validate.ts` (no-trigger / unreachable / …).

function isNode(n: unknown): n is FlowNode {
  if (typeof n !== 'object' || n === null) return false
  const o = n as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.type === 'string' &&
    VALID_NODE_TYPES.includes(o.type as FlowNodeType) &&
    typeof o.config === 'object' &&
    o.config !== null &&
    !Array.isArray(o.config) &&
    typeof o.position === 'object' &&
    o.position !== null &&
    typeof (o.position as { x?: unknown }).x === 'number' &&
    typeof (o.position as { y?: unknown }).y === 'number'
  )
}

/** Permissive (structural, not semantic) check of an edge `condition`: when
 *  present it must be an object with a string `field` and EITHER a valid `op`
 *  (new shape) OR an `equals` key (legacy shape). A garbled condition is rejected
 *  at the IPC save boundary; per-op semantic checks live in `flow-validate`. */
function isValidConditionShape(c: unknown): boolean {
  if (typeof c !== 'object' || c === null) return false
  const o = c as Record<string, unknown>
  if (typeof o.field !== 'string') return false
  if (typeof o.op === 'string') return VALID_CONDITION_OPS.includes(o.op as FlowConditionOp)
  return 'equals' in o
}

function isEdge(e: unknown): e is FlowEdge {
  if (typeof e !== 'object' || e === null) return false
  const o = e as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.from !== 'string' || typeof o.to !== 'string')
    return false
  if (o.condition !== undefined && !isValidConditionShape(o.condition)) return false
  return true
}

/** True when `g` is a structurally valid `FlowGraph` whose every edge endpoint
 *  names a node present in the graph. Used at the IPC save boundary. */
export function isFlowGraph(g: unknown): g is FlowGraph {
  if (typeof g !== 'object' || g === null) return false
  const o = g as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false
  if (!Array.isArray(o.nodes) || !o.nodes.every(isNode)) return false
  if (!Array.isArray(o.edges) || !o.edges.every(isEdge)) return false
  const ids = new Set((o.nodes as FlowNode[]).map((n) => n.id))
  return (o.edges as FlowEdge[]).every((e) => ids.has(e.from) && ids.has(e.to))
}

/** A `FlowSummary` from a full graph + its file mtime. */
export function summarize(graph: FlowGraph, updatedAt: number): FlowSummary {
  return { id: graph.id, name: graph.name, nodeCount: graph.nodes.length, updatedAt }
}

/** Re-export the resolved-descriptor status type for validation callers. */
export type { IntegrationStatus }

// ---------------------------------------------------------------------------
// Run-state types — OWNED by the Flow Engine (#2), PRODUCED for the canvas (#3)
// which renders them as a live overlay. In-memory only; runs do not survive a
// restart (they mirror the operator grants' non-durable posture — see the
// flow-engine design spec §5, §10.1).
// ---------------------------------------------------------------------------

/** Per-node execution state within a single run. `skipped` = a branch the
 *  router/gate did not take (deterministically), never silently un-run. */
export type NodeRunStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped'

/** Whole-run status. `needs-you` = a gate is awaiting a human; `rejected` = a
 *  human said no at a gate (a clean stop, NOT a failure). */
export type RunStatus = 'running' | 'needs-you' | 'done' | 'failed' | 'rejected'

export interface RunSnapshot {
  runId: string
  flowId: string
  triggerEventId: string
  status: RunStatus
  nodes: Record<string, NodeRunStatus>
  /** Node-id-keyed outputs; boolean/typed facts only (the hybrid seam reduces
   *  agent content to a typed value here before any routing reads it). */
  context: Record<string, unknown>
  startedAt: number
  endedAt?: number
  /** Terminal failure/reject reason — carries the real underlying exception. */
  message?: string
}

/** The fan-out the engine emits so #3 can render run state live. Mirrors the
 *  callback-registration shape `SessionManager` uses (`onStatus`/`onActivity`). */
export type RunEvent =
  | { kind: 'run-status'; runId: string; status: RunStatus; message?: string }
  | { kind: 'node-status'; runId: string; nodeId: string; status: NodeRunStatus }
  | { kind: 'run-activity'; runId: string; nodeId?: string; detail: string }
