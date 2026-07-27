/**
 * The load-bearing never-auto-send invariant tests (design §5, §10). These are
 * the point of the whole foundation slice: they prove — structurally, not by
 * policy — that saiife cannot send an email except behind an explicit,
 * recorded human approval. If any of these fail, the guarantee is broken.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approveAndSend, formatApprovalAudit } from '../../src/main/email/draft-gate'
import type { ApprovalAuditRecord } from '../../src/main/email/draft-gate'
import { TaskRouter } from '../../src/main/email/task-router'
import { draftPeekFromMime } from '../../src/shared/email'
import type { AccountRef, EmailMessage, MimeBody } from '../../src/main/email/provider'
import { MockEmailProvider } from './mock-email-provider'

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url))

/**
 * Every non-test source file under `src/`, as { relPath, text }. Covers ALL of
 * saiife's TS/TSX source families — `.ts`, `.tsx` (the renderer, e.g.
 * `ApproveButton.tsx`), `.mts`, `.cts` — so a send caller added in a `.tsx`
 * component cannot slip past the single-caller invariant. Excludes ambient
 * declarations (`.d.ts`) and in-tree test/spec files, matching the "all non-test
 * src/**" claim the invariant asserts (§10.1).
 */
const SRC_EXT = /\.(?:ts|tsx|mts|cts)$/
function srcFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (
        SRC_EXT.test(entry) &&
        !entry.endsWith('.d.ts') &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry)
      ) {
        out.push({ path: full.slice(SRC_DIR.length + 1), text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(SRC_DIR)
  return out
}

const account: AccountRef = { id: 'acct-primary', address: 'me@example.com', provider: 'gmail' }

const replyBody: MimeBody = {
  to: ['them@example.com'],
  subject: 'Re: quarterly report',
  text: 'Thanks — I will send the report Monday.'
}

function inbound(): EmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'them@example.com',
    to: ['me@example.com'],
    subject: 'quarterly report',
    body: 'Any update on the report?',
    receivedAt: 1,
    unread: true
  }
}

