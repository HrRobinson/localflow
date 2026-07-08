import type { SessionStatus } from './types'

export const ENVIRONMENT_MIN = 1
export const ENVIRONMENT_MAX = 9

/**
 * Environments 1–9 always exist (virtual, AeroSpace-style). Anything that is
 * not an integer in range — absent field in a pre-M3 sessions.json, a
 * hand-edited string, out-of-range number — lands on environment 1 rather
 * than throwing: sessions.json is user-editable, validate at the boundary.
 */
export function clampEnvironment(raw: unknown): number {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= ENVIRONMENT_MIN &&
    raw <= ENVIRONMENT_MAX
    ? raw
    : ENVIRONMENT_MIN
}

/** Non-empty environments plus the current one, ascending — the sidebar list. */
export function visibleEnvironments(
  sessions: { environment: number }[],
  current: number
): number[] {
  const set = new Set(sessions.map((s) => s.environment))
  set.add(current)
  return [...set].sort((a, b) => a - b)
}

// Worst wins: the rollup dot must surface the most attention-worthy state.
const STATUS_PRIORITY: SessionStatus[] = ['needs-you', 'working', 'running', 'idle', 'exited']

export function worstStatus(statuses: SessionStatus[]): SessionStatus {
  for (const status of STATUS_PRIORITY) {
    if (statuses.includes(status)) return status
  }
  return 'exited'
}
