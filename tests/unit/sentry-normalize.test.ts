import { describe, it, expect } from 'vitest'
import {
  normalizeIssue,
  normalizeEvent,
  webhookToPayload,
  triggersFor
} from '../../src/main/sentry/sentry-normalize'
import type { RawSentryEvent, RawSentryIssue } from '../../src/main/sentry/sentry-api'

// A realistic raw event: the frames are buried three levels deep in
// entries[exception].data.values[].stacktrace.frames[], ordered oldest-call-
// FIRST (Sentry order), mixing a dependency frame with two in-app frames. The
// crash happens in the LAST in-app frame — applyDiscount at cart.ts:88.
const rawEvent: RawSentryEvent = {
  eventID: 'abcdef0123456789abcdef0123456789',
  groupID: '4509876543',
  message: 'Cannot read property id of undefined',
  culprit: 'cart.ts in applyDiscount',
  platform: 'javascript',
  permalink: 'https://sentry.io/org/proj/issues/4509876543/events/abc/',
  entries: [
    {
      type: 'exception',
      data: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read property 'id' of undefined",
            stacktrace: {
              frames: [
                {
                  filename: 'node_modules/react/index.js',
                  absPath: '/app/node_modules/react/index.js',
                  function: 'renderRoot',
                  lineNo: 12,
                  inApp: false
                },
                {
                  filename: 'src/checkout/page.ts',
                  absPath: '/app/src/checkout/page.ts',
                  function: 'renderCheckout',
                  lineNo: 40,
                  inApp: true,
                  context: [
                    [39, '  const cart = getCart()'],
                    [40, '  return applyDiscount(cart)']
                  ]
                },
                {
                  filename: 'src/checkout/cart.ts',
                  absPath: '/app/src/checkout/cart.ts',
                  function: 'applyDiscount',
                  lineNo: 88,
                  colNo: 15,
                  module: 'checkout/cart',
                  inApp: true,
                  contextLine: '  return coupon.id * total'
                }
              ]
            }
          }
        ]
      }
    }
  ]
}

describe('normalizeEvent — the load-bearing flatten (§6.3)', () => {
  it('flattens entries[exception].data.values[].stacktrace.frames[] into a flat frames[]', () => {
    const { event } = normalizeEvent(rawEvent)
    expect(event.frames.map((f) => f.function)).toEqual([
      'renderRoot',
      'renderCheckout',
      'applyDiscount'
    ])
  })

  it('filters inAppFrames to just the app’s own frames', () => {
    const { event } = normalizeEvent(rawEvent)
    expect(event.inAppFrames.map((f) => f.filename)).toEqual([
      'src/checkout/page.ts',
      'src/checkout/cart.ts'
    ])
  })

  it('picks topInAppFrame = the crash-nearest in-app frame (the file:line to fix)', () => {
    const { event } = normalizeEvent(rawEvent)
    expect(event.topInAppFrame).toEqual({
      filename: 'src/checkout/cart.ts',
      absPath: '/app/src/checkout/cart.ts',
      function: 'applyDiscount',
      lineNo: 88,
      colNo: 15,
      module: 'checkout/cart',
      inApp: true,
      contextLine: '  return coupon.id * total'
    })
  })

  it('surfaces the primary exception type/value and the event ids', () => {
    const { event } = normalizeEvent(rawEvent)
    expect(event.exception).toEqual({
      type: 'TypeError',
      value: "Cannot read property 'id' of undefined"
    })
    expect(event.id).toBe('abcdef0123456789abcdef0123456789')
    expect(event.issueId).toBe('4509876543')
    expect(event.culprit).toBe('cart.ts in applyDiscount')
  })

  it('reads a source line from the context[] array when no explicit contextLine', () => {
    const { event } = normalizeEvent(rawEvent)
    const page = event.frames.find((f) => f.filename === 'src/checkout/page.ts')
    expect(page?.contextLine).toBe('  return applyDiscount(cart)')
  })

  it('leaves topInAppFrame undefined when no frame is in-app', () => {
    const depOnly: RawSentryEvent = {
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                type: 'Error',
                value: 'boom',
                stacktrace: {
                  frames: [{ filename: 'node_modules/x/y.js', inApp: false, lineNo: 1 }]
                }
              }
            ]
          }
        }
      ]
    }
    const { event } = normalizeEvent(depOnly)
    expect(event.topInAppFrame).toBeUndefined()
    expect(event.inAppFrames).toEqual([])
  })

  it('never throws on a sparse/garbage event — safe defaults', () => {
    const { event } = normalizeEvent({})
    expect(event.frames).toEqual([])
    expect(event.exception).toEqual({ type: '', value: '' })
    expect(event.topInAppFrame).toBeUndefined()
  })
})

