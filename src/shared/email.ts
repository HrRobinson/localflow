/**
 * Shared view/DTO types for the email connector (design §4.1) — analogous to
 * `src/shared/operator.ts`. No I/O; used by both main and renderer. Nothing
 * here is a secret: the draft peek is the outbound text a human is about to
 * approve, and the mailbox status proves connection state, never token value.
 */

import type { EmailProviderId, MimeBody } from '../main/email/provider'

/**
 * What the approval gate's peek renders for an email-task pane (§4.6). Instead
 * of the pty tail (`extractPeekLines`), an email pane's peek is the DRAFT BODY
 * that will be sent — the human reads exactly what goes out before approving.
 * Subject + To/Cc + the reply text; no secret, no message id.
 */
export interface DraftPeek {
  readonly subject: string
  readonly to: readonly string[]
  readonly cc?: readonly string[]
  /** The plaintext reply body that will be sent on approval. */
  readonly body: string
}

/**
 * A connected mailbox as surfaced to the renderer. Proves state (connected,
 * watch expiry, last cursor) — never carries a token, prefix, or hash (§6).
 */
export interface MailboxStatus {
  readonly accountId: string
  /** Display-only address; not a secret. */
  readonly address: string
  readonly provider: EmailProviderId
  readonly connected: boolean
  /** Epoch ms the inbound watch expires, when one is live (§4.3). */
  readonly watchExpiresAt?: number
  /** Opaque last-processed cursor position, echoed for display only. */
  readonly lastCursor?: string
}

/**
 * Derive the approval peek from the draft content the app itself created. Pure:
 * the peek is exactly the `MimeBody` the agent drafted, so a human approves the
 * literal outbound text (§4.6) with no re-fetch and no pty tail.
 */
export function draftPeekFromMime(body: MimeBody): DraftPeek {
  return {
    subject: body.subject,
    to: body.to,
    ...(body.cc !== undefined ? { cc: body.cc } : {}),
    body: body.text
  }
}
