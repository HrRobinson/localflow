import { describe, it, expect } from 'vitest'
import { ConsoleEventBus } from '../../src/main/console-bus'
import type { ConsoleEventInput, ConsoleSource } from '../../src/shared/console'

function input(label: string, source: ConsoleSource = 'status'): ConsoleEventInput {
  return {
    source,
    environment: 1,
    label,
    detail:
      source === 'status'
        ? { source: 'status', kind: 'Stop', status: 'idle' }
        : { source: 'operator', action: label }
  }
}

describe('ConsoleEventBus', () => {
  it('assigns unique ids, a rising seq, and a timestamp on emit', () => {
    let now = 100
    const bus = new ConsoleEventBus({}, () => now)
    const a = bus.emit(input('a'))
    now = 200
    const b = bus.emit(input('b'))
    expect(a.id).not.toBe(b.id)
    expect(a.seq).toBeLessThan(b.seq)
    expect(a.ts).toBe(100)
    expect(b.ts).toBe(200)
  })

  it('snapshot merges every ring sorted by seq', () => {
    const bus = new ConsoleEventBus()
    bus.emit(input('s1', 'status'))
    bus.emit(input('n1', 'network'))
    bus.emit(input('s2', 'status'))
    expect(bus.snapshot().map((e) => e.label)).toEqual(['s1', 'n1', 's2'])
  })

  it('per-source caps evict only the flooded ring', () => {
    const bus = new ConsoleEventBus({ network: 2 })
    bus.emit(input('keep', 'status'))
    bus.emit(input('n1', 'network'))
    bus.emit(input('n2', 'network'))
    bus.emit(input('n3', 'network'))
    const labels = bus.snapshot().map((e) => e.label)
    expect(labels).toContain('keep')
    expect(labels.filter((l) => l.startsWith('n'))).toEqual(['n2', 'n3'])
  })

  it('fans out each emit to subscribers and unsubscribes cleanly', () => {
    const bus = new ConsoleEventBus()
    const seen: string[] = []
    const off = bus.subscribe((e) => seen.push(Array.isArray(e) ? 'batch' : e.label))
    bus.emit(input('a'))
    off()
    bus.emit(input('b'))
    expect(seen).toEqual(['a'])
  })

  it('a throwing subscriber does not break emit or starve others', () => {
    const bus = new ConsoleEventBus()
    const seen: string[] = []
    bus.subscribe(() => {
      throw new Error('bad tap')
    })
    bus.subscribe((e) => seen.push(Array.isArray(e) ? 'batch' : e.label))
    expect(() => bus.emit(input('a'))).not.toThrow()
    expect(seen).toEqual(['a'])
  })

  it('emitBatch appends all inputs and fans out once with the array', () => {
    const bus = new ConsoleEventBus()
    const shapes: number[] = []
    bus.subscribe((e) => shapes.push(Array.isArray(e) ? e.length : 1))
    const out = bus.emitBatch([input('a', 'network'), input('b', 'network'), input('c', 'network')])
    expect(out.map((e) => e.label)).toEqual(['a', 'b', 'c'])
    expect(bus.snapshot().map((e) => e.label)).toEqual(['a', 'b', 'c'])
    expect(shapes).toEqual([3])
  })

  it('emitBatch on an empty array does not fan out', () => {
    const bus = new ConsoleEventBus()
    let calls = 0
    bus.subscribe(() => (calls += 1))
    expect(bus.emitBatch([])).toEqual([])
    expect(calls).toBe(0)
  })
})
