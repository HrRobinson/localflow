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
    case 'Notification':
      return 'needs-you'
    case 'Stop':
      return 'idle'
  }
}
