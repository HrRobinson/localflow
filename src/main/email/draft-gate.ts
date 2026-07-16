/**
 * The send seam (design §5) — the load-bearing module of the never-auto-send
 * guarantee.
 *
 * This is the ONLY module in `src/` that calls a provider's `sendDraft`. An
 * agent, however it reasons or is jailbroken, has no path here: `approveAndSend`
 * is invoked solely from the human approval entrypoint (the "Send ⏎" confirm in
 * `ApproveButton`), never from an agent's pane, tool, or control-API route.
 *
 * Two structural properties this file must preserve:
 *   1. Exactly one provider send call site in the whole codebase lives here
 *      (asserted by the single-caller invariant test, §10.1). Do not add another
 *      caller anywhere in `src/`.
 *   2. The human-approval audit record is written BEFORE the send, so every send
 *      is traceable to a human action (§5.5). Mirrors the append-only, secret-
 *      free posture of `guard-audit-tail.ts`: ids + timestamp only — NO email
 *      content, NO token material.
 */

import type { AccountRef, DraftRef, EmailProvider, SendResult } from './provider'

/**
 * One recorded human-approval event. Deliberately minimal: which draft, which
 * mailbox, and when. NEVER the subject, body, recipients, or any token — the
 * record proves a human approved *a* send, not what was said (§5.5, §6).
 */
export interface ApprovalAuditRecord {
  readonly ts: number
  readonly draftId: string
  readonly mailboxId: string
}

export interface DraftGateDeps {
  /** Only the send capability is needed here — nothing else of the provider. */
  readonly provider: Pick<EmailProvider, 'sendDraft'>
  /**
   * Append-only sink for the approval record (e.g. an `approvals.jsonl` tail,
   * like `guard-audit.jsonl`). Called BEFORE the send.
   */
  readonly recordApproval: (record: ApprovalAuditRecord) => void
  /** Injectable clock (test seam); defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Serialize an approval record to one append-only audit line. Holds only ids +
 * timestamp — safe to persist and to scan for token-shaped material (there is
 * none by construction).
 */
export function formatApprovalAudit(record: ApprovalAuditRecord): string {
  return JSON.stringify({ ts: record.ts, draftId: record.draftId, mailboxId: record.mailboxId })
}

/**
 * The single, gated send entrypoint. Records the human-approval audit record,
 * then sends the already-created draft. Reachable ONLY from the approval IPC
 * handler.
 *
 * On failure the draft is preserved provider-side and nothing was sent; the
 * error is legible and actionable and carries the real underlying cause (§9) —
 * retrying re-sends the same `draftId`, which the provider dedupes, so an
 * approved send never double-sends.
 */
export async function approveAndSend(
  deps: DraftGateDeps,
  account: AccountRef,
  draft: DraftRef
): Promise<SendResult> {
  const ts = (deps.now ?? Date.now)()
  // Record the approval BEFORE sending — the send must be traceable to it (§5.5).
  deps.recordApproval({ ts, draftId: draft.draftId, mailboxId: account.id })

  try {
    return await deps.provider.sendDraft(account, draft)
  } catch (err) {
    throw new Error(
      `Send failed for the approved reply on thread ${draft.threadId} — the draft is ` +
        `preserved in the mailbox and nothing was sent. Approve again to retry.`,
      { cause: err }
    )
  }
}
