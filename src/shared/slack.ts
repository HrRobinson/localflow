/**
 * Shared Slack connector vocabulary + normalized payload shapes (spec §6.3) —
 * the pinned ids the canvas palette and any flow-templates track read verbatim,
 * and the stable, already-normalized shapes an inbound Slack event writes to run
 * context. Imported by main (connector / blocks / approval port) and any
 * renderer palette surface.
 *
 * NO raw Slack API shape lives here — those are isolated in
 * `src/main/slack/slack-client.ts` (the API blast radius, §4.1) and the raw
 * envelope parsing in `src/main/slack/slack-blocks.ts`. This file holds ONLY
 * localflow-facing vocabulary: the pinned trigger/action ids and the normalized
 * message / slash / approval-decision shapes.
 */

// ── Pinned Slack vocabulary ids (§6 — the templates track consumes these) ────

/** Trigger ids (§6.1) — carried over Socket Mode or the Events path alike. */
export const SLACK_TRIGGER_IDS = [
  'message.received',
  'slash.command',
  'approval.responded'
] as const
export type SlackTriggerId = (typeof SLACK_TRIGGER_IDS)[number]

/** Action ids (§6.2) — every send is an `action` node the author may gate. */
export const SLACK_ACTION_IDS = ['postMessage', 'postApproval', 'replyInThread'] as const
export type SlackActionId = (typeof SLACK_ACTION_IDS)[number]

// ── Normalized payload / context shapes (§6.3 — PINNED) ──────────────────────

/** `message.received` trigger payload (normalized from a Slack message event). */
export interface SlackMessagePayload {
  /** channel id, e.g. "C0123". */
  channel: string
  /** author user id, e.g. "U0123". */
  user: string
  /** message text (mentions resolved to <@id> as Slack sends). */
  text: string
  /** message timestamp id (also the thread root if replied). */
  ts: string
  /** present when the message is in a thread. */
  threadTs?: string
}

/** `slash.command` trigger payload (non-/localflow commands). */
export interface SlackSlashPayload {
  /** e.g. "/deploy". */
  command: string
  /** the args after the command. */
  text: string
  channel: string
  user: string
  /** Slack response_url for a delayed reply (short-lived). */
  responseUrl: string
}

/** `approval.responded` trigger payload + the ApprovalPort's internal decision. */
export interface SlackApprovalDecision {
  runId: string
  nodeId: string
  approved: boolean
  /** the Slack user id who tapped. */
  decidedBy: string
}

// ── Action param / result shapes (what a flow node passes / gets back) ───────

/** `postMessage` / `replyInThread` result written to context (§6.2). */
export interface SlackMessageResult {
  channel: string
  ts: string
}

/** `postApproval` result written to context (§6.2). */
export interface SlackApprovalResult {
  approved: boolean
  decidedBy?: string
}
