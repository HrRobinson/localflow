import { describe, it, expect } from 'vitest'
import { approveAndSend, formatApprovalAudit } from '../../src/main/email/draft-gate'
import type { ApprovalAuditRecord } from '../../src/main/email/draft-gate'
import type { AccountRef, DraftRef } from '../../src/main/email/provider'
import { MockEmailProvider } from './mock-email-provider'

const account: AccountRef = { id: 'acct-primary', address: 'me@example.com', provider: 'gmail' }
const draft: DraftRef = { draftId: 'draft-1', threadId: 'thread-1' }

describe('draft-gate (the single send caller)', () => {
  it('records the approval audit BEFORE it sends, and sends exactly once', async () => {
    const provider = new MockEmailProvider()
    const events: string[] = []
    const audit: ApprovalAuditRecord[] = []

    // One shared log, written at each step's REAL execution instant: the recorder
    // pushes 'approval' when draft-gate records; the mock's `sendDraft` pushes
    // 'send' when the send actually runs. Reordering draft-gate to send-first would
    // flip these and fail the assertion (unlike a post-hoc reconstruction).
    provider.sendEvents = events
    const result = await approveAndSend(
      {
        provider,
        recordApproval: (r) => {
          audit.push(r)
          events.push('approval')
        },
        now: () => 1234
      },
      account,
      draft
    )

    expect(events).toEqual(['approval', 'send'])
    expect(provider.sends).toHaveLength(1)
    expect(result.threadId).toBe('thread-1')
    expect(audit).toEqual([{ ts: 1234, draftId: 'draft-1', mailboxId: 'acct-primary' }])
  })

  it('the approval record carries no email content and no secret material', () => {
    const record: ApprovalAuditRecord = { ts: 1234, draftId: 'draft-1', mailboxId: 'acct-primary' }
    const keys = Object.keys(record).sort()
    expect(keys).toEqual(['draftId', 'mailboxId', 'ts'])
    const line = formatApprovalAudit(record)
    // Serialized audit line holds only ids + ts — never body/subject/token.
    expect(line).not.toMatch(/subject|body|token|bearer|secret/i)
    expect(JSON.parse(line)).toEqual(record)
  })

  it('a post-approval send failure throws a legible error carrying the real cause', async () => {
    const provider = new MockEmailProvider()
    provider.failSendWith = new Error('503 backend error')
    let recorded = false

    await expect(
      approveAndSend(
        { provider, recordApproval: () => (recorded = true), now: () => 1 },
        account,
        draft
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('nothing was sent'),
      cause: expect.objectContaining({ message: '503 backend error' })
    })

    // Approval is still recorded (a human did approve); nothing sent; retry is safe.
    expect(recorded).toBe(true)
    expect(provider.sends).toHaveLength(0)
  })

  it('the send message names the thread and stays actionable', async () => {
    const provider = new MockEmailProvider()
    provider.failSendWith = new Error('quota exceeded')
    await expect(
      approveAndSend({ provider, recordApproval: () => {}, now: () => 1 }, account, draft)
    ).rejects.toThrow(/thread-1/)
  })
})
