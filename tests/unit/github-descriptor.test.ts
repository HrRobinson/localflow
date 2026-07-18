import { describe, it, expect } from 'vitest'
import { githubDescriptor } from '../../src/main/github/github-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  GITHUB_TRIGGER_IDS,
  GITHUB_READ_ACTION_IDS,
  GITHUB_WRITE_ACTION_IDS
} from '../../src/shared/github'

describe('github descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('github')
    expect(DESCRIPTOR_DEFS.github).toBe(githubDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('github')
  })

  it('pins the exact secret fields (§5) — keychain only', () => {
    const secretKeys = githubDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['pat', 'appPrivateKey', 'webhookSecret'])
  })

  it('pins the always-required fields (§5) — mode-specific secrets are conditional', () => {
    const requiredKeys = githubDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['authMode', 'webhookSecret', 'owner', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of githubDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the dev trigger ids the templates track consumes (§6.1)', () => {
    expect(githubDescriptor.triggers.map((t) => t.id)).toEqual([
      'issue.opened',
      'pr.opened',
      'check.failed',
      'workflow.failed'
    ])
    expect(githubDescriptor.triggers.map((t) => t.id)).toEqual([...GITHUB_TRIGGER_IDS])
  })

  it('pins the read + gated-write action ids, mergePR last (§6.2, §9)', () => {
    expect(githubDescriptor.actions.map((a) => a.id)).toEqual([
      ...GITHUB_READ_ACTION_IDS,
      ...GITHUB_WRITE_ACTION_IDS
    ])
    expect(githubDescriptor.actions.at(-1)?.id).toBe('mergePR')
  })

  it('never places a secret VALUE in the static descriptor (only placeholders)', () => {
    const serialized = JSON.stringify(githubDescriptor)
    expect(serialized).not.toContain('github_pat_realsecret')
    expect(serialized).not.toContain('PRIVATE KEY')
  })
})
