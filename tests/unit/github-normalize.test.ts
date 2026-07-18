import { describe, it, expect } from 'vitest'
import {
  normalizeIssue,
  normalizePull,
  normalizeCheckRun,
  webhookToTrigger,
  type RawIssue,
  type RawPull,
  type RawCheckRun
} from '../../src/main/github/github-normalize'

/**
 * The correctness boundary the conditions track depends on (§6.3, §12): assert
 * every raw issue/PR/check-run node and every webhook payload maps to the pinned
 * context shape — numeric ids, lowercased enums, `state:'merged'` distinguished
 * from `'closed'`, `mergeable:null → undefined`, `labels` as a lowercased
 * string[], and the `check.failed`/`workflow.failed` failure-derivation.
 */

const REPO = 'acme/web'

const rawIssue: RawIssue = {
  number: 7,
  title: 'Boom',
  body: 'it broke',
  state: 'open',
  user: { login: 'octocat' },
  labels: [{ name: 'Bug' }, { name: 'P1' }],
  html_url: 'https://github.com/acme/web/issues/7',
  created_at: '2026-07-18T00:00:00Z'
}

const rawPull: RawPull = {
  number: 42,
  title: 'Fix boom',
  state: 'open',
  merged: false,
  draft: false,
  user: { login: 'octocat' },
  head: { ref: 'fix/boom', sha: 'abc123' },
  base: { ref: 'main', repo: { full_name: 'acme/web' } },
  mergeable: true,
  html_url: 'https://github.com/acme/web/pull/42',
  created_at: '2026-07-18T00:00:00Z'
}

describe('normalizeIssue', () => {
  it('maps to the pinned shape with numeric id, lowercased labels, and login author', () => {
    expect(normalizeIssue(rawIssue, REPO)).toEqual({
      issue: {
        number: 7,
        title: 'Boom',
        body: 'it broke',
        state: 'open',
        author: 'octocat',
        labels: ['bug', 'p1'],
        repo: 'acme/web',
        url: 'https://github.com/acme/web/issues/7',
        createdAt: '2026-07-18T00:00:00Z'
      }
    })
  })

  it('derives repo from repository_url when no repo is passed', () => {
    const withUrl: RawIssue = {
      ...rawIssue,
      repository_url: 'https://api.github.com/repos/acme/api'
    }
    expect(normalizeIssue(withUrl).issue.repo).toBe('acme/api')
  })

  it('never throws on a sparse node — empty defaults', () => {
    const out = normalizeIssue({} as RawIssue)
    expect(out.issue).toMatchObject({ number: 0, title: '', state: 'open', labels: [] })
  })
})

describe('normalizePull', () => {
  it('distinguishes a merged PR from a plain closed one', () => {
    expect(normalizePull({ ...rawPull, state: 'closed', merged: true }, REPO).pr.state).toBe(
      'merged'
    )
    expect(normalizePull({ ...rawPull, state: 'closed', merged: false }, REPO).pr.state).toBe(
      'closed'
    )
    expect(normalizePull(rawPull, REPO).pr.state).toBe('open')
  })

  it('maps mergeable:null → undefined (GitHub still computing)', () => {
    expect(normalizePull({ ...rawPull, mergeable: null }, REPO).pr.mergeable).toBeUndefined()
    expect(normalizePull({ ...rawPull, mergeable: true }, REPO).pr.mergeable).toBe(true)
  })

  it('carries head/base refs, sha, draft, and repo from base.repo.full_name', () => {
    expect(normalizePull(rawPull).pr).toMatchObject({
      number: 42,
      headRef: 'fix/boom',
      baseRef: 'main',
      headSha: 'abc123',
      draft: false,
      repo: 'acme/web'
    })
  })
})

describe('normalizeCheckRun', () => {
  const rawCheck: RawCheckRun = {
    id: 99,
    name: 'unit',
    status: 'completed',
    conclusion: 'failure',
    head_sha: 'abc123',
    details_url: 'https://github.com/acme/web/runs/99',
    output: { summary: '3 tests failed' },
    pull_requests: [{ number: 42 }]
  }

  it('maps to the pinned shape with numeric id and the associated PR number', () => {
    expect(normalizeCheckRun(rawCheck, REPO)).toEqual({
      checkRun: {
        id: 99,
        name: 'unit',
        status: 'completed',
        conclusion: 'failure',
        prNumber: 42,
        headSha: 'abc123',
        repo: 'acme/web',
        detailsUrl: 'https://github.com/acme/web/runs/99',
        outputSummary: '3 tests failed'
      }
    })
  })

  it('prNumber is undefined when the check is not on a PR head', () => {
    expect(
      normalizeCheckRun({ ...rawCheck, pull_requests: [] }, REPO).checkRun.prNumber
    ).toBeUndefined()
  })
})

describe('webhookToTrigger', () => {
  it('issues/opened → issue.opened + a GitHubIssueContext', () => {
    const out = webhookToTrigger('issues', {
      action: 'opened',
      issue: rawIssue,
      repository: { full_name: 'acme/web' }
    })
    expect(out?.triggerId).toBe('issue.opened')
    expect((out?.payload as { issue: { number: number } }).issue.number).toBe(7)
  })

  it('pull_request/opened → pr.opened + a GitHubPRContext', () => {
    const out = webhookToTrigger('pull_request', {
      action: 'opened',
      pull_request: rawPull,
      repository: { full_name: 'acme/web' }
    })
    expect(out?.triggerId).toBe('pr.opened')
    expect((out?.payload as { pr: { number: number } }).pr.number).toBe(42)
  })

  it('check_run/completed with a failing conclusion → check.failed', () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled']) {
      const out = webhookToTrigger('check_run', {
        action: 'completed',
        check_run: {
          id: 1,
          name: 'x',
          status: 'completed',
          conclusion,
          head_sha: 's',
          pull_requests: [{ number: 42 }]
        },
        repository: { full_name: 'acme/web' }
      })
      expect(out?.triggerId).toBe('check.failed')
    }
  })

  it('check_run/completed with a SUCCESS conclusion fires nothing (derived filter)', () => {
    expect(
      webhookToTrigger('check_run', {
        action: 'completed',
        check_run: { id: 1, name: 'x', status: 'completed', conclusion: 'success' },
        repository: { full_name: 'acme/web' }
      })
    ).toBeNull()
  })

  it('workflow_run/completed with failure → workflow.failed', () => {
    const out = webhookToTrigger('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 5,
        name: 'CI',
        conclusion: 'failure',
        head_sha: 's',
        html_url: 'https://github.com/acme/web/actions/runs/5'
      },
      repository: { full_name: 'acme/web' }
    })
    expect(out?.triggerId).toBe('workflow.failed')
  })

  it('ignores an unsupported event and a non-opened issue action', () => {
    expect(webhookToTrigger('ping', {})).toBeNull()
    expect(
      webhookToTrigger('issues', { action: 'closed', issue: rawIssue, repository: {} })
    ).toBeNull()
  })
})
