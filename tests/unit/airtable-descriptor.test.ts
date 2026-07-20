import { describe, it, expect } from 'vitest'
import { airtableDescriptor } from '../../src/main/airtable/airtable-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  AIRTABLE_TRIGGER_IDS,
  AIRTABLE_READ_ACTION_IDS,
  AIRTABLE_WRITE_ACTION_IDS
} from '../../src/shared/airtable'

describe('airtable descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS (lockstep)', () => {
    expect([...INTEGRATION_IDS]).toContain('airtable')
    expect(DESCRIPTOR_DEFS.airtable).toBe(airtableDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('airtable')
  })

  it('pins the exact secret fields (§5) — PAT + phase-2 MAC secret, keychain only', () => {
    const secretKeys = airtableDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['personalAccessToken', 'webhookMacSecret'])
  })

  it('pins the exact required fields (§8) — PAT + base + table + environment', () => {
    const requiredKeys = airtableDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['personalAccessToken', 'baseId', 'tableId', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of airtableDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the poll-backed trigger ids the templates track consumes (§3.1)', () => {
    expect(airtableDescriptor.triggers.map((t) => t.id)).toEqual([
      'record.created',
      'record.updated'
    ])
    expect(airtableDescriptor.triggers.map((t) => t.id)).toEqual([...AIRTABLE_TRIGGER_IDS])
  })

  it('pins the read + gated-write action ids (§3.2)', () => {
    expect(airtableDescriptor.actions.map((a) => a.id)).toEqual([
      ...AIRTABLE_READ_ACTION_IDS,
      ...AIRTABLE_WRITE_ACTION_IDS
    ])
  })

  it('never places a secret VALUE in the static descriptor (only placeholders)', () => {
    const serialized = JSON.stringify(airtableDescriptor)
    expect(serialized).not.toContain('pat_real')
    // The PAT placeholder is the harmless masked hint, never a real token.
    const pat = airtableDescriptor.configFields.find((f) => f.key === 'personalAccessToken')
    expect(pat?.placeholder).toBe('pat…')
  })
})
