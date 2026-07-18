import { describe, it, expect } from 'vitest'
import { GitLabRestApi } from '../../src/main/gitlab/gitlab-api'
import { MockGitLabTransport, ok, err } from './mock-gitlab-transport'

const BASE = 'https://gitlab.com'
const PROJECT = 'group/project'
const PAT = 'glpat-DO_NOT_LEAK_9f3a'

function build(
  transport: MockGitLabTransport,
  over: { baseUrl?: string; projectPath?: string; allowHost?: string } = {}
): GitLabRestApi {
  return new GitLabRestApi({
    transport,
    baseUrl: over.baseUrl ?? BASE,
    projectPath: over.projectPath ?? PROJECT,
    reveal: () => PAT,
    allowHost: over.allowHost,
    sleep: () => Promise.resolve()
  })
}

describe('GitLabRestApi reads', () => {
  it('getIssue GETs projects/<enc>/issues/<iid> with a PRIVATE-TOKEN header', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 42 }))
    await build(t).getIssue('42')
    const req = t.requests[0]
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://gitlab.com/api/v4/projects/group%2Fproject/issues/42')
    expect(req.headers['PRIVATE-TOKEN']).toBe(PAT)
  })

  it('getMR / getPipeline hit the merge_requests / pipelines endpoints', async () => {
    const t = new MockGitLabTransport(() => ok({}))
    const api = build(t)
    await api.getMR('12')
    await api.getPipeline('555')
    expect(t.requests[0].url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests/12'
    )
    expect(t.requests[1].url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fproject/pipelines/555'
    )
  })

  it('searchIssues builds a query string from the given filters', async () => {
    const t = new MockGitLabTransport(() => ok([]))
    await build(t).searchIssues({ search: 'login', state: 'opened', labels: 'bug,p1' })
    const url = new URL(t.requests[0].url)
    expect(url.pathname).toBe('/api/v4/projects/group%2Fproject/issues')
    expect(url.searchParams.get('search')).toBe('login')
    expect(url.searchParams.get('state')).toBe('opened')
    expect(url.searchParams.get('labels')).toBe('bug,p1')
  })
})

describe('GitLabRestApi writes', () => {
  it('createNote POSTs to issues/<iid>/notes with the body', async () => {
    const t = new MockGitLabTransport(() => ok({ id: 1 }))
    await build(t).createNote('42', 'looking into it')
    const req = t.requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://gitlab.com/api/v4/projects/group%2Fproject/issues/42/notes')
    expect(JSON.parse(req.body ?? '{}')).toEqual({ body: 'looking into it' })
    expect(req.headers['Content-Type']).toBe('application/json')
  })

  it('createMR POSTs to merge_requests with the branch pair', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 12 }))
    await build(t).createMR({ source_branch: 'fix/x', target_branch: 'main', title: 'Fix x' })
    const req = t.requests[0]
    expect(req.url).toBe('https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests')
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      source_branch: 'fix/x',
      target_branch: 'main',
      title: 'Fix x'
    })
  })

  it('mergeMR PUTs to merge_requests/<iid>/merge', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 12, state: 'merged' }))
    await build(t).mergeMR('12', {})
    const req = t.requests[0]
    expect(req.method).toBe('PUT')
    expect(req.url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fproject/merge_requests/12/merge'
    )
  })
})

describe('GitLabRestApi errors (spec §11 — human, actionable, real cause)', () => {
  it('401 → a "rejected the access token" message', async () => {
    const t = new MockGitLabTransport(() => err(401))
    await expect(build(t).getIssue('1')).rejects.toThrow(/rejected the access token \(401\)/i)
  })

  it('403 → a missing-`api`-scope message', async () => {
    const t = new MockGitLabTransport(() => err(403))
    await expect(build(t).createIssue({ title: 'x' })).rejects.toThrow(/api. scope/i)
  })

  it('404 → names the project path, not a bare 404', async () => {
    const t = new MockGitLabTransport(() => err(404))
    await expect(build(t).getIssue('999')).rejects.toThrow(/group\/project/)
  })

  it('forwards the verbatim GitLab body message on a generic 4xx', async () => {
    const t = new MockGitLabTransport(() => err(400, 'branch not found'))
    await expect(build(t).createMR({ source_branch: 'nope' })).rejects.toThrow(/branch not found/)
  })

  it('a transport failure surfaces an "unreachable" message with the host', async () => {
    const t = new MockGitLabTransport(() => {
      throw new Error('ECONNREFUSED')
    })
    await expect(build(t).getIssue('1')).rejects.toThrow(/unreachable/i)
  })
})

describe('GitLabRestApi SSRF guard (spec §5.1) — before any request', () => {
  it('refuses a non-https baseUrl BEFORE any request', async () => {
    const t = new MockGitLabTransport(() => ok({}))
    await expect(build(t, { baseUrl: 'http://gitlab.com' }).getIssue('1')).rejects.toThrow(/https/i)
    expect(t.requests).toHaveLength(0)
  })

  it('refuses a private self-host baseUrl with NO allowHost', async () => {
    const t = new MockGitLabTransport(() => ok({}))
    await expect(build(t, { baseUrl: 'https://192.168.1.10' }).getIssue('1')).rejects.toThrow(
      /private|loopback|refus/i
    )
    expect(t.requests).toHaveLength(0)
  })

  it('ADMITS the configured private self-host when allowHost matches (§5.1 primary case)', async () => {
    const t = new MockGitLabTransport(() => ok({ iid: 1 }))
    await build(t, { baseUrl: 'https://192.168.1.10', allowHost: '192.168.1.10' }).getIssue('1')
    expect(t.requests[0].url).toBe('https://192.168.1.10/api/v4/projects/group%2Fproject/issues/1')
  })

  it('still refuses cloud metadata even when allowHost is set', async () => {
    const t = new MockGitLabTransport(() => ok({}))
    await expect(
      build(t, { baseUrl: 'https://169.254.169.254', allowHost: '169.254.169.254' }).getIssue('1')
    ).rejects.toThrow(/metadata|refus/i)
    expect(t.requests).toHaveLength(0)
  })
})

describe('GitLabRestApi backoff (spec §2.4)', () => {
  it('retries a 429 then succeeds', async () => {
    let calls = 0
    const t = new MockGitLabTransport(() => {
      calls += 1
      return calls < 3 ? err(429) : ok({ iid: 42 })
    })
    const out = await build(t).getIssue('42')
    expect(out).toEqual({ iid: 42 })
    expect(calls).toBe(3)
  })

  it('gives up after the retry cap on a persistent 503', async () => {
    const t = new MockGitLabTransport(() => err(503))
    await expect(build(t).getIssue('42')).rejects.toThrow(/503/)
    expect(t.requests.length).toBeGreaterThan(1)
    expect(t.requests.length).toBeLessThanOrEqual(4)
  })
})
