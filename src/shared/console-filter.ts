import type { ConsoleEvent, ConsoleSource } from './console'

export type ConsoleScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'environment'; environment: number }
  | { kind: 'everywhere' }

export interface ConsoleFilter {
  sources: Set<ConsoleSource> // empty = all sources
  scope: ConsoleScope
  text: string
}

export function visibleEvents(events: ConsoleEvent[], f: ConsoleFilter): ConsoleEvent[] {
  const text = f.text.trim().toLowerCase()
  return events.filter((e) => {
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
