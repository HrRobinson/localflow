// The heart of the Flow Canvas: PURE graph-edit transitions over an immutable
// `FlowGraph`. No React, no DOM, no library. Every function returns a NEW
// `FlowGraph` and never mutates its input, so the canvas library (behind
// CanvasSurface) is a projection — never the source of truth — and undo/redo is
// a trivial phase-2 add (snapshot the immutable graph).
//
// Id generation is INJECTED (`idFn`) exactly as `SessionManager` injects its
// clock, so tests are deterministic. Rejections (self-loop, duplicate edge,
// unknown endpoint) return the SAME graph reference, so callers can cheaply
// detect a no-op with `next === prev`.
import type { FlowEdge, FlowGraph, FlowNode, FlowNodeType } from '../../../shared/flows'
import type { IntegrationId } from '../../../shared/integrations'

/** Monotonic id source, injected so tests can assert exact ids. */
export type IdFn = () => string

/** A default id source for production use (never used in tests). */
export const makeIdFn = (prefix: string): IdFn => {
  let n = 0
  return () => `${prefix}-${Date.now().toString(36)}-${(n++).toString(36)}`
}

/** The seed a fresh flow starts from. */
export function emptyGraph(id: string, name: string): FlowGraph {
  return { id, name, nodes: [], edges: [] }
}

/** Fields accepted when placing a node from the palette. */
export interface AddNodeInput {
  type: FlowNodeType
  position: { x: number; y: number }
  integration?: IntegrationId
  ref?: string
}

export function addNode(graph: FlowGraph, input: AddNodeInput, idFn: IdFn): FlowGraph {
  const node: FlowNode = {
    id: idFn(),
    type: input.type,
    config: {},
    position: { ...input.position }
  }
  if (input.integration !== undefined) node.integration = input.integration
  if (input.ref !== undefined) node.ref = input.ref
  return { ...graph, nodes: [...graph.nodes, node] }
}

/** Removes a node and CASCADES every edge incident to it (no dangling edges). */
export function removeNode(graph: FlowGraph, nodeId: string): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.from !== nodeId && e.to !== nodeId)
  }
}

export function moveNode(
  graph: FlowGraph,
  nodeId: string,
  position: { x: number; y: number }
): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, position: { ...position } } : n))
  }
}

/** Patch a node's `config` (shallow-merged) and, optionally, its top-level
 *  `integration`/`ref` fields. Sibling nodes are never touched. */
export function updateNodeConfig(
  graph: FlowGraph,
  nodeId: string,
  configPatch: Record<string, unknown>,
  fields?: { integration?: IntegrationId; ref?: string }
): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== nodeId) return n
      const next: FlowNode = { ...n, config: { ...n.config, ...configPatch } }
      if (fields && 'integration' in fields) next.integration = fields.integration
      if (fields && 'ref' in fields) next.ref = fields.ref
      return next
    })
  }
}

const hasNode = (graph: FlowGraph, id: string): boolean => graph.nodes.some((n) => n.id === id)

/** Adds an edge. REJECTS (returns the same graph reference) a self-loop, a
 *  duplicate of an existing from→to edge, or an unknown endpoint. */
export function connect(graph: FlowGraph, from: string, to: string, idFn: IdFn): FlowGraph {
  if (from === to) return graph
  if (!hasNode(graph, from) || !hasNode(graph, to)) return graph
  if (graph.edges.some((e) => e.from === from && e.to === to)) return graph
  const edge: FlowEdge = { id: idFn(), from, to }
  return { ...graph, edges: [...graph.edges, edge] }
}

export function disconnect(graph: FlowGraph, edgeId: string): FlowGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) }
}

/** Sets (or clears, with `undefined`) a router branch condition on one edge. */
export function setEdgeCondition(
  graph: FlowGraph,
  edgeId: string,
  condition: { field: string; equals: unknown } | undefined
): FlowGraph {
  return {
    ...graph,
    edges: graph.edges.map((e) => {
      if (e.id !== edgeId) return e
      if (condition === undefined) {
        const next = { ...e }
        delete next.condition
        return next
      }
      return { ...e, condition: { ...condition } }
    })
  }
}

export function renameFlow(graph: FlowGraph, name: string): FlowGraph {
  return { ...graph, name }
}
