import { describe, it, expect } from 'vitest'
import { normalizeRecord, to18 } from '../../src/main/salesforce/salesforce-normalize'

/**
 * The CORRECTNESS BOUNDARY the conditions/templates tracks depend on (spec §6.3,
 * §12): a raw Salesforce record → the pinned `record.*` envelope, guarded hardest.
 * Pure function — no live org.
 */

const RAW = {
  attributes: { type: 'Lead', url: '/services/data/v62.0/sobjects/Lead/00Q000000000001' },
  Id: '00Q000000000001', // 15-char
  CreatedDate: '2026-07-18T09:00:00.000+0000',
  LastModifiedDate: '2026-07-19T12:30:00.000+0000',
  Company: 'Acme',
  AnnualRevenue: 2500000,
  NumberOfEmployees: 42,
  IsConverted: false,
  Rating: null
}

describe('salesforce normalize — the pinned record envelope (spec §6.3)', () => {
  it('strips the attributes envelope and types fields (numbers stay numbers, bools stay bools)', () => {
    const { record } = normalizeRecord(RAW, { instanceUrl: 'https://acme.my.salesforce.com' })
    expect(record.type).toBe('Lead')
    expect(record.fields).toEqual({
      Company: 'Acme',
      AnnualRevenue: 2500000,
      NumberOfEmployees: 42,
      IsConverted: false,
      Rating: null
    })
    // The envelope + the reserved metadata are NOT in the generic fields bag.
    expect(record.fields).not.toHaveProperty('attributes')
    expect(record.fields).not.toHaveProperty('Id')
    expect(record.fields).not.toHaveProperty('CreatedDate')
    // Types are preserved for deterministic numeric/boolean conditions.
    expect(typeof record.fields.AnnualRevenue).toBe('number')
    expect(record.fields.IsConverted).toBe(false)
  })

  it('widens a 15-char Id to the canonical 18-char Id (idempotent for 18-char input)', () => {
    const { record } = normalizeRecord(RAW)
    expect(record.id).toHaveLength(18)
    expect(record.id.slice(0, 15)).toBe('00Q000000000001')
    // Idempotent: feeding the already-18 id back yields the SAME id (spec §2.3).
    const again = normalizeRecord({ ...RAW, Id: record.id })
    expect(again.record.id).toBe(record.id)
  })

  it('to18 is stable and only touches 15-char ids', () => {
    expect(to18('00Q000000000001')).toHaveLength(18)
    expect(to18('short')).toBe('short') // not a 15-char id — unchanged
    const eighteen = to18('00Q000000000001')
    expect(to18(eighteen)).toBe(eighteen) // idempotent
  })

  it('carries createdDate / lastModifiedDate as ISO strings and builds a Lightning URL', () => {
    const { record } = normalizeRecord(RAW, { instanceUrl: 'https://acme.my.salesforce.com/' })
    expect(record.createdDate).toBe('2026-07-18T09:00:00.000+0000')
    expect(record.lastModifiedDate).toBe('2026-07-19T12:30:00.000+0000')
    expect(record.url).toBe(`https://acme.my.salesforce.com/lightning/r/${record.id}/view`)
  })

  it('falls back to attributes.type and tolerates a missing instance URL / garbage input', () => {
    const { record } = normalizeRecord(RAW) // no instanceUrl
    expect(record.type).toBe('Lead')
    expect(record.url).toBe('')
    // Garbage input never throws — an empty, well-typed envelope comes back.
    const empty = normalizeRecord(null)
    expect(empty.record).toMatchObject({ id: '', type: '', fields: {}, url: '' })
  })

  it('drops nested compound/relationship objects to null (flat generic envelope, MVP)', () => {
    const { record } = normalizeRecord({
      attributes: { type: 'Account' },
      Id: '001000000000001',
      BillingAddress: { city: 'SF', country: 'US' }, // compound field
      Owner: { attributes: {}, Name: 'Rep' } // relationship subquery
    })
    expect(record.fields.BillingAddress).toBeNull()
    expect(record.fields.Owner).toBeNull()
  })
})
