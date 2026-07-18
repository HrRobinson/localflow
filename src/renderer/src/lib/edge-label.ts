import type { FlowEdge } from '../../../shared/flows'

/** A compact edge label for a branch condition, handling both the new
 *  `{ field, op, value }` shape (unary ops omit the value) and the legacy
 *  `{ field, equals }` shape. Kept in a pure (jsx-free) lib module so the canvas
 *  renders it and the unit test exercises it directly. */
export function edgeConditionLabel(c: FlowEdge['condition']): string | undefined {
  if (!c) return undefined
  if ('op' in c) {
    if (c.op === 'exists' || c.op === 'truthy') return `${c.field} ${c.op}`
    return `${c.field} ${c.op} ${String(c.value ?? '')}`
  }
  return `${c.field} = ${String(c.equals)}`
}
