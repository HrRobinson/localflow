import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MockAirtableApi,
  type WebhookPayloadsPage,
  type RawChangedRecord
} from '../../src/main/airtable/airtable-api'
import { AirtablePoller } from '../../src/main/airtable/airtable-poller'
import { AirtableCursorStore } from '../../src/main/airtable/airtable-cursor-store'
import type { SeedEvent } from '../../src/main/flow/trigger-subscriber'

/**
 * The LOAD-BEARING poll test (spec §4, §10): the poller runs entirely off an
 * INJECTED CLOCK, so the `/payloads` cursor + baseline + dedup + degradation
 * semantics are asserted deterministically with NO real waiting and NO live
 * Airtable. Mirrors the PostHog poller tests.
 */

const POLL_S = 60
const WEBHOOK = 'achW'
const TABLE = 'tblIntake'
let dir: string
let clock: number

function cursorStore(): AirtableCursorStore {
  return new AirtableCursorStore({ file: join(dir, 'cursors.json') })
}
function buildPoller(
  api: MockAirtableApi,
  cursors = cursorStore(),
  log?: (m: string) => void
): AirtablePoller {
  return new AirtablePoller({ api, cursors, now: () => clock, pollSeconds: POLL_S, log })
}
async function nextTick(poller: AirtablePoller): Promise<void> {
  clock += POLL_S * 1000
  await poller.tick()
}
/** One `/payloads` page carrying a single created record. */
function createdPage(
  recordId: string,
  cursor: number,
  opts: { table?: string; txn?: number; fields?: Record<string, unknown> } = {}
): WebhookPayloadsPage {
  const rec: RawChangedRecord = {
    createdTime: '2026-07-20T10:00:00.000Z',
    cellValuesByFieldName: opts.fields ?? { Status: 'New' }
  }
  return {
    payloads: [
      {
        baseTransactionNumber: opts.txn ?? 1,
        changedTablesById: { [opts.table ?? TABLE]: { createdRecordsById: { [recordId]: rec } } }
      }
    ],
    cursor,
    mightHaveMore: false
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-at-poll-'))
  clock = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('baseline-without-firing on first observation (spec §4.2)', () => {
  it('jumps the cursor past the existing backlog WITHOUT firing; later changes fire once', async () => {
    const api = new MockAirtableApi({ payloadPages: [createdPage('rec1', 5)] })
    const cursors = cursorStore()
    const poller = buildPoller(api, cursors)
    const fired: SeedEvent[] = []
    poller.subscribe(
      'record.created',
      { baseId: 'app1', tableId: TABLE, webhookId: WEBHOOK },
      (e) => fired.push(e)
    )

    await poller.tick() // baseline: rec1 pre-exists → NOT fired
    expect(fired).toHaveLength(0)
    // Cursor advanced past the backlog (spec §4.2).
    expect(cursors.get(WEBHOOK)).toEqual({ kind: 'payloads', webhookId: WEBHOOK, cursor: 5 })

    // A genuinely-new created record arrives after baseline — fires exactly once.
    api.data.payloadPages = [createdPage('rec2', 6, { txn: 2 })]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['created:rec2:2'])
    // Cursor advanced AFTER the handoff.
    expect(cursors.get(WEBHOOK)).toEqual({ kind: 'payloads', webhookId: WEBHOOK, cursor: 6 })

    // An empty tick advances nothing new.
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['created:rec2:2'])
  })
})

describe('the SeedEvent payload carries the pinned change envelope (spec §3.3)', () => {
  it('surfaces record + changeType + baseId/tableId for downstream conditions', async () => {
    const api = new MockAirtableApi({ payloadPages: [createdPage('rec1', 2)] })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe(
      'record.created',
      { baseId: 'app1', tableId: TABLE, webhookId: WEBHOOK },
      (e) => fired.push(e)
    )
    await poller.tick() // baseline
    api.data.payloadPages = [
      createdPage('recX', 3, { txn: 9, fields: { Status: 'New', Score: 87 } })
    ]
    await nextTick(poller)
    expect(fired[0].payload).toMatchObject({
      changeType: 'created',
      baseId: 'app1',
      tableId: TABLE,
      record: { id: 'recX', fields: { Status: 'New', Score: 87 } }
    })
  })
})

