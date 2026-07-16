import { describe, it, expect } from 'vitest'
import {
  resolveField,
  applyTemplate,
  templateParams,
  parseFlowResult,
  selectEdges
} from '../../src/main/flow/context'
import type { FlowGraph } from '../../src/shared/flows'

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
      { id: 'e-other', from: 'r', to: 'other', condition: { field: 'triage.category', equals: 'other' } },
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
})
