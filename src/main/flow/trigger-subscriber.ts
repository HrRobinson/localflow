import { randomUUID } from 'node:crypto'
import type { FlowGraph } from '../../shared/flows'
import type { IntegrationRegistry } from '../../shared/integrations'

/**
 * Wires each enabled flow's `trigger` node to the `IntegrationRegistry` trigger
 * stream: `registry.subscribe(node.integration, node.ref, handler)`. When a
 * matching event arrives, `onStart` is invoked to seed a run (design §3.1). A
 * trigger whose optional `config.filter` predicate doesn't match the event
 * simply starts NO run — that is the opt-in default (works with no flow
 * subscribing), not an error (§9). Returns a single unsubscribe that tears down
 * every subscription.
 */

/** The typed event the engine seeds a run from. `payload` is written to the
 *  trigger node's context slot; `eventId` becomes `RunSnapshot.triggerEventId`. */
export interface SeedEvent {
  eventId: string
  payload: Record<string, unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Normalizes the registry's `unknown` event into a `{ eventId, payload }`. A
 *  `{ payload }`-shaped event is read directly; otherwise the whole event is
 *  the payload. A missing id is minted so every run has a stable id. */
export function coerceEvent(event: unknown): SeedEvent {
  if (isObject(event)) {
    const payload = isObject(event.payload) ? event.payload : event
    const rawId = event.eventId ?? event.id
    const eventId = typeof rawId === 'string' && rawId.length > 0 ? rawId : randomUUID()
    return { eventId, payload }
  }
  return { eventId: randomUUID(), payload: {} }
}

/** A trigger node's `config.filter` (an object of field→value) all match the
 *  event payload. No filter ⇒ always matches. Deterministic value compare. */
export function matchesFilter(
  config: Record<string, unknown>,
  payload: Record<string, unknown>
): boolean {
  if (!isObject(config.filter)) return true
  return Object.entries(config.filter).every(([key, value]) => payload[key] === value)
}

export function subscribeTriggers(
  registry: IntegrationRegistry,
  flows: FlowGraph[],
  onStart: (flow: FlowGraph, event: SeedEvent) => void
): () => void {
  const unsubs: (() => void)[] = []
  for (const flow of flows) {
    const trigger = flow.nodes.find((n) => n.type === 'trigger')
    // A trigger node names its integration + trigger id (`ref`). `cloud` is
    // action-only (empty triggers[]) so it never appears here — nothing to do.
    if (!trigger || !trigger.integration || !trigger.ref) continue
    const unsub = registry.subscribe(trigger.integration, trigger.ref, (event) => {
      const seed = coerceEvent(event)
      if (!matchesFilter(trigger.config, seed.payload)) return
      onStart(flow, seed)
    })
    unsubs.push(unsub)
  }
  return () => {
    for (const u of unsubs) u()
  }
}
