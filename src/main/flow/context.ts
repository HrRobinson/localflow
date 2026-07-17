import type { FlowConditionOp, FlowEdgeCondition, FlowGraph } from '../../shared/flows'
import { VALID_CONDITION_OPS } from '../../shared/flows'

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

// --- Edge conditions (pure, deterministic — no LLM, no clock, no I/O) --------

/**
 * Normalizes a persisted/untrusted edge condition into the canonical
 * `FlowEdgeCondition`. Accepts BOTH the new `{ field, op, value }` shape and the
 * legacy `{ field, equals }` shape (→ `{ field, op:'eq', value: equals }`), so
 * old saved flows evaluate byte-identically with zero on-disk migration.
 * Returns `null` for anything else (non-object, missing/non-string `field`, or an
 * unknown `op` with no legacy `equals` fallback) — the caller then treats the
 * edge as NOT firing (fail-closed, §5).
 */
export function normalizeCondition(raw: unknown): FlowEdgeCondition | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.field !== 'string') return null
  if (typeof o.op === 'string' && VALID_CONDITION_OPS.includes(o.op as FlowConditionOp)) {
    return { field: o.field, op: o.op as FlowConditionOp, value: o.value }
  }
  if ('equals' in o) return { field: o.field, op: 'eq', value: o.equals }
  return null
}

/** A value that participates in a comparison: a finite JS number, or a non-blank
 *  string that `Number()` parses to a finite number. The "looks numeric" test
 *  behind the numeric-preferring coercion policy. */
function looksNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v))
  return false
}

/** Numeric-preferring equality: numbers when both sides look numeric, else a
 *  strict `===` with a `String(...)` fallback (so `130 == "130"` and
 *  `"bug" == "bug"` both hold). */
function valuesEqual(left: unknown, value: unknown): boolean {
  if (looksNumeric(left) && looksNumeric(value)) return Number(left) === Number(value)
  if (left === value) return true
  return String(left) === String(value)
}

/** Numeric-preferring ordering compare. Returns -1/0/1, or `null` when the two
 *  sides are not comparable (e.g. an object/array/boolean `left`) — the caller
 *  maps `null` to a FALSE predicate, never a throw and never a NaN route. */
function compareOrder(left: unknown, value: unknown): number | null {
  if (looksNumeric(left) && looksNumeric(value)) {
    const a = Number(left)
    const b = Number(value)
    return a < b ? -1 : a > b ? 1 : 0
  }
  const strOrNum = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number'
  if (strOrNum(left) && strOrNum(value)) {
    const a = String(left)
    const b = String(value)
    return a < b ? -1 : a > b ? 1 : 0
  }
  return null
}

/** `contains` membership: substring for a string `left`, element membership for
 *  an array `left` (matching by `===` or stringified equality); FALSE otherwise. */
function containsValue(left: unknown, value: unknown): boolean {
  if (typeof left === 'string') return left.includes(String(value))
  if (Array.isArray(left)) return left.some((x) => x === value || String(x) === String(value))
  return false
}

/**
 * PURE per-op predicate: resolves `condition.field` against context once, then
 * dispatches on `op`. SAFETY INVARIANTS (§5): a missing field (`resolveField` →
 * `undefined`) makes EVERY op false (incl. `ne`/`exists`/`truthy`); no op throws;
 * an incomparable comparison resolves to false, never NaN-routes; deterministic.
 */
export function evalCondition(context: RunContext, condition: FlowEdgeCondition): boolean {
  const left = resolveField(context, condition.field)
  // A missing field is false for every op — the "garbled input matches nothing"
  // property. `ne` does NOT invert this into a spurious match.
  if (left === undefined) return false
  const { op, value } = condition
  switch (op) {
    case 'exists':
      return left !== null
    case 'truthy':
      return Boolean(left)
    case 'eq':
      return valuesEqual(left, value)
    case 'ne':
      return !valuesEqual(left, value)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cmp = compareOrder(left, value)
      if (cmp === null) return false
      if (op === 'gt') return cmp > 0
      if (op === 'gte') return cmp >= 0
      if (op === 'lt') return cmp < 0
      return cmp <= 0
    }
    case 'contains':
      return containsValue(left, value)
    default:
      return false
  }
}

/**
 * PURE routing: the out-edges of `nodeId` that fire given the current context.
 * An edge with no `condition` is unconditional (always taken); a conditional
 * edge fires iff its condition (normalized new-or-legacy) evaluates true via
 * `evalCondition` — a deterministic value compare, no LLM. A condition that
 * fails to normalize (unknown op) does NOT fire (fail-closed). This is the whole
 * of the engine's "boolean, not feelings" routing; `router` nodes are simply the
 * explicit branch points.
 */
export function selectEdges(graph: FlowGraph, nodeId: string, context: RunContext): string[] {
  return graph.edges
    .filter((e) => e.from === nodeId)
    .filter((e) => {
      if (!e.condition) return true
      const cond = normalizeCondition(e.condition)
      return cond !== null && evalCondition(context, cond)
    })
    .map((e) => e.id)
}
