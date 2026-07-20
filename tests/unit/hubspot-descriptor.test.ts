import { describe, it, expect } from 'vitest'
import { hubspotDescriptor } from '../../src/main/hubspot/hubspot-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  HUBSPOT_TRIGGER_IDS,
  HUBSPOT_READ_ACTION_IDS,
  HUBSPOT_WRITE_ACTION_IDS
} from '../../src/shared/hubspot'

describe('hubspot descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('hubspot')
    expect(DESCRIPTOR_DEFS.hubspot).toBe(hubspotDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('hubspot')
  })

  it('pins the exact secret fields (§4) — private-app token + webhook client secret', () => {
    const secretKeys = hubspotDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['privateAppToken', 'webhookClientSecret'])
  })

  it('pins the exact required fields (§8)', () => {
    const requiredKeys = hubspotDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['privateAppToken', 'webhookClientSecret', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of hubspotDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the CRM trigger ids the templates track consumes (§3.1)', () => {
    expect(hubspotDescriptor.triggers.map((t) => t.id)).toEqual([
      'contact.created',
      'deal.stageChanged',
      'form.submitted'
    ])
    expect(hubspotDescriptor.triggers.map((t) => t.id)).toEqual([...HUBSPOT_TRIGGER_IDS])
  })

  it('pins the read + gated-write action ids (§3.2)', () => {
    expect(hubspotDescriptor.actions.map((a) => a.id)).toEqual([
      ...HUBSPOT_READ_ACTION_IDS,
      ...HUBSPOT_WRITE_ACTION_IDS
    ])
  })

  it('never places a secret VALUE in the static descriptor (only placeholders)', () => {
    const serialized = JSON.stringify(hubspotDescriptor)
    expect(serialized).not.toContain('pat-na1-real')
  })
})
