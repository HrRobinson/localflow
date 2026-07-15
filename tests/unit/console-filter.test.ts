import { describe, it, expect } from 'vitest'
import {
  visibleEvents,
  deriveConsoleScope,
  appendConsoleEvents,
  RENDERER_EVENT_CAP,
  type ConsoleFilter,
  type ConsoleScope
} from '../../src/shared/console-filter'
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
  return { sources: ALL, scope: everywhere, text: '', ...over }
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

describe('appendConsoleEvents', () => {
  it('keeps only the last RENDERER_EVENT_CAP events', () => {
    const seed = Array.from({ length: RENDERER_EVENT_CAP }, (_, i) => ev('status', 1, `s${i}`))
    const result = appendConsoleEvents(seed, [ev('network', 1, 'newest')])
    expect(result.length).toBe(RENDERER_EVENT_CAP)
    expect(result[result.length - 1].label).toBe('newest')
    expect(result[0].label).toBe('s1')
  })

  it('leaves a below-cap array untrimmed', () => {
    const result = appendConsoleEvents([ev('status', 1, 'a')], [ev('status', 1, 'b')])
    expect(result.map((e) => e.label)).toEqual(['a', 'b'])
  })
})
