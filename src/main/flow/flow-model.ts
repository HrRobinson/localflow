import type { FlowEdge, FlowGraph, FlowNode, FlowNodeType } from '../../shared/flows'
import type { IntegrationId } from '../../shared/integrations'

/**
 * PURE validator for the `FlowGraph` model — the Developer-Preview blast radius
 * for the model shape. Mirrors `operator-config.ts` / `state-machine.ts`:
 * validate at the boundary, and let garbage DISABLE a flow rather than throw.
 * `parseFlowGraph` never throws; a malformed document returns null, and
 * `parseFlowGraphResult` carries a specific, loud reason naming the offending
 * field so `flow-store.ts` can surface it (design §7.1).
 */

export type ParseResult = { ok: true; flow: FlowGraph } | { ok: false; error: string }

const NODE_TYPES: ReadonlySet<string> = new Set<FlowNodeType>([
  'trigger',
  'agent',
  'action',
  'gate',
  'router'
])
const INTEGRATION_IDS: ReadonlySet<string> = new Set<IntegrationId>(['linear', 'email', 'cloud'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseNode(raw: unknown, index: number): { ok: true; node: FlowNode } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: `node #${index} is not an object` }
  if (typeof raw.id !== 'string' || raw.id.length === 0)
    return { ok: false, error: `node #${index} has a missing or non-string id` }
  const id = raw.id
  if (typeof raw.type !== 'string' || !NODE_TYPES.has(raw.type))
    return { ok: false, error: `node '${id}' has an invalid type '${String(raw.type)}'` }
  if (raw.integration !== undefined && !INTEGRATION_IDS.has(raw.integration as string))
    return { ok: false, error: `node '${id}' names an unknown integration '${String(raw.integration)}'` }
  if (raw.ref !== undefined && typeof raw.ref !== 'string')
    return { ok: false, error: `node '${id}' has a non-string ref` }
  if (raw.config !== undefined && !isObject(raw.config))
    return { ok: false, error: `node '${id}' has a non-object config` }
  const pos = isObject(raw.position) ? raw.position : {}
  const node: FlowNode = {
    id,
    type: raw.type as FlowNodeType,
    config: isObject(raw.config) ? raw.config : {},
    position: {
      x: typeof pos.x === 'number' ? pos.x : 0,
      y: typeof pos.y === 'number' ? pos.y : 0
    }
  }
  if (raw.integration !== undefined) node.integration = raw.integration as IntegrationId
  if (typeof raw.ref === 'string') node.ref = raw.ref
  return { ok: true, node }
}

function parseEdge(raw: unknown, index: number): { ok: true; edge: FlowEdge } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: `edge #${index} is not an object` }
  if (typeof raw.id !== 'string' || raw.id.length === 0)
    return { ok: false, error: `edge #${index} has a missing or non-string id` }
  if (typeof raw.from !== 'string' || typeof raw.to !== 'string')
    return { ok: false, error: `edge '${raw.id}' has a non-string from/to` }
  const edge: FlowEdge = { id: raw.id, from: raw.from, to: raw.to }
  if (raw.condition !== undefined) {
    if (!isObject(raw.condition) || typeof raw.condition.field !== 'string' || !('equals' in raw.condition))
      return { ok: false, error: `edge '${raw.id}' has an ill-typed condition (need { field: string, equals })` }
    edge.condition = { field: raw.condition.field, equals: raw.condition.equals }
  }
  return { ok: true, edge }
}

export function parseFlowGraphResult(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, error: 'flow is not an object' }
  if (typeof raw.id !== 'string' || raw.id.length === 0)
    return { ok: false, error: 'flow has a missing or non-string id' }
  if (typeof raw.name !== 'string')
    return { ok: false, error: `flow '${raw.id}' has a missing or non-string name` }
  if (!Array.isArray(raw.nodes)) return { ok: false, error: `flow '${raw.id}' has no nodes array` }
  if (!Array.isArray(raw.edges)) return { ok: false, error: `flow '${raw.id}' has no edges array` }

  const nodes: FlowNode[] = []
  const ids = new Set<string>()
  for (let i = 0; i < raw.nodes.length; i++) {
    const r = parseNode(raw.nodes[i], i)
    if (!r.ok) return { ok: false, error: `flow '${raw.id}': ${r.error}` }
    if (ids.has(r.node.id))
      return { ok: false, error: `flow '${raw.id}' has a duplicate node id '${r.node.id}'` }
    ids.add(r.node.id)
    nodes.push(r.node)
  }

  const triggers = nodes.filter((n) => n.type === 'trigger')
  if (triggers.length !== 1)
    return { ok: false, error: `flow '${raw.id}' must have exactly one trigger node (found ${triggers.length})` }

  const edges: FlowEdge[] = []
  for (let i = 0; i < raw.edges.length; i++) {
    const r = parseEdge(raw.edges[i], i)
    if (!r.ok) return { ok: false, error: `flow '${raw.id}': ${r.error}` }
    if (!ids.has(r.edge.from))
      return { ok: false, error: `flow '${raw.id}': edge '${r.edge.id}' → unknown source node '${r.edge.from}'` }
    if (!ids.has(r.edge.to))
      return { ok: false, error: `flow '${raw.id}': edge '${r.edge.id}' → unknown node '${r.edge.to}'` }
    edges.push(r.edge)
  }

  // No orphans: every non-trigger node must be reachable — i.e. have at least
  // one inbound edge. A node the walk can never reach is a modelling error the
  // author should see, not a silent dead branch.
  const hasInbound = new Set(edges.map((e) => e.to))
  const triggerId = triggers[0].id
  const orphan = nodes.find((n) => n.id !== triggerId && !hasInbound.has(n.id))
  if (orphan)
    return { ok: false, error: `flow '${raw.id}': node '${orphan.id}' is an orphan (no inbound edge)` }

  return { ok: true, flow: { id: raw.id, name: raw.name, nodes, edges } }
}

/** The spec's pinned signature: `FlowGraph` or null, never a throw. */
export function parseFlowGraph(raw: unknown): FlowGraph | null {
  const res = parseFlowGraphResult(raw)
  return res.ok ? res.flow : null
}
