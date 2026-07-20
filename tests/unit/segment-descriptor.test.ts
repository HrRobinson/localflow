import { describe, it, expect } from 'vitest'
import { segmentDescriptor } from '../../src/main/segment/segment-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import { SEGMENT_TRIGGER_IDS, SEGMENT_ACTION_IDS } from '../../src/shared/segment'

describe('segment descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('segment')
    expect(DESCRIPTOR_DEFS.segment).toBe(segmentDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('segment')
  })

  it('pins the exact secret fields (§5) — shared secret + write key, keychain only', () => {
    const secretKeys = segmentDescriptor.configFields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['sharedSecret', 'writeKey'])
  })

  it('requires only sharedSecret + environment — writeKey is OPTIONAL (§5, §13.2)', () => {
    const requiredKeys = segmentDescriptor.configFields.filter((f) => f.required).map((f) => f.key)
    expect(requiredKeys).toEqual(['sharedSecret', 'environment'])
    const writeKey = segmentDescriptor.configFields.find((f) => f.key === 'writeKey')
    expect(writeKey?.required).toBe(false)
  })

  it('gives every field a valid FieldType', () => {
    for (const f of segmentDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })

  it('pins the ONE trigger id the templates track consumes (§6.1) — the source multiplier', () => {
    expect(segmentDescriptor.triggers.map((t) => t.id)).toEqual(['event.tracked'])
    expect(segmentDescriptor.triggers.map((t) => t.id)).toEqual([...SEGMENT_TRIGGER_IDS])
  })

  it('pins the two gated write-action ids (§6.2)', () => {
    expect(segmentDescriptor.actions.map((a) => a.id)).toEqual(['track', 'identify'])
    expect(segmentDescriptor.actions.map((a) => a.id)).toEqual([...SEGMENT_ACTION_IDS])
  })
})
