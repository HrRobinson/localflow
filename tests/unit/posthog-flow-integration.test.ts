import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { MockPostHogApi } from '../../src/main/posthog/posthog-api'
import { PostHogConnector } from '../../src/main/posthog/posthog-connector'
import { PostHogPoller } from '../../src/main/posthog/posthog-poller'
import { PostHogCursorStore } from '../../src/main/posthog/posthog-cursor-store'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { SeedEvent } from '../../src/main/flow/trigger-subscriber'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (spec §9, §12): the REAL IntegrationRegistry +
 * the REAL action-runner + the REAL selectEdges routing + the REAL poller, driven
 * over a MockPostHogApi and an INJECTED CLOCK — no credentials, no network. Proves
 * the flagship §9 loop composes: an insight crossing 2% (seen by the poll) seeds a
 * run → getInsight/getFeatureFlag write normalized context → the router selects
 * the severe edge → the gated updateFeatureFlag reaches the mock (flag rolled back
 * to 0% / disabled) ONLY on the severe branch.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}
const PERSONAL_KEY = 'phx_live_SECRET_do_not_leak_9f3a'

function buildEnv(api: MockPostHogApi) {
  const dir = mkdtempSync(join(tmpdir(), 'lf-ph-flow-'))
  const configFile = join(dir, 'config.json')
  // Enabled + all required non-secret refs present, the personal key in the
  // keychain → status('posthog') === 'connected' so the action-runner runs nodes.
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        posthog: {
          enabled: true,
          projectApiKey: 'phc_public',
          host: 'https://us.posthog.com',
          environment: 1
        }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('posthog', 'personalApiKey', PERSONAL_KEY)
  const registry = new IntegrationRegistry({ creds, configFile })
  let clock = 0
  const poller = new PostHogPoller({
    api,
    cursors: new PostHogCursorStore({ file: join(dir, 'cursors.json') }),
    now: () => clock,
    log: () => {}
  })
  const connector = new PostHogConnector({ api, poller })
  registry.registerConnector('posthog', connector)
  return { registry, connector, poller, advance: () => (clock += 60_000) }
}

const getInsightNode: FlowNode = {
  id: 'read',
  type: 'action',
  integration: 'posthog',
  ref: 'getInsight',
  config: { params: { insightId: '{{t.insightId}}' } },
  position: { x: 0, y: 0 }
}
const getFlagNode: FlowNode = {
  id: 'flag',
  type: 'action',
  integration: 'posthog',
  ref: 'getFeatureFlag',
  config: { params: { flagId: 'ff-1' } },
  position: { x: 0, y: 0 }
}
const rollbackNode: FlowNode = {
  id: 'act',
  type: 'action',
  integration: 'posthog',
  ref: 'updateFeatureFlag',
  config: { params: { flagId: '{{flag.flag.id}}', active: false, rolloutPercentage: 0 } },
  position: { x: 0, y: 0 }
}

// The router: severe (value ≥ 5) → the gated rollback; else → gather/notify.
const routerGraph: FlowGraph = {
  id: 'flag-rollback',
  name: 'flag error-rate rollback',
  nodes: [getInsightNode],
  edges: [
    {
      id: 'severe',
      from: 'route',
      to: 'gate',
      condition: { field: 'read.insight.value', op: 'gte', value: 5 }
    },
    {
      id: 'elevated',
      from: 'route',
      to: 'gather',
      condition: { field: 'read.insight.value', op: 'lt', value: 5 }
    }
  ]
}

describe('offline PostHog product-analytics loop (spec §9)', () => {
  it('poll sees the insight cross 2% → reads → routes severe → gated rollback PATCHes the mock', async () => {
    // The insight sits at 1% (below), then jumps to 6% (severe).
    const api = new MockPostHogApi({
      insight: { id: 'ins-1', name: 'checkout error rate', value: 1, unit: '%' },
      flag: { id: 'ff-1', key: 'new-checkout', active: true, rollout_percentage: 100 }
    })
    const { registry, poller, advance } = buildEnv(api)

    // 1. The POLL trigger: subscribe, baseline, then cross the 2% threshold.
    const seeds: SeedEvent[] = []
    poller.subscribe('insight.threshold', { insightId: 'ins-1', threshold: 2 }, (e) =>
      seeds.push(e)
    )
    await poller.tick() // baseline 1% — no fire
    api.data.insight = { id: 'ins-1', name: 'checkout error rate', value: 6, unit: '%' }
    advance()
    await poller.tick() // 1 → 6 crosses 2 — the run is seeded
    expect(seeds).toHaveLength(1)

    // 2. Seed context from the SeedEvent (as trigger-subscriber would).
    const context: RunContext = { t: { insightId: String(seeds[0].payload.insightId) } }

    // 3. Reads via the REAL registry delegation + action-runner.
    const read = await runAction({ registry }, getInsightNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    expect((context.read as { insight: { value: number } }).insight.value).toBe(6)

    const flag = await runAction({ registry }, getFlagNode, context)
    Object.assign(context, flag.context)
    expect((context.flag as { flag: { id: string } }).flag.id).toBe('ff-1')

    // 4. The router selects the SEVERE edge (value 6 ≥ 5), not the elevated one.
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['severe'])

    // 5. Behind the author's gate, the rollback reaches the mock: flag → 0%/disabled.
    const act = await runAction({ registry }, rollbackNode, context)
    expect(act.status).toBe('done')
    expect(api.calls.updateFeatureFlag).toEqual([
      { id: 'ff-1', patch: { active: false, rolloutPercentage: 0 } }
    ])
  })

  it('an elevated-but-not-severe value (3%) routes AWAY from the gated rollback', async () => {
    const api = new MockPostHogApi({
      insight: { id: 'ins-1', name: 'rate', value: 3, unit: '%' }
    })
    const { registry } = buildEnv(api)
    const context: RunContext = { t: { insightId: 'ins-1' } }
    const read = await runAction({ registry }, getInsightNode, context)
    Object.assign(context, read.context)
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['elevated'])
  })

  it('fails the node with the REAL PostHog cause when the gated write rejects', async () => {
    const api = new MockPostHogApi({
      insight: { id: 'ins-1', name: 'rate', value: 6 },
      updateError: 'the personal API key lacks *write* scope on feature flags'
    })
    const { registry } = buildEnv(api)
    const outcome = await runAction({ registry }, rollbackNode, { flag: { flag: { id: 'ff-1' } } })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/lacks \*write\* scope/)
  })

  it('refuses any PostHog node when the integration is not connected (before any call)', async () => {
    // A fresh registry with NO posthog config → status needs-config → the
    // action-runner fails the node before touching the connector.
    const dir = mkdtempSync(join(tmpdir(), 'lf-ph-noconf-'))
    const registry = new IntegrationRegistry({
      creds: new CredentialStore({ backend, file: join(dir, 'secrets.enc') }),
      configFile: join(dir, 'config.json')
    })
    registry.registerConnector(
      'posthog',
      new PostHogConnector({
        api: new MockPostHogApi({}),
        poller: new PostHogPoller({
          api: new MockPostHogApi({}),
          cursors: new PostHogCursorStore({ file: join(dir, 'c.json') }),
          now: () => 0
        })
      })
    )
    const outcome = await runAction({ registry }, getInsightNode, { t: { insightId: 'x' } })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toMatch(/PostHog connected/i)
  })
})
