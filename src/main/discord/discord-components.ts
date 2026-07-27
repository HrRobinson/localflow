import type { ApprovalRequest } from '../flow/types'
import type {
  DiscordApprovalDecision,
  DiscordInteractionPayload,
  DiscordMessagePayload
} from '../../shared/discord'

/**
 * PURE Discord message-component builders + inbound-payload parsing (spec §4.2,
 * §6.3) — the correctness boundary for the approval round-trip. Builders encode
 * the `lf:approve|deny:{runId}:{nodeId}` correlation in each button's
 * `custom_id` (§7.1); the parse turns a raw Discord interaction / message /
 * command payload into the pinned normalized shapes (§6.3). Everything here is a
 * pure function of its input: a malformed payload yields `null` — never a throw,
 * never a partial resolve (spec §12). The PEER of `slack-blocks.ts`.
 *
 * NO network, NO secret, NO mutable state. Guarded hardest by unit tests.
 */

// ── Correlation via the button custom_id (§7.1) ──────────────────────────────

export type ApprovalAction = 'approve' | 'deny'

/** The pending-map key: `"{runId}:{nodeId}"`. runId is a uuid (no colons), so a
 *  first-colon split round-trips even a colon-bearing nodeId. */
export function correlationKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`
}

/** Encode a button custom_id: `lf:approve:{runId}:{nodeId}` / `lf:deny:…`. A
 *  Discord custom_id allows 100 chars — a uuid runId + a nodeId fits amply. */
export function encodeCustomId(action: ApprovalAction, runId: string, nodeId: string): string {
  return `lf:${action}:${runId}:${nodeId}`
}

/** Decode an `lf:approve|deny:{runId}:{nodeId}` custom_id, or null. The runId is
 *  a colon-free uuid, so the FIRST four `:`-fields fix the action + runId and the
 *  remainder is the (possibly colon-bearing) nodeId. */
export function parseCustomId(
  customId: string
): { action: ApprovalAction; runId: string; nodeId: string } | null {
  const parts = customId.split(':')
  if (parts.length < 4) return null
  const [prefix, action, runId, ...rest] = parts
  if (prefix !== 'lf') return null
  if (action !== 'approve' && action !== 'deny') return null
  const nodeId = rest.join(':')
  if (!runId || !nodeId) return null
  return { action, runId, nodeId }
}

// ── Discord button styles (numeric, per the components spec) ─────────────────

const BUTTON_STYLE_SUCCESS = 3
const BUTTON_STYLE_DANGER = 4
const COMPONENT_ACTION_ROW = 1
const COMPONENT_BUTTON = 2

// ── Builders (pure) ──────────────────────────────────────────────────────────

/** The message shape the client posts (`content` + optional `embeds`/`components`). */
export interface DiscordMessageBody {
  content: string
  embeds?: unknown[]
  components?: unknown[]
}

/** The interactive approval message: prompt + peek embed + Approve/Deny buttons. */
export function buildApprovalMessage(req: ApprovalRequest): DiscordMessageBody {
  const peekLines = req.peek.filter((line) => typeof line === 'string' && line.length > 0)
  const embeds = peekLines.length > 0 ? [{ description: peekLines.join('\n') }] : undefined
  const body: DiscordMessageBody = {
    content: `**Approval needed**\n${req.prompt}`,
    components: [
      {
        type: COMPONENT_ACTION_ROW,
        components: [
          {
            type: COMPONENT_BUTTON,
            style: BUTTON_STYLE_SUCCESS,
            label: 'Approve',
            custom_id: encodeCustomId('approve', req.runId, req.nodeId)
          },
          {
            type: COMPONENT_BUTTON,
            style: BUTTON_STYLE_DANGER,
            label: 'Deny',
            custom_id: encodeCustomId('deny', req.runId, req.nodeId)
          }
        ]
      }
    ]
  }
  if (embeds) body.embeds = embeds
  return body
}

/** The resolved, button-less card the message is updated to (§7.2). */
export function buildResolvedMessage(
  req: ApprovalRequest,
  decidedBy: string,
  approved: boolean
): DiscordMessageBody {
  const verb = approved ? 'Approved' : 'Denied'
  const by = decidedBy ? ` by <@${decidedBy}>` : ''
  return { content: `**${verb}**${by}\n${req.prompt}`, components: [] }
}

/** The expired card (no tap before the timeout — §7.3). Button-less. */
export function buildExpiredMessage(req: ApprovalRequest): DiscordMessageBody {
  return { content: `**Expired — no response**\n${req.prompt}`, components: [] }
}

/** The "no longer active" card for an unknown/stale tap (§11). Button-less. */
export function buildStaleMessage(): DiscordMessageBody {
  return {
    content: 'This approval is no longer active (the run has ended or saiife restarted).',
    components: []
  }
}

/** A plain notification / send (`postMessage`). */
export function buildNotifyMessage(text: string, embeds?: unknown[]): DiscordMessageBody {
  return embeds ? { content: text, embeds } : { content: text }
}

// ── Parse (pure; null on malformed — never throws) ───────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

/** Interaction types (Discord). */
const INTERACTION_PING = 1
const INTERACTION_APPLICATION_COMMAND = 2
const INTERACTION_MESSAGE_COMPONENT = 3

/** The per-interaction callback ref (needed to ack + UPDATE_MESSAGE in one call). */
export interface InteractionRef {
  interactionId: string
  token: string
}

/** Best-effort `{ interactionId, token }` from a raw INTERACTION_CREATE, or null. */
export function interactionRef(raw: unknown): InteractionRef | null {
  if (!isObject(raw)) return null
  const interactionId = str(raw.id)
  const token = str(raw.token)
  if (!interactionId || !token) return null
  return { interactionId, token }
}

/** The channel + message id of the message a component interaction acted on
 *  (for the REST edit fallback path). Null when absent. */
export function messageRefFromInteraction(
  raw: unknown
): { channelId: string; messageId: string } | null {
  if (!isObject(raw)) return null
  const channelId = str(raw.channel_id)
  const messageId = isObject(raw.message) ? str(raw.message.id) : undefined
  if (!channelId || !messageId) return null
  return { channelId, messageId }
}

const memberUserId = (raw: Record<string, unknown>): string | undefined => {
  // Guild interactions carry the user under `member.user`; DMs under `user`.
  if (isObject(raw.member) && isObject(raw.member.user)) {
    const id = str(raw.member.user.id)
    if (id) return id
  }
  if (isObject(raw.user)) return str(raw.user.id)
  return undefined
}

/**
 * Parse a raw component INTERACTION_CREATE into a normalized approval decision
 * (§6.3). Returns null unless it carries a recognized `lf:approve|deny:…`
 * custom_id and a tapping user id.
 */
export function parseInteraction(raw: unknown): DiscordApprovalDecision | null {
  if (!isObject(raw)) return null
  if (raw.type !== INTERACTION_MESSAGE_COMPONENT) return null
  const data = isObject(raw.data) ? raw.data : undefined
  const customId = data ? str(data.custom_id) : undefined
  if (!customId) return null
  const decoded = parseCustomId(customId)
  if (!decoded) return null
  const decidedBy = memberUserId(raw)
  if (!decidedBy) return null
  return {
    runId: decoded.runId,
    nodeId: decoded.nodeId,
    approved: decoded.action === 'approve',
    decidedBy
  }
}

/**
 * Parse a raw MESSAGE_CREATE into the pinned `DiscordMessagePayload` (§6.3).
 * Bot-authored messages (`author.bot`) are dropped — only a plain user message
 * wakes a flow. `text` is empty without the Message Content intent (§2.3). Null
 * on anything malformed.
 */
export function parseMessageEvent(raw: unknown): DiscordMessagePayload | null {
  if (!isObject(raw)) return null
  const author = isObject(raw.author) ? raw.author : undefined
  if (!author) return null
  if (author.bot === true) return null // ignore bot echoes.
  const channelId = str(raw.channel_id)
  const userId = str(author.id)
  const messageId = str(raw.id)
  if (!channelId || !userId || !messageId) return null
  const text = typeof raw.content === 'string' ? raw.content : ''
  const payload: DiscordMessagePayload = { channelId, userId, text, messageId }
  const guildId = str(raw.guild_id)
  if (guildId) payload.guildId = guildId
  // A thread is a channel; Discord carries the parent id when a message is in one.
  return payload
}

/**
 * Parse a raw INTERACTION_CREATE into the pinned `DiscordInteractionPayload`
 * (§6.3) — the generic `interaction` trigger. PING (type 1) and approval
 * components are handled elsewhere; this normalizes application commands and
 * user-defined components. Null on malformed.
 */
export function parseInteractionEvent(raw: unknown): DiscordInteractionPayload | null {
  if (!isObject(raw)) return null
  if (raw.type === INTERACTION_PING) return null
  if (typeof raw.type !== 'number') return null
  const interactionId = str(raw.id)
  const token = str(raw.token)
  const channelId = str(raw.channel_id)
  const userId = memberUserId(raw)
  if (!interactionId || !token || !channelId || !userId) return null
  const payload: DiscordInteractionPayload = {
    interactionId,
    token,
    type: raw.type,
    channelId,
    userId
  }
  const data = isObject(raw.data) ? raw.data : undefined
  if (data) {
    const name = str(data.name)
    if (name) payload.name = name
    const customId = str(data.custom_id)
    if (customId) payload.customId = customId
  }
  return payload
}

/** The normalized `/saiife` command payload the control bridge consumes. */
export interface DiscordCommandPayload {
  /** the command name WITHOUT the leading slash, e.g. "saiife". */
  name: string
  /** the joined args after the subcommand chain / options. */
  text: string
  channelId: string
  userId: string
  interactionId: string
  token: string
}

/**
 * Parse an application-command INTERACTION_CREATE (type 2) into a normalized
 * command payload. Reads the command `name` and flattens option values into a
 * space-joined `text` (mirroring Slack's `command`/`text` split). Null on
 * malformed or a non-command interaction.
 */
export function parseCommand(raw: unknown): DiscordCommandPayload | null {
  if (!isObject(raw)) return null
  if (raw.type !== INTERACTION_APPLICATION_COMMAND) return null
  const data = isObject(raw.data) ? raw.data : undefined
  const name = data ? str(data.name) : undefined
  const interactionId = str(raw.id)
  const token = str(raw.token)
  const channelId = str(raw.channel_id)
  const userId = memberUserId(raw)
  if (!name || !interactionId || !token || !channelId || !userId) return null
  return {
    name,
    text: flattenOptions(data?.options),
    channelId,
    userId,
    interactionId,
    token
  }
}

/** Flatten command options (incl. one subcommand level) into a space-joined arg
 *  string — e.g. `run refund-worker`, `status`, `stop run-5`. */
function flattenOptions(options: unknown): string {
  if (!Array.isArray(options)) return ''
  const parts: string[] = []
  for (const opt of options) {
    if (!isObject(opt)) continue
    const name = str(opt.name)
    // A subcommand carries a nested options array; a plain option carries a value.
    if (Array.isArray(opt.options)) {
      if (name) parts.push(name)
      const nested = flattenOptions(opt.options)
      if (nested) parts.push(nested)
    } else if (opt.value !== undefined && opt.value !== null) {
      parts.push(String(opt.value))
    } else if (name) {
      parts.push(name)
    }
  }
  return parts.join(' ')
}