const rawIssue: RawSentryIssue = {
  id: '4509876543',
  shortId: 'FRONTEND-42',
  title: "TypeError: Cannot read property 'id' of undefined",
  culprit: 'cart.ts in applyDiscount',
  level: 'error',
  status: 'unresolved',
  substatus: 'new',
  permalink: 'https://sentry.io/org/proj/issues/4509876543/',
  platform: 'javascript',
  project: { slug: 'frontend' },
  count: '128',
  userCount: 42,
  firstSeen: '2026-07-01T00:00:00Z',
  lastSeen: '2026-07-18T00:00:00Z'
}

describe('normalizeIssue', () => {
  it('maps the raw issue node to the pinned issue context (count coerced to a number)', () => {
    const { issue } = normalizeIssue(rawIssue)
    expect(issue).toEqual({
      id: '4509876543',
      shortId: 'FRONTEND-42',
      title: "TypeError: Cannot read property 'id' of undefined",
      culprit: 'cart.ts in applyDiscount',
      level: 'error',
      status: 'unresolved',
      substatus: 'new',
      permalink: 'https://sentry.io/org/proj/issues/4509876543/',
      platform: 'javascript',
      project: 'frontend',
      count: 128,
      userCount: 42,
      firstSeen: '2026-07-01T00:00:00Z',
      lastSeen: '2026-07-18T00:00:00Z'
    })
  })

  it('falls back to safe enum defaults for an unknown level/status', () => {
    const { issue } = normalizeIssue({ id: '1', level: 'weird', status: 'bogus' })
    expect(issue.level).toBe('error')
    expect(issue.status).toBe('unresolved')
  })
})

describe('webhookToPayload + triggersFor (§6.1)', () => {
  it('issue/created → issue.created with the issue fields', () => {
    const body = { action: 'created', data: { issue: rawIssue } }
    const payload = webhookToPayload('issue', body)
    expect(payload).toMatchObject({
      issueId: '4509876543',
      shortId: 'FRONTEND-42',
      projectSlug: 'frontend',
      level: 'error',
      resource: 'issue',
      action: 'created'
    })
    expect(triggersFor('issue', payload!)).toEqual(['issue.created'])
  })

  it('issue/unresolved fires issue.regressed ONLY when substatus === regressed (the derived filter)', () => {
    const regressed = webhookToPayload('issue', {
      action: 'unresolved',
      data: { issue: { ...rawIssue, substatus: 'regressed' } }
    })
    expect(triggersFor('issue', regressed!)).toEqual(['issue.regressed'])

    const ordinary = webhookToPayload('issue', {
      action: 'unresolved',
      data: { issue: { ...rawIssue, substatus: 'ongoing' } }
    })
    expect(triggersFor('issue', ordinary!)).toEqual([]) // no run seeded
  })

  it('event_alert → alert.triggered with the inline event + stack trace (no getEvent needed)', () => {
    const body = { action: 'triggered', data: { event: rawEvent, issue: rawIssue } }
    const payload = webhookToPayload('event_alert', body)
    expect(payload?.resource).toBe('event_alert')
    expect(payload?.event?.topInAppFrame?.filename).toBe('src/checkout/cart.ts')
    expect(triggersFor('event_alert', payload!)).toEqual(['alert.triggered'])
  })

  it('returns null for an unsupported resource or a body with no issue id', () => {
    expect(webhookToPayload('metric_alert', { data: {} })).toBeNull()
    expect(webhookToPayload('issue', { action: 'created', data: { issue: {} } })).toBeNull()
    expect(webhookToPayload('issue', 'not-an-object')).toBeNull()
  })
})
