import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { MockSalesforceApi } from '../../src/main/salesforce/salesforce-api'
import { SalesforceConnector } from '../../src/main/salesforce/salesforce-connector'
import { SalesforcePoller } from '../../src/main/salesforce/salesforce-poller'
import { SalesforceCursorStore } from '../../src/main/salesforce/salesforce-cursor-store'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import { subscribeTriggers } from '../../src/main/flow/trigger-subscriber'
import type { SeedEvent } from '../../src/main/flow/trigger-subscriber'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7, §9, §12): the REAL IntegrationRegistry
 * + action-runner + selectEdges routing + the REAL poller, driven over a
 * MockSalesforceApi and an INJECTED CLOCK — no credentials, no network. Proves the
 * flagship §7 CRM loop composes: a poll SeedEvent for a new Lead seeds a run →
 * getRecord writes normalized context → the router selects the high-value edge →
 * behind the author's gate the gated createTask AND submitForApproval reach the
 * mock; the low-value branch routes AWAY from the approval submit.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}
const CLIENT_SECRET = 'sfdc_consumer_SECRET_do_not_leak_9f3a'

function buildEnv(api: MockSalesforceApi) {
  const dir = mkdtempSync(join(tmpdir(), 'lf-sf-flow-'))
  const configFile = join(dir, 'config.json')
  // Enabled + all required non-secret refs, the consumer secret in the keychain →
  // status('salesforce') === 'connected' so the action-runner runs nodes.
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        salesforce: {
          enabled: true,
          clientId: '3MVG9consumerKey',
          loginUrl: 'https://login.salesforce.com',
          environment: 1
        }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('salesforce', 'clientSecret', CLIENT_SECRET)
  const registry = new IntegrationRegistry({ creds, configFile })
  let clock = 0
  const poller = new SalesforcePoller({
    api,
    cursors: new SalesforceCursorStore({ file: join(dir, 'cursors.json') }),
    now: () => clock,
    pollSeconds: 60,
    log: () => {}
  })
  const connector = new SalesforceConnector({
    api,
    poller,
    instanceUrl: 'https://acme.my.salesforce.com'
  })
  registry.registerConnector('salesforce', connector)
  return { registry, connector, poller, advance: () => (clock += 60_000) }
}

const lead = (id: string, revenue: number) => ({
  attributes: { type: 'Lead' },
  Id: id,
  CreatedDate: '2026-07-20T09:00:00Z',
  LastModifiedDate: '2026-07-20T09:00:00Z',
  Company: 'Acme',
  AnnualRevenue: revenue
})

const getRecordNode: FlowNode = {
  id: 'read',
  type: 'action',
  integration: 'salesforce',
  ref: 'getRecord',
  config: { params: { object: 'Lead', id: '{{t.record.id}}' } },
  position: { x: 0, y: 0 }
}
const createTaskNode: FlowNode = {
  id: 'task',
  type: 'action',
  integration: 'salesforce',
  ref: 'createTask',
  config: {
    params: { fields: { Subject: 'Call new high-value lead', WhoId: '{{read.record.id}}' } }
  },
  position: { x: 0, y: 0 }
}
const submitNode: FlowNode = {
  id: 'approve',
  type: 'action',
  integration: 'salesforce',
  ref: 'submitForApproval',
  config: { params: { recordId: '{{read.record.id}}', comments: 'High-value lead' } },
  position: { x: 0, y: 0 }
}

// The router: high-value (AnnualRevenue ≥ 1,000,000) → the gated task + approval
// submit; else → just the follow-up task.
const routerGraph: FlowGraph = {
  id: 'lead-worker',
  name: 'new-lead CRM worker',
  nodes: [getRecordNode],
  edges: [
    {
      id: 'high-value',
      from: 'route',
      to: 'gate',
      condition: { field: 'read.record.fields.AnnualRevenue', op: 'gte', value: 1000000 }
    },
    {
      id: 'low-value',
      from: 'route',
      to: 'task',
      condition: { field: 'read.record.fields.AnnualRevenue', op: 'lt', value: 1000000 }
    }
  ]
}

