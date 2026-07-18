import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowEngine } from '../../src/main/flow/flow-engine'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { SlackConnector } from '../../src/main/slack/slack-connector'
import { SlackApprovalPort } from '../../src/main/slack/slack-approval-port'
import { MockSlackApi } from '../../src/main/slack/slack-client'
import { APPROVE_ACTION_ID, DENY_ACTION_ID, correlationKey } from '../../src/main/slack/slack-blocks'
import type { FlowGraph, RunEvent } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7, §12): the REAL FlowEngine + the REAL
 * gate-runner + the REAL SlackApprovalPort, driven over a MockSlackApi — no
 * credentials, no network. Proves the headline loop: a flow reaching a `gate`
 * parks `needs-you` and posts to Slack; an Approve tap runs the approve edge; a
 * Deny ends the run `rejected` cleanly (a human "no" is not a failure).
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function connectedRegistry(api: MockSlackApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-slack-flow-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        slack: { enabled: true, defaultChannel: 'C-approvals', environment: 1 }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('slack', 'botToken', 'xoxb-x')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('slack', new SlackConnector({ api, defaultChannel: 'C-approvals' }))
  return registry
}

/** trigger → gate → (approve edge) → postMessage. Deny has no reject edge. */
const gatedFlow: FlowGraph = {
  id: 'refund-approval',
  name: 'gated refund',
  nodes: [
    { id: 't', type: 'trigger', integration: 'slack', ref: 'message.received', config: {}, position: { x: 0, y: 0 } },
    { id: 'g', type: 'gate', config: { prompt: 'Approve the refund?' }, position: { x: 0, y: 0 } },
    {
      id: 'post',
      type: 'action',
      integration: 'slack',
      ref: 'postMessage',
      config: { params: { text: 'Refund approved — proceeding.' } },
      position: { x: 0, y: 0 }
    }
  ],
  edges: [
    { id: 'e1', from: 't', to: 'g' },
    { id: 'e2', from: 'g', to: 'post', condition: { field: 'g.approved', op: 'truthy' } }
  ]
}

function buildEngine(api: MockSlackApi): { engine: FlowEngine; port: SlackApprovalPort; events: RunEvent[] } {
  const registry = connectedRegistry(api)
  const port = new SlackApprovalPort({ api, channel: 'C-approvals' })
  const engine = new FlowEngine({
    flows: [gatedFlow],
    config: { enabled: true, environment: 1, maxConcurrentPanes: 2 },
    registry,
    approvals: port,
    driver: {} as never,
    manager: { peek: () => [], get: () => undefined } as never,
    now: () => 1_000
  })
  const events: RunEvent[] = []
  engine.onEvent((e) => events.push(e))
  return { engine, port, events }
}

/** Await until the port has parked exactly one pending gate (the post resolves). */
async function untilPending(port: SlackApprovalPort): Promise<void> {
  await vi.waitFor(() => expect(port.pendingCount()).toBe(1))
}

const tap = (actionId: string, runId: string, user = 'U7'): unknown => ({
  type: 'block_actions',
  user: { id: user },
  channel: { id: 'C-approvals' },
  message: { ts: '1001.000100' },
  actions: [{ action_id: actionId, value: correlationKey(runId, 'g') }]
})

describe('offline Slack approval loop through the real engine', () => {
  it('parks needs-you at the gate, posts to Slack, and runs the approve edge on Approve', async () => {
    const api = new MockSlackApi()
    const { engine, port } = buildEngine(api)
    const started = engine.run(gatedFlow, { eventId: 'evt1', payload: { text: 'refund pls' } })
    expect(started.ok).toBe(true)
    const runId = started.ok ? started.runId : ''

    await untilPending(port)
    expect(engine.getRun(runId)?.status).toBe('needs-you')
    expect(api.calls.postMessage.some((p) => p.channel === 'C-approvals')).toBe(true)

    port.handleInteraction(tap(APPROVE_ACTION_ID, runId))
    await vi.waitFor(() => expect(engine.getRun(runId)?.status).toBe('done'))
    // The gated postMessage action ran (a second post, after the approval post).
    expect(api.calls.postMessage.some((p) => p.text === 'Refund approved — proceeding.')).toBe(true)
  })

  it('ends the run rejected (clean stop) on Deny — a human "no" is not a failure', async () => {
    const api = new MockSlackApi()
    const { engine, port } = buildEngine(api)
    const started = engine.run(gatedFlow, { eventId: 'evt2', payload: { text: 'refund pls' } })
    const runId = started.ok ? started.runId : ''

    await untilPending(port)
    port.handleInteraction(tap(DENY_ACTION_ID, runId))
    await vi.waitFor(() => expect(engine.getRun(runId)?.status).toBe('rejected'))
    // The gated action never ran — only the approval post exists.
    expect(api.calls.postMessage.every((p) => p.text !== 'Refund approved — proceeding.')).toBe(true)
  })
})
