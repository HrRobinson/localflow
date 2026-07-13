import type { SessionInfo } from './types'

/**
 * Walks `order` and emits contiguous runs for the grid to render: each group
 * appears once, at the position of its FIRST member, pulling every other
 * member of that group adjacent (their relative order preserved); solo
 * (ungrouped) panes each emit their own `{ group: null, ids: [id] }` run.
 * Ids in `order` with no matching pane (already closed, e.g.) are skipped.
 */
export function groupedOrder(
  order: string[],
  panes: SessionInfo[]
): Array<{ group: string | null; ids: string[] }> {
  const byId = new Map(panes.map((p) => [p.id, p]))
  const runs: Array<{ group: string | null; ids: string[] }> = []
  const runByGroup = new Map<string, { group: string | null; ids: string[] }>()

  for (const id of order) {
    const pane = byId.get(id)
    if (!pane) continue
    const groupId = pane.groupId ?? null
    if (groupId === null) {
      runs.push({ group: null, ids: [id] })
      continue
    }
    const existing = runByGroup.get(groupId)
    if (existing) {
      existing.ids.push(id)
    } else {
      const run = { group: groupId, ids: [id] }
      runByGroup.set(groupId, run)
      runs.push(run)
    }
  }
  return runs
}
