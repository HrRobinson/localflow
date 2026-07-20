import { describe, it, expect } from 'vitest'
import { parseFlowGraph, parseFlowGraphResult } from '../../src/main/flow/flow-model'

function graph(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f1',
    name: 'Flow one',
    nodes: [
      {
        id: 't',
        type: 'trigger',
        integration: 'email',
        ref: 'inbound',
        config: {},
        position: { x: 0, y: 0 }
      },
      { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } }
    ],
    edges: [{ id: 'e1', from: 't', to: 'a' }],
    ...over
  }
}

describe('parseFlowGraph — valid graphs', () => {
  it('accepts a well-formed graph and returns it typed', () => {
    const flow = parseFlowGraph(graph())
    expect(flow).not.toBeNull()
    expect(flow?.id).toBe('f1')
    expect(flow?.nodes).toHaveLength(2)
  })

  it('defaults a missing config to {} and a missing position to 0,0', () => {
    const flow = parseFlowGraph(
      graph({
        nodes: [
          { id: 't', type: 'trigger', integration: 'email', ref: 'inbound' },
          { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } }
        ]
      })
    )
    expect(flow?.nodes[0].config).toEqual({})
    expect(flow?.nodes[0].position).toEqual({ x: 0, y: 0 })
  })

  it('accepts a well-typed edge condition', () => {
    const flow = parseFlowGraph(
      graph({
        edges: [{ id: 'e1', from: 't', to: 'a', condition: { field: 'x.y', equals: 'bug' } }]
      })
    )
    expect(flow?.edges[0].condition).toEqual({ field: 'x.y', equals: 'bug' })
  })

  it('accepts a new-shape op condition and round-trips it verbatim', () => {
    const flow = parseFlowGraph(
      graph({
        edges: [
          {
            id: 'e1',
            from: 't',
            to: 'a',
            condition: { field: 'order.total', op: 'gt', value: 100 }
          }
        ]
      })
    )
    expect(flow?.edges[0].condition).toEqual({ field: 'order.total', op: 'gt', value: 100 })
  })

  it('accepts a unary op condition with no value', () => {
    const flow = parseFlowGraph(
      graph({
        edges: [
          { id: 'e1', from: 't', to: 'a', condition: { field: 'triage.category', op: 'exists' } }
        ]
      })
    )
    expect(flow?.edges[0].condition).toEqual({ field: 'triage.category', op: 'exists' })
  })

  it('rejects an unknown condition op with a loud, specific reason', () => {
    const raw = graph({
      edges: [{ id: 'e1', from: 't', to: 'a', condition: { field: 'x', op: 'bogus', value: 1 } }]
    })
    expect(parseFlowGraph(raw)).toBeNull()
    const res = parseFlowGraphResult(raw)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/invalid condition op/i)
      expect(res.error).toMatch(/bogus/)
    }
  })

  it('rejects a trigger-disconnected cycle (each node has an inbound edge, none reachable)', () => {
    // b→c and c→b: both have an inbound edge (the weak orphan check would pass),
    // but neither is reachable from the trigger — the engine would never run
    // them and could deadlock. Reachability from the trigger must reject this.
    const cyclic = graph({
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'email',
          ref: 'inbound',
          config: {},
          position: { x: 0, y: 0 }
        },
        { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } },
        { id: 'b', type: 'agent', ref: 'claude', config: {}, position: { x: 2, y: 0 } },
        { id: 'c', type: 'agent', ref: 'claude', config: {}, position: { x: 3, y: 0 } }
      ],
      edges: [
        { id: 'e1', from: 't', to: 'a' },
        { id: 'e2', from: 'b', to: 'c' },
        { id: 'e3', from: 'c', to: 'b' }
      ]
    })
    expect(parseFlowGraph(cyclic)).toBeNull()
    const res = parseFlowGraphResult(cyclic)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/unreachable from the trigger/i)
    // The baseline trigger→agent graph still passes.
    expect(parseFlowGraph(graph())).not.toBeNull()
  })
})

