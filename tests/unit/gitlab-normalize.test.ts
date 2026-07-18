import { describe, it, expect } from 'vitest'
import {
  normalizeIssue,
  normalizeMR,
  normalizePipeline,
  webhookToSeed
} from '../../src/main/gitlab/gitlab-normalize'

describe('gitlab-normalize — issue (§6.3)', () => {
  it('splits iid/id as NUMBERS, lowercases labels into an ARRAY, keeps ISO createdAt', () => {
    const out = normalizeIssue({
      iid: 42,
      id: 9001,
      project_id: 7,
      title: 'Login is broken',
      state: 'opened',
      labels: ['Bug', { name: 'P1' }],
      author: { username: 'ada' },
      web_url: 'https://gitlab.com/g/p/-/issues/42',
      created_at: '2026-07-18T10:00:00.000Z'
    })
    expect(out).toEqual({
      issue: {
        iid: 42,
        id: 9001,
        projectId: 7,
        title: 'Login is broken',
        state: 'opened',
        labels: ['bug', 'p1'],
        authorUsername: 'ada',
        webUrl: 'https://gitlab.com/g/p/-/issues/42',
        createdAt: '2026-07-18T10:00:00.000Z'
      }
    })
  })

  it('never throws on a sparse/garbage node — safe defaults', () => {
    const out = normalizeIssue({})
    expect(out.issue.iid).toBe(0)
    expect(out.issue.labels).toEqual([])
    expect(out.issue.state).toBe('opened')
    expect(normalizeIssue(null).issue.title).toBe('')
  })
})

describe('gitlab-normalize — MR (§6.3)', () => {
  it('normalizes state/mergeStatus enums, branches, and the draft boolean', () => {
    const out = normalizeMR({
      iid: 12,
      project_id: 7,
      title: 'Fix login',
      state: 'opened',
      source_branch: 'fix/login',
      target_branch: 'main',
      draft: true,
      merge_status: 'can_be_merged',
      author: { username: 'ada' },
      web_url: 'https://gitlab.com/g/p/-/merge_requests/12'
    })
    expect(out.mr).toMatchObject({
      iid: 12,
      state: 'opened',
      sourceBranch: 'fix/login',
      targetBranch: 'main',
      draft: true,
      mergeStatus: 'can_be_merged'
    })
  })

  it('treats legacy work_in_progress as draft and unknown merge_status as unchecked', () => {
    const out = normalizeMR({ work_in_progress: true, merge_status: 'weird' })
    expect(out.mr.draft).toBe(true)
    expect(out.mr.mergeStatus).toBe('unchecked')
  })
})

describe('gitlab-normalize — pipeline (§6.3)', () => {
  it('lowercases status, keeps ref/sha, derives failedJobCount from builds', () => {
    const out = normalizePipeline({
      id: 555,
      project_id: 7,
      status: 'failed',
      ref: 'main',
      sha: 'abc123',
      web_url: 'https://gitlab.com/g/p/-/pipelines/555',
      builds: [{ status: 'failed' }, { status: 'success' }, { status: 'failed' }]
    })
    expect(out.pipeline).toEqual({
      id: 555,
      projectId: 7,
      status: 'failed',
      ref: 'main',
      sha: 'abc123',
      webUrl: 'https://gitlab.com/g/p/-/pipelines/555',
      failedJobCount: 2
    })
  })

  it('maps the "cancelled" spelling to the canonical "canceled" enum', () => {
    expect(normalizePipeline({ status: 'cancelled' }).pipeline.status).toBe('canceled')
  })
})

describe('gitlab-normalize — webhook → seed (§6.1, §7)', () => {
  it('maps an Issue Hook (action=open) → issue.opened', () => {
    const seed = webhookToSeed('Issue Hook', {
      object_attributes: { iid: 42, action: 'open' },
      project: { id: 7 }
    })
    expect(seed).toEqual({
      triggerId: 'issue.opened',
      payload: { projectId: 7, issueIid: 42, action: 'open' }
    })
  })

  it('drops a non-open Issue Hook (no seed)', () => {
    expect(
      webhookToSeed('Issue Hook', { object_attributes: { iid: 42, action: 'update' } })
    ).toBeNull()
  })

  it('maps a Merge Request Hook (action=open) → mr.opened', () => {
    const seed = webhookToSeed('Merge Request Hook', {
      object_attributes: { iid: 12, action: 'open' },
      project: { id: 7 }
    })
    expect(seed?.triggerId).toBe('mr.opened')
  })

  it('maps a failed Pipeline Hook → pipeline.failed with ref/sha', () => {
    const seed = webhookToSeed('Pipeline Hook', {
      object_attributes: { id: 555, status: 'failed', ref: 'main', sha: 'abc123' },
      project: { id: 7 }
    })
    expect(seed).toEqual({
      triggerId: 'pipeline.failed',
      payload: { projectId: 7, pipelineId: 555, status: 'failed', ref: 'main', sha: 'abc123' }
    })
  })

  it('drops a non-failed Pipeline Hook — a green pipeline NEVER seeds a run (§4.4)', () => {
    expect(
      webhookToSeed('Pipeline Hook', { object_attributes: { id: 555, status: 'success' } })
    ).toBeNull()
    expect(
      webhookToSeed('Pipeline Hook', { object_attributes: { id: 556, status: 'running' } })
    ).toBeNull()
  })

  it('drops an unsupported event kind', () => {
    expect(webhookToSeed('Note Hook', { object_attributes: {} })).toBeNull()
    expect(webhookToSeed('Issue Hook', 'not-an-object')).toBeNull()
  })
})
