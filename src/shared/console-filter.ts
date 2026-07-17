import { CONSOLE_SOURCE_CAPS } from './console'
import type { ConsoleEvent, ConsoleSource } from './console'

export type ConsoleScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'environment'; environment: number }
  | { kind: 'everywhere' }

export interface ConsoleFilter {
  sources: Set<ConsoleSource> // empty = all sources
  muted: Set<ConsoleSource> // display-only exclusion (still in the bus)
  scope: ConsoleScope
  text: string
}

export function visibleEvents(events: ConsoleEvent[], f: ConsoleFilter): ConsoleEvent[] {
  const text = f.text.trim().toLowerCase()
  return events.filter((e) => {
    if (f.muted.has(e.source)) return false
    if (f.sources.size > 0 && !f.sources.has(e.source)) return false
    if (!matchesScope(e, f.scope)) return false
    if (text && !e.label.toLowerCase().includes(text)) return false
    return true
  })
}

function matchesScope(e: ConsoleEvent, scope: ConsoleScope): boolean {
  switch (scope.kind) {
    case 'everywhere':
      return true
    case 'environment':
      return e.environment === scope.environment
    case 'session':
      return e.sessionId === scope.sessionId
  }
}

export interface ConsoleFocus {
  view:
    | 'home'
    | 'environment'
    | 'settings'
    | 'changes'
    | 'activity'
    | 'cockpit'
    | 'integrations'
    | 'flows'
  enlarged: { id: string; level: 'pane' | 'session' } | null
  environment: number
}

/** Pure derivation of the auto scope from the current M5 focus. */
export function deriveConsoleScope(focus: ConsoleFocus): ConsoleScope {
  if (focus.enlarged) return { kind: 'session', sessionId: focus.enlarged.id }
  if (focus.view === 'environment') return { kind: 'environment', environment: focus.environment }
  return { kind: 'everywhere' }
}

export type ConsoleRings = Record<ConsoleSource, ConsoleEvent[]>

export function emptyConsoleRings(): ConsoleRings {
  return { status: [], operator: [], capture: [], guard: [], network: [] }
}

/** Renderer live-append: bucket incoming events by source, trim each
 *  touched ring to its own cap. Replaces the flat appendConsoleEvents. */
export function appendConsoleEvents(
  prev: ConsoleRings,
  incoming: ConsoleEvent[],
  caps: Record<ConsoleSource, number> = CONSOLE_SOURCE_CAPS
): ConsoleRings {
  if (incoming.length === 0) return prev
  const next = { ...prev }
  const touched = new Set<ConsoleSource>()
  for (const e of incoming) {
    if (!touched.has(e.source)) {
      next[e.source] = [...next[e.source]]
      touched.add(e.source)
    }
    next[e.source].push(e)
  }
  for (const source of touched) {
    const cap = caps[source]
    const ring = next[source]
    if (ring.length > cap) next[source] = ring.slice(ring.length - cap)
  }
  return next
}

/** Initial-snapshot ingestion: buckets a flat main-side snapshot by source
 *  and applies the SAME per-source caps, closing the snapshot-cap-bypass
 *  bug even if a future change ever lets main and renderer caps drift. */
export function ringsFromSnapshot(
  snapshot: ConsoleEvent[],
  caps: Record<ConsoleSource, number> = CONSOLE_SOURCE_CAPS
): ConsoleRings {
  return appendConsoleEvents(emptyConsoleRings(), snapshot, caps)
}

/** Flatten rings back into one seq-ordered array for filtering/rendering.
 *  Each ring is already seq-ordered internally (append-only), so this is a
 *  5-way merge — same asymptotic shape as the bus's own snapshot(), sized
 *  small enough (≤3600 rows) that a plain sort is fine here too. */
export function mergeConsoleRings(rings: ConsoleRings): ConsoleEvent[] {
  const all: ConsoleEvent[] = []
  for (const source of Object.keys(rings) as ConsoleSource[]) all.push(...rings[source])
  return all.sort((a, b) => a.seq - b.seq)
}
