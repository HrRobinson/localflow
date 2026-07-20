import { describe, it, expect } from 'vitest'
import { gitlabDescriptor } from '../../src/main/integrations/descriptors/gitlab'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  GITLAB_TRIGGER_IDS,
  GITLAB_READ_ACTION_IDS,
  GITLAB_WRITE_ACTION_IDS
} from '../../src/shared/gitlab'

describe('gitlab descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('gitlab')
    expect(DESCRIPTOR_DEFS.gitlab).toBe(gitlabDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('gitlab')
  })

  it('pins the exact secret fields (§5) — PAT + webhook secret, keychain only', () => {
    const secretKeys = gitlabDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['personalAccessToken', 'webhookSecret'])
  })

  it('pins the exact required fields (§8)', () => {
    const requiredKeys = gitlabDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual([
      'personalAccessToken',
      'webhookSecret',
      'baseUrl',
      'projectPath',
      'environment'
    ])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of gitlabDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the dev-tool trigger ids the templates track consumes (§6.1)', () => {
    expect(gitlabDescriptor.triggers.map((t) => t.id)).toEqual([
      'issue.opened',
      'mr.opened',
      'pipeline.failed'
    ])
    expect(gitlabDescriptor.triggers.map((t) => t.id)).toEqual([...GITLAB_TRIGGER_IDS])
  })

  it('pins the read + gated-write action ids (§6.2)', () => {
    expect(gitlabDescriptor.actions.map((a) => a.id)).toEqual([
      ...GITLAB_READ_ACTION_IDS,
      ...GITLAB_WRITE_ACTION_IDS
    ])
  })

  it('keeps the GitHub-sibling MR rename (mr.opened / getMR / openMR / mergeMR)', () => {
    const ids = [
      ...gitlabDescriptor.triggers.map((t) => t.id),
      ...gitlabDescriptor.actions.map((a) => a.id)
    ]
    expect(ids).toContain('mr.opened')
    expect(ids).toContain('getMR')
    expect(ids).toContain('openMR')
    expect(ids).toContain('mergeMR')
    // The GitHub `pr.*` spellings must NOT leak into the GitLab descriptor.
    expect(ids).not.toContain('pr.opened')
    expect(ids).not.toContain('openPr')
  })

  it('never places a secret VALUE in the static descriptor (only placeholders)', () => {
    const serialized = JSON.stringify(gitlabDescriptor)
    expect(serialized).not.toContain('glpat-real')
  })
})
