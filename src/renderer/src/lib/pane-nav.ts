export interface PaneRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export type Direction = 'left' | 'down' | 'up' | 'right'

/**
 * Picks the best neighbor of `activeId` in direction `dir`, from a list of
 * pane rects (as harvested from `getBoundingClientRect()`). Candidates are
 * rects whose center lies strictly on the given side of the active rect's
 * center. Among candidates, the score is the distance along the primary axis
 * plus twice the offset on the orthogonal axis — this both picks the nearest
 * pane in the requested direction and prefers axis-aligned panes over ones
 * that are nominally closer but diagonally offset. Lowest score wins; no
 * candidates means null (e.g. at a grid edge, or an unknown activeId).
 */
export function pickNeighbor(rects: PaneRect[], activeId: string, dir: Direction): string | null {
  const active = rects.find((r) => r.id === activeId)
  if (!active) return null

  const centerOf = (r: PaneRect): { x: number; y: number } => ({
    x: r.x + r.w / 2,
    y: r.y + r.h / 2
  })
  const activeCenter = centerOf(active)

  let best: { id: string; score: number } | null = null
  for (const r of rects) {
    if (r.id === activeId) continue
    const c = centerOf(r)
    const dx = c.x - activeCenter.x
    const dy = c.y - activeCenter.y

    let primary: number
    let orthogonal: number
    switch (dir) {
      case 'left':
        if (!(dx < 0)) continue
        primary = -dx
        orthogonal = Math.abs(dy)
        break
      case 'right':
        if (!(dx > 0)) continue
        primary = dx
        orthogonal = Math.abs(dy)
        break
      case 'up':
        if (!(dy < 0)) continue
        primary = -dy
        orthogonal = Math.abs(dx)
        break
      case 'down':
        if (!(dy > 0)) continue
        primary = dy
        orthogonal = Math.abs(dx)
        break
    }

    const score = primary + 2 * orthogonal
    if (best === null || score < best.score) {
      best = { id: r.id, score }
    }
  }

  return best?.id ?? null
}

/**
 * Swaps the positions of `a` and `b` in `order`, returning a new array.
 * Pure — never mutates `order`. If either id is not present, returns an
 * unchanged copy.
 */
export function swapInOrder(order: string[], a: string, b: string): string[] {
  const result = [...order]
  const ia = result.indexOf(a)
  const ib = result.indexOf(b)
  if (ia === -1 || ib === -1) return result
  ;[result[ia], result[ib]] = [result[ib], result[ia]]
  return result
}
