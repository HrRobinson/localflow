import { describe, it, expect } from 'vitest'
import { GitHubConnector } from '../../src/main/github/github-connector'
import { MockGitHubApi } from '../../src/main/github/github-api'
import type { RawIssue, RawPull, RawCheckRun } from '../../src/main/github/github-normalize'
import type {
  GitHubWebhookDelivery,
  GitHubWebhookServer
} from '../../src/main/github/github-webhook-server'

const DEFAULT = { owner: 'acme', repo: 'web' }

const issue: RawIssue = {
  number: 7,
  title: 'Boom',
  state: 'open',
  user: { login: 'octocat' },
  labels: [{ name: 'bug' }],
  html_url: 'https://github.com/acme/web/issues/7'
}

const pull: RawPull = {
  number: 42,
  title: 'Fix',
  state: 'open',
  merged: false,
  draft: false,
  user: { login: 'octocat' },
  head: { ref: 'fix/boom', sha: 'abc' },
  base: { ref: 'main', repo: { full_name: 'acme/web' } },
  mergeable: true,
  html_url: 'https://github.com/acme/web/pull/42'
}

const checkRun: RawCheckRun = {
  id: 99,
  name: 'unit',
  status: 'completed',
  conclusion: 'failure',
  head_sha: 'abc',
  pull_requests: [{ number: 42 }]
}

function fakeWebhook(): {
  server: GitHubWebhookServer
  deliver: (d: GitHubWebhookDelivery) => void
} {
  let sink: ((d: GitHubWebhookDelivery) => void) | null = null
  return {
    server: { port: 0, onEvent: (h) => (sink = h), close: () => {} },
    deliver: (d) => sink?.(d)
  }
}

describe('GitHubConnector — read dispatch', () => {
  it('getPR resolves the normalized PR context', async () => {
    const c = new GitHubConnector({
      api: new MockGitHubApi({ pulls: { 42: pull } }),
      defaultRepo: DEFAULT
    })
    const out = (await c.invokeAction('getPR', { number: '42' })) as { pr: { number: number } }
    expect(out.pr).toMatchObject({
      number: 42,
      headRef: 'fix/boom',
      repo: 'acme/web',
      state: 'open'
    })
  })

  it('getIssue and getCheckRun normalize too', async () => {
    const api = new MockGitHubApi({ issues: { 7: issue }, checkRuns: { 99: checkRun } })
    const c = new GitHubConnector({ api, defaultRepo: DEFAULT })
    const iss = (await c.invokeAction('getIssue', { number: 7 })) as { issue: { labels: string[] } }
    expect(iss.issue.labels).toEqual(['bug'])
    const cr = (await c.invokeAction('getCheckRun', { id: 99 })) as {
      checkRun: { prNumber: number; conclusion: string }
    }
    expect(cr.checkRun).toMatchObject({ prNumber: 42, conclusion: 'failure' })
  })

  it('searchIssues returns normalized items + count', async () => {
    const c = new GitHubConnector({ api: new MockGitHubApi({ searchResults: [issue] }) })
    const out = (await c.invokeAction('searchIssues', { query: 'is:open label:bug' })) as {
      count: number
    }
    expect(out.count).toBe(1)
  })

  it('rejects a missing number and missing repo legibly', async () => {
    const c = new GitHubConnector({ api: new MockGitHubApi(), defaultRepo: DEFAULT })
    await expect(c.invokeAction('getPR', {})).rejects.toThrow(/needs a positive 'number'/)
    const noRepo = new GitHubConnector({ api: new MockGitHubApi() })
    await expect(noRepo.invokeAction('getPR', { number: 1 })).rejects.toThrow(
      /needs an 'owner' and 'repo'/
    )
  })

  it('rejects an unknown action id legibly', async () => {
    const c = new GitHubConnector({ api: new MockGitHubApi(), defaultRepo: DEFAULT })
    await expect(c.invokeAction('doTheThing', {})).rejects.toThrow(/has no action 'doTheThing'/)
  })
})

