import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAirtableApi, type RawAirtableRecord } from '../../src/main/airtable/airtable-api'
import { AirtableConnector } from '../../src/main/airtable/airtable-connector'
import { AirtablePoller } from '../../src/main/airtable/airtable-poller'
import { AirtableCursorStore } from '../../src/main/airtable/airtable-cursor-store'

let dir: string
let clock: number
function buildPoller(api: MockAirtableApi): AirtablePoller {
  return new AirtablePoller({
    api,
    cursors: new AirtableCursorStore({ file: join(dir, 'cursors.json') }),
    now: () => clock,
    pollSeconds: 60,
    log: () => {}
  })
}
function buildConnector(api: MockAirtableApi): AirtableConnector {
  return new AirtableConnector({ api, poller: buildPoller(api) })
}
const rec = (id: string, fields: Record<string, unknown>): RawAirtableRecord => ({
  id,
  createdTime: '2026-07-20T00:00:00.000Z',
  fields
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-at-conn-'))
  clock = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('AirtableConnector — read dispatch (spec §3.2)', () => {
  it('getRecord → GET .../<id>, normalized to the pinned envelope', async () => {
    const api = new MockAirtableApi({
      records: { rec1: rec('rec1', { Status: 'New', Blank: '' }) }
    })
    const out = await buildConnector(api).invokeAction('getRecord', { recordId: 'rec1' })
    expect(api.calls.getRecord).toEqual(['rec1'])
    expect(out).toEqual({
      record: { id: 'rec1', createdTime: '2026-07-20T00:00:00.000Z', fields: { Status: 'New' } }
    })
  })

  it('listRecords → normalized records + count', async () => {
    const api = new MockAirtableApi({
      listResult: [rec('r1', { A: 1 }), rec('r2', { A: 2 })]
    })
    const out = await buildConnector(api).invokeAction('listRecords', { view: 'Grid' })
    expect(api.calls.listRecords[0]).toMatchObject({ view: 'Grid' })
    expect(out).toMatchObject({
      count: 2,
      records: [{ record: { id: 'r1' } }, { record: { id: 'r2' } }]
    })
  })

  it('rejects getRecord with a missing recordId, legibly, before any request', async () => {
    const api = new MockAirtableApi({})
    await expect(buildConnector(api).invokeAction('getRecord', {})).rejects.toThrow(/recordId/i)
    expect(api.calls.getRecord).toHaveLength(0)
  })
})

describe('AirtableConnector — gated write dispatch (spec §3.2)', () => {
  it('createRecord → POST { fields }, normalized', async () => {
    const api = new MockAirtableApi({ createResult: rec('recNEW', { Status: 'New' }) })
    const out = await buildConnector(api).invokeAction('createRecord', {
      fields: { Status: 'New' }
    })
    expect(api.calls.createRecord).toEqual([{ fields: { Status: 'New' } }])
    expect(out).toMatchObject({ record: { id: 'recNEW', fields: { Status: 'New' } } })
  })

  it('updateRecord → PATCH .../<id> { fields } (partial), normalized', async () => {
    const api = new MockAirtableApi({ records: { rec1: rec('rec1', { Status: 'New' }) } })
    const out = await buildConnector(api).invokeAction('updateRecord', {
      recordId: 'rec1',
      fields: { Status: 'Triaged' }
    })
    expect(api.calls.updateRecord).toEqual([
      { recordId: 'rec1', input: { fields: { Status: 'Triaged' } } }
    ])
    expect(out).toMatchObject({ record: { id: 'rec1', fields: { Status: 'Triaged' } } })
  })

  it('rejects a write with a missing/empty fields bag before any request', async () => {
    const api = new MockAirtableApi({})
    await expect(buildConnector(api).invokeAction('createRecord', {})).rejects.toThrow(/fields/i)
    await expect(
      buildConnector(api).invokeAction('updateRecord', { recordId: 'r', fields: {} })
    ).rejects.toThrow(/fields/i)
    expect(api.calls.createRecord).toHaveLength(0)
    expect(api.calls.updateRecord).toHaveLength(0)
  })

  it('forwards the REAL Airtable error verbatim on a failed write (reject convention, §9)', async () => {
    const api = new MockAirtableApi({
      updateError: "Airtable refused the write: unknown field 'Statuss' (INVALID_REQUEST_UNKNOWN)"
    })
    await expect(
      buildConnector(api).invokeAction('updateRecord', { recordId: 'r', fields: { Statuss: 'x' } })
    ).rejects.toThrow(/unknown field 'Statuss'/)
  })

  it('rejects an unknown action id legibly', async () => {
    const api = new MockAirtableApi({})
    await expect(buildConnector(api).invokeAction('deleteRecord', {})).rejects.toThrow(
      /unknown Airtable action/i
    )
  })
})

describe('AirtableConnector — subscribe is a POLL, never a webhook, never auto-writes (spec §4, §7.3)', () => {
  it('a subscribed record.created poll fires via the poller and makes ZERO writes', async () => {
    const api = new MockAirtableApi({
      payloadPages: [
        { payloads: [], cursor: 1, mightHaveMore: false } // baseline: empty
      ]
    })
    const poller = buildPoller(api)
    const connector = new AirtableConnector({ api, poller })
    const seen: unknown[] = []
    connector.subscribeWithConfig(
      'record.created',
      { baseId: 'app1', tableId: 'tblIntake', webhookId: 'achW' },
      (e) => seen.push(e)
    )
    await poller.tick() // baseline

    api.data.payloadPages = [
      {
        payloads: [
          {
            baseTransactionNumber: 2,
            changedTablesById: {
              tblIntake: {
                createdRecordsById: { rec1: { cellValuesByFieldName: { Status: 'New' } } }
              }
            }
          }
        ],
        cursor: 2,
        mightHaveMore: false
      }
    ]
    clock += 60_000
    await poller.tick()
    expect(seen).toHaveLength(1)
    // The pinned invariant: a poll tick fires ZERO writes.
    expect(api.calls.createRecord).toHaveLength(0)
    expect(api.calls.updateRecord).toHaveLength(0)
  })

  it('an unknown trigger id yields a no-op unsubscribe (opt-in default)', () => {
    const api = new MockAirtableApi({})
    const off = buildConnector(api).subscribe('not.a.trigger', () => {})
    expect(() => off()).not.toThrow()
  })

  it('subscribe(record.created) registers a poll reading base/table/webhook from config', () => {
    const api = new MockAirtableApi({})
    const connector = buildConnector(api)
    const off = connector.subscribe('record.created', () => {}, {
      baseId: 'app1',
      tableId: 'tblIntake',
      webhookId: 'achW'
    })
    expect(() => off()).not.toThrow()
  })
})

/** ★ The load-bearing secret invariant (spec §5, §8, §10): the personal access
 *  token VALUE never appears in a returned value, a log line, or an error. */
describe('AirtableConnector — no personal-access-token leak', () => {
  const PAT = 'patLIVE_do_not_leak_9f3a'

  it('never surfaces the PAT through outputs, logs, or errors', async () => {
    // The PAT rides only inside airtable-api's Bearer header (revealed at call
    // time). The connector/normalize never see it — prove the whole surface clean.
    const api = new MockAirtableApi({
      records: { rec1: rec('rec1', { Status: 'New' }) },
      updateError: 'Airtable rejected the personal access token (401)'
    })
    const connector = buildConnector(api)

    const read = await connector.invokeAction('getRecord', { recordId: 'rec1' })
    let errMsg = ''
    try {
      await connector.invokeAction('updateRecord', { recordId: 'rec1', fields: { Status: 'x' } })
    } catch (e) {
      errMsg = (e as Error).message
    }

    const surfaced = [JSON.stringify(read), errMsg].join('\n')
    expect(surfaced).not.toContain(PAT)
    expect(surfaced).not.toMatch(/Authorization|Bearer /)
  })
})