describe('parseFlowGraph — invalid graphs disable loudly, never throw', () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['non-object', 42 as unknown as Record<string, unknown>, /not an object/i],
    ['missing id', graph({ id: 123 }), /id/i],
    [
      'bad node type',
      graph({ nodes: [{ id: 't', type: 'wormhole', config: {}, position: { x: 0, y: 0 } }] }),
      /type/i
    ],
    [
      'duplicate node id',
      graph({
        nodes: [
          {
            id: 'dup',
            type: 'trigger',
            integration: 'email',
            ref: 'inbound',
            config: {},
            position: { x: 0, y: 0 }
          },
          { id: 'dup', type: 'agent', ref: 'claude', config: {}, position: { x: 0, y: 0 } }
        ],
        edges: []
      }),
      /duplicate/i
    ],
    [
      'no trigger node',
      graph({
        nodes: [{ id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 0, y: 0 } }],
        edges: []
      }),
      /exactly one trigger/i
    ],
    [
      'two trigger nodes',
      graph({
        nodes: [
          {
            id: 't1',
            type: 'trigger',
            integration: 'email',
            ref: 'inbound',
            config: {},
            position: { x: 0, y: 0 }
          },
          {
            id: 't2',
            type: 'trigger',
            integration: 'linear',
            ref: 'created',
            config: {},
            position: { x: 0, y: 0 }
          }
        ],
        edges: []
      }),
      /exactly one trigger/i
    ],
    [
      'dangling edge target',
      graph({ edges: [{ id: 'e9', from: 't', to: 'ghost' }] }),
      /e9.*ghost/i
    ],
    [
      'dangling edge source',
      graph({ edges: [{ id: 'e9', from: 'ghost', to: 'a' }] }),
      /e9.*ghost/i
    ],
    [
      'orphan node (no inbound)',
      graph({
        nodes: [
          {
            id: 't',
            type: 'trigger',
            integration: 'email',
            ref: 'inbound',
            config: {},
            position: { x: 0, y: 0 }
          },
          { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } },
          {
            id: 'orphan',
            type: 'action',
            integration: 'linear',
            ref: 'comment',
            config: {},
            position: { x: 2, y: 0 }
          }
        ],
        edges: [{ id: 'e1', from: 't', to: 'a' }]
      }),
      /orphan/i
    ],
    [
      'bad integration id',
      graph({
        nodes: [
          {
            id: 't',
            type: 'trigger',
            integration: 'telegram',
            ref: 'inbound',
            config: {},
            position: { x: 0, y: 0 }
          },
          { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } }
        ]
      }),
      /integration/i
    ],
    [
      'ill-typed condition field',
      graph({
        edges: [{ id: 'e1', from: 't', to: 'a', condition: { field: 42, equals: 'x' } }]
      }),
      /condition/i
    ]
  ]

  for (const [label, raw, reason] of cases) {
    it(`${label} → null with a specific reason`, () => {
      expect(parseFlowGraph(raw)).toBeNull()
      const res = parseFlowGraphResult(raw)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(reason)
    })
  }
})

describe('parseFlowGraph — customer-facing reply gate (§9)', () => {
  // A trigger + a single customer-facing action node, optionally with a `gate`
  // and/or an intermediate node spliced in between so we can test the "gate any
  // hops upstream" rule.
  const trigger = {
    id: 't',
    type: 'trigger',
    integration: 'email',
    ref: 'inbound',
    config: {},
    position: { x: 0, y: 0 }
  }

  it('(a) intercom replyToConversation with NO upstream gate → fails', () => {
    const res = parseFlowGraphResult({
      id: 'f',
      name: 'ungated intercom reply',
      nodes: [
        trigger,
        {
          id: 'reply',
          type: 'action',
          integration: 'intercom',
          ref: 'replyToConversation',
          config: {},
          position: { x: 1, y: 0 }
        }
      ],
      edges: [{ id: 'e1', from: 't', to: 'reply' }]
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/customer-facing send/)
      expect(res.error).toMatch(/intercom\.replyToConversation/)
    }
  })

  it('(b) intercom replyToConversation WITH a gate directly upstream → ok', () => {
    const res = parseFlowGraphResult({
      id: 'f',
      name: 'gated intercom reply',
      nodes: [
        trigger,
        { id: 'g', type: 'gate', config: {}, position: { x: 1, y: 0 } },
        {
          id: 'reply',
          type: 'action',
          integration: 'intercom',
          ref: 'replyToConversation',
          config: {},
          position: { x: 2, y: 0 }
        }
      ],
      edges: [
        { id: 'e1', from: 't', to: 'g' },
        { id: 'e2', from: 'g', to: 'reply' }
      ]
    })
    expect(res.ok).toBe(true)
  })

  it('(c) zendesk replyToTicket ungated → fails', () => {
    const res = parseFlowGraphResult({
      id: 'f',
      name: 'ungated zendesk reply',
      nodes: [
        trigger,
        {
          id: 'reply',
          type: 'action',
          integration: 'zendesk',
          ref: 'replyToTicket',
          config: {},
          position: { x: 1, y: 0 }
        }
      ],
      edges: [{ id: 'e1', from: 't', to: 'reply' }]
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/zendesk\.replyToTicket/)
  })

  it('(d) zendesk addInternalNote ungated → ok (not customer-facing)', () => {
    const res = parseFlowGraphResult({
      id: 'f',
      name: 'ungated zendesk internal note',
      nodes: [
        trigger,
        {
          id: 'note',
          type: 'action',
          integration: 'zendesk',
          ref: 'addInternalNote',
          config: {},
          position: { x: 1, y: 0 }
        }
      ],
      edges: [{ id: 'e1', from: 't', to: 'note' }]
    })
    expect(res.ok).toBe(true)
  })

  it('(e) a gate two hops upstream still satisfies the reply gate', () => {
    const res = parseFlowGraphResult({
      id: 'f',
      name: 'gate two hops upstream',
      nodes: [
        trigger,
        { id: 'g', type: 'gate', config: {}, position: { x: 1, y: 0 } },
        { id: 'mid', type: 'agent', ref: 'claude', config: {}, position: { x: 2, y: 0 } },
        {
          id: 'reply',
          type: 'action',
          integration: 'intercom',
          ref: 'replyToConversation',
          config: {},
          position: { x: 3, y: 0 }
        }
      ],
      edges: [
        { id: 'e1', from: 't', to: 'g' },
        { id: 'e2', from: 'g', to: 'mid' },
        { id: 'e3', from: 'mid', to: 'reply' }
      ]
    })
    expect(res.ok).toBe(true)
  })
})
