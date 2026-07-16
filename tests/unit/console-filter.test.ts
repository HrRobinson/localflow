import { describe, it, expect } from 'vitest'
import {
  visibleEvents,
  deriveConsoleScope,
  appendConsoleEvents,
  emptyConsoleRings,
  ringsFromSnapshot,
  mergeConsoleRings,
  type ConsoleFilter,
  type ConsoleScope,
  type ConsoleRings
} from '../../src/shared/console-filter'
import { CONSOLE_SOURCE_CAPS } from '../../src/shared/console'
import type { ConsoleEvent, ConsoleSource } from '../../src/shared/console'

let seq = 0
function ev(
  source: ConsoleSource,
  environment: number,
  label: string,
  sessionId?: string
): ConsoleEvent {
  const n = ++seq
  return {
    id: `e${n}`,
    seq: n,
    ts: n,
    source,
    environment,
    sessionId,
    label,
    detail: { source: 'operator', action: label } as ConsoleEvent['detail']
  }
}

const ALL = new Set<ConsoleSource>()
const everywhere: ConsoleScope = { kind: 'everywhere' }
function filter(over: Partial<ConsoleFilter> = {}): ConsoleFilter {
  return { sources: ALL, scope: everywhere, text: '', muted: new Set(), ...over }
}

describe('visibleEvents', () => {
  const events = [
    ev('status', 1, 'Stop idle', 'a'),
    ev('operator', 1, 'POST panes', undefined),
    ev('capture', 2, 'capture wp-1', undefined)
  ]

  it('empty source set means all sources', () => {
    expect(visibleEvents(events, filter()).length).toBe(3)
  })

  it('source chips OR-combine', () => {
    const f = filter({ sources: new Set<ConsoleSource>(['status', 'capture']) })
    expect(visibleEvents(events, f).map((e) => e.source)).toEqual(['status', 'capture'])
  })

  it('environment scope matches by environment', () => {
    const f = filter({ scope: { kind: 'environment', environment: 2 } })
    expect(visibleEvents(events, f).map((e) => e.label)).toEqual(['capture wp-1'])
  })

  it('session scope matches by sessionId', () => {
    const f = filter({ scope: { kind: 'session', sessionId: 'a' } })
    expect(visibleEvents(events, f).map((e) => e.label)).toEqual(['Stop idle'])
  })

  it('text is a case-insensitive substring over label', () => {
    expect(visibleEvents(events, filter({ text: 'PANES' })).map((e) => e.label)).toEqual([
      'POST panes'
    ])
  })

  it('source, scope, and text AND together', () => {
    const f = filter({
      sources: new Set<ConsoleSource>(['status']),
      scope: { kind: 'environment', environment: 1 },
      text: 'stop'
    })
    expect(visibleEvents(events, f).map((e) => e.label)).toEqual(['Stop idle'])
  })

  it('muted sources are hidden even when the source set is all', () => {
    const withNet = [...events, ev('network', 1, 'GET 200 · /x')]
    const f = filter({ muted: new Set<ConsoleSource>(['network']) })
    expect(visibleEvents(withNet, f).some((e) => e.source === 'network')).toBe(false)
    expect(visibleEvents(withNet, f).length).toBe(3)
  })
})

describe('deriveConsoleScope', () => {
  it('enlarged into a session yields session scope', () => {
    expect(
      deriveConsoleScope({
        view: 'environment',
        enlarged: { id: 's5', level: 'pane' },
        environment: 3
      })
    ).toEqual({ kind: 'session', sessionId: 's5' })
  })

  it('an environment grid yields environment scope', () => {
    expect(deriveConsoleScope({ view: 'environment', enlarged: null, environment: 3 })).toEqual({
      kind: 'environment',
      environment: 3
    })
  })

  it('home yields everywhere', () => {
    expect(deriveConsoleScope({ view: 'home', enlarged: null, environment: 1 })).toEqual({
      kind: 'everywhere'
    })
  })
})

