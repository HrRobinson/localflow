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
      //
      // Accepted risk: hook events are delivered as independent local curls,
      // with no ordering guarantee. A late PostToolUse landing after a
      // Notification could momentarily clear a real needs-you, and a late
      // PostToolUse landing after a Stop could re-flip idle back to working.
      // Low probability, and self-corrects on the next event; the
      // alternative — never clearing a mid-turn needs-you on PostToolUse —
      // is the bug this transition fixes. If this proves real in practice,
      // the hardening is a per-pane monotonic hook-sequence guard.
      return 'working'
    case 'Notification':
      return 'needs-you'
    case 'Stop':
      return 'idle'
  }
}
