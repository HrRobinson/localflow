import { describe, it, expect } from 'vitest'
import { salesforceDescriptor } from '../../src/main/salesforce/salesforce-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  SALESFORCE_TRIGGER_IDS,
  SALESFORCE_READ_ACTION_IDS,
  SALESFORCE_WRITE_ACTION_IDS
} from '../../src/shared/salesforce'

/**
 * Pins the trigger/action ids the templates + conditions tracks consume verbatim
 * (spec §6) — a change here is a deliberate, reviewed contract edit.
 */
describe('salesforce descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('salesforce')
    expect(DESCRIPTOR_DEFS.salesforce).toBe(salesforceDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('salesforce')
  })

  it('pins the exact secret fields (§5, §8) — the consumer secret + JWT key, keychain only', () => {
    const secretKeys = salesforceDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    // MVP pins client-credentials (clientSecret required); privateKey is the
    // designed-for JWT fork behind the same auth seam (spec §13.1).
    expect(secretKeys).toEqual(['clientSecret', 'privateKey'])
  })

  it('pins the exact required fields (§5) — client-creds fork', () => {
    const requiredKeys = salesforceDescriptor.configFields
      .filter((f) => f.required)
      .map((f) => f.key)
    expect(requiredKeys).toEqual(['clientSecret', 'clientId', 'loginUrl', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of salesforceDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the generic record triggers the templates track consumes (§6.1)', () => {
    expect(salesforceDescriptor.triggers.map((t) => t.id)).toEqual([
      'record.created',
      'record.updated'
    ])
    expect(salesforceDescriptor.triggers.map((t) => t.id)).toEqual([...SALESFORCE_TRIGGER_IDS])
  })

  it('pins the read + gated-write action ids (§6.2), incl. submitForApproval', () => {
    expect(salesforceDescriptor.actions.map((a) => a.id)).toEqual([
      ...SALESFORCE_READ_ACTION_IDS,
      ...SALESFORCE_WRITE_ACTION_IDS
    ])
    expect(salesforceDescriptor.actions.map((a) => a.id)).toContain('submitForApproval')
  })

  it('never places a secret VALUE in the static descriptor (only placeholders)', () => {
    const serialized = JSON.stringify(salesforceDescriptor)
    expect(serialized).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  })
})
