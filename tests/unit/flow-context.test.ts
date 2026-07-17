import { describe, it, expect } from 'vitest'
import {
  resolveField,
  applyTemplate,
  templateParams,
  parseFlowResult,
  selectEdges,
  evalCondition,
  normalizeCondition
} from '../../src/main/flow/context'
import type { FlowConditionOp, FlowEdgeCondition, FlowGraph } from '../../src/shared/flows'

describe('resolveField', () => {
  const ctx = {
    trigger: { from: 'a@b.com', subject: 'Help' },
    triage: { category: 'bug', nested: { score: 3 } }
  }

  it('resolves a dotted path into node-keyed context', () => {
    expect(resolveField(ctx, 'triage.category')).toBe('bug')
    expect(resolveField(ctx, 'trigger.from')).toBe('a@b.com')
    expect(resolveField(ctx, 'triage.nested.score')).toBe(3)
  })

  it('returns undefined for a missing path (never throws)', () => {
    expect(resolveField(ctx, 'triage.missing')).toBeUndefined()
    expect(resolveField(ctx, 'ghost.field')).toBeUndefined()
    expect(resolveField(ctx, 'triage.nested.score.deep')).toBeUndefined()
  })
})

describe('applyTemplate', () => {
  const ctx = { trigger: { subject: 'Login broken' }, triage: { category: 'bug' } }

  it('substitutes {{path}} tokens from context', () => {
    expect(applyTemplate('Triage: {{trigger.subject}}', ctx)).toBe('Triage: Login broken')
  })

  it('renders a missing token as an empty string (loud-but-safe)', () => {
    expect(applyTemplate('x={{triage.missing}}', ctx)).toBe('x=')
  })

  it('templateParams renders only string leaves, leaving non-strings intact', () => {
    const out = templateParams({ title: '{{trigger.subject}}', count: 2, flag: true }, ctx)
    expect(out).toEqual({ title: 'Login broken', count: 2, flag: true })
  })
})

describe('parseFlowResult', () => {
  it('parses a FLOW_RESULT sentinel line from peeked output', () => {
    expect(parseFlowResult(['blah', 'FLOW_RESULT: {"category":"bug"}', 'done'])).toEqual({
      category: 'bug'
    })
  })

  it('returns null when no sentinel is present', () => {
    expect(parseFlowResult(['just', 'normal', 'output'])).toBeNull()
  })

  it('returns null on malformed sentinel JSON (never throws)', () => {
    expect(parseFlowResult(['FLOW_RESULT: {not json}'])).toBeNull()
  })
})

describe('selectEdges', () => {
  const graph: FlowGraph = {
    id: 'g',
    name: 'g',
    nodes: [],
    edges: [
      { id: 'e-bug', from: 'r', to: 'bug', condition: { field: 'triage.category', equals: 'bug' } },
      {
        id: 'e-other',
        from: 'r',
        to: 'other',
        condition: { field: 'triage.category', equals: 'other' }
      },
      { id: 'e-always', from: 'r', to: 'log' }
    ]
  }

  it('takes conditional edges whose condition matches, plus unconditional edges', () => {
    const taken = selectEdges(graph, 'r', { triage: { category: 'bug' } })
    expect(taken.sort()).toEqual(['e-always', 'e-bug'])
  })

  it('drops conditional edges whose condition does not match', () => {
    const taken = selectEdges(graph, 'r', { triage: { category: 'other' } })
    expect(taken.sort()).toEqual(['e-always', 'e-other'])
  })

  it('evaluates a NEW-shape op condition on an edge (back-compat with legacy)', () => {
    const g: FlowGraph = {
      id: 'g',
      name: 'g',
      nodes: [],
      edges: [
        {
          id: 'e-big',
          from: 'r',
          to: 'big',
          condition: { field: 'order.total', op: 'gt', value: 100 }
        }
      ]
    }
    expect(selectEdges(g, 'r', { order: { total: 130 } })).toEqual(['e-big'])
    expect(selectEdges(g, 'r', { order: { total: 50 } })).toEqual([])
  })

  it('a legacy {field,equals} and its {field,op:eq,value} twin route identically', () => {
    const ctx = { triage: { category: 'bug' } }
    const legacy: FlowGraph = {
      id: 'g',
      name: 'g',
      nodes: [],
      edges: [
        { id: 'e', from: 'r', to: 't', condition: { field: 'triage.category', equals: 'bug' } }
      ]
    }
    const modern: FlowGraph = {
      id: 'g',
      name: 'g',
      nodes: [],
      edges: [
        {
          id: 'e',
          from: 'r',
          to: 't',
          condition: { field: 'triage.category', op: 'eq', value: 'bug' }
        }
      ]
    }
    expect(selectEdges(legacy, 'r', ctx)).toEqual(selectEdges(modern, 'r', ctx))
    expect(selectEdges(legacy, 'r', ctx)).toEqual(['e'])
  })

  it('does NOT fire an edge whose condition has an unknown op (fail-closed)', () => {
    const g: FlowGraph = {
      id: 'g',
      name: 'g',
      nodes: [],
      edges: [
        // @ts-expect-error — deliberately invalid op reaching the runtime seam
        { id: 'e', from: 'r', to: 't', condition: { field: 'x', op: 'bogus', value: 1 } }
      ]
    }
    expect(selectEdges(g, 'r', { x: 1 })).toEqual([])
  })
})

