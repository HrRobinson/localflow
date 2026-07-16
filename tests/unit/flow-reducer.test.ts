import { describe, it, expect } from 'vitest'
import {
  emptyGraph,
  addNode,
  removeNode,
  moveNode,
  updateNodeConfig,
  connect,
  disconnect,
  setEdgeCondition,
  renameFlow
} from '../../src/renderer/src/lib/flow-reducer'
import type { FlowGraph } from '../../src/shared/flows'

// Deterministic id generator (the SessionManager injected-clock pattern): each
// call returns the next id in the list, so tests assert exact ids.
function seqIds(...ids: string[]): () => string {
  let i = 0
  return () => ids[i++] ?? `overflow-${i}`
}

const base = (): FlowGraph => emptyGraph('flow-1', 'My flow')

describe('flow-reducer: emptyGraph', () => {
  it('creates a graph with the given id/name and no nodes or edges', () => {
    expect(base()).toEqual({ id: 'flow-1', name: 'My flow', nodes: [], edges: [] })
  })
})

describe('flow-reducer: addNode', () => {
  it('appends a node with the injected id, given type and position', () => {
    const g = addNode(base(), { type: 'trigger', position: { x: 10, y: 20 } }, seqIds('n1'))
    expect(g.nodes).toEqual([{ id: 'n1', type: 'trigger', config: {}, position: { x: 10, y: 20 } }])
  })
  it('carries integration + ref for integration-sourced nodes', () => {
    const g = addNode(
      base(),
      { type: 'action', integration: 'linear', ref: 'issue.create', position: { x: 0, y: 0 } },
      seqIds('n1')
    )
    expect(g.nodes[0]).toMatchObject({ integration: 'linear', ref: 'issue.create' })
  })
  it('returns a new graph and does not mutate the input', () => {
    const g0 = base()
    const g1 = addNode(g0, { type: 'agent', position: { x: 0, y: 0 } }, seqIds('n1'))
    expect(g1).not.toBe(g0)
    expect(g0.nodes).toEqual([])
  })
})

describe('flow-reducer: removeNode', () => {
  it('removes the node and cascades every incident edge', () => {
    let g = base()
    g = addNode(g, { type: 'trigger', position: { x: 0, y: 0 } }, seqIds('a'))
    g = addNode(g, { type: 'agent', position: { x: 0, y: 0 } }, seqIds('b'))
    g = addNode(g, { type: 'action', position: { x: 0, y: 0 } }, seqIds('c'))
    g = connect(g, 'a', 'b', seqIds('e1'))
    g = connect(g, 'b', 'c', seqIds('e2'))
    const removed = removeNode(g, 'b')
    expect(removed.nodes.map((n) => n.id)).toEqual(['a', 'c'])
    expect(removed.edges).toEqual([]) // both e1 and e2 were incident to b
  })
  it('is a no-op-shaped new graph for an unknown id', () => {
    const g = addNode(base(), { type: 'trigger', position: { x: 0, y: 0 } }, seqIds('a'))
    const out = removeNode(g, 'nope')
    expect(out.nodes.map((n) => n.id)).toEqual(['a'])
    expect(out).not.toBe(g)
  })
})

describe('flow-reducer: moveNode', () => {
  it('updates only position, leaving config and other nodes untouched', () => {
    let g = addNode(base(), { type: 'agent', position: { x: 0, y: 0 } }, seqIds('a'))
    g = updateNodeConfig(g, 'a', { prompt: 'hi' })
    const moved = moveNode(g, 'a', { x: 99, y: 88 })
    expect(moved.nodes[0].position).toEqual({ x: 99, y: 88 })
    expect(moved.nodes[0].config).toEqual({ prompt: 'hi' })
  })
})

