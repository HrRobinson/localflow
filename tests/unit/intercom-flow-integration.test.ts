import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { IntercomConnector } from '../../src/main/intercom/intercom-connector'
import { MockIntercomApi, type RawConversation } from '../../src/main/intercom/intercom-api'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7, §12): the REAL IntegrationRegistry + the
 * REAL action-runner, driven over a MockIntercomApi — no credentials, no network.
 * Proves the never-auto-send loop (§9): reading the conversation writes context and
 * makes ZERO replies; only the explicit `replyToConversation` action (the node the
 * author places downstream of a gate) reaches the client, exactly once, with the
 * approved draft body.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const conversation: RawConversation = {
  id: '1001',
  state: 'open',
  contacts: { contacts: [{ id: 'c_9', email: 'buyer@x.com' }] },
  conversation_parts: {
    conversation_parts: [{ body: '<p>where is my order</p>', author: { type: 'user' } }]
  }
}

function buildRegistry(api: MockIntercomApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-intercom-flow-'))
  const configFile = join(dir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: { intercom: { enabled: true, region: 'us', environment: 1 } }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('intercom', 'accessToken', 'tok_x')
  creds.set('intercom', 'clientSecret', 'sec_x')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('intercom', new IntercomConnector({ api }))
  return registry
}

const getConversationNode: FlowNode = {
  id: 'conv',
  type: 'action',
  integration: 'intercom',
  ref: 'getConversation',
  config: { params: { id: '{{t.conversationId}}' } },
  position: { x: 0, y: 0 }
}

const replyNode: FlowNode = {
  id: 'reply',
  type: 'action',
  integration: 'intercom',
  ref: 'replyToConversation',
  config: { params: { id: '{{t.conversationId}}', body: '{{draft}}' } },
  position: { x: 0, y: 0 }
}

describe('offline Intercom read → draft → gated reply (§9)', () => {
  it('reading + composing sends NOTHING; only the gated reply reaches the client, once', async () => {
    const api = new MockIntercomApi({ conversations: { '1001': conversation } })
    const registry = buildRegistry(api)

    // 1. The verified webhook seeds context['t'] (as the connector's subscribe would).
    const context: RunContext = { t: { conversationId: '1001', contactEmail: 'buyer@x.com' } }

    // 2. getConversation through the REAL registry → normalized context. NO reply yet.
    const read = await runAction({ registry }, getConversationNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    expect(
      (context.conv as { conversation: { contactEmail: string } }).conversation.contactEmail
    ).toBe('buyer@x.com')
    // ── THE NEVER-AUTO-SEND PROOF: reading the conversation made ZERO replies. ──
    expect(api.calls.reply).toHaveLength(0)

    // 3. A template/agent node composes the draft into context — still ZERO replies.
    context.draft = 'Your order ships today — thanks for your patience!'
    expect(api.calls.reply).toHaveLength(0)

    // 4. The human approved at the gate → the reply action runs, exactly once, with
    //    the approved draft body.
    const sent = await runAction({ registry }, replyNode, context)
    expect(sent.status).toBe('done')
    expect(api.calls.reply).toHaveLength(1)
    expect(api.calls.reply[0]).toMatchObject({
      conversationId: '1001',
      body: 'Your order ships today — thanks for your patience!'
    })
  })

  it('fails the node with the real Intercom cause when the reply rejects', async () => {
    const api = new MockIntercomApi({ replyError: 'the conversation is closed' })
    const registry = buildRegistry(api)
    const outcome = await runAction({ registry }, replyNode, {
      t: { conversationId: '1001' },
      draft: 'hi'
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/the conversation is closed/)
  })
})
