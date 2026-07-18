import type {
  FlowConditionOp,
  FlowEdge,
  FlowGraph,
  FlowNode,
  FlowNodeType
} from '../../shared/flows'
import { VALID_CONDITION_OPS } from '../../shared/flows'
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
const INTEGRATION_IDS: ReadonlySet<string> = new Set<IntegrationId>([
  'linear',
  'email',
  'cloud',
  'shopify',
  'woocommerce',
  'stripe'
])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseNode(
  raw: unknown,
  index: number
): { ok: true; node: FlowNode } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: `node #${index} is not an object` }
  if (typeof raw.id !== 'string' || raw.id.length === 0)
    return { ok: false, error: `node #${index} has a missing or non-string id` }
  const id = raw.id
  if (typeof raw.type !== 'string' || !NODE_TYPES.has(raw.type))
    return { ok: false, error: `node '${id}' has an invalid type '${String(raw.type)}'` }
  if (raw.integration !== undefined && !INTEGRATION_IDS.has(raw.integration as string))
    return {
      ok: false,
      error: `node '${id}' names an unknown integration '${String(raw.integration)}'`
    }
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

/**
 * STRICT validation of an edge condition. Accepts EITHER the new
 * `{ field, op, value? }` shape (op ∈ VALID_CONDITION_OPS) OR the legacy
 * `{ field, equals }` shape, preserving whichever it received (no on-disk
 * migration, §10.3). Anything else — non-object, non-string field, or an unknown
 * op with no legacy `equals` — is a loud, specific reject naming the edge.
 */
function parseCondition(
  raw: unknown,
  edgeId: string
): { ok: true; condition: FlowEdge['condition'] } | { ok: false; error: string } {
  if (!isObject(raw) || typeof raw.field !== 'string')
    return {
      ok: false,
      error: `edge '${edgeId}' has an ill-typed condition (need { field: string, op } or legacy { field, equals })`
    }
  if (typeof raw.op === 'string' || (!('equals' in raw) && raw.op !== undefined)) {
    if (typeof raw.op !== 'string' || !VALID_CONDITION_OPS.includes(raw.op as FlowConditionOp))
      return {
        ok: false,
        error: `edge '${edgeId}' has an invalid condition op '${String(raw.op)}' (expected one of ${VALID_CONDITION_OPS.join(', ')})`
      }
    const condition: FlowEdge['condition'] = { field: raw.field, op: raw.op as FlowConditionOp }
    if ('value' in raw) condition.value = raw.value
    return { ok: true, condition }
  }
  if ('equals' in raw) return { ok: true, condition: { field: raw.field, equals: raw.equals } }
  return {
    ok: false,
    error: `edge '${edgeId}' has an ill-typed condition (need { field: string, op } or legacy { field, equals })`
  }
}

function parseEdge(
  raw: unknown,
  index: number
): { ok: true; edge: FlowEdge } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: `edge #${index} is not an object` }
  if (typeof raw.id !== 'string' || raw.id.length === 0)
    return { ok: false, error: `edge #${index} has a missing or non-string id` }
  if (typeof raw.from !== 'string' || typeof raw.to !== 'string')
    return { ok: false, error: `edge '${raw.id}' has a non-string from/to` }
  const edge: FlowEdge = { id: raw.id, from: raw.from, to: raw.to }
  if (raw.condition !== undefined) {
    const cond = parseCondition(raw.condition, raw.id)
    if (!cond.ok) return { ok: false, error: cond.error }
    edge.condition = cond.condition
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
    return {
      ok: false,
      error: `flow '${raw.id}' must have exactly one trigger node (found ${triggers.length})`
    }

  const edges: FlowEdge[] = []
  for (let i = 0; i < raw.edges.length; i++) {
    const r = parseEdge(raw.edges[i], i)
    if (!r.ok) return { ok: false, error: `flow '${raw.id}': ${r.error}` }
    if (!ids.has(r.edge.from))
      return {
        ok: false,
        error: `flow '${raw.id}': edge '${r.edge.id}' → unknown source node '${r.edge.from}'`
      }
    if (!ids.has(r.edge.to))
      return {
        ok: false,
        error: `flow '${raw.id}': edge '${r.edge.id}' → unknown node '${r.edge.to}'`
      }
    edges.push(r.edge)
  }

  // Reachability: every node must be reachable from the trigger by following
  // edges. This is STRONGER than "every node has an inbound edge" — that weaker
  // check passes a trigger-DISCONNECTED CYCLE (e.g. b→c, c→b: each has an
  // inbound edge, yet neither is reachable from the trigger), which the engine
  // would never run and could deadlock a run waiting on it. A node the walk can
  // never reach is a modelling error the author should see, not a silent dead
  // branch. (BFS from the single trigger over the out-edge adjacency.)
  const triggerId = triggers[0].id
  const outEdges = new Map<string, string[]>()
  for (const e of edges) {
    const list = outEdges.get(e.from)
    if (list) list.push(e.to)
    else outEdges.set(e.from, [e.to])
  }
  const reachable = new Set<string>([triggerId])
  const queue: string[] = [triggerId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const next of outEdges.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next)
        queue.push(next)
      }
    }
  }
  const unreachable = nodes.find((n) => !reachable.has(n.id))
  if (unreachable)
    return {
      ok: false,
      error: `flow '${raw.id}': node '${unreachable.id}' is unreachable from the trigger (orphan or trigger-disconnected cycle)`
    }

  return { ok: true, flow: { id: raw.id, name: raw.name, nodes, edges } }
}

/** The spec's pinned signature: `FlowGraph` or null, never a throw. */
export function parseFlowGraph(raw: unknown): FlowGraph | null {
  const res = parseFlowGraphResult(raw)
  return res.ok ? res.flow : null
}
