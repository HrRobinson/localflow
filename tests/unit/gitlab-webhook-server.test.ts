import { describe, it, expect } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
import {
  parseGitLabEvent,
  verifyGitLabToken,
  GITLAB_EVENT_HEADER,
  GITLAB_EVENT_UUID_HEADER
} from '../../src/main/gitlab/gitlab-webhook-server'

const SECRET = 'wh_secret_do_not_leak'

function headers(over: Record<string, string> = {}): IncomingHttpHeaders {
  return { [GITLAB_EVENT_HEADER]: 'Pipeline Hook', ...over }
}

describe('gitlab webhook — X-Gitlab-Token (token scheme, §5.2)', () => {
  it('accepts a matching token and rejects a wrong / missing one', () => {
    expect(verifyGitLabToken(SECRET, SECRET)).toBe(true)
    expect(verifyGitLabToken('wrong', SECRET)).toBe(false)
    expect(verifyGitLabToken(undefined, SECRET)).toBe(false)
  })

  it('refuses an empty stored secret outright (not "verified" against nothing)', () => {
    expect(verifyGitLabToken('', '')).toBe(false)
  })
})

describe('gitlab webhook — parse + filter (§4.4, §6.1)', () => {
  const failedPipeline = JSON.stringify({
    object_kind: 'pipeline',
    object_attributes: { id: 555, status: 'failed', ref: 'main', sha: 'abc' },
    project: { id: 7 }
  })

  it('parses a failed Pipeline Hook → pipeline.failed event with the delivery uuid', () => {
    const out = parseGitLabEvent(
      Buffer.from(failedPipeline),
      headers({ [GITLAB_EVENT_UUID_HEADER]: 'uuid-9' })
    )
    expect(out).toEqual({
      triggerId: 'pipeline.failed',
      deliveryId: 'uuid-9',
      payload: { projectId: 7, pipelineId: 555, status: 'failed', ref: 'main', sha: 'abc' }
    })
  })

  it('drops a non-failed pipeline (no event → no run seeded)', () => {
    const green = JSON.stringify({ object_attributes: { id: 555, status: 'success' } })
    expect(parseGitLabEvent(Buffer.from(green), headers())).toBeNull()
  })

  it('parses an Issue Hook (action=open) → issue.opened', () => {
    const body = JSON.stringify({
      object_attributes: { iid: 42, action: 'open' },
      project: { id: 7 }
    })
    const out = parseGitLabEvent(
      Buffer.from(body),
      headers({ [GITLAB_EVENT_HEADER]: 'Issue Hook' })
    )
    expect(out?.triggerId).toBe('issue.opened')
  })

  it('drops malformed JSON and unsupported events', () => {
    expect(parseGitLabEvent(Buffer.from('{not json'), headers())).toBeNull()
    expect(
      parseGitLabEvent(Buffer.from('{}'), headers({ [GITLAB_EVENT_HEADER]: 'Note Hook' }))
    ).toBeNull()
  })
})
