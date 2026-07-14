import { describe, it, expect } from 'vitest'
import { ConsoleEventBus } from '../../src/main/console-bus'
import type { ConsoleEventInput } from '../../src/shared/console'

function input(label: string): ConsoleEventInput {
  return { source: 'status', environment: 1, label, detail: { source: 'status', kind: 'Stop', status: 'idle' } }
}

describe('ConsoleEventBus', () => {
  it('assigns unique ids and a timestamp on emit', () => {
    let now = 100
    const bus = new ConsoleEventBus(500, () => now)
    const a = bus.emit(input('a'))
    now = 200
    const b = bus.emit(input('b'))
    expect(a.id).not.toBe(b.id)
    expect(a.ts).toBe(100)
    expect(b.ts).toBe(200)
  })

  it('snapshot returns oldest-to-newest', () => {
    const bus = new ConsoleEventBus()
    bus.emit(input('first'))
    bus.emit(input('second'))
    expect(bus.snapshot().map((e) => e.label)).toEqual(['first', 'second'])
  })

  it('evicts oldest beyond the cap', () => {
    const bus = new ConsoleEventBus(2)
    bus.emit(input('a'))
    bus.emit(input('b'))
    bus.emit(input('c'))
    expect(bus.snapshot().map((e) => e.label)).toEqual(['b', 'c'])
  })

  it('fans out each emit to subscribers and unsubscribes cleanly', () => {
    const bus = new ConsoleEventBus()
    const seen: string[] = []
    const off = bus.subscribe((e) => seen.push(e.label))
    bus.emit(input('a'))
    off()
    bus.emit(input('b'))
    expect(seen).toEqual(['a'])
  })
})
