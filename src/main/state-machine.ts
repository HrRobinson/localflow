import type { HookEventName, SessionStatus } from '../shared/types'

export function transition(
  current: SessionStatus,
  event: HookEventName | 'pty-exit'
): SessionStatus {
  if (current === 'exited') return 'exited'
  switch (event) {
    case 'pty-exit':
      return 'exited'
    case 'UserPromptSubmit':
      return 'working'
    case 'PostToolUse':
      // An approved tool actually executing = working again — clears a
      // mid-turn needs-you that Notification set. A pending tool (Notification,
      // not yet run) stays needs-you. Harmless (redundant) on auto-approved
      // tools, which already went working via UserPromptSubmit.
      return 'working'
    case 'Notification':
      return 'needs-you'
    case 'Stop':
      return 'idle'
  }
}