describe('appendConsoleEvents (rings)', () => {
  it('is the direct regression test for M1: a network flood does not evict a quiet status row', () => {
    let rings = emptyConsoleRings()
    rings = appendConsoleEvents(rings, [ev('status', 1, 'quiet status row')])
    const flood = Array.from({ length: CONSOLE_SOURCE_CAPS.network + 200 }, (_, i) =>
      ev('network', 1, `n${i}`)
    )
    rings = appendConsoleEvents(rings, flood)
    const merged = mergeConsoleRings(rings)
    expect(merged.some((e) => e.label === 'quiet status row')).toBe(true)
    expect(rings.network.length).toBe(CONSOLE_SOURCE_CAPS.network)
  })

  it('caps each source ring independently, trimming to that source\'s own cap', () => {
    let rings = emptyConsoleRings()
    const caps = { status: 3, operator: 5, capture: 300, guard: 300, network: 2000 }
    const statusFlood = Array.from({ length: 10 }, (_, i) => ev('status', 1, `s${i}`))
    const operatorFlood = Array.from({ length: 10 }, (_, i) => ev('operator', 1, `o${i}`))
    rings = appendConsoleEvents(rings, [...statusFlood, ...operatorFlood], caps)
    expect(rings.status.length).toBe(3)
    expect(rings.status.map((e) => e.label)).toEqual(['s7', 's8', 's9'])
    expect(rings.operator.length).toBe(5)
    expect(rings.operator.map((e) => e.label)).toEqual(['o5', 'o6', 'o7', 'o8', 'o9'])
  })

  it('leaves a below-cap ring untrimmed', () => {
    let rings = emptyConsoleRings()
    rings = appendConsoleEvents(rings, [ev('status', 1, 'a')])
    rings = appendConsoleEvents(rings, [ev('status', 1, 'b')])
    expect(rings.status.map((e) => e.label)).toEqual(['a', 'b'])
  })

  it('an empty incoming batch is a no-op, returning the same rings reference', () => {
    const rings = emptyConsoleRings()
    const result = appendConsoleEvents(rings, [])
    expect(result).toBe(rings)
  })
})

describe('ringsFromSnapshot', () => {
  it('is the direct regression test for the snapshot-cap-bypass bug: trims a source that exceeds its cap', () => {
    const overflow = Array.from({ length: CONSOLE_SOURCE_CAPS.status + 50 }, (_, i) =>
      ev('status', 1, `s${i}`)
    )
    const rings = ringsFromSnapshot(overflow)
    expect(rings.status.length).toBe(CONSOLE_SOURCE_CAPS.status)
    expect(rings.status[rings.status.length - 1].label).toBe(
      `s${CONSOLE_SOURCE_CAPS.status + 49}`
    )
  })

  it("round-trips today's real shape with no rows dropped (snapshot at exactly the caps' sum, evenly distributed)", () => {
    seq = 0
    const snapshot: ConsoleEvent[] = []
    const sources: ConsoleSource[] = ['status', 'operator', 'capture', 'guard', 'network']
    for (const source of sources) {
      for (let i = 0; i < CONSOLE_SOURCE_CAPS[source]; i++) {
        snapshot.push(ev(source, 1, `${source}-${i}`))
      }
    }
    const rings = ringsFromSnapshot(snapshot)
    const total = Object.values(rings).reduce((sum: number, r) => sum + (r as ConsoleEvent[]).length, 0)
    expect(total).toBe(snapshot.length)
    for (const source of sources) {
      expect(rings[source].length).toBe(CONSOLE_SOURCE_CAPS[source])
    }
  })
})

describe('mergeConsoleRings', () => {
  it('flattens rings populated out of seq order into a single seq-sorted array', () => {
    let rings: ConsoleRings = emptyConsoleRings()
    rings = appendConsoleEvents(rings, [ev('network', 1, 'n1')])
    rings = appendConsoleEvents(rings, [ev('status', 1, 's1')])
    rings = appendConsoleEvents(rings, [ev('network', 1, 'n2')])
    const merged = mergeConsoleRings(rings)
    expect(merged.map((e) => e.seq)).toEqual([...merged.map((e) => e.seq)].sort((a, b) => a - b))
    expect(merged.map((e) => e.label)).toEqual(['n1', 's1', 'n2'])
  })
})
