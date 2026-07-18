// Pure decision logic behind Settings.tsx's typed-path "Use path" flow,
// split out into a plain .ts module (no JSX) so it can be imported from
// tests/unit, which type-checks under tsconfig.node.json (no --jsx flag)
// rather than tsconfig.web.json — same posture as globalErrorLogic.ts.
import type { AgentInfo, AgentPathTypedResult } from '../../../shared/types'

/**
 * What the "Use path" click should do to Settings' state, given main's
 * `agents:setPathTyped` result. Centralizing this (instead of branching
 * inline in the click handler) is what makes the rejection path testable —
 * and what previously let a rejection fall through as a silent no-op: the
 * old handler only had an `if (updated) {...}` branch and nothing for the
 * `null`/rejected case, so a value the renderer's looser pre-check accepted
 * but main's authoritative check rejected (e.g. `~otheruser/proj`, a typo)
 * left the button enabled and nothing on screen explaining why.
 */
export interface TypedPathApplyResult {
  /** New agent list to render, or null to leave the current one untouched. */
  agents: AgentInfo[] | null
  /** Inline error to show next to the field, or null to clear any prior one. */
  error: string | null
  /** Whether the draft input should be cleared (only ever true on success —
   * a rejected draft stays in place so the user can fix it in place). */
  clearDraft: boolean
}

export function applyTypedPathResult(result: AgentPathTypedResult | null): TypedPathApplyResult {
  if (!result) {
    // main returned null: a malformed call (unknown/'custom' agentId, a
    // non-string path) — a caller bug, not something the user typed wrong.
    // Nothing to show or clear.
    return { agents: null, error: null, clearDraft: false }
  }
  if (result.ok) {
    return { agents: result.agents, error: null, clearDraft: true }
  }
  return { agents: null, error: result.reason, clearDraft: false }
}
