import { describe, it, expect } from 'vitest'
import {
  initRunState,
  readyNodes,
  applyOutcome,
  setNodeStatus,
  isComplete
} from '../../src/main/flow/run-state'
import type { FlowGraph } from '../../src/shared/flows'

// t → r ; r --bug--> bug ; r --other--> other ; bug → done ; other → done
const graph: FlowGraph = {
  id: 'g',
  name: 'g',
  nodes: [
    { id: 't', type: 'trigger', config: {}, position: { x: 0, y: 0 } },
    { id: 'r', type: 'router', config: {}, position: { x: 1, y: 0 } },
    { id: 'bug', type: 'action', config: {}, position: { x: 2, y: 0 } },
    { id: 'other', type: 'action', config: {}, position: { x: 2, y: 1 } },
    { id: 'end', type: 'action', config: {}, position: { x: 3, y: 0 } }
  ],
  edges: [
    { id: 'e-tr', from: 't', to: 'r' },
    { id: 'e-bug', from: 'r', to: 'bug', condition: { field: 't.category', equals: 'bug' } },
    { id: 'e-other', from: 'r', to: 'other', condition: { field: 't.category', equals: 'other' } },
    { id: 'e-bug-end', from: 'bug', to: 'end' },
    { id: 'e-other-end', from: 'other', to: 'end' }
  ]
}

describe('run-state reducer', () => {
  it('starts every node pending; only the trigger (no inbound) is ready', () => {
    const s = initRunState(graph)
    expect(readyNodes(graph, s)).toEqual(['t'])
    expect(isComplete(graph, s)).toBe(false)
  })

  it('advances the trigger done → its downstream becomes ready', () => {
    let s = initRunState(graph)
    s = applyOutcome(graph, s, 't', 'done', ['e-tr'])
    expect(readyNodes(graph, s)).toEqual(['r'])
  })

  it('a router taking one branch skips the un-taken branch and its dead descendants', () => {
    let s = initRunState(graph)
    s = applyOutcome(graph, s, 't', 'done', ['e-tr'])
    // router takes only e-bug
    s = applyOutcome(graph, s, 'r', 'done', ['e-bug'])
    expect(readyNodes(graph, s)).toEqual(['bug'])
    expect(s.nodes.other).toBe('skipped')
    // 'end' has one dead inbound (from other) and one still-live path (via bug)
    expect(s.nodes.end).toBe('pending')
  })

  it('fan-in: end runs once the taken branch completes even though the other is dead', () => {
    let s = initRunState(graph)
    s = applyOutcome(graph, s, 't', 'done', ['e-tr'])
    s = applyOutcome(graph, s, 'r', 'done', ['e-bug'])
    s = setNodeStatus(s, 'bug', 'running')
    s = applyOutcome(graph, s, 'bug', 'done', ['e-bug-end'])
    expect(readyNodes(graph, s)).toEqual(['end'])
    s = applyOutcome(graph, s, 'end', 'done', [])
    expect(isComplete(graph, s)).toBe(true)
  })

  it('a failed node marks its whole downstream skipped and is complete', () => {
    let s = initRunState(graph)
    s = applyOutcome(graph, s, 't', 'done', ['e-tr'])
    s = applyOutcome(graph, s, 'r', 'failed', [])
    expect(s.nodes.bug).toBe('skipped')
    expect(s.nodes.other).toBe('skipped')
    expect(s.nodes.end).toBe('skipped')
    expect(isComplete(graph, s)).toBe(true)
  })

  it('setNodeStatus marks running/waiting without touching edges', () => {
    let s = initRunState(graph)
    s = setNodeStatus(s, 't', 'waiting')
    expect(s.nodes.t).toBe('waiting')
    expect(readyNodes(graph, s)).toEqual([])
  })
})