describe('never-auto-send invariant', () => {
  // §10.1 — Single caller: exactly one non-test caller of `.sendDraft(`, in draft-gate.
  // NOTE: this is a TEXT-SCAN tripwire — it matches the literal `.sendDraft(` call
  // shape across all src/** TS/TSX. It intentionally trades completeness for a
  // zero-dependency, always-on guard; an alias (`provider['sendDraft']`, a captured
  // `const s = provider.sendDraft`) could evade it. Pair it with the §5 review
  // checklist, and never introduce such an alias in src/.
  it('has exactly one provider-send call site in src/, and it is draft-gate', () => {
    const callers = srcFiles().filter((f) => f.text.includes('.sendDraft('))
    expect(callers.map((f) => f.path)).toEqual(['main/email/draft-gate.ts'])
    // And exactly one call, not several inside that file.
    const count = (callers[0].text.match(/\.sendDraft\(/g) ?? []).length
    expect(count).toBe(1)
  })

  // §10.4 — No combined compose-and-send verb is wired anywhere in src/.
  // Forward tripwire: nothing matches today (no provider impl is wired yet). It
  // guards FUTURE provider implementations — a Graph `sendMail(` or a raw SMTP
  // `DATA\r\n` submit outside the draft path would trip it (§5.1).
  it('wires no one-shot combined-send verb (sendMail / raw SMTP DATA)', () => {
    const offenders = srcFiles().filter(
      (f) => /\bsendMail\s*\(/.test(f.text) || /['"`]DATA\\r\\n/.test(f.text)
    )
    expect(offenders.map((f) => f.path)).toEqual([])
  })

  // §10.2 — No send without approval: a full inbound→draft cycle sends nothing.
  it('sends nothing through a full inbound→draft cycle until approval fires', async () => {
    const provider = new MockEmailProvider()
    const router = new TaskRouter({ environment: 7, createPane: () => 'pane-1' })

    // Inbound arrives → routed to a pane → agent reads, then drafts a reply.
    provider.seedThread({
      threadRef: { threadId: 't1' },
      subject: 'quarterly report',
      messages: [inbound()]
    })
    await provider.deliver(account, inbound())
    const task = router.route(inbound())
    await provider.getThread(account, { threadId: 't1' }) // agent reads
    const draft = await provider.createReplyDraft(account, { threadId: 't1' }, replyBody)
    router.attachDraft('t1', draft, draftPeekFromMime(replyBody))

    // Every agent-side action happened; NOTHING has been sent.
    expect(provider.drafts).toHaveLength(1)
    expect(provider.sends).toHaveLength(0)
    // The pane is parked waiting on the human.
    expect(router.statusFor(task.paneHandle)).toBe('needs-you')

    // Only now — the human approval entrypoint — does a send occur.
    await approveAndSend({ provider, recordApproval: () => {} }, account, draft)
    expect(provider.sends).toHaveLength(1)
  })

  // §10.3 — Approval → exactly one send with the approved draft, audit written first.
  it('records the approval audit before the single send of the approved draft', async () => {
    const provider = new MockEmailProvider()
    const draft = await provider.createReplyDraft(account, { threadId: 't1' }, replyBody)

    // Both markers land in ONE shared log at their real execution instant:
    // `recordApproval` pushes 'approval' when draft-gate records; the mock's
    // `sendDraft` pushes 'send' when the send seam is actually reached. So this
    // ordering assertion would FAIL if draft-gate ever sent before recording.
    const order: string[] = []
    provider.sendEvents = order
    const audit: ApprovalAuditRecord[] = []
    await approveAndSend(
      {
        provider,
        recordApproval: (r) => {
          audit.push(r)
          order.push('approval')
        },
        now: () => 999
      },
      account,
      draft
    )

    expect(order).toEqual(['approval', 'send'])
    expect(provider.sends).toHaveLength(1)
    expect(provider.sends[0].threadId).toBe(draft.threadId)
    expect(audit).toEqual([{ ts: 999, draftId: draft.draftId, mailboxId: account.id }])
  })

  // §5.5 — The audit is written BEFORE the send seam is reached even when the send
  // itself throws: the record must already exist so a failed send is still traceable
  // to the human approval. Captured via the same real-execution-order log.
  it('records the approval audit before a send that then throws', async () => {
    const provider = new MockEmailProvider()
    provider.failSendWith = new Error('503 backend error')
    const draft = await provider.createReplyDraft(account, { threadId: 't1' }, replyBody)

    const order: string[] = []
    provider.sendEvents = order
    await expect(
      approveAndSend(
        { provider, recordApproval: () => order.push('approval'), now: () => 1 },
        account,
        draft
      )
    ).rejects.toThrow(/nothing was sent/)

    // 'approval' precedes the (failed) send attempt; nothing actually went out.
    expect(order).toEqual(['approval', 'send'])
    expect(provider.sends).toHaveLength(0)
  })

  // §4.5/§4.6 — Status mapping + peek is the draft body, not pty tail.
  it('surfaces an email-task pane as needs-you with the draft body as its peek', async () => {
    const provider = new MockEmailProvider()
    const router = new TaskRouter({ environment: 7, createPane: () => 'pane-9' })
    const task = router.route(inbound())
    const draft = await provider.createReplyDraft(account, { threadId: 't1' }, replyBody)
    router.attachDraft('t1', draft, draftPeekFromMime(replyBody))

    expect(router.statusFor(task.paneHandle)).toBe('needs-you')
    expect(router.peekFor(task.paneHandle)).toEqual({
      to: ['them@example.com'],
      subject: 'Re: quarterly report',
      body: 'Thanks — I will send the report Monday.'
    })
  })

  // §6/§10 — No token-shaped material appears in any emitted/persisted string.
  it('emits no token-shaped material in audit lines or send-failure notices', async () => {
    // A generous scan for OAuth/bearer token shapes.
    const tokenShaped =
      /ya29\.|1\/\/[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{10,}|refresh_token|access_token|client_secret|[A-Za-z0-9_-]{40,}/

    // Walk the WHOLE error graph — message + the full `.cause` chain + every string
    // field on any attached object (`.config`, `.response`, headers …) — because a
    // provider error can smuggle a token in any of those, not just `.message`.
    const scanStrings = (v: unknown, seen = new Set<unknown>()): string[] => {
      if (typeof v === 'string') return [v]
      if (v === null || typeof v !== 'object' || seen.has(v)) return []
      seen.add(v)
      const out: string[] = []
      if (v instanceof Error) {
        out.push(v.message)
        out.push(...scanStrings(v.cause, seen))
      }
      for (const child of Object.values(v as Record<string, unknown>)) {
        out.push(...scanStrings(child, seen))
      }
      return out
    }

    const auditLine = formatApprovalAudit({ ts: 1, draftId: 'draft-1', mailboxId: 'acct-primary' })
    expect(auditLine).not.toMatch(tokenShaped)

    // The provider fails with an error whose message embeds a real bearer token —
    // exactly the shape a live gmail 401 can carry. draft-gate must scrub it before
    // it can ride out on `cause`.
    const provider = new MockEmailProvider()
    provider.failSendWith = new Error(
      '401 invalid_grant — Authorization: Bearer sk-FAKE123ABCDEFGHIJKLMNOP'
    )
    let thrown: unknown
    try {
      await approveAndSend({ provider, recordApproval: () => {}, now: () => 1 }, account, {
        draftId: 'draft-1',
        threadId: 't1'
      })
    } catch (e) {
      thrown = e
    }

    // Nothing token-shaped anywhere in the thrown error's message OR cause chain.
    for (const s of scanStrings(thrown)) {
      expect(s).not.toMatch(tokenShaped)
    }
    // ...yet the real, legible cause survives (redacted, not discarded).
    const cause = (thrown as Error).cause as Error
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toContain('invalid_grant')
    expect(cause.message).toContain('<redacted>')
  })
})
