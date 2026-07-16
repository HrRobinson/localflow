import { describe, expect, it } from 'vitest'
import {
  describeReason,
  noticeFromError,
  noticeFromRejection
} from '../../src/renderer/src/components/globalErrorLogic'

// Same limitation as error-boundary.test.ts: no jsdom / @testing-library/react
// in this repo's vitest setup (and tests/unit type-checks under
// tsconfig.node.json, no --jsx), so we can't mount <GlobalErrorNotice/> and
// dispatch a real `unhandledrejection` window event. Instead we exercise the
// pure event -> notice mapping the component's listeners call directly --
// this is the actual decision logic that turns a silent fire-and-forget IPC
// rejection into a visible notice (finding R14).
describe('describeReason', () => {
  it('uses the stack when the reason is an Error', () => {
    const err = new Error('kaboom')

    expect(describeReason(err)).toBe(err.stack ?? err.message)
  })

  it('passes string reasons through unchanged', () => {
    expect(describeReason('plain reason')).toBe('plain reason')
  })

  it('stringifies non-Error, non-string reasons', () => {
    expect(describeReason({ code: 42 })).toBe('{"code":42}')
  })
})

describe('noticeFromRejection', () => {
  it('surfaces the real rejection reason in the notice detail', () => {
    const notice = noticeFromRejection({ reason: new Error('ipc call failed') })

    expect(notice.message).toBe('An action failed in the background.')
    expect(notice.detail).toContain('ipc call failed')
  })

  it('handles a rejection with a plain string reason', () => {
    const notice = noticeFromRejection({ reason: 'session not found' })

    expect(notice.detail).toBe('session not found')
  })
})

describe('noticeFromError', () => {
  it('prefers the attached error detail over the generic event message', () => {
    const notice = noticeFromError({
      message: 'Script error.',
      error: new Error('real underlying message')
    })

    expect(notice.message).toBe('An unexpected error occurred.')
    expect(notice.detail).toContain('real underlying message')
  })

  it('falls back to the event message when no error is attached', () => {
    const notice = noticeFromError({ message: 'Script error.' })

    expect(notice.detail).toBe('Script error.')
  })
})
