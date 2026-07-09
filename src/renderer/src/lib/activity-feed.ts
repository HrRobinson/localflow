import { LIFECYCLE_KINDS, type ActivityEntry } from '../../../shared/types'

/**
 * Merge one pushed activity:event entry into the feed, mirroring main's
 * recordActivity: when a repeated hook event collapses main-side, main
 * re-pushes the UPDATED last ring row (count bumped, timestamp refreshed) —
 * entries carry no identity field, so the only way to recognize that push as
 * an update is that its kind+status equal the feed's current last row.
 * Lifecycle kinds never collapse main-side (two consecutive `moved` events
 * with unchanged status are two real history rows), so they always append.
 */
export function upsertActivity(entries: ActivityEntry[], incoming: ActivityEntry): ActivityEntry[] {
  const last = entries[entries.length - 1]
  if (
    last &&
    !LIFECYCLE_KINDS.has(incoming.kind) &&
    last.kind === incoming.kind &&
    last.status === incoming.status
  ) {
    return [...entries.slice(0, -1), incoming]
  }
  return [...entries, incoming]
}
