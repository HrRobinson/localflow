import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockSalesforceApi } from '../../src/main/salesforce/salesforce-api'
import { SalesforceConnector } from '../../src/main/salesforce/salesforce-connector'
import { SalesforcePoller } from '../../src/main/salesforce/salesforce-poller'
import { SalesforceCursorStore } from '../../src/main/salesforce/salesforce-cursor-store'

let dir: string
let clock: number
function buildPoller(api: MockSalesforceApi): SalesforcePoller {
  return new SalesforcePoller({
    api,
    cursors: new SalesforceCursorStore({ file: join(dir, 'cursors.json') }),
    now: () => clock,
    pollSeconds: 120,
    log: () => {}
  })
}
function buildConnector(api: MockSalesforceApi): SalesforceConnector {
  return new SalesforceConnector({
    api,
    poller: buildPoller(api),
    instanceUrl: 'https://acme.my.salesforce.com'
  })
}

const LEAD = {
  attributes: { type: 'Lead' },
  Id: '00Q000000000001',
  CreatedDate: '2026-07-18T09:00:00.000+0000',
  LastModifiedDate: '2026-07-19T12:30:00.000+0000',
  Company: 'Acme',
  AnnualRevenue: 2500000
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lf-sf-conn-'))
  clock = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SalesforceConnector — read dispatch (spec §6.2)', () => {
  it('getRecord → GET sobjects/<object>/<id>, normalized to record.*', async () => {
    const api = new MockSalesforceApi({ record: LEAD })
    const out = await buildConnector(api).invokeAction('getRecord', {
      object: 'Lead',
      id: '00Q000000000001'
    })
    expect(api.calls.getRecord).toEqual([
      { object: 'Lead', id: '00Q000000000001', fields: undefined }
    ])
    expect(out).toMatchObject({
      record: { type: 'Lead', fields: { Company: 'Acme', AnnualRevenue: 2500000 } }
    })
    // The 18-char widening + Lightning URL are applied by the normalize boundary.
    expect((out as { record: { id: string } }).record.id).toHaveLength(18)
  })

  it('query → SOQL result normalized to { records, count, done }', async () => {
    const api = new MockSalesforceApi({ records: [LEAD] })
    const out = await buildConnector(api).invokeAction('query', {
      soql: 'SELECT Id, Company FROM Lead'
    })
    expect(api.calls.query).toEqual(['SELECT Id, Company FROM Lead'])
    expect(out).toMatchObject({ count: 1, done: true, records: [{ type: 'Lead' }] })
  })

  it('rejects a read with a missing object/id/soql legibly, before any request', async () => {
    const api = new MockSalesforceApi({})
    await expect(buildConnector(api).invokeAction('getRecord', { object: 'Lead' })).rejects.toThrow(
      /needs a record 'id'/
    )
    await expect(buildConnector(api).invokeAction('query', {})).rejects.toThrow(/needs a 'soql'/)
    expect(api.calls.getRecord).toHaveLength(0)
  })
})

describe('SalesforceConnector — gated write dispatch (spec §6.2, §9)', () => {
  it('createRecord → POST sobjects/<object> with the fields, returns the new id', async () => {
    const api = new MockSalesforceApi({ createdId: '00Q000000000ABC' })
    const out = await buildConnector(api).invokeAction('createRecord', {
      object: 'Lead',
      fields: { Company: 'NewCo', LastName: 'Doe' }
    })
    expect(api.calls.createRecord).toEqual([
      { object: 'Lead', fields: { Company: 'NewCo', LastName: 'Doe' } }
    ])
    expect(out).toEqual({ id: '00Q000000000ABC', success: true })
  })

  it('createTask → POST sobjects/Task (the typed Task specialization)', async () => {
    const api = new MockSalesforceApi({})
    await buildConnector(api).invokeAction('createTask', {
      fields: { Subject: 'Call new lead', WhoId: '00Q000000000001' }
    })
    expect(api.calls.createRecord).toEqual([
      { object: 'Task', fields: { Subject: 'Call new lead', WhoId: '00Q000000000001' } }
    ])
    expect(api.calls.createRecord[0].object).toBe('Task')
  })

  it('updateRecord → PATCH sobjects/<object>/<id> with the fields', async () => {
    const api = new MockSalesforceApi({})
    const out = await buildConnector(api).invokeAction('updateRecord', {
      object: 'Lead',
      id: '00Q000000000001',
      fields: { Status: 'Working' }
    })
    expect(api.calls.updateRecord).toEqual([
      { object: 'Lead', id: '00Q000000000001', fields: { Status: 'Working' } }
    ])
    expect(out).toEqual({ id: '00Q000000000001', success: true })
  })

  it('submitForApproval → POST process/approvals with a Submit request (native gate, §9)', async () => {
    const api = new MockSalesforceApi({})
    const out = await buildConnector(api).invokeAction('submitForApproval', {
      recordId: '00Q000000000001',
      comments: 'High-value lead — please review'
    })
    expect(api.calls.submitForApproval).toEqual([
      {
        recordId: '00Q000000000001',
        approverId: undefined,
        comments: 'High-value lead — please review'
      }
    ])
    expect(out).toMatchObject({ success: true, instanceStatus: 'Pending' })
  })

  it('forwards the REAL Salesforce error verbatim on a failed write (reject convention, §11)', async () => {
    const api = new MockSalesforceApi({
      approvalError:
        "Salesforce couldn't submit for approval: it's already in an approval process (ALREADY_IN_PROCESS)."
    })
    await expect(
      buildConnector(api).invokeAction('submitForApproval', { recordId: '00Q000000000001' })
    ).rejects.toThrow(/ALREADY_IN_PROCESS/)
  })

  it('a missing id/fields REJECTS (async), never a sync throw, before the mock is called', async () => {
    const api = new MockSalesforceApi({})
    await expect(
      buildConnector(api).invokeAction('createRecord', { object: 'Lead' })
    ).rejects.toThrow(/needs a non-empty 'fields'/)
    await expect(buildConnector(api).invokeAction('submitForApproval', {})).rejects.toThrow(
      /needs a 'recordId'/
    )
    expect(api.calls.createRecord).toHaveLength(0)
    expect(api.calls.submitForApproval).toHaveLength(0)
  })

  it('rejects an unknown action id legibly', async () => {
    const api = new MockSalesforceApi({})
    await expect(buildConnector(api).invokeAction('deleteEverything', {})).rejects.toThrow(
      /Salesforce has no action 'deleteEverything'/
    )
  })
})

describe('SalesforceConnector — subscribe is a POLL, never a webhook, never auto-mutates (§7, §9)', () => {
  it('a subscribed record.created poll fires via the poller and makes ZERO writes', async () => {
    const api = new MockSalesforceApi({ records: [] })
    const poller = buildPoller(api)
    const connector = new SalesforceConnector({ api, poller })
    const seen: unknown[] = []
    connector.subscribeWithConfig('record.created', { object: 'Lead' }, (e) => seen.push(e))

    await poller.tick() // baseline (no records) — no fire
    api.data.records = [LEAD]
    clock += 120_000
    await poller.tick() // a new Lead → one fire, and crucially NO write of any kind
    expect(seen).toHaveLength(1)
    expect(api.calls.createRecord).toHaveLength(0)
    expect(api.calls.updateRecord).toHaveLength(0)
    expect(api.calls.submitForApproval).toHaveLength(0)
  })

  it('an unknown trigger id yields a no-op unsubscribe (opt-in default)', () => {
    const api = new MockSalesforceApi({})
    const off = buildConnector(api).subscribe('not.a.trigger', () => {})
    expect(() => off()).not.toThrow()
  })
})
