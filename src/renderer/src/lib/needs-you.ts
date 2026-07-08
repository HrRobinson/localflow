import type { SessionInfo } from '../../../shared/types'

/**
 * Picks the pane the jump-to-attention key should land on. Candidates are
 * every needs-you session, ordered: current-environment panes first (in
 * display order), then panes on other environments (in display order) —
 * attention outranks environment boundaries, but nearby panes win ties.
 * The result is the candidate strictly after `activeId` in that combined
 * ring, wrapping — so repeated presses cycle through every waiting pane
 * everywhere. `activeId` null or unknown starts from the ring's top.
 * Pure; returns null when nothing needs attention.
 */
export function nextNeedsYou(
  order: string[],
  sessions: SessionInfo[],
  activeId: string | null,
  currentEnvironment: number
): string | null {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const waiting = order.filter((id) => byId.get(id)?.status === 'needs-you')
  if (waiting.length === 0) return null
  const ring = [
    ...waiting.filter((id) => byId.get(id)!.environment === currentEnvironment),
    ...waiting.filter((id) => byId.get(id)!.environment !== currentEnvironment)
  ]
  const start = activeId === null ? -1 : ring.indexOf(activeId)
  return ring[(start + 1) % ring.length] ?? null
}
