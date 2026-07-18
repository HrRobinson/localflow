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
  renameFlow,
  instantiateTemplate,
  dedupeName
} from '../../src/renderer/src/lib/flow-reducer'
import type { FlowGraph } from '../../src/shared/flows'
import type { FlowTemplate } from '../../src/shared/flow-templates'
import { isFlowGraph } from '../../src/shared/flows'
import { BUILTIN_FLOW_TEMPLATES } from '../../src/main/flow/builtin-templates'

// A counter-backed id generator for the real built-ins (whose node/edge counts
// vary): each call returns a fresh, unique id with the given prefix.
function counterIds(prefix: string): () => string {
  let i = 0
  return () => `${prefix}-${i++}`
}

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
  const routerGraph = (): FlowGraph => {
    let g = base()
    g = addNode(g, { type: 'router', position: { x: 0, y: 0 } }, seqIds('a'))
    g = addNode(g, { type: 'action', position: { x: 0, y: 0 } }, seqIds('b'))
    return connect(g, 'a', 'b', seqIds('e1'))
  }

  it('sets and clears a new-shape router condition on an edge', () => {
    let g = routerGraph()
    g = setEdgeCondition(g, 'e1', { field: 'order.total', op: 'gt', value: 100 })
    expect(g.edges[0].condition).toEqual({ field: 'order.total', op: 'gt', value: 100 })
    g = setEdgeCondition(g, 'e1', undefined)
    expect(g.edges[0].condition).toBeUndefined()
  })

  it('stores a unary op condition without a value', () => {
    let g = routerGraph()
    g = setEdgeCondition(g, 'e1', { field: 'triage.category', op: 'exists' })
    expect(g.edges[0].condition).toEqual({ field: 'triage.category', op: 'exists' })
  })

  it('returns a new graph and does not mutate the input', () => {
    const g0 = routerGraph()
    const g1 = setEdgeCondition(g0, 'e1', { field: 'x', op: 'eq', value: 'y' })
    expect(g1).not.toBe(g0)
    expect(g0.edges[0].condition).toBeUndefined()
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

describe('flow-reducer: dedupeName', () => {
  it('returns the base name unchanged when no collision', () => {
    expect(dedupeName('Ecom Support Worker', [])).toBe('Ecom Support Worker')
    expect(dedupeName('Ecom Support Worker', ['Other'])).toBe('Ecom Support Worker')
  })
  it('appends " 2" on the first collision', () => {
    expect(dedupeName('Ecom Support Worker', ['Ecom Support Worker'])).toBe('Ecom Support Worker 2')
  })
  it('finds the next free counter across a run of collisions', () => {
    expect(dedupeName('Worker', ['Worker', 'Worker 2', 'Worker 3'])).toBe('Worker 4')
  })
  it('fills a gap in the counter sequence', () => {
    // "Worker 2" is free even though "Worker" and "Worker 3" are taken.
    expect(dedupeName('Worker', ['Worker', 'Worker 3'])).toBe('Worker 2')
  })
})

describe('flow-reducer: instantiateTemplate', () => {
  // A template with placeholder ids, a router condition (new shape), and nested
  // config — the shape instantiate must deep-clone + re-id.
  const template = (): FlowTemplate => ({
    id: 'ecom-support',
    name: 'Ecom Support Worker',
    description: 'x',
    category: 'ecom',
    graph: {
      id: 't-graph',
      name: 'Ecom Support Worker',
      nodes: [
        {
          id: 't-trigger',
          type: 'trigger',
          integration: 'email',
          ref: 'inbound',
          config: {},
          position: { x: 1, y: 2 }
        },
        {
          id: 't-agent',
          type: 'agent',
          ref: 'claude',
          config: { prompt: 'draft a reply', nested: { a: 1 } },
          position: { x: 3, y: 4 }
        },
        { id: 't-router', type: 'router', config: {}, position: { x: 5, y: 6 } }
      ],
      edges: [
        { id: 't-e1', from: 't-trigger', to: 't-agent' },
        {
          id: 't-e2',
          from: 't-agent',
          to: 't-router',
          condition: { field: 'order.total', op: 'gt', value: 100 }
        }
      ]
    }
  })

  const opts = (existingNames: string[] = []): Parameters<typeof instantiateTemplate>[1] => ({
    flowId: 'flow-1',
    nodeIdFn: seqIds('n1', 'n2', 'n3'),
    edgeIdFn: seqIds('e1', 'e2'),
    existingNames
  })

  it('mints the injected flow id + a fresh, de-duplicated name', () => {
    const g = instantiateTemplate(template(), opts(['Ecom Support Worker']))
    expect(g.id).toBe('flow-1')
    expect(g.name).toBe('Ecom Support Worker 2')
  })

  it('re-mints every node id from nodeIdFn (no template placeholder survives)', () => {
    const g = instantiateTemplate(template(), opts())
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(g.nodes.some((n) => n.id.startsWith('t-'))).toBe(false)
  })

  it('re-mints edge ids and re-maps from/to consistently to the new node ids', () => {
    const g = instantiateTemplate(template(), opts())
    expect(g.edges.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(g.edges).toEqual([
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3', condition: { field: 'order.total', op: 'gt', value: 100 } }
    ])
  })

  it('produces a structurally valid FlowGraph', () => {
    const g = instantiateTemplate(template(), opts())
    expect(isFlowGraph(g)).toBe(true)
  })

  it('preserves node types, integration + ref refs, and counts exactly', () => {
    const t = template()
    const g = instantiateTemplate(t, opts())
    expect(g.nodes.map((n) => n.type)).toEqual(['trigger', 'agent', 'router'])
    expect(g.nodes.length).toBe(t.graph.nodes.length)
    expect(g.edges.length).toBe(t.graph.edges.length)
    expect(g.nodes[0]).toMatchObject({ integration: 'email', ref: 'inbound' })
    expect(g.nodes[1]).toMatchObject({ ref: 'claude' })
  })

  it('DEEP-CLONES config/condition/position — mutating the result never touches the template', () => {
    const t = template()
    const g = instantiateTemplate(t, opts())
    // Mutate every nested clone on the result.
    ;(g.nodes[1].config.nested as { a: number }).a = 999
    g.nodes[0].position.x = -1
    ;(g.edges[1].condition as { value: number }).value = -1
    // The template constant is untouched.
    expect((t.graph.nodes[1].config.nested as { a: number }).a).toBe(1)
    expect(t.graph.nodes[0].position.x).toBe(1)
    expect(t.graph.edges[1].condition).toEqual({ field: 'order.total', op: 'gt', value: 100 })
  })

  it('does not mutate the input template', () => {
    const t = template()
    const before = JSON.stringify(t)
    instantiateTemplate(t, opts())
    expect(JSON.stringify(t)).toBe(before)
  })
})

describe('flow-reducer: instantiateTemplate over the REAL built-ins', () => {
  // Fold-in: exercise every shipped BUILTIN_FLOW_TEMPLATE (not a synthetic
  // fixture) through instantiate, proving (a) the source constant is never
  // mutated and (b) the result is a valid FlowGraph carrying only fresh ids.
  it.each(BUILTIN_FLOW_TEMPLATES.map((t) => [t.id, t] as const))(
    'instantiates %s without mutating the source and yields a valid, freshly-ided graph',
    (_id, tmpl) => {
      const before = JSON.stringify(tmpl)
      const g = instantiateTemplate(tmpl, {
        flowId: 'flow-real',
        nodeIdFn: counterIds('node'),
        edgeIdFn: counterIds('edge'),
        existingNames: []
      })

      // (a) The shipped constant is untouched.
      expect(JSON.stringify(tmpl)).toBe(before)

      // (b) A valid FlowGraph with the injected flow id.
      expect(isFlowGraph(g)).toBe(true)
      expect(g.id).toBe('flow-real')
      expect(g.nodes.length).toBe(tmpl.graph.nodes.length)
      expect(g.edges.length).toBe(tmpl.graph.edges.length)

      // (c) Every id is freshly minted — no template placeholder survives, and
      // ids are unique within the instantiated graph.
      const sourceNodeIds = new Set(tmpl.graph.nodes.map((n) => n.id))
      for (const n of g.nodes) expect(sourceNodeIds.has(n.id)).toBe(false)
      const nodeIds = g.nodes.map((n) => n.id)
      expect(new Set(nodeIds).size).toBe(nodeIds.length)
      const edgeIds = g.edges.map((e) => e.id)
      expect(new Set(edgeIds).size).toBe(edgeIds.length)
    }
  )
})
