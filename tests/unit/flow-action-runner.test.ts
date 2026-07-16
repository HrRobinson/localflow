import { describe, it, expect, vi } from 'vitest'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import type { FlowNode } from '../../src/shared/flows'
import type { IntegrationDescriptor, IntegrationRegistry } from '../../src/shared/integrations'

function descriptor(over: Partial<IntegrationDescriptor> = {}): IntegrationDescriptor {
  return {
    id: 'linear',
    label: 'Linear',
    configFields: [],
    triggers: [],
    actions: [{ id: 'createIssue', label: 'Create issue' }],
    status: () => 'connected',
    ...over
  }
}

function registry(over: Partial<IntegrationRegistry> = {}): IntegrationRegistry {
  return {
    descriptors: () => [descriptor()],
    get: () => descriptor(),
    invokeAction: vi.fn(async () => ({ issueId: 'ENG-1' })),
    subscribe: () => () => {},
    ...over
  }
}

function actionNode(over: Partial<FlowNode> = {}): FlowNode {
  return {
    id: 'ac1',
    type: 'action',
    integration: 'linear',
    ref: 'createIssue',
    config: { params: { title: 'Re: {{trigger.subject}}' } },
    position: { x: 0, y: 0 },
    ...over
  }
}

describe('runAction', () => {
  it('invokes the action with templated params and writes the result to context', async () => {
    const invokeAction = vi.fn(async () => ({ issueId: 'ENG-42' }))
    const out = await runAction({ registry: registry({ invokeAction }) }, actionNode(), {
      trigger: { subject: 'Login broken' }
    })
    expect(invokeAction).toHaveBeenCalledWith('linear', 'createIssue', {
      title: 'Re: Login broken'
    })
    expect(out.status).toBe('done')
    expect(out.context).toEqual({ ac1: { issueId: 'ENG-42' } })
  })

  it('fails legibly BEFORE any call when the integration is not connected', async () => {
    const invokeAction = vi.fn()
    const out = await runAction(
      {
        registry: registry({
          get: () => descriptor({ status: () => 'needs-config' }),
          invokeAction
        })
      },
      actionNode(),
      {}
    )
    expect(invokeAction).not.toHaveBeenCalled()
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/Linear/)
    expect(out.message).toMatch(/connect/i)
  })

  it('fails when the integration id is unknown to the registry', async () => {
    const out = await runAction({ registry: registry({ get: () => undefined }) }, actionNode(), {})
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/linear/i)
  })

  it('fails when the node is missing an integration or ref', async () => {
    const out = await runAction({ registry: registry() }, actionNode({ ref: undefined }), {})
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/misconfigured|ref/i)
  })

  it('forwards the real exception when invokeAction rejects', async () => {
    const invokeAction = vi.fn(async () => {
      throw new Error('RATELIMITED: retry after 30s')
    })
    const out = await runAction({ registry: registry({ invokeAction }) }, actionNode(), {})
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/RATELIMITED: retry after 30s/)
  })
})
