// Pinned interface owned by sub-project #2 (Flow Engine) and PRODUCED by the
// Flow Canvas (#3). The `FlowNodeType` / `FlowNode` / `FlowEdge` / `FlowGraph`
// block below is declared VERBATIM (per the cross-project contract) so the
// branches reconcile cleanly at merge. `flow-store.ts` persists exactly this
// shape (round-trippable JSON) and the reducers operate on exactly it.
//
// When #2 lands and owns these types, this file re-exports from #2's module — a
// one-line change, since the shapes are identical by fiat.
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
export interface FlowEdge {
  id: string
  from: string
  to: string
  condition?: { field: string; equals: unknown }
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

function isEdge(e: unknown): e is FlowEdge {
  if (typeof e !== 'object' || e === null) return false
  const o = e as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.from === 'string' && typeof o.to === 'string'
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
