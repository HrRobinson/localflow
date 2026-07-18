import { describe, it, expect } from 'vitest'
import { httpDescriptor } from '../../src/main/http/http-descriptor'
import { DESCRIPTOR_DEFS, descriptorDefs } from '../../src/main/integrations/descriptors'
import { INTEGRATION_IDS } from '../../src/shared/integrations'
import { HTTP_ACTION_IDS, HTTP_TRIGGER_IDS } from '../../src/shared/http'

describe('http descriptor', () => {
  it('is registered in the shared union and DESCRIPTOR_DEFS', () => {
    expect([...INTEGRATION_IDS]).toContain('http')
    expect(DESCRIPTOR_DEFS.http).toBe(httpDescriptor)
    expect(descriptorDefs.map((d) => d.id)).toContain('http')
  })

  it('owns NO per-id secret field — every secret is per node (§7)', () => {
    expect(httpDescriptor.configFields.filter((f) => f.secret)).toEqual([])
  })

  it('keeps the descriptor-level config thin: environment (required) + ingress base (§6.6)', () => {
    expect(httpDescriptor.configFields.map((f) => f.key)).toEqual(['environment', 'ingressBaseUrl'])
    expect(httpDescriptor.configFields.filter((f) => f.required).map((f) => f.key)).toEqual([
      'environment'
    ])
  })

  it('pins the generic action + trigger ids the palette/templates track consume (§6)', () => {
    expect(httpDescriptor.actions.map((a) => a.id)).toEqual(['http.get', 'http.send'])
    expect(httpDescriptor.actions.map((a) => a.id)).toEqual([...HTTP_ACTION_IDS])
    expect(httpDescriptor.triggers.map((t) => t.id)).toEqual(['webhook.received'])
    expect(httpDescriptor.triggers.map((t) => t.id)).toEqual([...HTTP_TRIGGER_IDS])
  })

  it('gives every field a valid FieldType', () => {
    for (const f of httpDescriptor.configFields) {
      expect(['string', 'string[]', 'number']).toContain(f.type)
    }
  })
})
