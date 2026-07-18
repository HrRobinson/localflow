import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockPostHogApi } from '../../src/main/posthog/posthog-api'
import { PostHogPoller } from '../../src/main/posthog/posthog-poller'
import { PostHogCursorStore } from '../../src/main/posthog/posthog-cursor-store'
import type { SeedEvent } from '../../src/main/flow/trigger-subscriber'

/**
 * The LOAD-BEARING poll test (spec §7, §12): the poller runs entirely off an
 * INJECTED CLOCK, so the cadence + cursor semantics are asserted deterministically
 * with NO real waiting and NO live PostHog. Covers each trigger's dedup, a
 * restart-resume, and the announced-degradation rule.
 */

const POLL_S = 60
let dir: string
let clock: number

function cursorStore(): PostHogCursorStore {
  return new PostHogCursorStore({ file: join(dir, 'cursors.json') })
}
function buildPoller(api: MockPostHogApi, cursors = cursorStore(), log?: (m: string) => void) {
  return new PostHogPoller({ api, cursors, now: () => clock, pollSeconds: POLL_S, log })
}
/** Advance past the cadence so the next `tick()` re-polls the subscription. */
async function nextTick(poller: PostHogPoller): Promise<void> {
  clock += POLL_S * 1000
  await poller.tick()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-ph-poll-'))
  clock = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('insight.threshold — edge-cross (spec §7.2c)', () => {
  it('fires only on the crossing, not on every tick above the line', async () => {
    const api = new MockPostHogApi({ insight: { id: '5', name: 'errs', value: 1 } })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe('insight.threshold', { insightId: '5', threshold: 2 }, (e) => fired.push(e))

    await poller.tick() // baseline value 1 — NO fire
    expect(fired).toHaveLength(0)

    api.data.insight = { id: '5', name: 'errs', value: 3 }
    await nextTick(poller) // 1 → 3 crosses 2 — ONE fire
    expect(fired).toHaveLength(1)
    expect(fired[0].payload).toMatchObject({ insightId: '5', value: 3, threshold: 2 })

    await nextTick(poller) // still 3 — sustained above, NO new fire
    api.data.insight = { id: '5', name: 'errs', value: 5 }
    await nextTick(poller) // 3 → 5, still above, NO new fire
    expect(fired).toHaveLength(1)
  })

  it('supports a "below" crossing direction', async () => {
    const api = new MockPostHogApi({ insight: { id: '5', name: 'x', value: 10 } })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe(
      'insight.threshold',
      { insightId: '5', threshold: 5, direction: 'below' },
      (e) => fired.push(e)
    )
    await poller.tick() // baseline 10
    api.data.insight = { id: '5', name: 'x', value: 2 }
    await nextTick(poller) // 10 → 2 crosses below 5
    expect(fired).toHaveLength(1)
  })
})

describe('cohort.entered — membership set-diff (spec §7.2b)', () => {
  it('fires once per newly-present person; re-entry fires again; present never re-fires', async () => {
    const api = new MockPostHogApi({ cohort: { id: '9', name: 'churn', members: ['a', 'b'] } })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe('cohort.entered', { cohortId: '9' }, (e) => fired.push(e))

    await poller.tick() // baseline {a,b} — NO fire (can't know who's "new")
    expect(fired).toHaveLength(0)

    api.data.cohort = { id: '9', name: 'churn', members: ['a', 'b', 'c'] }
    await nextTick(poller) // c is new — one fire carrying enteredDistinctId
    expect(fired).toHaveLength(1)
    expect(fired[0].payload).toMatchObject({ enteredDistinctId: 'c' })

    await nextTick(poller) // {a,b,c} unchanged — no re-fire for present members
    expect(fired).toHaveLength(1)

    api.data.cohort = { id: '9', name: 'churn', members: ['a', 'b'] } // c leaves
    await nextTick(poller)
    api.data.cohort = { id: '9', name: 'churn', members: ['a', 'b', 'c'] } // c re-enters
    await nextTick(poller)
    expect(fired).toHaveLength(2) // a real re-entry fires again
  })
})

describe('event.matched — timestamp+uuid cursor (spec §7.2a)', () => {
  const ev = (uuid: string, ts: string) => ({
    uuid,
    event: '$error',
    distinct_id: 'p',
    timestamp: ts,
    properties: {}
  })

  it('a boundary-tick event fires exactly once (not skipped, not re-fired)', async () => {
    const api = new MockPostHogApi({ events: [ev('e1', '2026-07-18T10:00:00Z')] })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe('event.matched', { event: '$error' }, (e) => fired.push(e))

    await poller.tick() // e1 fires
    expect(fired.map((f) => f.eventId)).toEqual(['e1'])

    await nextTick(poller) // e1 is at the boundary ts, returned again → deduped
    expect(fired.map((f) => f.eventId)).toEqual(['e1'])

    // A second event at the SAME timestamp, higher uuid — must fire, not be skipped.
    api.data.events = [ev('e1', '2026-07-18T10:00:00Z'), ev('e2', '2026-07-18T10:00:00Z')]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['e1', 'e2'])

    // A later event fires.
    api.data.events = [...api.data.events, ev('e3', '2026-07-18T10:05:00Z')]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['e1', 'e2', 'e3'])
  })
})

