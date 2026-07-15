import type { ConsoleEvent } from './console'

export type ConsoleRowAction = 'rerun-watchpoint' | 'open-source'

export function rowActions(event: ConsoleEvent): ConsoleRowAction[] {
  if (event.source === 'capture') return ['rerun-watchpoint', 'open-source']
  return ['open-source']
}

export function missingWatchpointNotice(
  watchpoints: { id: string }[],
  watchpointId: string
): string | null {
  return watchpoints.some((w) => w.id === watchpointId)
    ? null
    : `watchpoint ${watchpointId} no longer exists`
}
