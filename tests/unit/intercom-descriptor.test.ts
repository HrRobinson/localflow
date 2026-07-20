import { describe, it, expect } from 'vitest'
import { intercomDescriptor } from '../../src/main/intercom/intercom-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import {
  INTERCOM_TRIGGER_IDS,
  INTERCOM_READ_ACTION_IDS,
  INTERCOM_WRITE_ACTION_IDS,
  INTERCOM_CUSTOMER_FACING_ACTION_IDS
} from '../../src/shared/intercom'

describe('intercom descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('intercom')
    expect(DESCRIPTOR_DEFS.intercom).toBe(intercomDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('intercom')
  })

  it('pins the exact secret fields (§5) — access token + client secret, keychain only', () => {
    const secretKeys = intercomDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['accessToken', 'clientSecret'])
  })

  it('pins the exact required fields (§5)', () => {
    const requiredKeys = intercomDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['accessToken', 'clientSecret', 'environment'])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of intercomDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the trigger ids the templates track consumes (§6.1)', () => {
    expect(intercomDescriptor.triggers.map((t) => t.id)).toEqual([
      'conversation.replied',
      'conversation.created'
    ])
    expect(intercomDescriptor.triggers.map((t) => t.id)).toEqual([...INTERCOM_TRIGGER_IDS])
  })

  it('pins the read + gated-write action ids (§6.2)', () => {
    expect(intercomDescriptor.actions.map((a) => a.id)).toEqual([
      ...INTERCOM_READ_ACTION_IDS,
      ...INTERCOM_WRITE_ACTION_IDS
    ])
    // The customer-facing set is exactly replyToConversation (§9).
    expect([...INTERCOM_CUSTOMER_FACING_ACTION_IDS]).toEqual(['replyToConversation'])
    expect(intercomDescriptor.actions.map((a) => a.id)).toContain('replyToConversation')
  })
})
