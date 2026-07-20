// PURE validation of a `FlowGraph` against the resolved integration registry.
// No React, no DOM. Table-ish, mirrors state-machine.ts's purity. Runs live on
// every reducer result (cheap for small graphs), feeding per-node badges and
// the toolbar summary chip.
//
// `ok` is false iff there is at least one `error`-severity issue. Warnings
// (empty-graph, unreachable, router-cycle) never block. Messages are human and
// actionable, and name the node/integration.
import type { FlowGraph, FlowNode, ValidationIssue, ValidationResult } from '../../../shared/flows'
import type { ResolvedIntegrationDescriptor } from '../../../shared/integrations'
import { ZENDESK_PUBLIC_REPLY_ACTION_ID } from '../../../shared/zendesk'

const INTEGRATION_TYPES = new Set(['trigger', 'action'])

/** All node ids reachable by following edges forward from any `trigger`. */
function reachableFromTriggers(graph: FlowGraph): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = adjacency.get(e.from) ?? []
    list.push(e.to)
    adjacency.set(e.from, list)
  }
  const seen = new Set<string>()
  const stack = graph.nodes.filter((n) => n.type === 'trigger').map((n) => n.id)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of adjacency.get(id) ?? []) stack.push(next)
  }
  return seen
}

/**
 * Detect cycles. Returns `{ hasCycle, throughRouterOnly }`:
 * `hasCycle` is true if the (directed) node graph contains any back-edge;
 * `throughRouterOnly` is true when EVERY cycle passes through at least one
 * `router` node — routers may loop by design (retries/loops, §10.2), so those
 * are a warning, while a cycle with no router on it is a hard error.
 */
function detectCycles(graph: FlowGraph): { hasCycle: boolean; throughRouterOnly: boolean } {
  const adjacency = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!graph.nodes.some((n) => n.id === e.to)) continue
    const list = adjacency.get(e.from) ?? []
    list.push(e.to)
    adjacency.set(e.from, list)
  }
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]))
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  let hasCycle = false
  let nonRouterCycle = false

  // Iterative DFS tracking the current path so a detected back-edge can be
  // inspected for whether the cycle it closes contains a router.
  const visit = (start: string): void => {
    const path: string[] = []
    const stack: Array<{ id: string; phase: 'enter' | 'exit' }> = [{ id: start, phase: 'enter' }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame.phase === 'enter') {
        if (color.get(frame.id) === BLACK) {
          stack.pop()
          continue
        }
        color.set(frame.id, GRAY)
        path.push(frame.id)
        frame.phase = 'exit'
        for (const next of adjacency.get(frame.id) ?? []) {
          const c = color.get(next) ?? WHITE
          if (c === GRAY) {
            // Back-edge → cycle. The cycle is path[idx..end] + next.
            hasCycle = true
            const idx = path.indexOf(next)
            const cycleNodes = path.slice(idx)
            if (!cycleNodes.some((id) => typeOf.get(id) === 'router')) nonRouterCycle = true
          } else if (c === WHITE) {
            stack.push({ id: next, phase: 'enter' })
          }
        }
      } else {
        color.set(frame.id, BLACK)
        path.pop()
        stack.pop()
      }
    }
  }
  for (const n of graph.nodes) if ((color.get(n.id) ?? WHITE) === WHITE) visit(n.id)
  return { hasCycle, throughRouterOnly: hasCycle && !nonRouterCycle }
}

function nodeLabel(node: FlowNode): string {
  return node.type
}

/** All node ids that can reach `target` by following edges forward (its
 *  ancestors) — a reverse-adjacency BFS. */
function ancestorsOf(graph: FlowGraph, target: string): Set<string> {
  const incoming = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = incoming.get(e.to) ?? []
    list.push(e.from)
    incoming.set(e.to, list)
  }
  const seen = new Set<string>()
  const stack = [...(incoming.get(target) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const prev of incoming.get(id) ?? []) stack.push(prev)
  }
  return seen
}

/**
 * The never-auto-send reply gate (spec §9). `replyToTicket` is the ONLY Zendesk
 * action that posts a customer-facing (`comment.public: true`) reply, so it is
 * UNAUTHORABLE without a `gate` node somewhere upstream of it. A public reply with
 * no preceding gate is a hard error — the gate is the whole point. (`addInternalNote`
 * and the other mutations are NOT customer-facing and are exempt.)
 */
function replyGateIssues(graph: FlowGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]))
  for (const node of graph.nodes) {
    if (
      node.type !== 'action' ||
      node.integration !== 'zendesk' ||
      node.ref !== ZENDESK_PUBLIC_REPLY_ACTION_ID
    ) {
      continue
    }
    const ancestors = ancestorsOf(graph, node.id)
    const hasGate = [...ancestors].some((id) => typeOf.get(id) === 'gate')
    if (!hasGate) {
      issues.push({
        severity: 'error',
        nodeId: node.id,
        code: 'reply-gate-required',
        message:
          'A public reply to a customer must be approved at a gate — add a gate node before ' +
          'this "Public reply to the customer" action (Zendesk replies never auto-send).'
      })
    }
  }
  return issues
}

/** Integration-node config issues: no ref selected, a missing required
 *  NON-secret field, or the integration isn't connected. Secret fields are the
 *  integration's, never the flow's (§6.4) — a missing secret is not a flow
 *  error. */
