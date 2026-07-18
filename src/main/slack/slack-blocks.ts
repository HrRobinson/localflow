import type { ApprovalRequest } from '../flow/types'
import type {
  SlackApprovalDecision,
  SlackMessagePayload,
  SlackSlashPayload
} from '../../shared/slack'

/**
 * PURE Block Kit builders + inbound-payload parsing (spec §4.2, §6.3) — the
 * correctness boundary for the approval round-trip. Builders encode the
 * `"{runId}:{nodeId}"` correlation key in each button's `value`; the parse turns
 * a raw Slack interaction / message / slash payload into the pinned normalized
 * shapes (§6.3). Everything here is a pure function of its input: a malformed
 * payload yields `null` — never a throw, never a partial resolve (spec §12).
 *
 * NO network, NO secret, NO mutable state. Guarded hardest by unit tests.
 */

// ── Correlation key (§7.1) ───────────────────────────────────────────────────

/** The pending-map key + button value: `"{runId}:{nodeId}"`. runId is a uuid
 *  (no colons), so a first-colon split round-trips even a colon-bearing nodeId. */
export function correlationKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`
}

/** Decode a `"{runId}:{nodeId}"` button value back to its parts, or null. */
export function decodeCorrelation(value: string): { runId: string; nodeId: string } | null {
  const idx = value.indexOf(':')
  if (idx <= 0 || idx >= value.length - 1) return null
  return { runId: value.slice(0, idx), nodeId: value.slice(idx + 1) }
}

// ── Action ids on the Approve / Deny buttons ─────────────────────────────────

export const APPROVE_ACTION_ID = 'localflow_approve'
export const DENY_ACTION_ID = 'localflow_deny'

// ── Builders (pure) ──────────────────────────────────────────────────────────

/** The interactive approval message: prompt + peek context + Approve/Deny. */
export function buildApprovalMessage(req: ApprovalRequest): {
  text: string
  blocks: unknown[]
} {
  const value = correlationKey(req.runId, req.nodeId)
  const peekBlocks = req.peek
    .filter((line) => typeof line === 'string' && line.length > 0)
    .map((line) => ({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: line }]
    }))
  return {
    text: `Approval needed: ${req.prompt}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Approval needed*\n${req.prompt}` } },
      ...peekBlocks,
      {
        type: 'actions',
        block_id: `approval:${value}`,
        elements: [
          {
            type: 'button',
            action_id: APPROVE_ACTION_ID,
            style: 'primary',
            text: { type: 'plain_text', text: 'Approve' },
            value
          },
          {
            type: 'button',
            action_id: DENY_ACTION_ID,
            style: 'danger',
            text: { type: 'plain_text', text: 'Deny' },
            value
          }
        ]
      }
    ]
  }
}

/** The resolved, button-less card the message is `chat.update`d to (§7.2). */
export function buildResolvedMessage(
  req: ApprovalRequest,
  decidedBy: string,
  approved: boolean
): { text: string; blocks: unknown[] } {
  const verb = approved ? 'Approved' : 'Denied'
  const by = decidedBy ? ` by <@${decidedBy}>` : ''
  return {
    text: `${verb}${by}: ${req.prompt}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${verb}*${by}\n${req.prompt}` } }
    ]
  }
}

/** The expired card (no tap before the timeout — §7.3). Button-less. */
export function buildExpiredMessage(req: ApprovalRequest): { text: string; blocks: unknown[] } {
  return {
    text: `Expired — no response: ${req.prompt}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Expired — no response*\n${req.prompt}` }
      }
    ]
  }
}

/** A plain notification / send (`postMessage`). */
export function buildNotifyMessage(text: string, blocks?: unknown[]): { text: string; blocks?: unknown[] } {
  return blocks ? { text, blocks } : { text }
}

// ── Parse (pure; null on malformed — never throws) ───────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/**
 * Parse a raw `block_actions` interaction payload into a normalized approval
 * decision (§6.3). Returns null unless it carries a recognized Approve/Deny
 * action whose `value` decodes to a `{runId, nodeId}` and a tapping user id.
 */
export function parseInteraction(raw: unknown): SlackApprovalDecision | null {
  if (!isObject(raw)) return null
  if (raw.type !== 'block_actions') return null
  const actions = raw.actions
  if (!Array.isArray(actions) || actions.length === 0) return null
  const action = actions.find(
    (a) => isObject(a) && (a.action_id === APPROVE_ACTION_ID || a.action_id === DENY_ACTION_ID)
  )
  if (!isObject(action)) return null
  const value = str(action.value)
  if (!value) return null
  const decoded = decodeCorrelation(value)
  if (!decoded) return null
  const decidedBy = isObject(raw.user) ? str(raw.user.id) : undefined
  if (!decidedBy) return null
  return {
    runId: decoded.runId,
    nodeId: decoded.nodeId,
    approved: action.action_id === APPROVE_ACTION_ID,
    decidedBy
  }
}

/**
 * Parse a raw Slack message event into the pinned `SlackMessagePayload` (§6.3).
 * Accepts either the bare `message` event object or the `event_callback`
 * wrapper. Bot-authored messages (`bot_id`) and message subtypes (edits, joins)
 * are dropped — only a plain user message wakes a flow. Null on anything else.
 */
export function parseMessageEvent(raw: unknown): SlackMessagePayload | null {
  if (!isObject(raw)) return null
  const event = isObject(raw.event) ? raw.event : raw
  if (event.type !== 'message') return null
  // Ignore bot echoes + non-plain subtypes (edits/joins) — they aren't inbound chat.
  if (event.bot_id !== undefined || event.subtype !== undefined) return null
  const channel = str(event.channel)
  const user = str(event.user)
  const ts = str(event.ts)
  if (!channel || !user || !ts) return null
  const text = typeof event.text === 'string' ? event.text : ''
  const payload: SlackMessagePayload = { channel, user, text, ts }
  const threadTs = str(event.thread_ts)
  if (threadTs) payload.threadTs = threadTs
  return payload
}

/** Parse a raw slash-command payload into the pinned `SlackSlashPayload` (§6.3). */
export function parseSlashCommand(raw: unknown): SlackSlashPayload | null {
  if (!isObject(raw)) return null
  const command = str(raw.command)
  const channel = str(raw.channel_id)
  const user = str(raw.user_id)
  const responseUrl = str(raw.response_url)
  if (!command || !channel || !user) return null
  return {
    command,
    text: typeof raw.text === 'string' ? raw.text : '',
    channel,
    user,
    responseUrl: responseUrl ?? ''
  }
}
