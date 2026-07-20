import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockPostHogApi } from '../../src/main/posthog/posthog-api'
import { PostHogConnector } from '../../src/main/posthog/posthog-connector'
import { PostHogPoller } from '../../src/main/posthog/posthog-poller'
import { PostHogCursorStore } from '../../src/main/posthog/posthog-cursor-store'

let dir: string
let clock: number
function buildPoller(api: MockPostHogApi): PostHogPoller {
  return new PostHogPoller({
    api,
    cursors: new PostHogCursorStore({ file: join(dir, 'cursors.json') }),
    now: () => clock,
    pollSeconds: 60,
    log: () => {}
  })
}
function buildConnector(api: MockPostHogApi): PostHogConnector {
  return new PostHogConnector({ api, poller: buildPoller(api) })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-ph-conn-'))
  clock = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PostHogConnector — read dispatch', () => {
  it('getInsight → GET insights/<id>, normalized to insight.*', async () => {
    const api = new MockPostHogApi({
      insight: { id: 5, name: 'errs', result: [{ aggregated_value: 3 }] }
    })
    const out = await buildConnector(api).invokeAction('getInsight', { insightId: '5' })
    expect(api.calls.getInsight).toEqual(['5'])
    expect(out).toMatchObject({ insight: { id: '5', name: 'errs', value: 3 } })
  })

  it('getFeatureFlag → GET feature_flags/<id>, normalized to flag.*', async () => {
    const api = new MockPostHogApi({
      flag: { id: 3, key: 'new-checkout', active: true, rollout_percentage: 100 }
    })
    const out = await buildConnector(api).invokeAction('getFeatureFlag', { flagId: '3' })
    expect(api.calls.getFeatureFlag).toEqual(['3'])
    expect(out).toEqual({
      flag: { id: '3', key: 'new-checkout', active: true, rolloutPercentage: 100 }
    })
  })

  it('getCohort → GET cohorts/<id>, normalized to cohort.*', async () => {
    const api = new MockPostHogApi({ cohort: { id: 9, name: 'churn-risk', count: 42 } })
    const out = await buildConnector(api).invokeAction('getCohort', { cohortId: '9' })
    expect(out).toEqual({ cohort: { id: '9', name: 'churn-risk', count: 42 } })
  })

  it('queryEvents → normalized events + count', async () => {
    const api = new MockPostHogApi({
      events: [
        {
          uuid: 'e1',
          event: 'x',
          distinct_id: 'p',
          timestamp: '2026-07-18T00:00:00Z',
          properties: {}
        }
      ]
    })
    const out = await buildConnector(api).invokeAction('queryEvents', { event: 'x' })
    expect(out).toMatchObject({ count: 1, events: [{ event: { id: 'e1', name: 'x' } }] })
  })

  it('rejects a read with a missing id, legibly, before any request', async () => {
    const api = new MockPostHogApi({})
    await expect(buildConnector(api).invokeAction('getInsight', {})).rejects.toThrow(/insightId/i)
    expect(api.calls.getInsight).toHaveLength(0)
  })
})

describe('PostHogConnector — gated write dispatch', () => {
  it('updateFeatureFlag → PATCH with active/rolloutPercentage', async () => {
    const api = new MockPostHogApi({
      flag: { id: 3, key: 'k', active: false, rollout_percentage: 0 }
    })
    const out = await buildConnector(api).invokeAction('updateFeatureFlag', {
      flagId: '3',
      active: false,
      rolloutPercentage: 0
    })
    expect(api.calls.updateFeatureFlag).toEqual([
      { id: '3', patch: { active: false, rolloutPercentage: 0 } }
    ])
    expect(out).toMatchObject({ flag: { active: false, rolloutPercentage: 0 } })
  })

  it('rejects updateFeatureFlag with neither active nor rolloutPercentage', async () => {
    const api = new MockPostHogApi({})
    await expect(
      buildConnector(api).invokeAction('updateFeatureFlag', { flagId: '3' })
    ).rejects.toThrow(/active.*rolloutPercentage|rolloutPercentage/i)
    expect(api.calls.updateFeatureFlag).toHaveLength(0)
  })

  it('forwards the REAL PostHog error verbatim on a failed write (reject convention)', async () => {
    const api = new MockPostHogApi({
      updateError: 'the personal API key lacks *write* scope on feature flags'
    })
    await expect(
      buildConnector(api).invokeAction('updateFeatureFlag', { flagId: '3', active: false })
    ).rejects.toThrow(/lacks \*write\* scope/)
  })

  it('rejects an unknown action id legibly', async () => {
    const api = new MockPostHogApi({})
    await expect(buildConnector(api).invokeAction('deleteEverything', {})).rejects.toThrow(
      /unknown PostHog action/i
    )
  })
})

describe('PostHogConnector — subscribe is a POLL, never a webhook, never auto-mutates', () => {
  it('a subscribed insight.threshold poll fires via the poller and makes ZERO writes', async () => {
    const api = new MockPostHogApi({ insight: { id: '5', name: 'errs', value: 1 } })
    const poller = buildPoller(api)
    const connector = new PostHogConnector({ api, poller })
    const seen: unknown[] = []
    connector.subscribeWithConfig('insight.threshold', { insightId: '5', threshold: 2 }, (e) =>
      seen.push(e)
    )
    // Baseline tick (value 1, below): no fire.
    await poller.tick()
    // Value crosses 2: one fire — and crucially NO updateFeatureFlag write.
    api.data.insight = { id: '5', name: 'errs', value: 3 }
    clock += 60_000
    await poller.tick()
    expect(seen).toHaveLength(1)
    expect(api.calls.updateFeatureFlag).toHaveLength(0)
  })

  it('an unknown trigger id yields a no-op unsubscribe (opt-in default)', () => {
    const api = new MockPostHogApi({})
    const off = buildConnector(api).subscribe('not.a.trigger', () => {})
    expect(() => off()).not.toThrow()
  })
})

/** ★ The load-bearing secret invariant (spec §8, §12): the personal API key VALUE
 *  never appears in a returned value, a log line, or an error surfaced onward. */
describe('PostHogConnector — no personal-API-key leak', () => {
  const KEY = 'phx_live_SECRET_do_not_leak_9f3a'

  it('never surfaces the personal API key through outputs, logs, or errors', async () => {
    const logs: string[] = []
    // The key rides only inside posthog-api's Bearer header (revealed at call
    // time). The connector/normalize never see it — prove the whole surface is clean.
    const api = new MockPostHogApi({
      insight: { id: '5', name: 'errs', value: 3 },
      updateError: 'PostHog rejected the request (401)'
    })
    const poller = new PostHogPoller({
      api,
      cursors: new PostHogCursorStore({ file: join(dir, 'cursors.json') }),
      now: () => 0,
      log: (m) => logs.push(m)
    })
    const connector = new PostHogConnector({ api, poller })

    const read = await connector.invokeAction('getInsight', { insightId: '5' })
    let errMsg = ''
    try {
      await connector.invokeAction('updateFeatureFlag', { flagId: '3', active: false })
    } catch (e) {
      errMsg = (e as Error).message
    }

    const surfaced = [JSON.stringify(read), logs.join('\n'), errMsg].join('\n')
    expect(surfaced).not.toContain(KEY)
    expect(surfaced).not.toContain('phx_')
    expect(surfaced).not.toMatch(/Authorization|Bearer /)
  })
})
