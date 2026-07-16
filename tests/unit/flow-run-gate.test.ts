import { describe, it, expect, vi } from 'vitest'
import { FlowEngine } from '../../src/main/flow/flow-engine'
import type { ApprovalPort } from '../../src/main/flow/types'
import type { PaneDriver } from '../../src/main/flow/pane-driver'
import type { FlowGraph } from '../../src/shared/flows'
import type {
  IntegrationDescriptor,
  IntegrationId,
  IntegrationRegistry
} from '../../src/shared/integrations'

/**
 * The STRICT run-time gate (design intent, see flow-store.ts's docstring):
 * listing/editing is lenient (drafts round-trip through loadFlows), but
 * `FlowEngine.run` and `FlowEngine.start`'s trigger subscription both validate
 * through the STRICT `parseFlowGraphResult` before doing anything live. These
 * tests never spawn a real pane — the flows under test have no `agent` node,
 * so `driver`/`manager` are never touched.
 */

const descriptor = (id: IntegrationId): IntegrationDescriptor => ({
  id,
  label: id,
  configFields: [],
  triggers: [
    { id: 'inbound', label: 'inbound' },
    { id: 'other', label: 'other' }
  ],
  actions: [],
  status: () => 'connected'
})

function stubRegistry(): {
  registry: IntegrationRegistry
  subscribed: Set<string>
  fire: (id: IntegrationId, triggerId: string, event: unknown) => void
} {
  const handlers: Record<string, (e: unknown) => void> = {}
  const subscribed = new Set<string>()
  return {
    subscribed,
    fire: (id, triggerId, event) => handlers[`${id}:${triggerId}`]?.(event),
    registry: {
      descriptors: () => [descriptor('email')],
      get: (id) => descriptor(id),
      invokeAction: async () => ({ ok: true }),
      subscribe: (id, triggerId, handler) => {
        const key = `${id}:${triggerId}`
        subscribed.add(key)
        handlers[key] = handler
        return () => {
          subscribed.delete(key)
          delete handlers[key]
        }
      }
    }
  }
}

function triggerOnlyFlow(id: string, ref: string): FlowGraph {
  return {
    id,
    name: `Flow ${id}`,
    nodes: [
      {
        id: 't',
        type: 'trigger',
        integration: 'email',
        ref,
        config: {},
        position: { x: 0, y: 0 }
      }
    ],
    edges: []
  }
}

function draftWithUnreachableNode(id: string): FlowGraph {
  return {
    id,
    name: `Draft ${id}`,
    nodes: [
      {
        id: 't',
        type: 'trigger',
        integration: 'email',
        ref: 'other',
        config: {},
        position: { x: 0, y: 0 }
      },
      { id: 'orphan', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } }
    ],
    edges: [] // 'orphan' is unreachable from the trigger
  }
}

function engineFor(flows: FlowGraph[], reg: ReturnType<typeof stubRegistry>): FlowEngine {
  const approvals: ApprovalPort = { requestApproval: async () => false }
  return new FlowEngine({
    flows,
    config: { enabled: true, environment: 1, maxConcurrentPanes: 2 },
    registry: reg.registry,
    approvals,
    driver: {} as PaneDriver,
    manager: { peek: () => [], get: () => null },
    now: () => 1000
  })
}

describe('FlowEngine.run — the strict run-time gate', () => {
  it('rejects an unrunnable flow (unreachable-from-trigger node) with a reason naming the cause, and starts no run', () => {
    const reg = stubRegistry()
    const draft = draftWithUnreachableNode('draft-1')
    const engine = engineFor([], reg)

    const result = engine.run(draft, { eventId: 'evt-1', payload: {} })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected ok:false')
    expect(result.error).toMatch(/can't run this flow/i)
    expect(result.error).toMatch(/unreachable/i)
    expect(result.error).toMatch(/orphan/)
    expect(engine.snapshots()).toEqual([])
  })

  it('runs a fully-valid flow: returns ok:true with a runId, and a snapshot exists', () => {
    const reg = stubRegistry()
    const flow = triggerOnlyFlow('valid-1', 'inbound')
    const engine = engineFor([], reg)

    const result = engine.run(flow, { eventId: 'evt-2', payload: { from: 'a@b.com' } })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok:true')
    expect(result.runId).toBeTruthy()
    expect(engine.getRun(result.runId)?.flowId).toBe('valid-1')
  })
})

describe('FlowEngine.start — trigger subscription only for runnable flows', () => {
  it('subscribes a valid flow but skips an unrunnable one, without throwing when the skipped trigger fires', () => {
    const reg = stubRegistry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const valid = triggerOnlyFlow('valid-2', 'inbound')
    const draft = draftWithUnreachableNode('draft-2')
    const engine = engineFor([valid, draft], reg)

    expect(() => engine.start()).not.toThrow()

    expect(reg.subscribed.has('email:inbound')).toBe(true)
    expect(reg.subscribed.has('email:other')).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/draft-2/)

    // Firing the never-subscribed channel is a no-op, not a throw, and starts no run.
    expect(() => reg.fire('email', 'other', {})).not.toThrow()
    expect(engine.snapshots()).toEqual([])

    // Firing the subscribed channel starts a real run.
    reg.fire('email', 'inbound', { eventId: 'evt-3', payload: {} })
    expect(engine.snapshots()).toHaveLength(1)

    warn.mockRestore()
  })
})
