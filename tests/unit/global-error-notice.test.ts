import { describe, expect, it } from 'vitest'
import {
  describeReason,
  isBenignErrorMessage,
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

    expect(notice?.message).toBe('An unexpected error occurred.')
    expect(notice?.detail).toContain('real underlying message')
  })

  it('falls back to the event message when no error is attached', () => {
    const notice = noticeFromError({ message: 'Script error.' })

    expect(notice?.detail).toBe('Script error.')
  })

  // ResizeObserver's loop-limit errors are dispatched as real `window` 'error'
  // events by Chromium, but they're benign (industry-standard to ignore, e.g.
  // Sentry's default ignore list). TerminalPane's ResizeObserver + synchronous
  // FitAddon.fit() is the textbook trigger for this, so without filtering,
  // resizing/splitting a terminal pane cries wolf with a red error toast.
  it('returns null (no notice) for a ResizeObserver loop limit error', () => {
    const notice = noticeFromError({ message: 'ResizeObserver loop limit exceeded' })

    expect(notice).toBeNull()
  })

  it('returns null (no notice) for a ResizeObserver undelivered notifications error', () => {
    const notice = noticeFromError({
      message: 'ResizeObserver loop completed with undelivered notifications.'
    })

    expect(notice).toBeNull()
  })

  it('matches the benign ResizeObserver messages case-insensitively', () => {
    const notice = noticeFromError({ message: 'RESIZEOBSERVER LOOP LIMIT EXCEEDED' })

    expect(notice).toBeNull()
  })

  it('still surfaces a notice for a genuine error message', () => {
    const notice = noticeFromError({ message: 'TypeError: x is not a function' })

    expect(notice).not.toBeNull()
    expect(notice?.message).toBe('An unexpected error occurred.')
    expect(notice?.detail).toBe('TypeError: x is not a function')
  })
})

describe('isBenignErrorMessage', () => {
  it('matches the ResizeObserver loop limit exceeded message', () => {
    expect(isBenignErrorMessage('ResizeObserver loop limit exceeded')).toBe(true)
  })

  it('matches the ResizeObserver loop completed with undelivered notifications message', () => {
    expect(
      isBenignErrorMessage('ResizeObserver loop completed with undelivered notifications.')
    ).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isBenignErrorMessage('resizeobserver loop limit exceeded')).toBe(true)
  })

  it('matches as a substring of a longer message', () => {
    expect(
      isBenignErrorMessage('Uncaught Error: ResizeObserver loop limit exceeded at foo.js:1')
    ).toBe(true)
  })

  it('does not match unrelated error messages', () => {
    expect(isBenignErrorMessage('TypeError: cannot read property of undefined')).toBe(false)
  })

  it('does not match an empty message', () => {
    expect(isBenignErrorMessage('')).toBe(false)
  })
})
