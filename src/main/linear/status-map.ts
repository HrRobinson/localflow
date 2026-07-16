import type { ActivityEntry, SessionStatus } from '../../shared/types'
import type { AgentActivityInput, LinearSessionState } from '../../shared/linear'

/**
 * Pure mapping from localflow's status feed to a Linear `AgentActivity`
 * (spec §4.5). Deliberately side-effect-free and clock-injected, mirroring
 * `state-machine.ts`'s purity so every mapping is exhaustively unit-testable
 * with no Linear workspace (spec §9).
 *
 * Two rate-limit rules the spec (§2, §4.5) requires are encoded here, not in
 * the connector:
 *  - `working` heartbeats are DEBOUNCED — at most one `thought` per
 *    `HEARTBEAT_INTERVAL_MS` while already `active`.
 *  - `elicitation` / `response` / `error` fire only on a genuine state
 *    TRANSITION — never re-emitted while the session already sits in the
 *    resulting `AgentSession.state`.
 *
 * A discrete activity entry that arrives while `working` maps to `action`
 * (a work step) rather than a heartbeat `thought`; entries are already
 * de-duplicated upstream (`recordActivity` bumps a `count`), so actions are
 * not time-debounced.
 */

/** Minimum ms between `working` heartbeat `thought`s (spec §4.5 "≤1/N sec"). */
export const HEARTBEAT_INTERVAL_MS = 15_000

export interface MapInput {
  status: SessionStatus
  /**
   * The activity entry that triggered this call, when driven by
   * `onActivity` rather than `onStatus`. Present ⇒ a discrete work step.
   */
  entry?: ActivityEntry
  /**
   * The pending question for a `needs-you` pane — the same text
   * `ApproveButton` shows (sourced from `manager.peek()`, spec §4.5). Used as
   * the `elicitation` body.
   */
  peekText?: string
  /**
   * The failure tail for an `exited` pane (the real instant-exit message from
   * `session-manager.ts`). Used verbatim as the `error` body so the human sees
   * the real underlying error, in Linear too (spec §8, error-message-style).
   */
  message?: string
}

export interface MapContext {
  /** Epoch ms; injected so tests are deterministic. */
  now: number
  /** The `AgentSession.state` we last emitted for this session, if any. */
  lastEmittedState?: LinearSessionState
  /** Epoch ms of the last activity we emitted for this session (debounce). */
  lastActivityAt?: number
  /** Override the heartbeat debounce window (tests / rate-limit tuning). */
  heartbeatIntervalMs?: number
}

export interface MapResult {
  activity: AgentActivityInput
  /** The resulting state — the caller stores this as `lastEmittedState`. */
  state: LinearSessionState
}

function heartbeat(prior: LinearSessionState | undefined): AgentActivityInput {
  if (prior === 'awaitingInput') return { kind: 'thought', body: 'Resuming work.' }
  if (prior === 'active') return { kind: 'thought', body: 'Still working…' }
  return { kind: 'thought', body: 'Working on it…' }
}

function describeStep(entry: ActivityEntry): string {
  const times = entry.count && entry.count > 1 ? ` (×${entry.count})` : ''
  return `\`${entry.kind}\`${times}`
}

/**
 * Translate one status/activity tick into the `AgentActivity` to emit, or
 * `null` when nothing should be emitted (debounced heartbeat, repeated
 * transition, or a status with no Linear mapping such as `running`).
 */
export function mapStatusToActivity(input: MapInput, ctx: MapContext): MapResult | null {
  const { status } = input

  switch (status) {
    case 'needs-you': {
      if (ctx.lastEmittedState === 'awaitingInput') return null
      const body = input.peekText?.trim() || 'This session needs your input to continue.'
      return { activity: { kind: 'elicitation', body }, state: 'awaitingInput' }
    }

    case 'idle': {
      if (ctx.lastEmittedState === 'complete') return null
      return { activity: { kind: 'response', body: 'Turn complete.' }, state: 'complete' }
    }

    case 'exited': {
      // Only a failure carries a message; a clean exit says nothing (the
      // idle→response path already closed the loop). No message ⇒ no emit.
      if (!input.message) return null
      if (ctx.lastEmittedState === 'error') return null
      return { activity: { kind: 'error', body: input.message }, state: 'error' }
    }

    case 'working': {
      // A discrete activity entry is a work step → `action`, not a heartbeat.
      if (input.entry) {
        return { activity: { kind: 'action', body: describeStep(input.entry) }, state: 'active' }
      }
      // Pure heartbeat: always emit on the transition into `active`; otherwise
      // debounce to at most one `thought` per interval.
      if (ctx.lastEmittedState === 'active') {
        const interval = ctx.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
        const since = ctx.now - (ctx.lastActivityAt ?? -Infinity)
        if (since < interval) return null
      }
      return { activity: heartbeat(ctx.lastEmittedState), state: 'active' }
    }

    // 'running' (browser panes) and any future status have no Linear mapping.
    default:
      return null
  }
}