describe('restart-resume (spec §7.4)', () => {
  it('rehydrates from the persisted cursor: no missed and no re-fired signals', async () => {
    const shared = cursorStore()
    const api = new MockPostHogApi({ insight: { id: '5', name: 'x', value: 1 } })
    const poller1 = buildPoller(api, shared)
    const fired1: SeedEvent[] = []
    poller1.subscribe('insight.threshold', { insightId: '5', threshold: 2 }, (e) => fired1.push(e))
    await poller1.tick() // baseline 1
    api.data.insight = { id: '5', name: 'x', value: 3 }
    await nextTick(poller1) // crosses → fires
    expect(fired1).toHaveLength(1)

    // "Restart": a NEW cursor store reads the persisted sidecar; a NEW poller
    // re-subscribes and must NOT re-fire the already-seen crossing.
    const poller2 = buildPoller(api, cursorStore())
    const fired2: SeedEvent[] = []
    poller2.subscribe('insight.threshold', { insightId: '5', threshold: 2 }, (e) => fired2.push(e))
    await poller2.tick() // value still 3, cursor already 3 — NO re-fire
    expect(fired2).toHaveLength(0)

    api.data.insight = { id: '5', name: 'x', value: 1 }
    await nextTick(poller2) // back below
    api.data.insight = { id: '5', name: 'x', value: 3 }
    await nextTick(poller2) // crosses again — a genuine new crossing fires
    expect(fired2).toHaveLength(1)
  })
})

describe('degradation is announced, cursor not advanced (spec §11)', () => {
  it('a failing tick logs loudly and does NOT advance the cursor; the next tick recovers', async () => {
    const api = new MockPostHogApi({ insight: { id: '5', name: 'x', value: 1 } })
    const logs: string[] = []
    const cursors = cursorStore()
    const poller = buildPoller(api, cursors, (m) => logs.push(m))
    const fired: SeedEvent[] = []
    poller.subscribe('insight.threshold', { insightId: '5', threshold: 2 }, (e) => fired.push(e))

    await poller.tick() // baseline 1 stored
    expect(cursors.get('insight.threshold:5:2:above')).toEqual({ kind: 'insight', lastValue: 1 })

    // The value would cross to 3, but the poll ERRORS this tick.
    api.data.insight = { id: '5', name: 'x', value: 3 }
    api.data.insightError = 'PostHog host unreachable (ECONNREFUSED)'
    await nextTick(poller)
    expect(fired).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/poll failed.*ECONNREFUSED/i)
    expect(logs.join('\n')).toMatch(/not advanced/i)
    // Cursor UNCHANGED — the signal is worked late, never lost.
    expect(cursors.get('insight.threshold:5:2:above')).toEqual({ kind: 'insight', lastValue: 1 })

    // Recovery: the poll succeeds, sees 1 → 3, fires the crossing it deferred.
    api.data.insightError = undefined
    await nextTick(poller)
    expect(fired).toHaveLength(1)
  })
})

describe('subscription config guard', () => {
  it('a missing insightId announces degradation (does not throw out of the tick)', async () => {
    const api = new MockPostHogApi({})
    const logs: string[] = []
    const poller = buildPoller(api, cursorStore(), (m) => logs.push(m))
    poller.subscribe('insight.threshold', { threshold: 2 }, () => {})
    await poller.tick()
    expect(logs.join('\n')).toMatch(/needs a 'insightId'/)
  })
})
