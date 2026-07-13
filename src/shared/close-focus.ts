import type { SessionInfo } from './types'

/**
 * Chooses which pane should receive focus after `closedId` closes (pty
 * closed, pane still listed in `panes`) or is deleted (pane already gone
 * from `panes`, but `closedId` is still present in the `order` snapshot the
 * caller captured before removing it). Prefers the nearest pane — by
 * position in `order`, earlier index wins distance ties — sharing the
 * closed pane's `groupId` (when it has one and a sibling remains); else the
 * nearest pane in `order` overall; null when none remain.
 */
export function nextFocusAfterClose(
  closedId: string,
  order: string[],
  panes: SessionInfo[]
): string | null {
  const byId = new Map(panes.map((p) => [p.id, p]))
  const closedIdx = order.indexOf(closedId)
  const closedGroupId = byId.get(closedId)?.groupId ?? null

  const candidates = order
    .map((id, idx) => ({ id, idx }))
    .filter(({ id }) => id !== closedId && byId.has(id))

  const nearest = (pool: typeof candidates): string | null => {
    let best: { id: string; idx: number } | null = null
    let bestDistance = Infinity
    for (const cand of pool) {
      const distance = Math.abs(cand.idx - closedIdx)
      if (
        best === null ||
        distance < bestDistance ||
        (distance === bestDistance && cand.idx < best.idx)
      ) {
        best = cand
        bestDistance = distance
      }
    }
    return best?.id ?? null
  }

  if (closedGroupId !== null) {
    const siblings = candidates.filter((c) => byId.get(c.id)?.groupId === closedGroupId)
    const sibling = nearest(siblings)
    if (sibling) return sibling
  }
  return nearest(candidates)
}
