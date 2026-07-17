import type { FlowGraph } from '../../shared/flows'

/**
 * The run-scoped context is a `Record<string, unknown>` keyed by node id: each
 * node writes its typed output under its own id (e.g. `context['triage'] =
 * { category: 'bug' }`). Everything here is PURE and deterministic — the
 * boolean/typed layer the router and action params read. No LLM, no I/O.
 */
export type RunContext = Record<string, unknown>

/**
 * Resolves a dotted path (`nodeId.field.sub`) against the run context. Returns
 * `undefined` for any missing or non-object hop — never throws, so a condition
 * over an absent field is simply "not equal", not a crash.
 */
export function resolveField(context: RunContext, path: string): unknown {
  let cur: unknown = context
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * Substitutes `{{path}}` tokens in a string with `resolveField` values. A
 * token that resolves to `undefined`/`null` renders as an empty string (an
 * unresolved template must never leak the literal `{{…}}` into a prompt or an
 * action param). Non-string resolved values are stringified.
 */
export function applyTemplate(template: string, context: RunContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, path: string) => {
    const value = resolveField(context, path)
    return value === undefined || value === null ? '' : String(value)
  })
}

/**
 * Renders every STRING leaf of a params object through `applyTemplate`,
 * leaving non-string values (numbers, booleans, nested objects) untouched.
 * Used to template an action node's `config` params against run context.
 */
export function templateParams(
  params: Record<string, unknown>,
  context: RunContext
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'string' ? applyTemplate(value, context) : value
  }
  return out
}

/** The sentinel prefix an agent prints so the engine can reduce its free-form
 *  output to a typed fact (the hybrid seam, design §3.2 / open decision §10.4). */
const FLOW_RESULT_RE = /FLOW_RESULT:\s*(\{.*\})\s*$/

/**
 * Extracts the typed fact from an agent pane's peeked output: the last
 * `FLOW_RESULT: {…}` line, JSON-parsed. Returns null when there is no sentinel
 * or its JSON is malformed (never throws — a missing/garbled sentinel means
 * "no fact", which the router treats as an unmatched condition).
 */
export function parseFlowResult(lines: string[]): Record<string, unknown> | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = FLOW_RESULT_RE.exec(lines[i])
    if (!m) continue
    try {
      const parsed: unknown = JSON.parse(m[1])
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
    return null
  }
  return null
}

/**
 * PURE routing: the out-edges of `nodeId` that fire given the current context.
 * An edge with no `condition` is unconditional (always taken); a conditional
 * edge fires iff `resolveField(context, field) === equals` — a deterministic
 * value compare, no LLM. This is the whole of the engine's "boolean, not
 * feelings" routing; `router` nodes are simply the explicit branch points.
 */
export function selectEdges(graph: FlowGraph, nodeId: string, context: RunContext): string[] {
  return graph.edges
    .filter((e) => e.from === nodeId)
    .filter((e) => !e.condition || resolveField(context, e.condition.field) === e.condition.equals)
    .map((e) => e.id)
}
