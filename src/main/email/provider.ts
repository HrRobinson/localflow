/**
 * The email connector's provider abstraction (design §4.2). Pure types + the
 * `EmailProvider` interface — NO I/O, no network, no secret material. Importable
 * by the renderer for view types the way `src/shared/*` is.
 *
 * The load-bearing shape is the DELIBERATE split between `createReplyDraft`
 * (creates a draft, never sends) and `sendDraft` (a separate method, callable
 * only via `draft-gate.ts` — design §5). There is intentionally NO combined
 * compose-and-send verb on this interface: the never-auto-send guarantee is
 * structural, and a one-shot send verb would be a hole in it.
 */

/** Which wire provider backs a mailbox. Only 'gmail' is implemented in the MVP. */
export type EmailProviderId = 'gmail' | 'graph' | 'imap'

/**
 * A connected mailbox reference. `id` is the stable local id (also the keychain
 * key for its tokens — design §6); `address` is display-only and NOT a secret.
 * Carries no token material by construction.
 */
export interface AccountRef {
  readonly id: string
  readonly address: string
  readonly provider: EmailProviderId
}

/** A provider thread/conversation id — the key panes are routed by (§4.4). */
export interface EmailThreadRef {
  readonly threadId: string
}

/**
 * One inbound message, normalized across providers. Body is the plaintext the
 * agent reasons over; no attachments in the MVP. Carries no secret.
 */
export interface EmailMessage {
  readonly id: string
  readonly threadId: string
  readonly from: string
  readonly to: readonly string[]
  readonly cc?: readonly string[]
  readonly subject: string
  /** Plaintext body / snippet the agent reads. */
  readonly body: string
  /** Epoch ms the provider reports the message arrived. */
  readonly receivedAt: number
  readonly unread?: boolean
}

/** A full conversation, for the agent to reason over before drafting a reply. */
export interface EmailThread {
  readonly threadRef: EmailThreadRef
  readonly subject: string
  readonly messages: readonly EmailMessage[]
}

/**
 * The content of a reply the agent wants to draft — the RFC 2822 reply fields
 * a provider turns into a genuine draft. This is exactly what the human will
 * see in the approval peek (§4.6), so it holds the outbound text and nothing
 * secret.
 */
export interface MimeBody {
  readonly to: readonly string[]
  readonly cc?: readonly string[]
  readonly subject: string
  /** The plaintext reply body that will be sent. */
  readonly text: string
  /** RFC 2822 threading headers, when replying in-thread. */
  readonly inReplyTo?: string
  readonly references?: readonly string[]
}

/**
 * A handle to a created draft. Deliberately opaque: it references a draft the
 * app itself created, and is the ONLY thing `sendDraft` accepts — you cannot
 * send arbitrary pre-composed mail, only a draft that already exists (§5).
 */
export interface DraftRef {
  readonly draftId: string
  readonly threadId: string
}

/**
 * The result of a gated send. `sentMessageId` is the provider's id for the
 * message that actually went out; no content echoed back.
 */
export interface SendResult {
  readonly sentMessageId: string
  readonly threadId: string
  readonly sentAt: number
}

/**
 * An opaque provider position (Gmail `historyId`, Graph delta link, IMAP UID).
 * saiife never interprets it — it persists it (design §8) and echoes it back
 * to `listInbound` / `reconcile` so a restart resumes without missing mail.
 */
export interface MailboxCursor {
  readonly position: string
}

/** A live inbound watch/subscription, with its renewal deadline (§4.3). */
export interface WatchHandle {
  readonly account: AccountRef
  readonly watchId: string
  /** Epoch ms the watch expires; `renewWatch` must run before this (§9). */
  readonly expiresAt: number
}

/** Called by the inbound receiver with newly arrived messages (§4.3). */
export type InboundHandler = (messages: readonly EmailMessage[]) => void | Promise<void>

/**
 * The pluggable seam every provider (Gmail / Graph / IMAP) implements. The loop
 * (`task-router`, `draft-gate`, watch-receiver) is written once against this and
 * never branches on `id`. `sendDraft` being a named, isolated method is what
 * makes §5's structural guarantee auditable: exactly one caller in the codebase.
 */
export interface EmailProvider {
  readonly id: EmailProviderId

  // AUTH — returns nothing renderable; tokens flow through the keychain only (§6).
  authorize(account: AccountRef): Promise<void>
  ensureFresh(account: AccountRef): Promise<void>

  // READ / TRIAGE
  listInbound(account: AccountRef, cursor: MailboxCursor): Promise<readonly EmailMessage[]>
  getThread(account: AccountRef, threadRef: EmailThreadRef): Promise<EmailThread>

  // DRAFT (create only — CANNOT send).
  createReplyDraft(
    account: AccountRef,
    threadRef: EmailThreadRef,
    body: MimeBody
  ): Promise<DraftRef>

  // SEND — deliberately a SEPARATE method, callable only via draft-gate.ts (§5).
  sendDraft(account: AccountRef, draft: DraftRef): Promise<SendResult>

  // INBOUND TRIGGER lifecycle
  startWatch(account: AccountRef, onInbound: InboundHandler): Promise<WatchHandle>
  renewWatch(handle: WatchHandle): Promise<WatchHandle>
  reconcile(account: AccountRef, cursor: MailboxCursor): Promise<readonly EmailMessage[]>
}
