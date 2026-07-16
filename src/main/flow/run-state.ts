import type { FlowGraph, NodeRunStatus } from '../../shared/flows'

/**
 * PURE per-run node state + reducer — unit-testable in isolation, exactly like
 * `state-machine.ts`. The engine (`flow-engine.ts`) owns the async side (panes,
 * gates, the clock); everything here is a deterministic function of the graph
 * and the decisions already made.
 *
 * The routing bookkeeping is edge-centric: an out-edge is either TAKEN (the
 * source completed and the routing chose it) or DEAD (the source completed and
 * did not choose it, or the source failed/was skipped). A node becomes runnable
 * once every inbound edge is decided and at least one is taken; if every inbound
 * edge is dead, the node is skipped (never silently un-run) — and that skip
 * propagates to its descendants.
 */
export interface RunNodesState {
  nodes: Record<string, NodeRunStatus>
  takenEdges: Set<string>
  deadEdges: Set<string>
}

export function initRunState(graph: FlowGraph): RunNodesState {
  const nodes: Record<string, NodeRunStatus> = {}
  for (const n of graph.nodes) nodes[n.id] = 'pending'
  return { nodes, takenEdges: new Set(), deadEdges: new Set() }
}

const clone = (s: RunNodesState): RunNodesState => ({
  nodes: { ...s.nodes },
  takenEdges: new Set(s.takenEdges),
  deadEdges: new Set(s.deadEdges)
})

/** The pending nodes whose inbound edges are fully decided with ≥1 taken (a
 *  root node with no inbound edges is ready immediately). */
export function readyNodes(graph: FlowGraph, state: RunNodesState): string[] {
  return graph.nodes
    .filter((n) => state.nodes[n.id] === 'pending')
    .filter((n) => {
      const inbound = graph.edges.filter((e) => e.to === n.id)
      if (inbound.length === 0) return true
      const allDecided = inbound.every((e) => state.takenEdges.has(e.id) || state.deadEdges.has(e.id))
      const anyTaken = inbound.some((e) => state.takenEdges.has(e.id))
      return allDecided && anyTaken
    })
    .map((n) => n.id)
}

/** Marks a node running/waiting (the engine's in-flight marks). No edge
 *  decisions — those only happen when a node reaches a terminal status. */
export function setNodeStatus(
  state: RunNodesState,
  nodeId: string,
  status: NodeRunStatus
): RunNodesState {
  const next = clone(state)
  next.nodes[nodeId] = status
  return next
}

/**
 * Records a node's terminal outcome and propagates the routing decision:
 *  - `done`  → the node's out-edges in `selectedEdgeIds` are TAKEN, the rest DEAD;
 *  - `failed`/`skipped`/`rejected` → every out-edge is DEAD.
 * Then skip-propagates to a fixpoint: any pending node whose inbound edges are
 * all decided with none taken becomes `skipped`, deadening its own out-edges.
 */
export function applyOutcome(
  graph: FlowGraph,
  state: RunNodesState,
  nodeId: string,
  status: NodeRunStatus,
  selectedEdgeIds: string[]
): RunNodesState {
  const next = clone(state)
  next.nodes[nodeId] = status
  const selected = new Set(selectedEdgeIds)
  for (const e of graph.edges) {
    if (e.from !== nodeId) continue
    if (status === 'done' && selected.has(e.id)) next.takenEdges.add(e.id)
    else next.deadEdges.add(e.id)
  }
  propagateSkips(graph, next)
  return next
}

function propagateSkips(graph: FlowGraph, state: RunNodesState): void {
  let changed = true
  while (changed) {
    changed = false
    for (const n of graph.nodes) {
      if (state.nodes[n.id] !== 'pending') continue
      const inbound = graph.edges.filter((e) => e.to === n.id)
      if (inbound.length === 0) continue
      const allDecided = inbound.every(
        (e) => state.takenEdges.has(e.id) || state.deadEdges.has(e.id)
      )
      const anyTaken = inbound.some((e) => state.takenEdges.has(e.id))
      if (allDecided && !anyTaken) {
        state.nodes[n.id] = 'skipped'
        for (const e of graph.edges) if (e.from === n.id) state.deadEdges.add(e.id)
        changed = true
      }
    }
  }
}

/** True once no node is still pending/running/waiting — the run has settled. */
export function isComplete(graph: FlowGraph, state: RunNodesState): boolean {
  return graph.nodes.every((n) => {
    const s = state.nodes[n.id]
    return s === 'done' || s === 'failed' || s === 'skipped'
  })
}
