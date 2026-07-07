/**
 * Reconciles a pane display order against the current set of session ids.
 * Ids already in `order` keep their relative position (stability matters:
 * panes must not jump around as unrelated sessions change). Ids present in
 * `ids` but missing from `order` are appended, in the order they appear in
 * `ids`. Ids no longer present in `ids` are dropped.
 */
export function reconcileOrder(order: string[], ids: string[]): string[] {
  const idSet = new Set(ids)
  const kept = order.filter((id) => idSet.has(id))
  const keptSet = new Set(kept)
  const added = ids.filter((id) => !keptSet.has(id))
  return [...kept, ...added]
}