describe('record.updated matches only `changed` records (spec §3.1)', () => {
  it('an updated subscription ignores a created-only batch and fires on a change', async () => {
    const api = new MockAirtableApi({ payloadPages: [createdPage('rec1', 1)] })
    const poller = buildPoller(api)
    const fired: SeedEvent[] = []
    poller.subscribe(
      'record.updated',
      { baseId: 'app1', tableId: TABLE, webhookId: WEBHOOK },
      (e) => fired.push(e)
    )
    await poller.tick() // baseline

    // A created-only batch: the `updated` sub must NOT fire.
    api.data.payloadPages = [createdPage('rec2', 2, { txn: 2 })]
    await nextTick(poller)
    expect(fired).toHaveLength(0)

    // A changed record fires with changedFieldNames.
    api.data.payloadPages = [
      {
        payloads: [
          {
            baseTransactionNumber: 3,
            changedTablesById: {
              [TABLE]: {
                changedRecordsById: {
                  rec2: {
                    cellValuesByFieldName: { Status: 'Triaged' },
                    changedFieldNames: ['Status']
                  }
                }
              }
            }
          }
        ],
        cursor: 3,
        mightHaveMore: false
      }
    ]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['updated:rec2:3'])
    expect(fired[0].payload).toMatchObject({ changedFieldNames: ['Status'] })
  })
})

describe('fan-out — one /payloads call serves every matching subscription (spec §4.2)', () => {
  it('a single fetched batch fans out to two subscriptions on the same webhook', async () => {
    const api = new MockAirtableApi({ payloadPages: [createdPage('rec0', 1)] })
    const poller = buildPoller(api)
    const firedA: SeedEvent[] = []
    const firedB: SeedEvent[] = []
    poller.subscribe(
      'record.created',
      { baseId: 'app1', tableId: 'tblA', webhookId: WEBHOOK },
      (e) => firedA.push(e)
    )
    poller.subscribe(
      'record.created',
      { baseId: 'app1', tableId: 'tblB', webhookId: WEBHOOK },
      (e) => firedB.push(e)
    )
    await poller.tick() // baseline for the shared webhook group
    const callsAfterBaseline = api.calls.listWebhookPayloads.length

    // One batch touches BOTH tables; both subs share webhook achW.
    api.data.payloadPages = [
      {
        payloads: [
          {
            baseTransactionNumber: 2,
            changedTablesById: {
              tblA: { createdRecordsById: { recA: { cellValuesByFieldName: { X: 1 } } } },
              tblB: { createdRecordsById: { recB: { cellValuesByFieldName: { Y: 2 } } } }
            }
          }
        ],
        cursor: 2,
        mightHaveMore: false
      }
    ]
    await nextTick(poller)
    expect(firedA.map((f) => f.eventId)).toEqual(['created:recA:2'])
    expect(firedB.map((f) => f.eventId)).toEqual(['created:recB:2'])
    // Exactly ONE additional /payloads fetch served both subscriptions.
    expect(api.calls.listWebhookPayloads.length).toBe(callsAfterBaseline + 1)
  })
})

describe('at-least-once idempotency — persist failure does not double-seed (spec §4.2)', () => {
  class FlakyCursorStore extends AirtableCursorStore {
    failNext = false
    set(key: string, cursor: Parameters<AirtableCursorStore['set']>[1]): void {
      if (this.failNext) {
        this.failNext = false
        throw new Error('Couldn’t persist the Airtable poll cursor — disk full (ENOSPC).')
      }
      super.set(key, cursor)
    }
  }

  it('an emitted change whose cursor persist FAILS is not re-seeded on the re-fetch', async () => {
    const cursors = new FlakyCursorStore({ file: join(dir, 'cursors.json') })
    const api = new MockAirtableApi({ payloadPages: [] })
    const logs: string[] = []
    const poller = buildPoller(api, cursors, (m) => logs.push(m))
    const fired: SeedEvent[] = []
    poller.subscribe(
      'record.created',
      { baseId: 'app1', tableId: TABLE, webhookId: WEBHOOK },
      (e) => fired.push(e)
    )
    await poller.tick() // baseline (empty)

    // A new record arrives; the cursor persist AFTER its emit fails this tick.
    api.data.payloadPages = [createdPage('rec1', 2, { txn: 2 })]
    cursors.failNext = true
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['created:rec1:2']) // handed off once
    expect(logs.join('\n')).toMatch(/poll failed|ENOSPC/i) // degradation announced

    // The cursor never durably advanced, so the SAME page is re-fetched next tick;
    // the in-poller seen-set must stop it re-seeding the same change.
    api.data.payloadPages = [createdPage('rec1', 2, { txn: 2 })]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['created:rec1:2'])
  })
})