function integrationIssues(
  node: FlowNode,
  registry: ResolvedIntegrationDescriptor[]
): ValidationIssue[] {
  if (!INTEGRATION_TYPES.has(node.type)) return []
  const issues: ValidationIssue[] = []
  const descriptor = node.integration ? registry.find((d) => d.id === node.integration) : undefined
  const kind = node.type === 'trigger' ? 'trigger' : 'action'

  if (!node.integration || !node.ref) {
    issues.push({
      severity: 'error',
      nodeId: node.id,
      code: 'missing-config',
      message: `This ${kind} node needs configuring — open it and pick an integration ${kind}.`
    })
    return issues
  }
  if (!descriptor) {
    // integration id set but no descriptor known — treat as not connected.
    issues.push({
      severity: 'error',
      nodeId: node.id,
      code: 'integration-not-connected',
      message: `The "${node.integration}" integration isn't available — finish setup in Integrations.`
    })
    return issues
  }
  const missingRequired = descriptor.configFields.filter(
    (f) => f.required && !f.secret && !hasValue(node.config[f.key])
  )
  if (missingRequired.length > 0) {
    const field = missingRequired[0]
    issues.push({
      severity: 'error',
      nodeId: node.id,
      code: 'missing-config',
      message: `The ${descriptor.label} ${kind} needs configuring — open it and set "${field.label}".`
    })
  }
  if (descriptor.status !== 'connected') {
    issues.push({
      severity: 'error',
      nodeId: node.id,
      code: 'integration-not-connected',
      message: `${descriptor.label} isn't connected — finish setup in Integrations. (${descriptor.status})`
    })
  }
  return issues
}

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim().length > 0
  return true
}

/** Unary ops need no `value`; every other op is binary and requires one. */
const UNARY_OPS = new Set(['exists', 'truthy'])

/** Non-blocking issues for an incomplete edge condition: an empty `field`, or a
 *  binary op with a missing/blank `value`. Handles both the new
 *  `{ field, op, value }` and legacy `{ field, equals }` shapes. Warning only —
 *  editing is never interrupted (mirrors the router-cycle posture). */
function conditionIssues(graph: FlowGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const e of graph.edges) {
    const c = e.condition
    if (!c) continue
    const isNew = 'op' in c
    const field = c.field
    const op = isNew ? c.op : 'eq'
    const value = isNew ? c.value : c.equals
    if (!hasValue(field)) {
      issues.push({
        severity: 'warning',
        edgeId: e.id,
        code: 'incomplete-condition',
        message: `Branch → ${e.to} has a condition with no field — set a field or remove the condition.`
      })
      continue
    }
    if (!UNARY_OPS.has(op) && !hasValue(value)) {
      issues.push({
        severity: 'warning',
        edgeId: e.id,
        code: 'incomplete-condition',
        message: `Branch → ${e.to} has an operator but no value — set a value or remove the condition.`
      })
    }
  }
  return issues
}

export function validateFlow(
  graph: FlowGraph,
  registry: ResolvedIntegrationDescriptor[]
): ValidationResult {
  const issues: ValidationIssue[] = []

  if (graph.nodes.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'empty-graph',
      message: 'This flow is empty — drop a trigger from the palette to start.'
    })
    return { ok: true, issues }
  }

  // no-trigger
  if (!graph.nodes.some((n) => n.type === 'trigger')) {
    issues.push({
      severity: 'error',
      code: 'no-trigger',
      message: 'A flow needs a trigger to start it — add a trigger node.'
    })
  }

  // dangling-edge (self-heals under the reducer; catches imported/corrupt graphs)
  const nodeIds = new Set(graph.nodes.map((n) => n.id))
  for (const e of graph.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
      issues.push({
        severity: 'error',
        edgeId: e.id,
        code: 'dangling-edge',
        message: 'An arrow points at a node that no longer exists — reconnect or delete it.'
      })
    }
  }

  // unreachable (warning) — only meaningful when there is a trigger to reach from
  if (graph.nodes.some((n) => n.type === 'trigger')) {
    const reachable = reachableFromTriggers(graph)
    for (const n of graph.nodes) {
      if (n.type !== 'trigger' && !reachable.has(n.id)) {
        issues.push({
          severity: 'warning',
          nodeId: n.id,
          code: 'unreachable',
          message: `This ${nodeLabel(n)} node isn't reachable from any trigger — connect an arrow into it, or remove it.`
        })
      }
    }
  }

  // integration node issues
  for (const n of graph.nodes) issues.push(...integrationIssues(n, registry))

  // incomplete edge conditions (warning — never blocks save)
  issues.push(...conditionIssues(graph))

  // never-auto-send: a public reply must have a preceding gate (§9)
  issues.push(...replyGateIssues(graph))

  // cycles
  const { hasCycle, throughRouterOnly } = detectCycles(graph)
  if (hasCycle) {
    issues.push({
      severity: throughRouterOnly ? 'warning' : 'error',
      code: 'cycle',
      message: throughRouterOnly
        ? 'This flow loops back through a router — allowed, but confirm the branch conditions terminate.'
        : 'This flow loops back on itself — remove the arrow, or route the loop through a router node.'
    })
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues }
}
