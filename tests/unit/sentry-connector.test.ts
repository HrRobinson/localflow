import { describe, it, expect } from 'vitest'
import { SentryConnector } from '../../src/main/sentry/sentry-connector'
import {
  MockSentryApi,
  type RawSentryEvent,
  type RawSentryIssue
} from '../../src/main/sentry/sentry-api'
import type {
  SentryWebhookDelivery,
  SentryWebhookServer
} from '../../src/main/sentry/sentry-webhook-server'

const issueNode: RawSentryIssue = {
  id: '4509',
  shortId: 'FE-1',
  title: 'boom',
  culprit: 'cart.ts in applyDiscount',
  level: 'error',
  status: 'unresolved',
  project: { slug: 'frontend' }
}

const eventNode: RawSentryEvent = {
  eventID: 'ev1',
  groupID: '4509',
  culprit: 'cart.ts in applyDiscount',
  entries: [
    {
      type: 'exception',
      data: {
        values: [
          {
            type: 'TypeError',
            value: 'undefined',
            stacktrace: {
              frames: [
                { filename: 'src/cart.ts', function: 'applyDiscount', lineNo: 88, inApp: true }
              ]
            }
          }
        ]
      }
    }
  ]
}

/** A fake webhook server whose onEvent sink we can drive directly. */
function fakeWebhook(): {
  server: SentryWebhookServer
  deliver: (d: SentryWebhookDelivery) => void
} {
  let sink: ((d: SentryWebhookDelivery) => void) | null = null
  return {
    server: { port: 0, onEvent: (h) => (sink = h), close: () => {} },
    deliver: (d) => sink?.(d)
  }
}

describe('SentryConnector — action dispatch', () => {
  it('getEvent resolves the normalized event context with topInAppFrame', async () => {
    const c = new SentryConnector({ api: new MockSentryApi({ events: { '4509': eventNode } }) })
    const out = (await c.invokeAction('getEvent', { id: '4509' })) as {
      event: { topInAppFrame?: { filename: string; lineNo: number } }
    }
    expect(out.event.topInAppFrame).toMatchObject({ filename: 'src/cart.ts', lineNo: 88 })
  })

  it('getIssue resolves the normalized issue context', async () => {
    const c = new SentryConnector({ api: new MockSentryApi({ issues: { '4509': issueNode } }) })
    const out = (await c.invokeAction('getIssue', { id: '4509' })) as { issue: { shortId: string } }
    expect(out.issue).toMatchObject({ id: '4509', shortId: 'FE-1', project: 'frontend' })
  })

  it('searchIssues returns normalized issues + count', async () => {
    const c = new SentryConnector({ api: new MockSentryApi({ searchResults: [issueNode] }) })
    const out = (await c.invokeAction('searchIssues', { query: 'is:unresolved' })) as {
      count: number
      issues: { issue: { id: string } }[]
    }
    expect(out.count).toBe(1)
    expect(out.issues[0].issue.id).toBe('4509')
  })

  it('resolveIssue forwards statusDetails.inCommit (the project-scoped close, §7)', async () => {
    const api = new MockSentryApi({})
    const c = new SentryConnector({ api })
    await c.invokeAction('resolveIssue', {
      id: '4509',
      statusDetails: { inCommit: { commit: 'deadbeef' } }
    })
    expect(api.calls.resolveIssue).toEqual([
      { id: '4509', statusDetails: { inCommit: { commit: 'deadbeef' } } }
    ])
  })

  it('assignIssue / ignoreIssue / commentIssue reach the api with their params', async () => {
    const api = new MockSentryApi({})
    const c = new SentryConnector({ api })
    await c.invokeAction('assignIssue', { id: '4509', assignedTo: 'user:7' })
    await c.invokeAction('ignoreIssue', { id: '4509' })
    await c.invokeAction('commentIssue', { id: '4509', text: 'fix PR #12 opened by saiife' })
    expect(api.calls.assignIssue).toEqual([{ id: '4509', assignedTo: 'user:7' }])
    expect(api.calls.ignoreIssue).toEqual([{ id: '4509', statusDetails: undefined }])
    expect(api.calls.commentIssue).toEqual([{ id: '4509', text: 'fix PR #12 opened by saiife' }])
  })

  it('rejects a mutation failure verbatim (the pinned convention)', async () => {
    const api = new MockSentryApi({ resolveError: 'issue already resolved' })
    const c = new SentryConnector({ api })
    await expect(c.invokeAction('resolveIssue', { id: '4509' })).rejects.toThrow(/already resolved/)
  })

  it('rejects a missing id, a missing assignee/text, and an unknown action legibly', async () => {
    const c = new SentryConnector({ api: new MockSentryApi({}) })
    await expect(c.invokeAction('getIssue', {})).rejects.toThrow(/needs an issue id/)
    await expect(c.invokeAction('assignIssue', { id: '1' })).rejects.toThrow(/needs 'assignedTo'/)
    await expect(c.invokeAction('commentIssue', { id: '1' })).rejects.toThrow(
      /needs a non-empty 'text'/
    )
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })
})

