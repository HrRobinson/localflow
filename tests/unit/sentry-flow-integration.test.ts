import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { SentryConnector } from '../../src/main/sentry/sentry-connector'
import { MockSentryApi, type RawSentryEvent } from '../../src/main/sentry/sentry-api'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { applyTemplate, selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §7, §12): the REAL IntegrationRegistry +
 * the REAL action-runner + the REAL routing, driven over a MockSentryApi and a
 * FAKE GitHub node that composes purely through run context — no credentials, no
 * network, no cross-connector call. Proves the flagship SENSOR → ACTUATOR → CLOSE
 * loop: an issue.created seed → getEvent writes the topInAppFrame file:line → a
 * downstream "GitHub" node reads it by dotted path and produces { prNumber,
 * mergeCommitSha } → resolveIssue closes the issue IN the fixing commit.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const crashEvent: RawSentryEvent = {
  eventID: 'ev-1',
  groupID: '4509',
  message: "Cannot read property 'id' of undefined",
  culprit: 'cart.ts in applyDiscount',
  platform: 'javascript',
  permalink: 'https://sentry.io/org/proj/issues/4509/',
  entries: [
    {
      type: 'exception',
      data: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read property 'id' of undefined",
            stacktrace: {
              frames: [
                { filename: 'node_modules/react/index.js', function: 'r', lineNo: 1, inApp: false },
                {
                  filename: 'src/checkout/cart.ts',
                  absPath: '/app/src/checkout/cart.ts',
                  function: 'applyDiscount',
                  lineNo: 88,
                  inApp: true
                }
              ]
            }
          }
        ]
      }
    }
  ]
}

function buildRegistry(api: MockSentryApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-sentry-flow-'))
  const configFile = join(dir, 'config.json')
  // Enabled + required non-secret refs present, secrets in the keychain →
  // status('sentry') === 'connected' so the action-runner lets the node run.
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        sentry: { enabled: true, orgSlug: 'my-org', projectSlug: 'frontend', environment: 1 }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('sentry', 'authToken', 'sntrys_x')
  creds.set('sentry', 'webhookSecret', 'whsec_x')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector('sentry', new SentryConnector({ api }))
  return registry
}

const getEventNode: FlowNode = {
  id: 'crash',
  type: 'action',
  integration: 'sentry',
  ref: 'getEvent',
  config: { params: { id: '{{t.issueId}}' } },
  position: { x: 0, y: 0 }
}

// Only act on our own code — the router gates on the in-app frame.
const routerGraph: FlowGraph = {
  id: 'incident-worker',
  name: 'fix on error',
  nodes: [getEventNode],
  edges: [
    {
      id: 'ours',
      from: 'route',
      to: 'openFixPR',
      condition: { field: 'crash.event.topInAppFrame.inApp', op: 'truthy', value: true }
    }
  ]
}

describe('offline Sentry → GitHub → resolve compose (§7)', () => {
  it('reads the crash, routes on the in-app frame, and closes in the fixing commit', async () => {
    const api = new MockSentryApi({ events: { '4509': crashEvent } })
    const registry = buildRegistry(api)

    // 1. The issue.created trigger seed lands in context['t'] (as subscribe would).
    const context: RunContext = { t: { issueId: '4509', shortId: 'FE-1' } }

    // 2. getEvent reads through the REAL registry delegation + action-runner and
    //    writes the normalized SentryEventContext with topInAppFrame.
    const read = await runAction({ registry }, getEventNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    const frame = (
      context.crash as { event: { topInAppFrame: { filename: string; lineNo: number } } }
    ).event.topInAppFrame
    expect(frame).toMatchObject({ filename: 'src/checkout/cart.ts', lineNo: 88 })

    // 3. The router selects the in-app edge (act only on our own code).
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['ours'])

    // 4. The GITHUB node (a downstream, sibling connector) reads the PINNED Sentry
    //    context BY DOTTED PATH — it depends on §6.3 field names, not on Sentry.
    const file = applyTemplate('{{crash.event.topInAppFrame.filename}}', context)
    const line = applyTemplate('{{crash.event.topInAppFrame.lineNo}}', context)
    const title = applyTemplate(
      'Fix: {{crash.event.exception.type}} in {{crash.event.topInAppFrame.function}}',
      context
    )
    expect(file).toBe('src/checkout/cart.ts')
    expect(line).toBe('88')
    expect(title).toBe('Fix: TypeError in applyDiscount')
    // It produces { prNumber, mergeCommitSha } into context (as after a merge).
    context.merged = { prNumber: 123, mergeCommitSha: 'deadbeefcafe', issueRef: '4509' }

    // 5. The CLOSE comes back to Sentry: resolveIssue with inCommit = the merge sha.
    const resolveNode: FlowNode = {
      id: 'resolve',
      type: 'action',
      integration: 'sentry',
      ref: 'resolveIssue',
      config: {
        params: {
          id: '{{t.issueId}}',
          statusDetails: { inCommit: { commit: 'deadbeefcafe' } }
        }
      },
      position: { x: 0, y: 0 }
    }
    const resolve = await runAction({ registry }, resolveNode, context)
    expect(resolve.status).toBe('done')
    expect(api.calls.resolveIssue).toEqual([
      { id: '4509', statusDetails: { inCommit: { commit: 'deadbeefcafe' } } }
    ])
  })

  it('fails the node with the real Sentry cause when resolve rejects', async () => {
    const api = new MockSentryApi({ resolveError: 'issue already resolved' })
    const registry = buildRegistry(api)
    const resolveNode: FlowNode = {
      id: 'resolve',
      type: 'action',
      integration: 'sentry',
      ref: 'resolveIssue',
      config: { params: { id: '4509' } },
      position: { x: 0, y: 0 }
    }
    const outcome = await runAction({ registry }, resolveNode, {})
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/already resolved/)
  })
})
