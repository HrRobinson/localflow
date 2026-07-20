import { describe, it, expect } from 'vitest'
import { pagerdutyDescriptor } from '../../src/main/pagerduty/pagerduty-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  PAGERDUTY_TRIGGER_IDS,
  PAGERDUTY_READ_ACTION_IDS,
  PAGERDUTY_MUTATION_ACTION_IDS
} from '../../src/shared/pagerduty'

describe('pagerduty descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS (the lockstep touch-points)', () => {
    expect([...INTEGRATION_IDS]).toContain('pagerduty')
    expect(DESCRIPTOR_DEFS.pagerduty).toBe(pagerdutyDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('pagerduty')
  })

  it('pins the exact secret fields — api key + webhook secret + routing key, keychain only (§5)', () => {
    const secretKeys = pagerdutyDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['apiKey', 'webhookSecret', 'routingKey'])
  })

  it('pins the exact required fields (§5, §8)', () => {
    const requiredKeys = pagerdutyDescriptor.configFields
      .filter((f) => f.required)
      .map((f) => f.key)
    expect(requiredKeys).toEqual(['apiKey', 'webhookSecret', 'fromEmail', 'region', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of pagerdutyDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the on-call trigger ids the templates + compose tracks consume (§6.1)', () => {
    expect(pagerdutyDescriptor.triggers.map((t) => t.id)).toEqual([
      'incident.triggered',
      'incident.acknowledged',
      'incident.escalated',
      'incident.resolved'
    ])
    expect(pagerdutyDescriptor.triggers.map((t) => t.id)).toEqual([...PAGERDUTY_TRIGGER_IDS])
  })

  it('pins the read + gated-mutation action ids (§6.2)', () => {
    expect(pagerdutyDescriptor.actions.map((a) => a.id)).toEqual([
      ...PAGERDUTY_READ_ACTION_IDS,
      ...PAGERDUTY_MUTATION_ACTION_IDS
    ])
    // acknowledge is a MUTATION (flow-gated), not a read (§9).
    expect(PAGERDUTY_MUTATION_ACTION_IDS).toContain('acknowledgeIncident')
  })

  it('never stores a secret value in the static descriptor', () => {
    expect(JSON.stringify(pagerdutyDescriptor)).not.toContain('u+realkey')
  })
})
