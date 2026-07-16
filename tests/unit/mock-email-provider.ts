/**
 * In-memory `EmailProvider` for the offline test substrate (design §10). No
 * network, no OAuth. The entire safety core (task-router, draft-gate, status
 * mapping) is driven against this. Its public `sends` / `drafts` arrays are the
 * observation points for the never-auto-send invariant tests.
 *
 * NOTE: this is a test util, not `src/` — the single-caller invariant test
 * (§10.1) deliberately excludes it when counting `.sendDraft(` callers.
 */

import type {
  AccountRef,
  DraftRef,
  EmailMessage,
  EmailProvider,
  EmailThread,
  EmailThreadRef,
  InboundHandler,
  MailboxCursor,
  MimeBody,
  SendResult,
  WatchHandle
} from '../../src/main/email/provider'

interface StoredDraft {
  readonly account: AccountRef
  readonly ref: DraftRef
  readonly body: MimeBody
}

export class MockEmailProvider implements EmailProvider {
  readonly id = 'gmail' as const

  /** Every message the mailbox has seen, in arrival order. */
  readonly inbox: EmailMessage[] = []
  /** Drafts created via `createReplyDraft` — NEVER sent by this call. */
  readonly drafts: StoredDraft[] = []
  /** The observation point: every send that actually happened. Stays empty
   *  until `sendDraft` is called (only draft-gate does that, on approval). */
  readonly sends: SendResult[] = []

  /** When set, `sendDraft` rejects with this — for the §9 send-failure test. */
  failSendWith: Error | null = null

  private readonly threads = new Map<string, EmailThread>()
  private readonly handlers = new Map<string, InboundHandler>()
  private seq = 0

  // --- AUTH: no token material, offline no-ops. ---
  async authorize(): Promise<void> {}
  async ensureFresh(): Promise<void> {}

  // --- READ / TRIAGE ---
  async listInbound(_account: AccountRef, cursor: MailboxCursor): Promise<readonly EmailMessage[]> {
    const after = Number(cursor.position) || 0
    return this.inbox.slice(after)
  }

  async getThread(_account: AccountRef, threadRef: EmailThreadRef): Promise<EmailThread> {
    const thread = this.threads.get(threadRef.threadId)
    if (!thread) {
      throw new Error(`mock: no thread ${threadRef.threadId}`)
    }
    return thread
  }

  // --- DRAFT (create only — this NEVER pushes to `sends`). ---
  async createReplyDraft(
    account: AccountRef,
    threadRef: EmailThreadRef,
    body: MimeBody
  ): Promise<DraftRef> {
    const ref: DraftRef = { draftId: `draft-${++this.seq}`, threadId: threadRef.threadId }
    this.drafts.push({ account, ref, body })
    return ref
  }

  // --- SEND (gated; the only writer of `sends`). ---
  async sendDraft(_account: AccountRef, draft: DraftRef): Promise<SendResult> {
    if (this.failSendWith) throw this.failSendWith
    const result: SendResult = {
      sentMessageId: `sent-${++this.seq}`,
      threadId: draft.threadId,
      sentAt: this.seq
    }
    this.sends.push(result)
    return result
  }

  // --- INBOUND lifecycle ---
  async startWatch(account: AccountRef, onInbound: InboundHandler): Promise<WatchHandle> {
    this.handlers.set(account.id, onInbound)
    return { account, watchId: `watch-${account.id}`, expiresAt: 7 }
  }

  async renewWatch(handle: WatchHandle): Promise<WatchHandle> {
    return { ...handle, expiresAt: handle.expiresAt + 7 }
  }

  async reconcile(account: AccountRef, cursor: MailboxCursor): Promise<readonly EmailMessage[]> {
    return this.listInbound(account, cursor)
  }

  // --- Test seams (not part of EmailProvider) ---

  /** Seed a full conversation so `getThread` can return it. */
  seedThread(thread: EmailThread): void {
    this.threads.set(thread.threadRef.threadId, thread)
  }

  /** Simulate an inbound arrival: record it and fire the account's watch. */
  async deliver(account: AccountRef, message: EmailMessage): Promise<void> {
    this.inbox.push(message)
    const handler = this.handlers.get(account.id)
    if (handler) await handler([message])
  }
}
