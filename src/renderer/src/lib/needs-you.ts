import type { SessionInfo } from '../../../shared/types'

/**
 * Picks the pane the jump-to-attention key should land on: the first
 * needs-you session strictly after `activeId` in display order, wrapping —
 * so repeated presses cycle through every waiting pane, and the active pane
 * itself is returned only when it is the sole one waiting. `activeId` null
 * or unknown (e.g. pressed from the home overview) starts the scan from the
 * top of the order. Pure; returns null when nothing needs attention.
 */
export function nextNeedsYou(
  order: string[],
  sessions: SessionInfo[],
  activeId: string | null
): string | null {
  if (order.length === 0) return null
  const waiting = new Set(sessions.filter((s) => s.status === 'needs-you').map((s) => s.id))
  if (waiting.size === 0) return null
  const start = activeId === null ? -1 : order.indexOf(activeId)
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length]
    if (waiting.has(id)) return id
  }
  return null
}
