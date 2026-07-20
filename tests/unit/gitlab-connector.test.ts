import { describe, it, expect } from 'vitest'
import { GitLabRestApi } from '../../src/main/gitlab/gitlab-api'
import { GitLabConnector } from '../../src/main/gitlab/gitlab-connector'
import type { GitLabWebhookEvent } from '../../src/main/gitlab/gitlab-webhook-server'
import { MockGitLabTransport, ok, err } from './mock-gitlab-transport'

const BASE = 'https://gitlab.com'
const PROJECT = 'group/project'
const PAT = 'glpat-DO_NOT_LEAK_2b7c'

function buildApi(transport: MockGitLabTransport): GitLabRestApi {
  return new GitLabRestApi({
    transport,
    baseUrl: BASE,
    projectPath: PROJECT,
    reveal: () => PAT,
    sleep: () => Promise.resolve()
  })
}

const issueJson = {
  iid: 42,
  id: 9001,
  project_id: 7,
  title: 'Login broken',
  state: 'opened',
  labels: ['Bug'],
  author: { username: 'ada' },
  web_url: 'https://gitlab.com/g/p/-/issues/42',
  created_at: '2026-07-18T10:00:00.000Z'
}

describe('GitLabConnector — read dispatch (normalized)', () => {
  it('getIssue → GET issues/<iid>, normalized to issue.*', async () => {
    const t = new MockGitLabTransport(() => ok(issueJson))
    const out = await new GitLabConnector({ api: buildApi(t) }).invokeAction('getIssue', {
      iid: 42
    })
    expect(t.requests[0].url).toBe('https://gitlab.com/api/v4/projects/group%2Fproject/issues/42')
    expect(out).toMatchObject({ issue: { iid: 42, labels: ['bug'], state: 'opened' } })
  })

  it('getPipeline → normalized pipeline.* (lowercase status)', async () => {
    const t = new MockGitLabTransport(() => ok({ id: 555, status: 'FAILED', ref: 'main' }))
    const out = await new GitLabConnector({ api: buildApi(t) }).invokeAction('getPipeline', {
      id: 555
    })
    expect(out).toMatchObject({ pipeline: { id: 555, status: 'failed', ref: 'main' } })
  })

  it('searchIssues → { issues, count }', async () => {
    const t = new MockGitLabTransport(() => ok([issueJson, { ...issueJson, iid: 43 }]))
    const out = await new GitLabConnector({ api: buildApi(t) }).invokeAction('searchIssues', {
      search: 'login'
    })
    expect(out).toMatchObject({ count: 2 })
    expect((out as { issues: unknown[] }).issues).toHaveLength(2)
  })

  it('rejects a read with a missing id, before any request', async () => {
    const t = new MockGitLabTransport(() => ok(issueJson))
    await expect(
      new GitLabConnector({ api: buildApi(t) }).invokeAction('getIssue', {})
    ).rejects.toThrow(/iid/i)
    expect(t.requests).toHaveLength(0)
  })
})

describe('GitLabConnector — gated write dispatch', () => {
  it('commentIssue → POST issues/<iid>/notes { body }', async () => {
    const t = new MockGitLabTransport(() => ok({ id: 1 }))
    await new GitLabConnector({ api: buildApi(t) }).invokeAction('commentIssue', {
      iid: 42,
      body: 'on it'
    })
    expect(t.requests[0].url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fproject/issues/42/notes'
    )
    expect(JSON.parse(t.requests[0].body ?? '{}')).toEqual({ body: 'on it' })
  })

  it('labelIssue → PUT issues/<iid> { labels } (array joined)', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 42 }))
    await new GitLabConnector({ api: buildApi(t) }).invokeAction('labelIssue', {
      iid: 42,
      labels: ['bug', 'p1']
    })
    expect(t.requests[0].method).toBe('PUT')
    expect(JSON.parse(t.requests[0].body ?? '{}')).toEqual({ labels: 'bug,p1' })
  })

  it('openMR → POST merge_requests with the branch pair; NEVER merges', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 12 }))
    await new GitLabConnector({ api: buildApi(t) }).invokeAction('openMR', {
      sourceBranch: 'fix/pipeline-555',
      targetBranch: 'main',
      title: 'Fix failing pipeline 555'
    })
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0].url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests'
    )
    expect(t.requests[0].url).not.toMatch(/\/merge$/)
  })

  it('rejects an unknown action id legibly', async () => {
    const t = new MockGitLabTransport(() => ok({}))
    await expect(
      new GitLabConnector({ api: buildApi(t) }).invokeAction('deleteEverything', {})
    ).rejects.toThrow(/unknown GitLab action/i)
    expect(t.requests).toHaveLength(0)
  })
})

