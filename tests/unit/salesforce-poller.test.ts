import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockSalesforceApi } from '../../src/main/salesforce/salesforce-api'
import { SalesforcePoller } from '../../src/main/salesforce/salesforce-poller'
import {
  SalesforceCursorStore,
  type SalesforceCursor
} from '../../src/main/salesforce/salesforce-cursor-store'
import type { SeedEvent } from '../../src/main/flow/trigger-subscriber'

/**
 * The LOAD-BEARING poll test (spec §7, §12): the SOQL `LastModifiedDate` reconcile
 * runs entirely off an INJECTED CLOCK, so the `(ts, Id)` tuple-cursor + baseline
 * semantics are asserted deterministically with NO real waiting and NO live org.
 * Covers baseline-without-firing, the inclusive-boundary tuple dedup, the
 * same-timestamp tie broken by Id, the seen-set persist-failure idempotency, a
 * restart-resume, and the announced-degradation rule.
 */

const POLL_S = 120
let dir: string
let clock: number

function cursorStore(): SalesforceCursorStore {
  return new SalesforceCursorStore({ file: join(dir, 'cursors.json') })
}
function buildPoller(
  api: MockSalesforceApi,
  cursors = cursorStore(),
  log?: (m: string) => void
): SalesforcePoller {
  return new SalesforcePoller({ api, cursors, now: () => clock, pollSeconds: POLL_S, log })
}
async function nextTick(poller: SalesforcePoller): Promise<void> {
  clock += POLL_S * 1000
  await poller.tick()
}

/** A raw Lead record with a given Id + LastModifiedDate. */
const lead = (id: string, lastModified: string) => ({
  attributes: { type: 'Lead' },
  Id: id,
  CreatedDate: '2026-07-01T00:00:00.000+0000',
  LastModifiedDate: lastModified,
  Company: 'Acme'
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-sf-poll-'))
  clock = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('record.updated — (LastModifiedDate, Id) reconcile cursor (spec §7.2)', () => {
  it('baselines pre-existing records WITHOUT firing; only later-modified records fire once', async () => {
    // r1 exists BEFORE subscribe — the first tick baselines the backlog and must
    // NOT flood a run for pre-existing records (spec §7.3).
    const api = new MockSalesforceApi({
      records: [lead('00Q000000000001', '2026-07-18T10:00:00Z')]
    })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe('record.updated', { object: 'Lead' }, (e) => fired.push(e))

    await poller.tick() // r1 pre-exists → baseline, NO fire
    expect(fired.map((f) => f.eventId)).toEqual([])

    await nextTick(poller) // r1 still at/under the boundary cursor → no re-fire
    expect(fired.map((f) => f.eventId)).toEqual([])

    // A NEW record at the SAME timestamp, higher Id — arrives after baseline, fires once.
    api.data.records = [
      lead('00Q000000000001', '2026-07-18T10:00:00Z'),
      lead('00Q000000000002', '2026-07-18T10:00:00Z')
    ]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId.slice(0, 15))).toEqual(['00Q000000000002'])

    // A later-modified record fires exactly once; the boundary row is deduped.
    api.data.records = [
      ...(api.data.records ?? []),
      lead('00Q000000000003', '2026-07-18T10:05:00Z')
    ]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId.slice(0, 15))).toEqual(['00Q000000000002', '00Q000000000003'])
    await nextTick(poller) // r3 now the boundary, returned again by the inclusive query → deduped
    expect(fired).toHaveLength(2)
  })

  it('seeds the normalized record (18-char id, typed fields) as the SeedEvent payload', async () => {
    const api = new MockSalesforceApi({ records: [] })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe('record.updated', { object: 'Lead' }, (e) => fired.push(e))
    await poller.tick() // baseline empty
    api.data.records = [lead('00Q000000000001', '2026-07-18T10:00:00Z')]
    await nextTick(poller)
    expect(fired).toHaveLength(1)
    const record = (fired[0].payload as { record: { id: string; type: string } }).record
    expect(record.id).toHaveLength(18)
    expect(record.type).toBe('Lead')
    expect(fired[0].eventId).toBe(record.id) // idempotency key is the 18-char id
  })

  it('threads the sObject + WHERE from the node config into the reconcile query (§4.3)', async () => {
    const api = new MockSalesforceApi({ records: [] })
    const poller = buildPoller(api)
    poller.subscribe(
      'record.updated',
      { object: 'Opportunity', where: "StageName = 'Prospecting'" },
      () => {}
    )
    await poller.tick()
    expect(api.calls.queryReconcile[0]).toMatchObject({
      object: 'Opportunity',
      timestampField: 'LastModifiedDate',
      where: "StageName = 'Prospecting'"
    })
  })
})

describe('record.created — cursors on CreatedDate (spec §6.1)', () => {
  it('uses the CreatedDate timestamp field for its reconcile', async () => {
    const api = new MockSalesforceApi({ records: [] })
    const poller = buildPoller(api)
    poller.subscribe('record.created', { object: 'Lead' }, () => {})
    await poller.tick()
    expect(api.calls.queryReconcile[0].timestampField).toBe('CreatedDate')
  })
})

