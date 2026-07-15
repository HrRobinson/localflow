import type { ConsoleEvent, ConsoleEventInput, ConsoleSource } from '../shared/console'

const DEFAULT_CAPS: Record<ConsoleSource, number> = {
  status: 500,
  operator: 500,
  capture: 300,
  guard: 300,
  network: 2000
}

type ConsoleSubscriber = (e: ConsoleEvent | ConsoleEvent[]) => void

export class ConsoleEventBus {
  private rings = new Map<ConsoleSource, ConsoleEvent[]>()
  private subs = new Set<ConsoleSubscriber>()
  private seq = 0
  private readonly caps: Record<ConsoleSource, number>

  constructor(
    caps: Partial<Record<ConsoleSource, number>> = {},
    private readonly now: () => number = Date.now
  ) {
    this.caps = { ...DEFAULT_CAPS, ...caps }
  }

  private append(input: ConsoleEventInput): ConsoleEvent {
    const seq = ++this.seq
    const event: ConsoleEvent = { ...input, id: `ce-${seq}`, seq, ts: this.now() }
    const ring = this.rings.get(event.source) ?? []
    ring.push(event)
    const cap = this.caps[event.source]
    if (ring.length > cap) ring.splice(0, ring.length - cap)
    this.rings.set(event.source, ring)
    return event
  }

  private fanOut(payload: ConsoleEvent | ConsoleEvent[]): void {
    for (const sub of this.subs) {
      try {
        sub(payload)
      } catch (err) {
        console.error('console subscriber threw', err)
      }
    }
  }

  emit(input: ConsoleEventInput): ConsoleEvent {
    const event = this.append(input)
    this.fanOut(event)
    return event
  }

  emitBatch(inputs: ConsoleEventInput[]): ConsoleEvent[] {
    const events = inputs.map((i) => this.append(i))
    if (events.length > 0) this.fanOut(events)
    return events
  }

  snapshot(): ConsoleEvent[] {
    const all: ConsoleEvent[] = []
    for (const ring of this.rings.values()) all.push(...ring)
    return all.sort((a, b) => a.seq - b.seq)
  }

  subscribe(cb: ConsoleSubscriber): () => void {
    this.subs.add(cb)
    return () => {
      this.subs.delete(cb)
    }
  }
}
