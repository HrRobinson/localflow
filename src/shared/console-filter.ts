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
  view: 'home' | 'environment' | 'settings' | 'changes' | 'activity' | 'cockpit'
  enlarged: { id: string; level: 'pane' | 'session' } | null
  environment: number
}

/** Pure derivation of the auto scope from the current M5 focus. */
export function deriveConsoleScope(focus: ConsoleFocus): ConsoleScope {
  if (focus.enlarged) return { kind: 'session', sessionId: focus.enlarged.id }
  if (focus.view === 'environment') return { kind: 'environment', environment: focus.environment }
  return { kind: 'everywhere' }
}

export const RENDERER_EVENT_CAP = 3000

/** Renderer live-append: concatenate a batch, keep only the last `cap` (P1.2). */
export function appendConsoleEvents(
  prev: ConsoleEvent[],
  incoming: ConsoleEvent[],
  cap = RENDERER_EVENT_CAP
): ConsoleEvent[] {
  const next = [...prev, ...incoming]
  return next.length > cap ? next.slice(next.length - cap) : next
}
