import type { ConsoleEvent } from './console'

export type ConsoleRowAction = 'rerun-watchpoint' | 'open-source'

export function rowActions(event: ConsoleEvent): ConsoleRowAction[] {
  if (event.source === 'capture') return ['rerun-watchpoint', 'open-source']
  return ['open-source']
}