describe('GitLabConnector — mergeMR runs when reached (§9, graph-gate authority)', () => {
  // Authority for mergeMR is the flow GRAPH — a `gate` node the author places
  // before it, enforced by the flow engine — exactly like every other gated
  // mutation (GitHub mergePR, Stripe createRefund, Woo refundOrder). The
  // connector has no static param to fake ("approved: true" hardcoded on the
  // node with no gate anywhere) and no in-connector gate check to bypass; it
  // just calls the API when invoked, like the other connectors' mutations.
  it('★ runs mergeMR when invoked — no param gate, like the other connectors’ mutations', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 12, state: 'merged' }))
    await new GitLabConnector({ api: buildApi(t) }).invokeAction('mergeMR', { iid: 12 })
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0].method).toBe('PUT')
    expect(t.requests[0].url).toMatch(/merge_requests\/12\/merge$/)
  })

  it('still rejects on a missing iid, before any API call (unrelated to gating)', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 12, state: 'merged' }))
    await expect(
      new GitLabConnector({ api: buildApi(t) }).invokeAction('mergeMR', {})
    ).rejects.toThrow(/iid/i)
    expect(t.requests).toHaveLength(0)
  })

  it('rejects on a real API failure with the actual error, no gate wording', async () => {
    const t = new MockGitLabTransport(() => err(405))
    await expect(
      new GitLabConnector({ api: buildApi(t) }).invokeAction('mergeMR', { iid: 12 })
    ).rejects.not.toThrow(/gate/i)
  })
})

describe('GitLabConnector — subscribe fan-out + authority (§9)', () => {
  const event = (): GitLabWebhookEvent => ({
    triggerId: 'pipeline.failed',
    deliveryId: 'uuid-9',
    payload: { projectId: 7, pipelineId: 555, status: 'failed', ref: 'main', sha: 'abc' }
  })

  it('a webhook event fans out to the matching trigger handler as a SeedEvent', () => {
    const t = new MockGitLabTransport(() => ok({}))
    const connector = new GitLabConnector({ api: buildApi(t) })
    const seen: unknown[] = []
    connector.subscribe('pipeline.failed', (e) => seen.push(e))
    connector.deliver(event())
    expect(seen).toEqual([{ eventId: 'uuid-9', payload: event().payload }])
  })

  it('does not deliver to a handler subscribed to a different trigger', () => {
    const t = new MockGitLabTransport(() => ok({}))
    const connector = new GitLabConnector({ api: buildApi(t) })
    const seen: unknown[] = []
    connector.subscribe('issue.opened', (e) => seen.push(e))
    connector.deliver(event())
    expect(seen).toHaveLength(0)
  })

  it('★ AUTHORITY: a delivered trigger NEVER fires a write on its own', () => {
    const t = new MockGitLabTransport(() => ok({}))
    const connector = new GitLabConnector({ api: buildApi(t) })
    connector.subscribe('pipeline.failed', () => {})
    connector.deliver(event())
    expect(t.requests).toHaveLength(0)
  })
})

/** ★ The load-bearing secret invariant (spec §9): no PAT VALUE ever appears in a
 *  returned value, a log line, or an error surfaced onward. */
describe('GitLabConnector — no PAT leak', () => {
  it('never surfaces the PAT through outputs, logs, or errors', async () => {
    const logs: string[] = []
    const t = new MockGitLabTransport(() => ok(issueJson))
    const connector = new GitLabConnector({ api: buildApi(t), log: (m) => logs.push(m) })

    const read = await connector.invokeAction('getIssue', { iid: 42 })
    connector.subscribe('pipeline.failed', () => {
      throw new Error('handler boom') // force a route+reason log
    })
    connector.deliver({
      triggerId: 'pipeline.failed',
      deliveryId: 'x',
      payload: { projectId: 7, pipelineId: 1, status: 'failed', ref: 'main', sha: 'a' }
    })

    let errMsg = ''
    try {
      const bad = new MockGitLabTransport(() => err(401))
      await new GitLabConnector({ api: buildApi(bad) }).invokeAction('getIssue', { iid: 1 })
    } catch (e) {
      errMsg = (e as Error).message
    }

    const surfaced = [JSON.stringify(read), logs.join('\n'), errMsg].join('\n')
    expect(surfaced).not.toContain(PAT)
    // …and the PRIVATE-TOKEN header carrying it is never logged either.
    expect(logs.join('\n')).not.toMatch(/PRIVATE-TOKEN|glpat-/)
  })
})
