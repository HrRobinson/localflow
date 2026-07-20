import { describe, it, expect } from 'vitest'
import { validateFlow } from '../../src/renderer/src/lib/flow-validate'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'
import type { ResolvedIntegrationDescriptor } from '../../src/shared/integrations'

/**
 * The never-auto-send flow-validate guard (§9 layer 3): an `intercom.replyToConversation`
 * node is UNAUTHORABLE unless it sits downstream of a `gate`. A hard ERROR moves the
 * invariant from "the template happens to gate it" to "an un-gated customer reply
 * cannot be drawn."
 */

const registry: ResolvedIntegrationDescriptor[] = [
  {
    id: 'intercom',
    label: 'Intercom',
    configFields: [
      { key: 'environment', label: 'localflow environment (1-9)', secret: false, required: true }
    ],
    triggers: [{ id: 'conversation.replied', label: 'Customer replied' }],
    actions: [
      { id: 'getConversation', label: 'Get a conversation' },
      { id: 'replyToConversation', label: 'Reply to the customer' }
    ],
    status: 'connected'
  }
]

const trigger: FlowNode = {
  id: 't',
  type: 'trigger',
  integration: 'intercom',
  ref: 'conversation.replied',
  config: { environment: 1 },
  position: { x: 0, y: 0 }
}
const reply: FlowNode = {
  id: 'reply',
  type: 'action',
  integration: 'intercom',
  ref: 'replyToConversation',
  config: { environment: 1, params: { id: '{{t.conversationId}}', body: '{{draft}}' } },
  position: { x: 0, y: 0 }
}
const gate: FlowNode = { id: 'gate', type: 'gate', config: {}, position: { x: 0, y: 0 } }
const compose: FlowNode = { id: 'compose', type: 'agent', config: {}, position: { x: 0, y: 0 } }

const codes = (g: FlowGraph): string[] => validateFlow(g, registry).issues.map((i) => i.code)

describe('never-auto-send guard on intercom.replyToConversation (§9)', () => {
  it('ERRORS when the reply is reachable with NO upstream gate', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'ungated',
      nodes: [trigger, reply],
      edges: [{ id: 'e', from: 't', to: 'reply' }]
    }
    const res = validateFlow(g, registry)
    expect(res.ok).toBe(false)
    const issue = res.issues.find((i) => i.code === 'ungated-customer-facing')
    expect(issue?.severity).toBe('error')
    expect(issue?.nodeId).toBe('reply')
  })

  it('PASSES when a gate sits between the trigger and the reply', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'gated',
      nodes: [trigger, compose, gate, reply],
      edges: [
        { id: 'e1', from: 't', to: 'compose' },
        { id: 'e2', from: 'compose', to: 'gate' },
        { id: 'e3', from: 'gate', to: 'reply' }
      ]
    }
    expect(codes(g)).not.toContain('ungated-customer-facing')
    expect(validateFlow(g, registry).ok).toBe(true)
  })

  it('ERRORS when ANY path to the reply bypasses the gate (a gate-free branch)', () => {
    const g: FlowGraph = {
      id: 'f',
      name: 'partly-gated',
      nodes: [trigger, gate, reply],
      edges: [
        { id: 'e1', from: 't', to: 'gate' },
        { id: 'e2', from: 'gate', to: 'reply' },
        // A second edge reaches the reply WITHOUT passing the gate.
        { id: 'e3', from: 't', to: 'reply' }
      ]
    }
    expect(codes(g)).toContain('ungated-customer-facing')
    expect(validateFlow(g, registry).ok).toBe(false)
  })
})
