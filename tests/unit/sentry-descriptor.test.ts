import { describe, it, expect } from 'vitest'
import { sentryDescriptor } from '../../src/main/sentry/sentry-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  SENTRY_TRIGGER_IDS,
  SENTRY_READ_ACTION_IDS,
  SENTRY_MUTATION_ACTION_IDS
} from '../../src/shared/sentry'

describe('sentry descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('sentry')
    expect(DESCRIPTOR_DEFS.sentry).toBe(sentryDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('sentry')
  })

  it('pins the exact secret fields (§5) — token + Client Secret, keychain only', () => {
    const secretKeys = sentryDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['authToken', 'webhookSecret'])
  })

  it('pins the exact required fields (§8)', () => {
    const requiredKeys = sentryDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['authToken', 'webhookSecret', 'orgSlug', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of sentryDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the dev/incident trigger ids the templates + GitHub tracks consume (§6.1)', () => {
    expect(sentryDescriptor.triggers.map((t) => t.id)).toEqual([
      'issue.created',
      'issue.regressed',
      'alert.triggered'
    ])
    expect(sentryDescriptor.triggers.map((t) => t.id)).toEqual([...SENTRY_TRIGGER_IDS])
  })

  it('pins the read + gated-mutation action ids (§6.2)', () => {
    expect(sentryDescriptor.actions.map((a) => a.id)).toEqual([
      ...SENTRY_READ_ACTION_IDS,
      ...SENTRY_MUTATION_ACTION_IDS
    ])
  })

  it('defaults the self-host baseUrl placeholder to sentry.io and never stores a secret value', () => {
    const baseUrl = sentryDescriptor.configFields.find((f) => f.key === 'baseUrl')
    expect(baseUrl?.placeholder).toBe('https://sentry.io')
    expect(JSON.stringify(sentryDescriptor)).not.toContain('sntrys_real')
  })
})
