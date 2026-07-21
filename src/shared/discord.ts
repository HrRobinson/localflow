/**
 * Shared Discord connector vocabulary + normalized payload shapes (spec §6.3) —
 * the pinned ids the canvas palette and any flow-templates track read verbatim,
 * and the stable, already-normalized shapes an inbound Discord event writes to
 * run context. Imported by main (connector / components / approval port) and any
 * renderer palette surface. The PEER of `src/shared/slack.ts`.
 *
 * NO raw Discord API shape lives here — those are isolated in
 * `src/main/discord/discord-client.ts` (the API blast radius, §4.1) and the raw
 * gateway/interaction parsing in `src/main/discord/discord-components.ts`. This
 * file holds ONLY saiife-facing vocabulary: the pinned trigger/action ids and
 * the normalized message / interaction / approval-decision shapes.
 */

// ── Pinned Discord vocabulary ids (§6 — the templates track consumes these) ──

/** Trigger ids (§6.1) — carried over the Gateway or the HTTP Interactions path. */
export const DISCORD_TRIGGER_IDS = [
  'message.received',
  'interaction',
  'approval.responded'
] as const
export type DiscordTriggerId = (typeof DISCORD_TRIGGER_IDS)[number]

/** Action ids (§6.2) — every send is an `action` node the author may gate. */
export const DISCORD_ACTION_IDS = ['postMessage', 'postApproval', 'replyInThread'] as const
export type DiscordActionId = (typeof DISCORD_ACTION_IDS)[number]

// ── Normalized payload / context shapes (§6.3 — PINNED) ──────────────────────

/** `message.received` trigger payload (normalized from a Discord MESSAGE_CREATE).
 *  `text` is EMPTY without the Message Content privileged intent (§2.3, §13.3). */
export interface DiscordMessagePayload {
  /** channel snowflake. */
  channelId: string
  /** present for guild (server) messages. */
  guildId?: string
  /** author snowflake. */
  userId: string
  /** message content (EMPTY without the Message Content intent). */
  text: string
  /** message snowflake. */
  messageId: string
  /** present when posted in a thread. */
  threadId?: string
}

/** `interaction` trigger payload (non-/saiife, non-approval interactions). */
export interface DiscordInteractionPayload {
  interactionId: string
  /** per-interaction token for the callback (short-lived). */
  token: string
  /** 2 = application command, 3 = message component, … */
  type: number
  /** command name for an application-command interaction. */
  name?: string
  /** custom_id for a component interaction. */
  customId?: string
  channelId: string
  userId: string
}

/** `approval.responded` trigger payload + the ApprovalPort's internal decision. */
export interface DiscordApprovalDecision {
  runId: string
  nodeId: string
  approved: boolean
  /** the Discord user id who tapped. */
  decidedBy: string
}

// ── Action param / result shapes (what a flow node passes / gets back) ───────

/** `postMessage` / `replyInThread` result written to context (§6.2). */
export interface DiscordMessageResult {
  channelId: string
  messageId: string
}

/** `postApproval` result written to context (§6.2). */
export interface DiscordApprovalResult {
  approved: boolean
  decidedBy?: string
}
