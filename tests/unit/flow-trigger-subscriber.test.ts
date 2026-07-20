import { describe, it, expect, vi } from 'vitest'
import {
  subscribeTriggers,
  coerceEvent,
  matchesFilter
} from '../../src/main/flow/trigger-subscriber'
import type { FlowGraph } from '../../src/shared/flows'
import type { IntegrationRegistry } from '../../src/shared/integrations'

function flow(over: Partial<FlowGraph> = {}): FlowGraph {
  return {
    id: 'f',
    name: 'f',
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

describe('coerceEvent', () => {
  it('reads a { eventId, payload } shape', () => {
    expect(coerceEvent({ eventId: 'evt-1', payload: { from: 'a@b.com' } })).toEqual({
      eventId: 'evt-1',
      payload: { from: 'a@b.com' }
    })
  })

  it('falls back to the whole event as payload and mints an id when absent', () => {
    const r = coerceEvent({ from: 'a@b.com' })
    expect(r.payload).toEqual({ from: 'a@b.com' })
    expect(typeof r.eventId).toBe('string')
  })
})

describe('matchesFilter', () => {
  it('passes when no filter is configured', () => {
    expect(matchesFilter({}, { label: 'support' })).toBe(true)
  })
  it('passes only when every filter field equals the payload', () => {
    expect(matchesFilter({ filter: { label: 'support' } }, { label: 'support' })).toBe(true)
    expect(matchesFilter({ filter: { label: 'support' } }, { label: 'sales' })).toBe(false)
  })
})

describe('subscribeTriggers', () => {
  it("subscribes each enabled flow's trigger node and starts a run on a matching event", () => {
    const handlers: Record<string, (e: unknown) => void> = {}
    const registry: IntegrationRegistry = {
      descriptors: () => [],
      get: () => undefined,
      invokeAction: async () => ({}),
      subscribe: (id, triggerId, handler) => {
        handlers[`${id}:${triggerId}`] = handler
        return () => {}
      }
    }
    const started: { flowId: string; eventId: string }[] = []
    subscribeTriggers(registry, [flow()], (f, ev) =>
      started.push({ flowId: f.id, eventId: ev.eventId })
    )
    handlers['email:inbound']({ eventId: 'e9', payload: { subject: 'hi' } })
    expect(started).toEqual([{ flowId: 'f', eventId: 'e9' }])
  })

  it('a filtered-out event starts no run', () => {
    const handlers: Record<string, (e: unknown) => void> = {}
    const registry: IntegrationRegistry = {
      descriptors: () => [],
      get: () => undefined,
      invokeAction: async () => ({}),
      subscribe: (id, triggerId, handler) => {
        handlers[`${id}:${triggerId}`] = handler
        return () => {}
      }
    }
    const onStart = vi.fn()
    const f = flow({
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'email',
          ref: 'inbound',
          config: { filter: { label: 'support' } },
          position: { x: 0, y: 0 }
        },
        { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } }
      ]
    })
    subscribeTriggers(registry, [f], onStart)
    handlers['email:inbound']({ payload: { label: 'sales' } })
    expect(onStart).not.toHaveBeenCalled()
    handlers['email:inbound']({ payload: { label: 'support' } })
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('returns an unsubscribe that tears down every subscription', () => {
    const unsub = vi.fn()
    const registry: IntegrationRegistry = {
      descriptors: () => [],
      get: () => undefined,
      invokeAction: async () => ({}),
      subscribe: () => unsub
    }
    const stop = subscribeTriggers(registry, [flow(), flow({ id: 'f2' })], () => {})
    stop()
    expect(unsub).toHaveBeenCalledTimes(2)
  })

  it('isolates a throwing connector to its own flow — other flows still subscribe (defense-in-depth)', () => {
    const subscribed: { integration: string; triggerId: string; handler: (e: unknown) => void }[] =
      []
    const unsubs: number[] = []
    const registry: IntegrationRegistry = {
      descriptors: () => [],
      get: () => undefined,
      invokeAction: async () => ({}),
      subscribe: (id, triggerId, handler) => {
        // A fake connector that throws — isolates loop-hardening from any real
        // connector's own bad-config behavior (e.g. Segment's own fix).
        if (triggerId === 'boom') throw new Error('boom connector: bad config')
        const index = subscribed.length
        subscribed.push({ integration: id, triggerId, handler })
        return () => unsubs.push(index)
      }
    }
    const good1 = flow({ id: 'good1' })
    const throwing = flow({
      id: 'throwing',
      nodes: [
        {
          id: 't',
          type: 'trigger',
          integration: 'stripe',
          ref: 'boom',
          config: {},
          position: { x: 0, y: 0 }
        },
        { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } }
      ]
    })
    const good2 = flow({ id: 'good2' })
    const started: string[] = []

    let stop: () => void = () => {}
    expect(() => {
      stop = subscribeTriggers(registry, [good1, throwing, good2], (f) => started.push(f.id))
    }).not.toThrow()

    // Both good flows subscribed despite the middle flow's connector throwing.
    expect(subscribed).toHaveLength(2)
    for (const s of subscribed) s.handler({ payload: {} })
    expect(started).toEqual(['good1', 'good2'])

    // The accumulated unsubs for the flows that DID subscribe are still returned.
    stop()
    expect(unsubs).toHaveLength(2)
  })
})
