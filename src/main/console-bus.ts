import type { ConsoleEvent, ConsoleEventInput } from '../shared/console'

const DEFAULT_CAP = 500

export class ConsoleEventBus {
  private ring: ConsoleEvent[] = []
  private subs = new Set<(e: ConsoleEvent) => void>()
  private seq = 0

  constructor(
    private readonly cap: number = DEFAULT_CAP,
    private readonly now: () => number = Date.now
  ) {}

  emit(input: ConsoleEventInput): ConsoleEvent {
    const event: ConsoleEvent = { ...input, id: `ce-${++this.seq}`, ts: this.now() }
    this.ring.push(event)
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap)
    for (const sub of this.subs) {
      try {
        sub(event)
      } catch (err) {
        console.error('console subscriber threw', err)
      }
    }
    return event
  }

  snapshot(): ConsoleEvent[] {
    return [...this.ring]
  }

  subscribe(cb: (e: ConsoleEvent) => void): () => void {
    this.subs.add(cb)
    return () => {
      this.subs.delete(cb)
    }
  }
}
