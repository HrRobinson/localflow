import { describe, it, expect } from 'vitest'
import { TaskRouter } from '../../src/main/email/task-router'
import type { EmailPaneRequest } from '../../src/main/email/task-router'
import type { DraftRef, EmailMessage } from '../../src/main/email/provider'
import { draftPeekFromMime } from '../../src/shared/email'

function msg(over: Partial<EmailMessage> & Pick<EmailMessage, 'id' | 'threadId'>): EmailMessage {
  return {
    from: 'them@example.com',
    to: ['me@example.com'],
    subject: 'Re: hello',
    body: 'hi there',
    receivedAt: 1,
    ...over
  }
}

function makeRouter() {
  const created: EmailPaneRequest[] = []
  let n = 0
  const router = new TaskRouter({
    environment: 7,
    createPane: (req) => {
      created.push(req)
      return `pane-${++n}`
    }
  })
  return { router, created }
}

describe('TaskRouter (pane-per-thread)', () => {
  it('spawns one pane for an inbound thread via the injected seam', () => {
    const { router, created } = makeRouter()
    const task = router.route(msg({ id: 'm1', threadId: 't1' }))
    expect(task.paneHandle).toBe('pane-1')
    expect(task.threadId).toBe('t1')
    expect(created).toEqual([{ threadId: 't1', subject: 'Re: hello', environment: 7 }])
  })

  it('reuses the same pane for a second message in the same thread (1:1)', () => {
    const { router, created } = makeRouter()
    const first = router.route(msg({ id: 'm1', threadId: 't1' }))
    const second = router.route(msg({ id: 'm2', threadId: 't1' }))
    expect(second.paneHandle).toBe(first.paneHandle)
    expect(created).toHaveLength(1)
  })

  it('routes distinct threads to distinct panes', () => {
    const { router } = makeRouter()
    const a = router.route(msg({ id: 'm1', threadId: 't1' }))
    const b = router.route(msg({ id: 'm2', threadId: 't2' }))
    expect(a.paneHandle).not.toBe(b.paneHandle)
  })

  it('a fresh task is working and its peek falls back to the pty tail (null)', () => {
    const { router } = makeRouter()
    const task = router.route(msg({ id: 'm1', threadId: 't1' }))
    expect(router.statusFor(task.paneHandle)).toBe('working')
    expect(router.peekFor(task.paneHandle)).toBeNull()
  })

  it('once a draft is attached the pane is needs-you and peek is the DRAFT BODY', () => {
    const { router } = makeRouter()
    const task = router.route(msg({ id: 'm1', threadId: 't1' }))
    const draft: DraftRef = { draftId: 'd1', threadId: 't1' }
    const peek = draftPeekFromMime({
      to: ['them@example.com'],
      subject: 'Re: hello',
      text: 'Thanks — sending the report Monday.'
    })
    router.attachDraft('t1', draft, peek)

    expect(router.statusFor(task.paneHandle)).toBe('needs-you')
    // The peek is the outbound draft, NOT pty tail (§4.6).
    expect(router.peekFor(task.paneHandle)).toEqual({
      to: ['them@example.com'],
      subject: 'Re: hello',
      body: 'Thanks — sending the report Monday.'
    })
    // The task exposes the DraftRef the approval gate will send.
    expect(router.draftFor(task.paneHandle)).toEqual(draft)
  })

  it('attachDraft for an unknown thread throws a legible error', () => {
    const { router } = makeRouter()
    expect(() =>
      router.attachDraft(
        'ghost',
        { draftId: 'd1', threadId: 'ghost' },
        {
          to: [],
          subject: '',
          body: ''
        }
      )
    ).toThrow(/ghost/)
  })
})
