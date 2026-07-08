import type { SessionStatus } from './types'

export const WORKSPACE_MIN = 1
export const WORKSPACE_MAX = 9

/**
 * Workspaces 1–9 always exist (virtual, AeroSpace-style). Anything that is
 * not an integer in range — absent field in a pre-M3 sessions.json, a
 * hand-edited string, out-of-range number — lands on workspace 1 rather
 * than throwing: sessions.json is user-editable, validate at the boundary.
 */
export function clampWorkspace(raw: unknown): number {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= WORKSPACE_MIN &&
    raw <= WORKSPACE_MAX
    ? raw
    : WORKSPACE_MIN
}

/** Non-empty workspaces plus the current one, ascending — the sidebar list. */
export function visibleWorkspaces(sessions: { workspace: number }[], current: number): number[] {
  const set = new Set(sessions.map((s) => s.workspace))
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