describe('flow-reducer: updateNodeConfig', () => {
  it('shallow-merges the patch into the node config', () => {
    let g = addNode(base(), { type: 'agent', position: { x: 0, y: 0 } }, seqIds('a'))
    g = updateNodeConfig(g, 'a', { agentId: 'claude' })
    g = updateNodeConfig(g, 'a', { prompt: 'go' })
    expect(g.nodes[0].config).toEqual({ agentId: 'claude', prompt: 'go' })
  })
  it('never touches sibling nodes', () => {
    let g = addNode(base(), { type: 'agent', position: { x: 0, y: 0 } }, seqIds('a'))
    g = addNode(g, { type: 'agent', position: { x: 0, y: 0 } }, seqIds('b'))
    g = updateNodeConfig(g, 'a', { prompt: 'x' })
    expect(g.nodes.find((n) => n.id === 'b')!.config).toEqual({})
  })
  it('can also patch integration + ref via updateNode fields', () => {
    let g = addNode(base(), { type: 'trigger', position: { x: 0, y: 0 } }, seqIds('a'))
    g = updateNodeConfig(g, 'a', {}, { integration: 'linear', ref: 'issue.created' })
    expect(g.nodes[0]).toMatchObject({ integration: 'linear', ref: 'issue.created' })
  })
})

describe('flow-reducer: connect', () => {
  const twoNodes = (): FlowGraph => {
    let g = base()
    g = addNode(g, { type: 'trigger', position: { x: 0, y: 0 } }, seqIds('a'))
    g = addNode(g, { type: 'agent', position: { x: 0, y: 0 } }, seqIds('b'))
    return g
  }
  it('adds an edge between two existing nodes', () => {
    const g = connect(twoNodes(), 'a', 'b', seqIds('e1'))
    expect(g.edges).toEqual([{ id: 'e1', from: 'a', to: 'b' }])
  })
  it('rejects a self-loop (returns the same graph reference)', () => {
    const g0 = twoNodes()
    const g1 = connect(g0, 'a', 'a', seqIds('e1'))
    expect(g1).toBe(g0)
  })
  it('rejects a duplicate edge', () => {
    const g0 = connect(twoNodes(), 'a', 'b', seqIds('e1'))
    const g1 = connect(g0, 'a', 'b', seqIds('e2'))
    expect(g1).toBe(g0)
  })
  it('rejects an unknown endpoint', () => {
    const g0 = twoNodes()
    expect(connect(g0, 'a', 'ghost', seqIds('e1'))).toBe(g0)
    expect(connect(g0, 'ghost', 'b', seqIds('e1'))).toBe(g0)
  })
})

describe('flow-reducer: disconnect', () => {
  it('removes the named edge only', () => {
    let g = base()
    g = addNode(g, { type: 'trigger', position: { x: 0, y: 0 } }, seqIds('a'))
    g = addNode(g, { type: 'agent', position: { x: 0, y: 0 } }, seqIds('b'))
    g = connect(g, 'a', 'b', seqIds('e1'))
    const out = disconnect(g, 'e1')
    expect(out.edges).toEqual([])
  })
})

describe('flow-reducer: setEdgeCondition', () => {
  it('sets and clears the router condition on an edge', () => {
    let g = base()
    g = addNode(g, { type: 'router', position: { x: 0, y: 0 } }, seqIds('a'))
    g = addNode(g, { type: 'action', position: { x: 0, y: 0 } }, seqIds('b'))
    g = connect(g, 'a', 'b', seqIds('e1'))
    g = setEdgeCondition(g, 'e1', { field: 'priority', equals: 'high' })
    expect(g.edges[0].condition).toEqual({ field: 'priority', equals: 'high' })
    g = setEdgeCondition(g, 'e1', undefined)
    expect(g.edges[0].condition).toBeUndefined()
  })
})

describe('flow-reducer: renameFlow', () => {
  it('renames and does not mutate the input', () => {
    const g0 = base()
    const g1 = renameFlow(g0, 'Renamed')
    expect(g1.name).toBe('Renamed')
    expect(g0.name).toBe('My flow')
  })
})
