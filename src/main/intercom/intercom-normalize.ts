import type { RawContact, RawConversation, RawConversationPart } from './intercom-api'
import type {
  IntercomAuthorType,
  IntercomContactContext,
  IntercomContactRole,
  IntercomConversationContext,
  IntercomConversationState,
  IntercomPriority,
  IntercomTriggerId,
  IntercomTriggerPayload
} from '../../shared/intercom'

/**
 * PURE normalization (spec §6.3, §10) — the correctness boundary the conditions
 * track depends on. A raw Intercom conversation/contact (or a raw webhook
 * notification's `data.item`) becomes the PINNED context/trigger shape. This is
 * where the join-key convention is enforced: `contactEmail` is LOWERCASED (so it
 * matches `shopify.searchOrders(email:)` / `stripe.getCustomer` exactly), statuses
 * become LOWERCASE enums (exact `eq`/`ne`), the last message is reduced to
 * PLAINTEXT (HTML stripped), tags become a lowercase string array, and unix
 * timestamps become ISO 8601. Never throws — a sparse/garbage object normalizes to
 * safe defaults so a malformed read never crashes a run (mirrors
 * `stripe-normalize.ts`).
 */

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Lowercase a string field (email / tag). Empty stays empty. */
function lower(v: unknown): string {
  return str(v).toLowerCase()
}

/** Intercom unix seconds → ISO 8601; absent/invalid → ''. */
function isoFromUnix(sec: unknown): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return ''
  return new Date(sec * 1000).toISOString()
}

/**
 * Strip HTML tags and decode the few entities Intercom emits, reducing a part's
 * `body` to plaintext so a condition/template reads clean text, never markup.
 */
export function htmlToPlaintext(html: unknown): string {
  const raw = str(html)
  if (raw.length === 0) return ''
  let text = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
  // Fixed-point tag strip: a single pass is bypassable because removing an inner
  // `<...>` can re-form an outer tag (e.g. `<scr<script>ipt>` → `<script>`), so
  // repeat until no `<...>` remains. Then drop any stray lone `<`/`>` left by
  // broken markup — the target is plaintext, so residual bracket chars are noise.
  let prev: string
  do {
    prev = text
    text = text.replace(/<[^>]*>/g, '')
  } while (text !== prev)
  text = text.replace(/[<>]/g, '')
  // Decode entities AFTER tag stripping, with `&amp;` LAST: decoding `&amp;`→`&`
  // first could turn `&amp;lt;` into `&lt;`→`<` (double-unescape). Decoding it
  // last means a decoded value can never be re-read as another entity. Literal
  // `<`/`>` produced here stay as text and are not re-stripped, so no tag can be
  // reopened.
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
  return text.replace(/[ \t]+\n/g, '\n').trim()
}

const STATES: Record<string, IntercomConversationState> = {
  open: 'open',
  closed: 'closed',
  snoozed: 'snoozed'
}

const PRIORITIES: Record<string, IntercomPriority> = {
  priority: 'priority',
  not_priority: 'not_priority'
}

const ROLES: Record<string, IntercomContactRole> = {
  user: 'user',
  lead: 'lead'
}

/** Map an Intercom author `type` to the pinned lowercase enum. Admin/bot stay;
 *  every human/contact type (user, lead, contact) collapses to 'user'. */
function authorType(v: unknown): IntercomAuthorType {
  const t = str(v)
  if (t === 'admin') return 'admin'
  if (t === 'bot') return 'bot'
  return 'user'
}

/** The latest conversation part (falls back to the source message). */
function lastPart(raw: RawConversation): RawConversationPart | undefined {
  const parts = raw.conversation_parts?.conversation_parts ?? []
  if (parts.length > 0) return parts[parts.length - 1]
  if (raw.source) return { body: raw.source.body, author: raw.source.author }
  return undefined
}

/** The primary contact (id + email) — the first listed contact, else the source
 *  author when they are a user/lead. */
function primaryContact(raw: RawConversation): { id: string; email: string } {
  const contacts = raw.contacts?.contacts ?? []
  const withEmail = contacts.find((c) => str(c?.email).length > 0)
  const chosen = withEmail ?? contacts[0]
  if (chosen && str(chosen.id).length > 0) {
    return { id: str(chosen.id), email: lower(chosen.email) }
  }
  const author = raw.source?.author
  if (author && (str(author.type) === 'user' || str(author.type) === 'lead')) {
    return { id: str(author.id), email: lower(author.email) }
  }
  return { id: '', email: '' }
}

export function normalizeConversation(raw: RawConversation): IntercomConversationContext {
  const part = lastPart(raw)
  const contact = primaryContact(raw)
  const tags = (raw.tags?.tags ?? []).map((t) => lower(t?.name)).filter((n) => n.length > 0)
  return {
    conversation: {
      id: str(raw.id),
      state: STATES[str(raw.state)] ?? 'open',
      read: raw.read === true,
      priority: PRIORITIES[str(raw.priority)] ?? 'not_priority',
      title: str(raw.title),
      contactId: contact.id,
      contactEmail: contact.email,
      lastMessageBody: htmlToPlaintext(part?.body),
      lastMessageAuthorType: authorType(part?.author?.type),
      tags,
      createdAt: isoFromUnix(raw.created_at),
      updatedAt: isoFromUnix(raw.updated_at)
    }
  }
}

export function normalizeContact(raw: RawContact): IntercomContactContext {
  return {
    contact: {
      id: str(raw.id),
      email: lower(raw.email),
      name: str(raw.name),
      role: ROLES[str(raw.role)] ?? 'user',
      createdAt: isoFromUnix(raw.created_at),
      lastSeenAt: isoFromUnix(raw.last_seen_at)
    }
  }
}

// ── Webhook notification → trigger payload (§6.1) ────────────────────────────

/**
 * Which pinned trigger id(s) a verified Intercom `topic` fires. Both are native
 * 1:1 topics; an unsupported topic fires nothing (§6.1).
 */
export function triggersForTopic(topic: string): IntercomTriggerId[] {
  switch (topic) {
    case 'conversation.user.replied':
      return ['conversation.replied']
    case 'conversation.user.created':
      return ['conversation.created']
    default:
      return []
  }
}

/**
 * Normalize a verified notification's `topic` + `data.item` (a conversation) into an
 * `IntercomTriggerPayload`, or `null` when the topic is unsupported or the item is
 * unusable (no conversation id) — so no run is ever seeded on an unexpected shape.
 * The payload carries the keys `getConversation`/`getContact` and the
 * cross-connector commerce reads need immediately (§6.1).
 */
export function notificationToPayload(
  topic: string,
  item: unknown,
  notificationId: string
): IntercomTriggerPayload | null {
  if (triggersForTopic(topic).length === 0) return null
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
  const raw = item as RawConversation
  const conversationId = str(raw.id)
  if (conversationId.length === 0) return null
  const contact = primaryContact(raw)
  return {
    conversationId,
    contactId: contact.id,
    contactEmail: contact.email,
    lastMessageBody: htmlToPlaintext(lastPart(raw)?.body),
    notificationId,
    topic
  }
}