describe('GitHubConnector — gated writes map to the api and forward errors verbatim', () => {
  it('openPR maps params to createPull and resolves its result', async () => {
    const api = new MockGitHubApi()
    const c = new GitHubConnector({ api, defaultRepo: DEFAULT })
    const out = await c.invokeAction('openPR', {
      head: 'fix/boom',
      base: 'main',
      title: 'Fix boom',
      body: 'summary'
    })
    expect(out).toEqual({ number: 200, url: '' })
    expect(api.calls.createPull).toEqual([
      {
        repo: DEFAULT,
        input: { head: 'fix/boom', base: 'main', title: 'Fix boom', body: 'summary', draft: false }
      }
    ])
  })

  it('labelIssue accepts a comma-list, commentIssue/closeIssue/createIssue/dispatchWorkflow route', async () => {
    const api = new MockGitHubApi()
    const c = new GitHubConnector({ api, defaultRepo: DEFAULT })
    await c.invokeAction('labelIssue', { number: 7, labels: 'bug, p1' })
    await c.invokeAction('commentIssue', { number: 7, body: 'hi' })
    await c.invokeAction('closeIssue', { number: 7 })
    await c.invokeAction('createIssue', { title: 'New' })
    await c.invokeAction('dispatchWorkflow', { workflow: 'ci.yml', ref: 'main' })
    expect(api.calls.addLabels[0].labels).toEqual(['bug', 'p1'])
    expect(api.calls.createComment).toHaveLength(1)
    expect(api.calls.closeIssue).toHaveLength(1)
    expect(api.calls.createIssue).toHaveLength(1)
    expect(api.calls.dispatchWorkflow[0].workflow).toBe('ci.yml')
  })

  it('mergePR maps to mergePull and rejects a GitHub error verbatim (the pinned convention)', async () => {
    const ok = new MockGitHubApi()
    const okc = new GitHubConnector({ api: ok, defaultRepo: DEFAULT })
    await okc.invokeAction('mergePR', { number: 42, method: 'squash' })
    expect(ok.calls.mergePull).toEqual([
      { repo: DEFAULT, number: 42, input: { method: 'squash', sha: undefined } }
    ])

    const bad = new MockGitHubApi({ errors: { mergePull: 'Pull Request is not mergeable' } })
    const badc = new GitHubConnector({ api: bad, defaultRepo: DEFAULT })
    await expect(badc.invokeAction('mergePR', { number: 42 })).rejects.toThrow(/not mergeable/)
  })
})

describe('GitHubConnector — authority: the connector NEVER auto-mutates (§9)', () => {
  it('a webhook delivery only seeds a run — it never calls ANY write (incl. mergePR)', () => {
    const api = new MockGitHubApi({ pulls: { 42: pull } })
    const { server, deliver } = fakeWebhook()
    const c = new GitHubConnector({ api, defaultRepo: DEFAULT, webhook: server })
    const seeds: unknown[] = []
    c.subscribe('check.failed', (e) => seeds.push(e))
    c.subscribe('pr.opened', (e) => seeds.push(e))

    deliver({
      deliveryId: 'd1',
      event: 'check_run',
      payload: { action: 'completed', check_run: checkRun, repository: { full_name: 'acme/web' } }
    })
    deliver({
      deliveryId: 'd2',
      event: 'pull_request',
      payload: { action: 'opened', pull_request: pull, repository: { full_name: 'acme/web' } }
    })

    // Two runs were seeded…
    expect(seeds).toHaveLength(2)
    // …and NOT ONE write method was invoked by the webhook path.
    expect(api.calls.mergePull).toHaveLength(0)
    expect(api.calls.createPull).toHaveLength(0)
    expect(api.calls.createComment).toHaveLength(0)
    expect(api.calls.addLabels).toHaveLength(0)
    expect(api.calls.closeIssue).toHaveLength(0)
    expect(api.calls.createIssue).toHaveLength(0)
    expect(api.calls.dispatchWorkflow).toHaveLength(0)
  })

  it('check.failed seed carries the normalized check-run context (fix-loop entry, §7)', () => {
    const { server, deliver } = fakeWebhook()
    const c = new GitHubConnector({
      api: new MockGitHubApi(),
      defaultRepo: DEFAULT,
      webhook: server
    })
    const seeds: { payload: { checkRun: { prNumber: number } } }[] = []
    c.subscribe('check.failed', (e) => seeds.push(e as never))
    deliver({
      deliveryId: 'd3',
      event: 'check_run',
      payload: { action: 'completed', check_run: checkRun, repository: { full_name: 'acme/web' } }
    })
    expect(seeds[0].payload.checkRun.prNumber).toBe(42)
  })

  it('a SUCCESS check_run seeds nothing (the derived failure filter, §6.1)', () => {
    const { server, deliver } = fakeWebhook()
    const c = new GitHubConnector({
      api: new MockGitHubApi(),
      defaultRepo: DEFAULT,
      webhook: server
    })
    const seeds: unknown[] = []
    c.subscribe('check.failed', (e) => seeds.push(e))
    deliver({
      deliveryId: 'd4',
      event: 'check_run',
      payload: {
        action: 'completed',
        check_run: { ...checkRun, conclusion: 'success' },
        repository: { full_name: 'acme/web' }
      }
    })
    expect(seeds).toHaveLength(0)
  })

  it('an unsubscribe stops delivery and an unknown trigger is a no-op function', () => {
    const { server, deliver } = fakeWebhook()
    const c = new GitHubConnector({
      api: new MockGitHubApi(),
      defaultRepo: DEFAULT,
      webhook: server,
      log: () => {}
    })
    const seeds: unknown[] = []
    const off = c.subscribe('pr.opened', (e) => seeds.push(e))
    expect(typeof c.subscribe('bogus.trigger', () => {})).toBe('function')
    off()
    deliver({
      deliveryId: 'd5',
      event: 'pull_request',
      payload: { action: 'opened', pull_request: pull, repository: { full_name: 'acme/web' } }
    })
    expect(seeds).toHaveLength(0)
  })
})
