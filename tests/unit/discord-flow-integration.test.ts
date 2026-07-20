import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowEngine } from '../../src/main/flow/flow-engine'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { DiscordConnector } from '../../src/main/discord/discord-connector'
import { DiscordApprovalPort } from '../../src/main/discord/discord-approval-port'
import { MockDiscordApi } from '../../src/main/discord/discord-client'
import { encodeCustomId } from '../../src/main/discord/discord-components'
import type { FlowGraph, RunEvent } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7, §12): the REAL FlowEngine + the REAL
 * gate-runner + the REAL DiscordApprovalPort, driven over a MockDiscordApi — no
 * credentials, no network. Proves the headline loop: a flow reaching a `gate`
 * parks `needs-you` and posts to Discord; an Approve tap runs the approve edge; a
 * Deny ends the run `rejected` cleanly (a human "no" is not a failure).
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

function connectedRegistry(api: MockDiscordApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-discord-flow-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        discord: {
          enabled: true,
          guildId: 'G1',
          defaultChannel: 'C-approvals',
          environment: 1
        }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('discord', 'botToken', 'the-bot-token')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector(
    'discord',
    new DiscordConnector({ api, defaultChannel: 'C-approvals' })
  )
  return registry
}

/** trigger → gate → (approve edge) → postMessage. Deny has no reject edge. */
const gatedFlow: FlowGraph = {
  id: 'refund-approval',
  name: 'gated refund',
  nodes: [
    {
      id: 't',
      type: 'trigger',
      integration: 'discord',
      ref: 'message.received',
      config: {},
      position: { x: 0, y: 0 }
    },
    { id: 'g', type: 'gate', config: { prompt: 'Approve the refund?' }, position: { x: 0, y: 0 } },
    {
      id: 'post',
      type: 'action',
      integration: 'discord',
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

function buildEngine(api: MockDiscordApi): {
  engine: FlowEngine
  port: DiscordApprovalPort
  events: RunEvent[]
} {
  const registry = connectedRegistry(api)
  const port = new DiscordApprovalPort({ api, channel: 'C-approvals' })
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

async function untilPending(port: DiscordApprovalPort): Promise<void> {
  await vi.waitFor(() => expect(port.pendingCount()).toBe(1))
}

const tap = (action: 'approve' | 'deny', runId: string, user = 'U7'): unknown => ({
  id: 'i-x',
  token: 't-x',
  type: 3,
  channel_id: 'C-approvals',
  member: { user: { id: user } },
  message: { id: 'msg-1' },
  data: { custom_id: encodeCustomId(action, runId, 'g') }
})

describe('offline Discord approval loop through the real engine', () => {
  it('parks needs-you at the gate, posts to Discord, and runs the approve edge on Approve', async () => {
    const api = new MockDiscordApi()
    const { engine, port } = buildEngine(api)
    const started = engine.run(gatedFlow, { eventId: 'evt1', payload: { text: 'refund pls' } })
    expect(started.ok).toBe(true)
    const runId = started.ok ? started.runId : ''

    await untilPending(port)
    expect(engine.getRun(runId)?.status).toBe('needs-you')
    expect(api.calls.postMessage.some((p) => p.channelId === 'C-approvals')).toBe(true)

    port.handleInteraction(tap('approve', runId))
    await vi.waitFor(() => expect(engine.getRun(runId)?.status).toBe('done'))
    expect(
      api.calls.postMessage.some((p) => p.body.content === 'Refund approved — proceeding.')
    ).toBe(true)
  })

  it('ends the run rejected (clean stop) on Deny — a human "no" is not a failure', async () => {
    const api = new MockDiscordApi()
    const { engine, port } = buildEngine(api)
    const started = engine.run(gatedFlow, { eventId: 'evt2', payload: { text: 'refund pls' } })
    const runId = started.ok ? started.runId : ''

    await untilPending(port)
    port.handleInteraction(tap('deny', runId))
    await vi.waitFor(() => expect(engine.getRun(runId)?.status).toBe('rejected'))
    expect(
      api.calls.postMessage.every((p) => p.body.content !== 'Refund approved — proceeding.')
    ).toBe(true)
  })
})