describe('normalizeCondition', () => {
  it('passes a valid new-shape condition through', () => {
    expect(normalizeCondition({ field: 'a', op: 'gt', value: 3 })).toEqual({
      field: 'a',
      op: 'gt',
      value: 3
    })
  })

  it('normalizes a legacy {field,equals} to {field,op:eq,value}', () => {
    expect(normalizeCondition({ field: 'a', equals: 'bug' })).toEqual({
      field: 'a',
      op: 'eq',
      value: 'bug'
    })
  })

  it('returns null for an unknown op with no legacy fallback', () => {
    expect(normalizeCondition({ field: 'a', op: 'bogus' })).toBeNull()
  })

  it('returns null for a non-object or a missing/non-string field', () => {
    expect(normalizeCondition(null)).toBeNull()
    expect(normalizeCondition('x')).toBeNull()
    expect(normalizeCondition({ op: 'eq', value: 1 })).toBeNull()
    expect(normalizeCondition({ field: 42, op: 'eq' })).toBeNull()
  })
})

describe('evalCondition', () => {
  const cond = (field: string, op: FlowConditionOp, value?: unknown): FlowEdgeCondition => ({
    field,
    op,
    value
  })

  describe('eq / ne', () => {
    it('string equality', () => {
      expect(evalCondition({ s: { v: 'bug' } }, cond('s.v', 'eq', 'bug'))).toBe(true)
      expect(evalCondition({ s: { v: 'bug' } }, cond('s.v', 'eq', 'ui'))).toBe(false)
    })
    it('numeric equality', () => {
      expect(evalCondition({ n: 5 }, cond('n', 'eq', 5))).toBe(true)
      expect(evalCondition({ n: 5 }, cond('n', 'eq', 6))).toBe(false)
    })
    it('cross-type numeric equality (130 == "130")', () => {
      expect(evalCondition({ n: 130 }, cond('n', 'eq', '130'))).toBe(true)
      expect(evalCondition({ n: '130' }, cond('n', 'eq', 130))).toBe(true)
    })
    it('ne is the logical negation of eq', () => {
      expect(evalCondition({ s: 'bug' }, cond('s', 'ne', 'ui'))).toBe(true)
      expect(evalCondition({ s: 'bug' }, cond('s', 'ne', 'bug'))).toBe(false)
    })
    it('ne on a missing field is FALSE (missing never inverts to a match)', () => {
      expect(evalCondition({}, cond('gone', 'ne', 'bug'))).toBe(false)
    })
  })

  describe('gt / gte / lt / lte', () => {
    it('numeric ordering', () => {
      expect(evalCondition({ n: 130 }, cond('n', 'gt', 100))).toBe(true)
      expect(evalCondition({ n: 50 }, cond('n', 'gt', 100))).toBe(false)
      expect(evalCondition({ n: 130 }, cond('n', 'lt', 100))).toBe(false)
      expect(evalCondition({ n: 50 }, cond('n', 'lt', 100))).toBe(true)
    })
    it('numeric-preferring: string-numeric compares as numbers', () => {
      expect(evalCondition({ n: '130' }, cond('n', 'gt', '100'))).toBe(true)
      expect(evalCondition({ n: '130' }, cond('n', 'gt', 100))).toBe(true)
      // "9" > "100" would be true lexicographically; numeric coercion makes it false
      expect(evalCondition({ n: '9' }, cond('n', 'gt', '100'))).toBe(false)
    })
    it('lexicographic compare when values are non-numeric strings', () => {
      expect(evalCondition({ s: 'b' }, cond('s', 'gt', 'a'))).toBe(true)
      expect(evalCondition({ s: 'a' }, cond('s', 'gt', 'b'))).toBe(false)
    })
    it('gte / lte boundary equality', () => {
      expect(evalCondition({ n: 100 }, cond('n', 'gte', 100))).toBe(true)
      expect(evalCondition({ n: 100 }, cond('n', 'lte', 100))).toBe(true)
      expect(evalCondition({ n: 100 }, cond('n', 'gt', 100))).toBe(false)
      expect(evalCondition({ n: 100 }, cond('n', 'lt', 100))).toBe(false)
    })
    it('non-numeric non-string left vs numeric value is FALSE (no NaN route)', () => {
      expect(evalCondition({ o: { a: 1 } }, cond('o', 'gt', 100))).toBe(false)
      expect(evalCondition({ b: true }, cond('b', 'gt', 0))).toBe(false)
      expect(evalCondition({ arr: [1, 2] }, cond('arr', 'lt', 5))).toBe(false)
    })
  })

  describe('contains', () => {
    it('string membership', () => {
      expect(evalCondition({ e: 'a@b.com' }, cond('e', 'contains', '@'))).toBe(true)
      expect(evalCondition({ e: 'abc' }, cond('e', 'contains', 'z'))).toBe(false)
    })
    it('array membership (value or String(value) matches an element)', () => {
      expect(evalCondition({ tags: ['bug', 'ui'] }, cond('tags', 'contains', 'bug'))).toBe(true)
      expect(evalCondition({ tags: [1, 2, 3] }, cond('tags', 'contains', '2'))).toBe(true)
      expect(evalCondition({ tags: ['bug'] }, cond('tags', 'contains', 'ui'))).toBe(false)
    })
    it('non-string/array left is FALSE', () => {
      expect(evalCondition({ n: 130 }, cond('n', 'contains', '1'))).toBe(false)
      expect(evalCondition({ o: { a: 1 } }, cond('o', 'contains', 'a'))).toBe(false)
    })
  })

  describe('exists', () => {
    it('present and non-null is true; false/0/empty-string still exist', () => {
      expect(evalCondition({ v: 'x' }, cond('v', 'exists'))).toBe(true)
      expect(evalCondition({ v: false }, cond('v', 'exists'))).toBe(true)
      expect(evalCondition({ v: 0 }, cond('v', 'exists'))).toBe(true)
      expect(evalCondition({ v: '' }, cond('v', 'exists'))).toBe(true)
    })
    it('missing or null is false', () => {
      expect(evalCondition({}, cond('gone', 'exists'))).toBe(false)
      expect(evalCondition({ v: null }, cond('v', 'exists'))).toBe(false)
    })
  })

  describe('truthy', () => {
    it('Boolean(left) truth table', () => {
      expect(evalCondition({ v: 'x' }, cond('v', 'truthy'))).toBe(true)
      expect(evalCondition({ v: 1 }, cond('v', 'truthy'))).toBe(true)
      expect(evalCondition({ v: 0 }, cond('v', 'truthy'))).toBe(false)
      expect(evalCondition({ v: '' }, cond('v', 'truthy'))).toBe(false)
      expect(evalCondition({ v: false }, cond('v', 'truthy'))).toBe(false)
      expect(evalCondition({ v: null }, cond('v', 'truthy'))).toBe(false)
    })
    it('missing is false', () => {
      expect(evalCondition({}, cond('gone', 'truthy'))).toBe(false)
    })
  })

  describe('missing-field-is-false for EVERY op (the safety property)', () => {
    const ops: FlowConditionOp[] = [
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'contains',
      'exists',
      'truthy'
    ]
    for (const op of ops) {
      it(`${op} on an absent field is false and never throws`, () => {
        expect(evalCondition({ present: 1 }, cond('absent', op, 0))).toBe(false)
      })
    }
  })
})
