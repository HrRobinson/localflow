import { describe, it, expect } from 'vitest'
import { edgeConditionLabel } from '../../src/renderer/src/lib/edge-label'

// ACCEPTANCE (formatter half): CanvasSurface's edge-label formatter must render
// the built-in templates' `{ op, value }` conditions as a legible predicate —
// NOT the old "field = undefined" the legacy equals-only formatter produced for
// a rich condition. Covers the new shape, the unary ops, and the legacy shape.
describe('edgeConditionLabel', () => {
  it('renders a binary { op, value } condition (the built-in template shape)', () => {
    expect(edgeConditionLabel({ field: 'order.total', op: 'gt', value: 100 })).toBe(
      'order.total gt 100'
    )
    expect(edgeConditionLabel({ field: 'priority', op: 'eq', value: 'high' })).toBe(
      'priority eq high'
    )
    // Regression guard: a rich condition must NOT collapse to "field = undefined".
    expect(edgeConditionLabel({ field: 'order.total', op: 'lte', value: 100 })).not.toMatch(
      /undefined/
    )
  })

  it('omits the value for the unary ops', () => {
    expect(edgeConditionLabel({ field: 'refund', op: 'exists' })).toBe('refund exists')
    expect(edgeConditionLabel({ field: 'flagged', op: 'truthy' })).toBe('flagged truthy')
  })

  it('still renders the legacy { field, equals } shape', () => {
    expect(edgeConditionLabel({ field: 'status', equals: 'open' })).toBe('status = open')
  })

  it('returns undefined for an absent condition', () => {
    expect(edgeConditionLabel(undefined)).toBeUndefined()
  })
})
