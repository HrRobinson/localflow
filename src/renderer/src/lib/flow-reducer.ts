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
import type { FlowTemplate } from '../../../shared/flow-templates'

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

// --- Templates ---------------------------------------------------------------

/**
 * Returns `base` unless it already appears in `existingNames`, in which case it
 * appends the lowest free counter: `"Ecom Support Worker"` →
 * `"Ecom Support Worker 2"` → `"… 3"`. Pure; a display nicety only (ids are the
 * real key — instantiate always mints a fresh flow id, so there is never an
 * actual storage collision). The counter starts at 2 so the first duplicate
 * reads naturally ("… 2" is the second one).
 */
export function dedupeName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** The id sources + de-dup context an instantiate needs. */
export interface InstantiateOptions {
  /** Fresh flow id (e.g. `flowIds.current()`). */
  flowId: string
  /** Fresh node ids (one call per template node). */
  nodeIdFn: IdFn
  /** Fresh edge ids (one call per template edge). */
  edgeIdFn: IdFn
  /** Existing flow names, for name de-dup. */
  existingNames: string[]
}

/**
 * Deep-clones a template's seed `FlowGraph` into a fresh, unsaved draft:
 * every node/edge/flow id is re-minted from the injected id fns, `from`/`to`
 * are re-mapped through the new node ids, and `config`/`condition`/`position`
 * are DEEP-CLONED so the returned graph shares NO mutable reference with the
 * template constant (mutating the draft never touches `BUILTIN_FLOW_TEMPLATES`).
 * `integration`/`ref` are copied verbatim — they are refs, never secrets. Pure;
 * ids injected so tests assert exact output. The result is a valid `FlowGraph`
 * (every edge endpoint names a present node).
 */
export function instantiateTemplate(template: FlowTemplate, opts: InstantiateOptions): FlowGraph {
  const idMap = new Map<string, string>()
  for (const node of template.graph.nodes) idMap.set(node.id, opts.nodeIdFn())

  const nodes: FlowNode[] = template.graph.nodes.map((n) => {
    const node: FlowNode = {
      id: idMap.get(n.id)!,
      type: n.type,
      config: structuredClone(n.config),
      position: { ...n.position }
    }
    if (n.integration !== undefined) node.integration = n.integration
    if (n.ref !== undefined) node.ref = n.ref
    return node
  })

  const edges: FlowEdge[] = template.graph.edges.map((e) => {
    const edge: FlowEdge = {
      id: opts.edgeIdFn(),
      // A template is authored with in-graph endpoints, so both are mapped; the
      // `?? e.from` fallback keeps a stray endpoint intact rather than crashing.
      from: idMap.get(e.from) ?? e.from,
      to: idMap.get(e.to) ?? e.to
    }
    if (e.condition !== undefined) edge.condition = structuredClone(e.condition)
    return edge
  })

  return {
    id: opts.flowId,
    name: dedupeName(template.name, opts.existingNames),
    nodes,
    edges
  }
}