describe('SentryConnector — trigger subscription', () => {
  it('delivers a verified issue/created webhook as a SeedEvent to issue.created', () => {
    const { server, deliver } = fakeWebhook()
    const c = new SentryConnector({ api: new MockSentryApi({}), webhook: server })
    const seeds: unknown[] = []
    const off = c.subscribe('issue.created', (e) => seeds.push(e))
    deliver({
      requestId: 'req-1',
      resource: 'issue',
      action: 'created',
      payload: { data: { issue: issueNode } }
    })
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({
      eventId: 'req-1',
      payload: { issueId: '4509', resource: 'issue' }
    })
    off()
    deliver({
      requestId: 'req-2',
      resource: 'issue',
      action: 'created',
      payload: { data: { issue: issueNode } }
    })
    expect(seeds).toHaveLength(1) // unsubscribed
  })

  it('applies the derived regressed filter — only substatus=regressed fires issue.regressed', () => {
    const { server, deliver } = fakeWebhook()
    const c = new SentryConnector({ api: new MockSentryApi({}), webhook: server })
    const regressed: unknown[] = []
    c.subscribe('issue.regressed', (e) => regressed.push(e))

    deliver({
      requestId: 'r1',
      resource: 'issue',
      action: 'unresolved',
      payload: { data: { issue: { ...issueNode, substatus: 'ongoing' } } }
    })
    expect(regressed).toHaveLength(0) // ordinary un-resolve seeds nothing

    deliver({
      requestId: 'r2',
      resource: 'issue',
      action: 'unresolved',
      payload: { data: { issue: { ...issueNode, substatus: 'regressed' } } }
    })
    expect(regressed).toHaveLength(1)
  })

  it('delivers an event_alert as alert.triggered with the inline event', () => {
    const { server, deliver } = fakeWebhook()
    const c = new SentryConnector({ api: new MockSentryApi({}), webhook: server })
    const alerts: { payload: { event?: { topInAppFrame?: { filename: string } } } }[] = []
    c.subscribe('alert.triggered', (e) => alerts.push(e as never))
    deliver({
      requestId: 'r3',
      resource: 'event_alert',
      action: 'triggered',
      payload: { data: { event: eventNode, issue: issueNode } }
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0].payload.event?.topInAppFrame?.filename).toBe('src/cart.ts')
  })

  it('ignores an unknown trigger id and an unsupported resource', () => {
    const { server, deliver } = fakeWebhook()
    const c = new SentryConnector({ api: new MockSentryApi({}), webhook: server, log: () => {} })
    const seeds: unknown[] = []
    c.subscribe('issue.created', (e) => seeds.push(e))
    expect(typeof c.subscribe('bogus.trigger', () => {})).toBe('function')
    deliver({ requestId: 'r4', resource: 'metric_alert', payload: { data: {} } })
    expect(seeds).toHaveLength(0)
  })
})
