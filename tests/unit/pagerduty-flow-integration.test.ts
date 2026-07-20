import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { PagerDutyConnector } from '../../src/main/pagerduty/pagerduty-connector'
import { MockPagerDutyApi, type RawPagerDutyIncident } from '../../src/main/pagerduty/pagerduty-api'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7, §12): the REAL IntegrationRegistry +
 * the REAL action-runner + the REAL routing, driven over a MockPagerDutyApi — no
 * credentials, no network. Proves the on-call spine: an incident.triggered seed →
 * getIncident writes the pinned context → a router gates on urgency → a gated
 * addNote records the diagnosis → resolveIncident closes it. Crucially it asserts
 * the AUTHORITY invariant: no write fires except through an explicit action node
 * the author placed (§9).
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const incident: RawPagerDutyIncident = {
  id: 'PABC123',
  incident_number: 42,
  title: 'API 500s spiking',
  status: 'triggered',
  urgency: 'high',
  service: { id: 'PSVC01', summary: 'Checkout API' },
  html_url: 'https://acme.pagerduty.com/incidents/PABC123'
}

function buildRegistry(api: MockPagerDutyApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-pd-flow-'))
  const configFile = join(dir, 'config.json')
  // Enabled + required non-secret refs present, secrets in the keychain →
  // status('pagerduty') === 'connected' so the action-runner lets the node run.
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        pagerduty: {
          enabled: true,
          fromEmail: 'bot@acme.com',
          region: 'us',
          environment: 1
        }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('pagerduty', 'apiKey', 'pd_key_x')
  creds.set('pagerduty', 'webhookSecret', 'pd_whsec_x')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('pagerduty', new PagerDutyConnector({ api }))
  return registry
}

const getIncidentNode: FlowNode = {
  id: 'inc',
  type: 'action',
  integration: 'pagerduty',
  ref: 'getIncident',
  config: { params: { id: '{{t.incidentId}}' } },
  position: { x: 0, y: 0 }
}

// Only work high-urgency pages — the router gates on the normalized enum.
const routerGraph: FlowGraph = {
  id: 'oncall-worker',
  name: 'triage on page',
  nodes: [getIncidentNode],
  edges: [
    {
      id: 'high',
      from: 'route',
      to: 'triage',
      condition: { field: 'inc.incident.urgency', op: 'eq', value: 'high' }
    }
  ]
}

describe('offline PagerDuty on-call loop (§7)', () => {
  it('reads the page, routes on urgency, and only writes through gated action nodes', async () => {
    const api = new MockPagerDutyApi(
      { incidents: { PABC123: incident } },
      { fromEmail: 'bot@acme.com' }
    )
    const registry = buildRegistry(api)

    // 1. The incident.triggered seed lands in context['t'] (as subscribe would).
    const context: RunContext = { t: { incidentId: 'PABC123' } }

    // 2. getIncident reads through the REAL registry delegation + action-runner and
    //    writes the normalized PagerDutyIncidentContext.
    const read = await runAction({ registry }, getIncidentNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    const inc = (context.inc as { incident: { id: string; urgency: string } }).incident
    expect(inc).toMatchObject({ id: 'PABC123', urgency: 'high' })

    // 3. The router selects the high-urgency edge (deterministic value compare).
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['high'])

    // ★ AUTHORITY: no write has fired — reading + routing touched NO mutation.
    expect(api.calls.acknowledgeIncident).toEqual([])
    expect(api.calls.resolveIncident).toEqual([])
    expect(api.calls.escalateIncident).toEqual([])
    expect(api.calls.addNote).toEqual([])

    // 4. The author's GATED note node records the diagnosis (a mutation node).
    const addNoteNode: FlowNode = {
      id: 'note',
      type: 'action',
      integration: 'pagerduty',
      ref: 'addNote',
      config: {
        params: { id: '{{inc.incident.id}}', note: 'localflow triaged: likely a null guard.' }
      },
      position: { x: 0, y: 0 }
    }
    const noted = await runAction({ registry }, addNoteNode, context)
    expect(noted.status).toBe('done')
    expect(api.calls.addNote).toEqual([
      { id: 'PABC123', note: 'localflow triaged: likely a null guard.' }
    ])

    // 5. The CLOSE: a gated resolveIncident node closes the page.
    const resolveNode: FlowNode = {
      id: 'resolve',
      type: 'action',
      integration: 'pagerduty',
      ref: 'resolveIncident',
      config: { params: { id: '{{inc.incident.id}}' } },
      position: { x: 0, y: 0 }
    }
    const resolved = await runAction({ registry }, resolveNode, context)
    expect(resolved.status).toBe('done')
    expect(api.calls.resolveIncident).toEqual([{ id: 'PABC123' }])
  })

  it('fails the node with the real PagerDuty cause when escalate rejects (top-of-policy)', async () => {
    const api = new MockPagerDutyApi(
      { escalateError: 'Incident is at the maximum escalation level' },
      { fromEmail: 'bot@acme.com' }
    )
    const registry = buildRegistry(api)
    const escalateNode: FlowNode = {
      id: 'escalate',
      type: 'action',
      integration: 'pagerduty',
      ref: 'escalateIncident',
      config: { params: { id: 'PABC123' } },
      position: { x: 0, y: 0 }
    }
    const outcome = await runAction({ registry }, escalateNode, {})
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/maximum escalation level/)
  })
})
