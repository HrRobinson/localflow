import { describe, it, expect } from 'vitest'
import { parseAirtableConfig } from '../../src/main/airtable/airtable-config'

/**
 * Validate-at-the-boundary parsing of the non-secret `airtable` block (spec §5,
 * §8). Garbage DISABLES the feature (returns null) rather than throwing; secrets
 * never live here.
 */

const base = {
  airtable: {
    enabled: true,
    baseId: 'appXXXXXXXXXXXXXX',
    tableId: 'Intake',
    environment: 1
  }
}

describe('parseAirtableConfig', () => {
  it('accepts a well-formed block (base + table + environment)', () => {
    expect(parseAirtableConfig(base)).toEqual({
      enabled: true,
      baseId: 'appXXXXXXXXXXXXXX',
      tableId: 'Intake',
      environment: 1
    })
  })

  it('carries optional view/webhook refs and clamps pollSeconds', () => {
    const cfg = parseAirtableConfig({
      airtable: {
        ...base.airtable,
        viewId: 'viwABC',
        webhookId: 'achXYZ',
        pollSeconds: 99999
      }
    })
    expect(cfg).toMatchObject({ viewId: 'viwABC', webhookId: 'achXYZ', pollSeconds: 3600 })
  })

  it('disables (null) on a disabled/absent block or missing required refs', () => {
    expect(parseAirtableConfig({ airtable: { ...base.airtable, enabled: false } })).toBeNull()
    expect(parseAirtableConfig({})).toBeNull()
    expect(parseAirtableConfig({ airtable: { ...base.airtable, baseId: '' } })).toBeNull()
    expect(parseAirtableConfig({ airtable: { ...base.airtable, tableId: undefined } })).toBeNull()
    expect(parseAirtableConfig({ airtable: { ...base.airtable, environment: 0 } })).toBeNull()
    expect(parseAirtableConfig({ airtable: { ...base.airtable, environment: 12 } })).toBeNull()
  })

  it('drops a secret hand-edited into config.json (never surfaces it)', () => {
    // A PAT wrongly placed in config.json must not appear in the parsed config —
    // parseAirtableConfig only reads the pinned non-secret refs.
    const cfg = parseAirtableConfig({
      airtable: { ...base.airtable, personalAccessToken: 'patLEAK' }
    })
    expect(JSON.stringify(cfg)).not.toContain('patLEAK')
  })
})
