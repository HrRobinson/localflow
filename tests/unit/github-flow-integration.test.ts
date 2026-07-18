import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IntegrationRegistry } from '../../src/main/integrations/integration-registry'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'
import { GitHubConnector } from '../../src/main/github/github-connector'
import { MockGitHubApi } from '../../src/main/github/github-api'
import type { RawPull } from '../../src/main/github/github-normalize'
import { runAction } from '../../src/main/flow/node-runners/action-runner'
import { selectEdges } from '../../src/main/flow/context'
import type { RunContext } from '../../src/main/flow/context'
import type { FlowGraph, FlowNode } from '../../src/shared/flows'

/**
 * OFFLINE engine-composition test (§7, §12): the REAL IntegrationRegistry + the
 * REAL action-runner + the REAL selectEdges routing, driven over a MockGitHubApi
 * — no credentials, no network. Proves the flagship fix-PR loop composes:
 * a check.failed seed → getPR writes normalized context → the router selects the
 * open/non-draft edge → the gated openPR reaches the mock — and, above all,
 * **that no mergePR is EVER called** (the "I merge PRs myself" contract, §9).
 * The `agent` node that authors the fix is a builtin exercised in its own tests;
 * here the loop is proven at the connector/registry seam.
 */

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

const pull = (state: string, draft: boolean): RawPull => ({
  number: 42,
  title: 'Fix boom',
  state,
  merged: false,
  draft,
  user: { login: 'octocat' },
  head: { ref: 'fix/boom', sha: 'abc' },
  base: { ref: 'main', repo: { full_name: 'acme/web' } },
  mergeable: true,
  html_url: 'https://github.com/acme/web/pull/42'
})

function buildRegistry(api: MockGitHubApi): IntegrationRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'lf-github-flow-'))
  const configFile = join(dir, 'config.json')
  // Enabled + required non-secret refs present, secrets in the keychain →
  // status('github') === 'connected' so the action-runner lets the node run.
  writeFileSync(
    configFile,
    JSON.stringify({
      integrations: {
        github: { enabled: true, authMode: 'pat', owner: 'acme', repo: 'web', environment: 1 }
      }
    })
  )
  const creds = new CredentialStore({ backend, file: join(dir, 'secrets.enc') })
  creds.set('github', 'pat', 'github_pat_x')
  creds.set('github', 'webhookSecret', 'whsec_x')
  const registry = new IntegrationRegistry({ creds, configFile })
  registry.registerConnector(
    'github',
    new GitHubConnector({ api, defaultRepo: { owner: 'acme', repo: 'web' } })
  )
  return registry
}

const getPRNode: FlowNode = {
  id: 'pr',
  type: 'action',
  integration: 'github',
  ref: 'getPR',
  config: { params: { number: '{{t.checkRun.prNumber}}' } },
  position: { x: 0, y: 0 }
}

const routerGraph: FlowGraph = {
  id: 'fix-pr-worker',
  name: 'fix a failing check',
  nodes: [getPRNode],
  edges: [
    { id: 'work', from: 'route', to: 'agent', condition: { field: 'pr.pr.state', equals: 'open' } },
    { id: 'skip', from: 'route', to: 'end', condition: { field: 'pr.pr.state', equals: 'closed' } }
  ]
}

describe('offline GitHub fix-PR loop', () => {
  it('reads the PR, routes on the normalized state, opens a PR — and NEVER merges', async () => {
    const api = new MockGitHubApi({ pulls: { 42: pull('open', false) } })
    const registry = buildRegistry(api)

    // 1. check.failed seed lands in context['t'] (as the webhook subscribe would).
    const context: RunContext = {
      t: { checkRun: { prNumber: 42, name: 'unit', detailsUrl: 'https://…', headSha: 'abc' } }
    }

    // 2. getPR reads through the REAL registry delegation + action-runner.
    const read = await runAction({ registry }, getPRNode, context)
    expect(read.status).toBe('done')
    Object.assign(context, read.context)
    expect((context.pr as { pr: { headRef: string } }).pr).toMatchObject({
      number: 42,
      state: 'open',
      headRef: 'fix/boom'
    })

    // 3. The router selects the "work it" edge (open, non-draft PR).
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['work'])

    // 4. The gated openPR (standing in for the post-agent publish) reaches the mock.
    const openPRNode: FlowNode = {
      id: 'openPR',
      type: 'action',
      integration: 'github',
      ref: 'openPR',
      config: {
        params: {
          head: 'fix/boom',
          base: '{{pr.pr.baseRef}}',
          title: 'Fix unit',
          body: 'automated fix'
        }
      },
      position: { x: 0, y: 0 }
    }
    const opened = await runAction({ registry }, openPRNode, context)
    expect(opened.status).toBe('done')
    expect(api.calls.createPull).toHaveLength(1)
    expect(api.calls.createPull[0].input).toMatchObject({ head: 'fix/boom', base: 'main' })

    // 5. THE CONTRACT: no mergePR node on the auto-path → the mock never merged.
    expect(api.calls.mergePull).toHaveLength(0)
  })

  it('routes a closed PR to the end branch (no work) — and still never merges', async () => {
    const api = new MockGitHubApi({ pulls: { 42: pull('closed', false) } })
    const registry = buildRegistry(api)
    const context: RunContext = { t: { checkRun: { prNumber: 42 } } }
    const read = await runAction({ registry }, getPRNode, context)
    Object.assign(context, read.context)
    expect(selectEdges(routerGraph, 'route', context)).toEqual(['skip'])
    expect(api.calls.mergePull).toHaveLength(0)
  })

  it('fails the node with the real GitHub cause when a write rejects', async () => {
    const api = new MockGitHubApi({
      errors: { createPull: 'A pull request already exists for acme:fix/boom' }
    })
    const registry = buildRegistry(api)
    const openPRNode: FlowNode = {
      id: 'openPR',
      type: 'action',
      integration: 'github',
      ref: 'openPR',
      config: { params: { head: 'fix/boom', base: 'main', title: 'x' } },
      position: { x: 0, y: 0 }
    }
    const res = await runAction({ registry }, openPRNode, {})
    expect(res.status).toBe('failed')
    expect(res.message).toMatch(/already exists/)
  })
})
