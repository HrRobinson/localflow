import type { ActivityEntry, SessionInfo } from '../../../shared/types'

/**
 * All human-facing activity copy lives here (one place to review/translate,
 * per the spec). Each function is pure; the two time helpers take an injected
 * `now` so they are trivially unit-testable and tick off the renderer's normal
 * re-render (the 1s session poll) without their own timers.
 */

/**
 * Plain-language copy for one entry — the view appends the relative time.
 * `count` is the number of consecutive identical hook events collapsed into
 * this entry (absent or 1 = no suffix; >1 appends " ×N", e.g. a chatty agent
 * re-emitting Notification while already needs-you).
 */
export function activityLine(kind: ActivityEntry['kind'], count?: number): string {
  const line = baseLine(kind)
  return count !== undefined && count > 1 ? `${line} ×${count}` : line
}

function baseLine(kind: ActivityEntry['kind']): string {
  switch (kind) {
    case 'created':
      return 'session created'
    case 'reopened':
      return 'session reopened'
    case 'closed':
      return 'you closed the terminal'
    case 'exited':
      return 'process exited'
    case 'moved':
      return 'moved to another environment'
    case 'UserPromptSubmit':
      return 'you sent a prompt'
    case 'Notification':
      return 'waiting for your approval'
    case 'PostToolUse':
      return 'a tool ran'
    case 'Stop':
      return 'turn finished'
  }
}

/** "just now" / "Ns ago" / "Nm ago" / "Nh ago" / "Nd ago". */
export function relativeTime(then: number, now: number): string {
  const s = Math.floor(Math.max(0, now - then) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Compact elapsed span "45s" / "12m" / "3h" / "2d" for the "waiting for N" copy. */
export function humanDuration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * The persistent header line so the page is glanceable without reading history.
 * needs-you shows how long the user has kept the agent waiting; the other
 * states get an honest one-liner.
 */
export function currentStateLine(session: SessionInfo, now: number): string {
  switch (session.status) {
    case 'needs-you':
      return typeof session.needsYouSince === 'number'
        ? `⏳ waiting for your approval for ${humanDuration(now - session.needsYouSince)}`
        : '⏳ waiting for your approval'
    case 'working':
      return '● working'
    case 'idle':
      return '✓ idle — last turn finished'
    case 'running':
      return '● running'
    case 'exited':
      return '○ exited'
  }
}