describe('degradation is announced, cursor not advanced (spec §9)', () => {
  it('a failing tick logs loudly and does NOT advance the cursor; the next tick recovers', async () => {
    const api = new MockAirtableApi({ payloadPages: [createdPage('rec1', 3)] })
    const cursors = cursorStore()
    const logs: string[] = []
    const poller = buildPoller(api, cursors, (m) => logs.push(m))
    const fired: SeedEvent[] = []
    poller.subscribe(
      'record.created',
      { baseId: 'app1', tableId: TABLE, webhookId: WEBHOOK },
      (e) => fired.push(e)
    )
    await poller.tick() // baseline → cursor 3
    expect(cursors.get(WEBHOOK)?.cursor).toBe(3)

    // The next poll ERRORS: a new record would arrive but the fetch throws.
    api.data.payloadPages = [createdPage('rec2', 4, { txn: 2 })]
    api.data.payloadsError = 'Airtable host unreachable (ECONNREFUSED)'
    await nextTick(poller)
    expect(fired).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/poll failed.*ECONNREFUSED/i)
    expect(logs.join('\n')).toMatch(/not advanced/i)
    expect(cursors.get(WEBHOOK)?.cursor).toBe(3) // UNCHANGED — worked late, never lost

    // Recovery: the poll succeeds and fires the change it deferred.
    api.data.payloadsError = undefined
    api.data.payloadPages = [createdPage('rec2', 4, { txn: 2 })]
    await nextTick(poller)
    expect(fired.map((f) => f.eventId)).toEqual(['created:rec2:2'])
  })

  it('a missing webhookId announces degradation (does not throw out of the tick)', async () => {
    const api = new MockAirtableApi({})
    const logs: string[] = []
    const poller = buildPoller(api, cursorStore(), (m) => logs.push(m))
    poller.subscribe('record.created', { baseId: 'app1', tableId: TABLE }, () => {})
    await poller.tick()
    expect(logs.join('\n')).toMatch(/needs a 'webhookId'/)
  })
})

describe('restart-resume (spec §4.3)', () => {
  it('rehydrates from the persisted cursor: no missed and no re-fired changes', async () => {
    const api = new MockAirtableApi({ payloadPages: [createdPage('rec1', 5)] })
    const poller1 = buildPoller(api, cursorStore())
    const fired1: SeedEvent[] = []
    poller1.subscribe(
      'record.created',
      { baseId: 'app1', tableId: TABLE, webhookId: WEBHOOK },
      (e) => fired1.push(e)
    )
    await poller1.tick() // baseline → cursor 5

    // "Restart": a NEW poller + cursor store reads the sidecar; the cursor is 5,
    // so a re-subscribe does NOT re-baseline and an empty stream does NOT re-fire.
    const poller2 = buildPoller(api, cursorStore())
    const fired2: SeedEvent[] = []
    poller2.subscribe(
      'record.created',
      { baseId: 'app1', tableId: TABLE, webhookId: WEBHOOK },
      (e) => fired2.push(e)
    )
    await poller2.tick() // stream empty past cursor 5 → NO re-fire
    expect(fired2).toHaveLength(0)

    api.data.payloadPages = [createdPage('rec9', 6, { txn: 9 })]
    await nextTick(poller2)
    expect(fired2.map((f) => f.eventId)).toEqual(['created:rec9:9'])
  })
})
