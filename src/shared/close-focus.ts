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

/** What the enlarge staircase shows: a single pane ('pane') or a whole
 * group, staircased side by side ('session') — `id` is always a pane id,
 * even at the 'session' level, since it's just the anchor member the group
 * was entered through. */
export type Enlarged = { id: string; level: 'pane' | 'session' } | null

/**
 * Decides what the enlarge staircase should show after `goneId` disappears
 * (deleted, closed, or moved to another environment) from `panes`.
 *
 * Only matters when `cur` is currently anchored on `goneId`; anything else
 * (including `cur === null`) passes through unchanged.
 *
 * At the 'session' level, `enlarged.id` is just the anchor member of a
 * group — the staircase itself shows every member side by side. So losing
 * the anchor doesn't mean losing the view: if a same-group sibling is still
 * present in `panes`, the anchor is reassigned to it and 'session' level is
 * kept. Only when no sibling survives (solo pane, whole group gone, or
 * `cur.level` was already 'pane', which has no group-wide meaning to
 * preserve) does the view collapse to the grid (null).
 *
 * `panes` must be the snapshot to resolve `goneId`'s group from: the
 * pre-refresh list for delete/close (still holds `goneId`'s own record),
 * or the post-refresh list scoped to the current environment for a move
 * (which naturally omits `goneId` and every sibling that moved with it,
 * collapsing the view — see moveToEnvironment in App.tsx).
 */
export function nextEnlargedAfterGone(
  cur: Enlarged,
  goneId: string,
  panes: SessionInfo[]
): Enlarged {
  if (cur === null || cur.id !== goneId) return cur
  if (cur.level === 'session') {
    const byId = new Map(panes.map((p) => [p.id, p]))
    const goneGroupId = byId.get(goneId)?.groupId ?? null
    if (goneGroupId !== null) {
      const sibling = panes.find((p) => p.id !== goneId && p.groupId === goneGroupId)
      if (sibling) return { id: sibling.id, level: 'session' }
    }
  }
  return null
}