describe('seen-set idempotency — persist failure does not double-seed (spec §7.2)', () => {
  class FlakyCursorStore extends SalesforceCursorStore {
    failNext = false
    set(key: string, cursor: SalesforceCursor): void {
      if (this.failNext) {
        this.failNext = false
        throw new Error('Couldn’t persist the Salesforce poll cursor — disk full (ENOSPC).')
      }
      super.set(key, cursor)
    }
  }

  it('an emitted record whose cursor persist FAILS is not re-seeded on the next tick', async () => {
    const cursors = new FlakyCursorStore({ file: join(dir, 'cursors.json') })
    const api = new MockSalesforceApi({ records: [] })
    const logs: string[] = []
    const poller = buildPoller(api, cursors, (m) => logs.push(m))
    const fired: SeedEvent[] = []
    poller.subscribe('record.updated', { object: 'Lead' }, (e) => fired.push(e))

    await poller.tick() // baseline (no records)

    api.data.records = [lead('00Q000000000001', '2026-07-18T10:00:00Z')]
    cursors.failNext = true
    await nextTick(poller)
    expect(fired).toHaveLength(1) // handed off exactly once
    expect(logs.join('\n')).toMatch(/poll failed|ENOSPC/i) // degradation announced

    // The cursor never durably advanced, so r1 is re-queried — the seen-set stops
    // it re-seeding the same signal.
    await nextTick(poller)
    expect(fired).toHaveLength(1)
  })
})

describe('restart-resume (spec §4.5)', () => {
  it('rehydrates from the persisted tuple cursor: no missed and no re-fired records', async () => {
    const shared = cursorStore()
    const api = new MockSalesforceApi({
      records: [lead('00Q000000000001', '2026-07-18T10:00:00Z')]
    })
    const poller1 = buildPoller(api, shared)
    const fired1: SeedEvent[] = []
    poller1.subscribe('record.updated', { object: 'Lead' }, (e) => fired1.push(e))
    await poller1.tick() // baseline r1 — no fire
    api.data.records = [
      ...(api.data.records ?? []),
      lead('00Q000000000002', '2026-07-18T10:05:00Z')
    ]
    await nextTick(poller1) // r2 fires
    expect(fired1).toHaveLength(1)

    // "Restart": a NEW cursor store reads the persisted sidecar; a NEW poller
    // re-subscribes and must NOT re-fire the already-seen r1/r2.
    const poller2 = buildPoller(api, cursorStore())
    const fired2: SeedEvent[] = []
    poller2.subscribe('record.updated', { object: 'Lead' }, (e) => fired2.push(e))
    await poller2.tick() // cursor already at r2 — no re-fire
    expect(fired2).toHaveLength(0)

    api.data.records = [
      ...(api.data.records ?? []),
      lead('00Q000000000003', '2026-07-18T10:10:00Z')
    ]
    await nextTick(poller2) // a genuinely newer record fires
    expect(fired2.map((f) => f.eventId.slice(0, 15))).toEqual(['00Q000000000003'])
  })
})

describe('degradation is announced, cursor not advanced (spec §7.4, §11)', () => {
  it('a failing tick logs loudly and does NOT advance the cursor; the next tick recovers', async () => {
    const api = new MockSalesforceApi({
      records: [lead('00Q000000000001', '2026-07-18T10:00:00Z')]
    })
    const logs: string[] = []
    const cursors = cursorStore()
    const poller = buildPoller(api, cursors, (m) => logs.push(m))
    const fired: SeedEvent[] = []
    poller.subscribe('record.updated', { object: 'Lead' }, (e) => fired.push(e))

    await poller.tick() // baseline r1 stored
    const key = 'record.updated:Lead:'
    const baseline = cursors.get(key)
    expect(baseline?.ts).toBe('2026-07-18T10:00:00Z')

    // A newer record would fire, but the poll ERRORS this tick.
    api.data.records = [
      ...(api.data.records ?? []),
      lead('00Q000000000002', '2026-07-18T10:05:00Z')
    ]
    api.data.queryError = 'Salesforce API request limit exceeded (REQUEST_LIMIT_EXCEEDED)'
    await nextTick(poller)
    expect(fired).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/poll failed.*REQUEST_LIMIT_EXCEEDED/i)
    expect(logs.join('\n')).toMatch(/not advanced/i)
    // Cursor UNCHANGED — the signal is worked late, never lost.
    expect(cursors.get(key)).toEqual(baseline)

    // Recovery: the poll succeeds, sees r2, fires the record it deferred.
    api.data.queryError = undefined
    await nextTick(poller)
    expect(fired).toHaveLength(1)
  })

  it('a missing object config announces degradation (does not throw out of the tick)', async () => {
    const api = new MockSalesforceApi({})
    const logs: string[] = []
    const poller = buildPoller(api, cursorStore(), (m) => logs.push(m))
    poller.subscribe('record.updated', {}, () => {}) // no object
    await poller.tick()
    expect(logs.join('\n')).toMatch(/needs an 'object'/)
  })
})
