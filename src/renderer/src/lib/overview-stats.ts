import type { SessionInfo, SessionStatus } from '../../../shared/types'

export interface StatSegment {
  status: SessionStatus
  label: string
  count: number
}

export interface OverviewStats {
  /** Non-zero counts in a fixed, glanceable order. */
  segments: StatSegment[]
  /** Longest current wait (ms) from needsYouSince, or null when nobody waits. */
  oldestWaitMs: number | null
}

// Fixed display order + the compact label per status. `running` sits between
// needs-you and done; when there are none it simply drops out, reproducing the
// canonical "N working · N needs you · N done · N off" form from the spec.
const ORDER: { status: SessionStatus; label: string }[] = [
  { status: 'working', label: 'working' },
  { status: 'needs-you', label: 'needs you' },
  { status: 'running', label: 'running' },
  { status: 'idle', label: 'done' },
  { status: 'exited', label: 'off' }
]

/** Pure derivation for the Overview stats strip. Numbers only — no charts. */
export function deriveOverviewStats(sessions: SessionInfo[], now: number): OverviewStats {
  const counts = new Map<SessionStatus, number>()
  let oldest: number | null = null
  for (const session of sessions) {
    counts.set(session.status, (counts.get(session.status) ?? 0) + 1)
    if (session.status === 'needs-you' && typeof session.needsYouSince === 'number') {
      oldest = oldest === null ? session.needsYouSince : Math.min(oldest, session.needsYouSince)
    }
  }
  const segments = ORDER.filter(({ status }) => (counts.get(status) ?? 0) > 0).map(
    ({ status, label }) => ({ status, label, count: counts.get(status) ?? 0 })
  )
  return { segments, oldestWaitMs: oldest === null ? null : Math.max(0, now - oldest) }
}
