/**
 * Shared Linear-integration types (spec §4.2 last row, §7). Kept in `shared`
 * because both the main-process connector and any future renderer surface need
 * the same vocabulary. No secrets ever live in these shapes — the OAuth tokens
 * and the webhook signing secret stay in the keychain (spec §5); config.json
 * and these types carry only references and non-secret ids.
 */

/** The two `AgentSessionEvent` actions the MVP handles (spec §6.1). */
export type LinearSessionAction = 'created' | 'prompted'

/** A minimal reference to the Linear issue a session is working (spec §6.1). */
export interface LinearIssueRef {
  id: string
  identifier?: string
  title?: string
}

/**
 * The `AgentSession` carried on an inbound webhook. Field set tracks Linear's
 * Developer Preview and is validated at the receiver boundary — never trusted
 * by shape (spec §4.4).
 */
export interface LinearAgentSession {
  id: string
  state?: string
  issue?: LinearIssueRef
  /** Bootstrap context that seeds the pane's first prompt (spec §6.2). */
  promptContext?: string
}

/**
 * A verified inbound `AgentSessionEvent` (spec §6.1). Produced only after the
 * webhook receiver has HMAC-verified and JSON-parsed the raw body.
 */
export interface LinearSessionEvent {
  action: LinearSessionAction
  agentSession: LinearAgentSession
  /** For action 'prompted': the human's follow-up text, written into the pane. */
  prompt?: string
}

/** Kinds of `AgentActivity` localflow emits back to Linear (spec §4.5, §6.3). */
export type AgentActivityKind = 'thought' | 'action' | 'elicitation' | 'response' | 'error'

/**
 * A single `AgentActivity` to post to a session's thread — the sole status
 * channel (spec §6.3). `body` is Markdown. This is what `status-map.ts`
 * produces and `linear-client.ts` (deferred) will emit.
 */
export interface AgentActivityInput {
  kind: AgentActivityKind
  body: string
}

/**
 * The `AgentSession.state` an activity drives Linear into (spec §4.5). Tracked
 * locally as `lastEmittedState` so the connector emits `elicitation`/`response`/
 * `error` only on genuine transitions.
 */
export type LinearSessionState = 'pending' | 'active' | 'awaitingInput' | 'complete' | 'error'

/**
 * One entry in the connector's in-memory issue↔pane map (spec §7). Not
 * persisted — mirrors the operator grants being in-memory; on restart the map
 * is empty and in-flight sessions are reconciled (deferred). `lastEmittedState`
 * prevents duplicate emits; `lastActivityAt` drives the heartbeat debounce and
 * the `stale` reasoning.
 */
export interface LinearPaneLink {
  agentSessionId: string
  issueId: string
  /** A localflow session id. */
  paneId: string
  /** Environment 1-9 hosting this Linear work. */
  environment: number
  lastActivityAt: number
  lastEmittedState?: LinearSessionState
}
