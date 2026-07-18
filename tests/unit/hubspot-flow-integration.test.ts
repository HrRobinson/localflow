import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { HubspotConnector } from '../../src/main/hubspot/hubspot-connector'
import { MockHubSpotApi, type HubSpotObject } from '../../src/main/hubspot/hubspot-api'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (§6, §10): the REAL IntegrationRegistry + the
 * REAL action-runner + the REAL selectEdges routing, driven over a MockHubSpotApi
 * — no credentials, no network. Proves the §6 flagship loop composes: a
 * contact.created seed → getContact + getCompany write normalized context → the
 * router selects the "qualified + mid-market" edge → createTask reaches the mock;
 * and that a too-small company takes the else branch (no task).
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const contact = (id: string): HubSpotObject => ({
  id,
  createdAt: '2026-07-01T00:00:00Z',
  properties: {
    email: 'ada@example.com',
    firstname: 'Ada',
    lastname: 'Lovelace',
    lifecyclestage: 'lead'
  }
})

const company = (id: string, employees: string): HubSpotObject => ({
  id,
  properties: { name: 'Globex', domain: 'globex.com', numberofemployees: employees }
})

function buildRegistry(api: MockHubSpotApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-hubspot-flow-'))
  const configFile = join(dir, 'config.json')
  // Enabled + all required non-secret refs present, secrets in the keychain →
  // status('hubspot') === 'connected' so the action-runner lets the node run.
  writeFileSync(
    configFile,
    JSON.stringify({ integrations: { hubspot: { enabled: true, environment: 1 } } })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('hubspot', 'privateAppToken', 'pat-na1-x')
  creds.set('hubspot', 'webhookClientSecret', 'whsec-x')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('hubspot', new HubspotConnector({ api }))
  return registry
}

const getContactNode: FlowNode = {
  id: 'lead',
  type: 'action',
  integration: 'hubspot',
  ref: 'getContact',
  config: { params: { id: '{{t.contactId}}' } },
  position: { x: 0, y: 0 }
}

const getCompanyNode: FlowNode = {
  id: 'co',
  type: 'action',
  integration: 'hubspot',
  ref: 'getCompany',
  config: { params: { id: '{{t.companyId}}' } },
  position: { x: 0, y: 0 }
}

const routerGraph: FlowGraph = {
  id: 'sales-worker',
  name: 'qualify + follow up',
  nodes: [getContactNode, getCompanyNode],
  edges: [
    {
      id: 'qualified',
      from: 'route',
      to: 'createTask',
      condition: { field: 'co.company.numEmployees', op: 'gte', value: 200 }
    },
    {
      id: 'tooSmall',
      from: 'route',
      to: 'logOnly',
      condition: { field: 'co.company.numEmployees', op: 'lt', value: 200 }
    }
  ]
}

describe('offline HubSpot sales loop', () => {
  it('reads contact + company, routes on the normalized employee count, then creates a task', async () => {
    const api = new MockHubSpotApi({
      contacts: { '501': contact('501') },
      companies: { '900': company('900', '250') }
    })
    const registry = buildRegistry(api)

    // 1. Trigger seed lands in context['t'] (as the webhook subscribe would).
    const context: RunContext = { t: { contactId: '501', companyId: '900' } }

    // 2. Enrich through the REAL registry delegation + action-runner.
    const read = await runAction({ registry }, getContactNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    expect((context.lead as { contact: { name: string } }).contact.name).toBe('Ada Lovelace')

    const co = await runAction({ registry }, getCompanyNode, context)
    Object.assign(context, co.context)
    expect((context.co as { company: { numEmployees: number } }).company.numEmployees).toBe(250)

    // 3. The router selects the qualified (mid-market+) edge, not the too-small one.
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['qualified'])

    // 4. The gated write reaches the api client.
    const taskNode: FlowNode = {
      id: 'createTask',
      type: 'action',
      integration: 'hubspot',
      ref: 'createTask',
      config: {
        params: { subject: 'Follow up with {{lead.contact.name}}', contactId: '{{t.contactId}}' }
      },
      position: { x: 0, y: 0 }
    }
    const task = await runAction({ registry }, taskNode, context)
    expect(task.status).toBe('done')
    expect(api.calls.createTask[0]).toMatchObject({
      subject: 'Follow up with Ada Lovelace',
      contactId: '501'
    })
  })

  it('routes a too-small company to the else branch (no task edge)', async () => {
    const api = new MockHubSpotApi({
      contacts: { '7': contact('7') },
      companies: { '8': company('8', '12') }
    })
    const registry = buildRegistry(api)
    const context: RunContext = { t: { contactId: '7', companyId: '8' } }
    const co = await runAction({ registry }, getCompanyNode, context)
    Object.assign(context, co.context)
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['tooSmall'])
  })

  it('fails the node with the real HubSpot cause when a write rejects', async () => {
    const api = new MockHubSpotApi({
      createTaskError: 'HubSpot rejected the request (400): invalid owner'
    })
    const registry = buildRegistry(api)
    const taskNode: FlowNode = {
      id: 'createTask',
      type: 'action',
      integration: 'hubspot',
      ref: 'createTask',
      config: { params: { subject: 'x' } },
      position: { x: 0, y: 0 }
    }
    const outcome = await runAction({ registry }, taskNode, {})
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/invalid owner/)
  })
})