describe('offline Salesforce CRM worker loop (spec §7, §9)', () => {
  it('poll sees a new high-value Lead → read → routes high-value → gated createTask + submitForApproval hit the mock', async () => {
    const api = new MockSalesforceApi({ records: [] })
    const { registry, poller, advance } = buildEnv(api)

    // 1. The POLL trigger: subscribe, baseline empty, then a new high-value Lead.
    const seeds: SeedEvent[] = []
    poller.subscribe('record.created', { object: 'Lead' }, (e) => seeds.push(e))
    await poller.tick() // baseline — no fire
    api.data.records = [lead('00Q000000000001', 2500000)]
    api.data.record = lead('00Q000000000001', 2500000) // what getRecord returns
    advance()
    await poller.tick() // a new Lead — the run is seeded
    expect(seeds).toHaveLength(1)

    // 2. Seed context from the SeedEvent (as trigger-subscriber would).
    const seededId = (seeds[0].payload as { record: { id: string } }).record.id
    const context: RunContext = { t: { record: { id: seededId } } }

    // 3. Read via the REAL registry delegation + action-runner.
    const read = await runAction({ registry }, getRecordNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    expect(
      (context.read as { record: { fields: { AnnualRevenue: number } } }).record.fields
        .AnnualRevenue
    ).toBe(2500000)

    // 4. The router selects the HIGH-VALUE edge (revenue ≥ 1M).
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['high-value'])

    // 5. Behind the author's gate, the gated writes reach the mock. The follow-up
    // Task is created against the Task activity object; the Lead is submitted to
    // the org's Approval Process with the templated record id (a top-level param
    // the engine resolves from context — the distinctive native gate, §9).
    const task = await runAction({ registry }, createTaskNode, context)
    expect(task.status).toBe('done')
    const submit = await runAction({ registry }, submitNode, context)
    expect(submit.status).toBe('done')

    expect(api.calls.createRecord).toHaveLength(1)
    expect(api.calls.createRecord[0].object).toBe('Task')
    expect(api.calls.createRecord[0].fields).toMatchObject({ Subject: 'Call new high-value lead' })
    expect(api.calls.submitForApproval).toEqual([
      { recordId: seededId, approverId: undefined, comments: 'High-value lead' }
    ])
  })

  it('a low-value Lead routes AWAY from the approval submit', async () => {
    const api = new MockSalesforceApi({ record: lead('00Q000000000009', 50000) })
    const { registry } = buildEnv(api)
    const context: RunContext = { t: { record: { id: '00Q000000000009' } } }
    const read = await runAction({ registry }, getRecordNode, context)
    Object.assign(context, read.context)
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['low-value'])
  })

  it('fails the node with the REAL Salesforce cause when a gated write rejects (§11)', async () => {
    const api = new MockSalesforceApi({
      approvalError: 'no active Approval Process is defined for Lead (NO_APPLICABLE_PROCESS).'
    })
    const { registry } = buildEnv(api)
    const outcome = await runAction({ registry }, submitNode, {
      read: { record: { id: '00Q000000000001' } }
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/NO_APPLICABLE_PROCESS/)
  })

  it('the REAL subscribe path threads the trigger node config → a poll tick SEEDS a run', async () => {
    const api = new MockSalesforceApi({ records: [] })
    const { registry, poller, advance } = buildEnv(api)

    const triggerNode: FlowNode = {
      id: 'trig',
      type: 'trigger',
      integration: 'salesforce',
      ref: 'record.created',
      config: { object: 'Lead' },
      position: { x: 0, y: 0 }
    }
    const flow: FlowGraph = { id: 'f', name: 'poll flow', nodes: [triggerNode], edges: [] }

    const seeds: SeedEvent[] = []
    const unsub = subscribeTriggers(registry, [flow], (_flow, event) => seeds.push(event))

    await poller.tick() // baseline — no fire
    api.data.records = [lead('00Q000000000001', 2500000)]
    advance()
    await poller.tick() // a new Lead must seed a run

    expect(seeds).toHaveLength(1)
    expect((seeds[0].payload as { record: { type: string } }).record.type).toBe('Lead')
    unsub()
  })

  it('refuses any Salesforce node when the integration is not connected (before any call)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-sf-noconf-'))
    const registry = new IntegrationRegistry({
      creds: new CredentialStore({ backend, file: join(dir, 'secrets.enc') }),
      configFile: join(dir, 'config.json')
    })
    const api = new MockSalesforceApi({})
    registry.registerConnector(
      'salesforce',
      new SalesforceConnector({
        api,
        poller: new SalesforcePoller({
          api,
          cursors: new SalesforceCursorStore({ file: join(dir, 'c.json') }),
          now: () => 0
        })
      })
    )
    const outcome = await runAction({ registry }, getRecordNode, { t: { record: { id: 'x' } } })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/Salesforce/i)
  })
})
