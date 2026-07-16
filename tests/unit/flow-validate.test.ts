import { describe, it, expect } from 'vitest'
import { validateFlow } from '../../src/renderer/src/lib/flow-validate'
import type { FlowGraph, ValidationCode } from '../../src/shared/flows'
import type { ResolvedIntegrationDescriptor } from '../../src/shared/integrations'

const registry: ResolvedIntegrationDescriptor[] = [
  {
    id: 'linear',
    label: 'Linear',
    configFields: [{ key: 'team', label: 'Team', secret: false, required: true }],
    triggers: [{ id: 'issue.created', label: 'Issue created' }],
    actions: [{ id: 'issue.create', label: 'Create issue' }],
    status: 'connected'
  },
  {
    id: 'email',
    label: 'Email',
    configFields: [],
    triggers: [],
    actions: [{ id: 'message.send', label: 'Send email' }],
    status: 'needs-config'
  }
]

const codes = (g: FlowGraph): ValidationCode[] => validateFlow(g, registry).issues.map((i) => i.code)

describe('flow-validate', () => {
  it('flags an empty graph as a warning, not an error', () => {
    const g: FlowGraph = { id: 'f', name: 'x', nodes: [], edges: [] }
    const res = validateFlow(g, registry)
    expect(res.issues.map((i) => i.code)).toContain('empty-graph')
    expect(res.issues.find((i) => i.code === 'empty-graph')!.severity).toBe('warning')
    // A warning-only graph is still ok:true (drafts save freely, §5).
    expect(res.ok).toBe(true)
  })

  it('flags no-trigger as an error when there is no trigger node', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [{ id: 'a', type: 'agent', config: {}, position: { x: 0, y: 0 } }],
      edges: []
    }
    const res = validateFlow(g, registry)
    expect(res.issues.map((i) => i.code)).toContain('no-trigger')
    expect(res.ok).toBe(false)
  })

  it('passes a well-formed connected trigger→agent graph', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: { team: 'ENG' },
          position: { x: 0, y: 0 }
        },
        { id: 'a', type: 'agent', config: { agentId: 'claude' }, position: { x: 0, y: 0 } }
      ],
      edges: [{ id: 'e', from: 't', to: 'a' }]
    }
    const res = validateFlow(g, registry)
    expect(res.issues).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('flags an unreachable node as a warning', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: { team: 'ENG' },
          position: { x: 0, y: 0 }
        },
        { id: 'lonely', type: 'agent', config: {}, position: { x: 0, y: 0 } }
      ],
      edges: []
    }
    const issue = validateFlow(g, registry).issues.find((i) => i.code === 'unreachable')
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe('warning')
    expect(issue!.nodeId).toBe('lonely')
  })

  it('flags a dangling edge referencing a missing node', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: { team: 'ENG' },
          position: { x: 0, y: 0 }
        }
      ],
      edges: [{ id: 'e', from: 't', to: 'ghost' }]
    }
    const issue = validateFlow(g, registry).issues.find((i) => i.code === 'dangling-edge')
    expect(issue).toBeDefined()
    expect(issue!.edgeId).toBe('e')
    expect(validateFlow(g, registry).ok).toBe(false)
  })

  it('flags missing-config when an integration node has no ref', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [{ id: 't', type: 'trigger', integration: 'linear', config: {}, position: { x: 0, y: 0 } }],
      edges: []
    }
    expect(codes(g)).toContain('missing-config')
  })

  it('flags missing-config when a required non-secret field is empty', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: {}, // team (required, non-secret) missing
          position: { x: 0, y: 0 }
        }
      ],
      edges: []
    }
    expect(codes(g)).toContain('missing-config')
  })

  it('does NOT flag missing-config for a missing SECRET field (managed in Integrations)', () => {
    const secretReg: ResolvedIntegrationDescriptor[] = [
      {
        id: 'email',
        label: 'Email',
        configFields: [{ key: 'smtpUrl', label: 'SMTP', secret: true, required: true }],
        triggers: [{ id: 'message.received', label: 'received' }],
        actions: [],
        status: 'connected'
      }
    ]
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'email',
          ref: 'message.received',
          config: {},
          position: { x: 0, y: 0 }
        }
      ],
      edges: []
    }
    expect(validateFlow(g, secretReg).issues.map((i) => i.code)).not.toContain('missing-config')
  })

  it('flags integration-not-connected when status is needs-config', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: { team: 'ENG' },
          position: { x: 0, y: 0 }
        },
        {
          id: 'act',
          type: 'action',
          integration: 'email', // needs-config in the registry
          ref: 'message.send',
          config: {},
          position: { x: 0, y: 0 }
        }
      ],
      edges: [{ id: 'e', from: 't', to: 'act' }]
    }
    const issue = validateFlow(g, registry).issues.find(
      (i) => i.code === 'integration-not-connected'
    )
    expect(issue).toBeDefined()
    expect(issue!.nodeId).toBe('act')
    expect(issue!.message).toMatch(/Email/)
  })

  it('flags a non-router cycle as an error', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: { team: 'ENG' },
          position: { x: 0, y: 0 }
        },
        { id: 'a', type: 'agent', config: {}, position: { x: 0, y: 0 } },
        { id: 'b', type: 'agent', config: {}, position: { x: 0, y: 0 } }
      ],
      edges: [
        { id: 'e0', from: 't', to: 'a' },
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'a' } // cycle a→b→a
      ]
    }
    const res = validateFlow(g, registry)
    expect(res.issues.map((i) => i.code)).toContain('cycle')
    expect(res.ok).toBe(false)
  })

  it('allows a cycle that passes through a router (warns, does not error)', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: { team: 'ENG' },
          position: { x: 0, y: 0 }
        },
        { id: 'r', type: 'router', config: {}, position: { x: 0, y: 0 } },
        { id: 'a', type: 'agent', config: {}, position: { x: 0, y: 0 } }
      ],
      edges: [
        { id: 'e0', from: 't', to: 'r' },
        { id: 'e1', from: 'r', to: 'a' },
        { id: 'e2', from: 'a', to: 'r' } // loops back through the router
      ]
    }
    const res = validateFlow(g, registry)
    // No hard cycle error (a router may loop by design), but it is surfaced.
    expect(res.ok).toBe(true)
    expect(res.issues.map((i) => i.code)).toContain('cycle')
    expect(res.issues.find((i) => i.code === 'cycle')!.severity).toBe('warning')
  })

  it('agent/gate/router nodes never raise integration issues', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'x',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'linear',
          ref: 'issue.created',
          config: { team: 'ENG' },
          position: { x: 0, y: 0 }
        },
        { id: 'g', type: 'gate', config: { manual: true }, position: { x: 0, y: 0 } }
      ],
      edges: [{ id: 'e', from: 't', to: 'g' }]
    }
    const cs = codes(g)
    expect(cs).not.toContain('missing-config')
    expect(cs).not.toContain('integration-not-connected')
  })
})
