import { describe, it, expect } from 'vitest'
import { normalizeRecord, normalizePayloadBatch } from '../../src/main/airtable/airtable-normalize'
import type { RawWebhookPayload } from '../../src/main/airtable/airtable-api'

/**
 * The correctness boundary conditions + the agent depend on (spec §3.3, §10) —
 * guarded hardest. Envelope stability + empty→undefined + NEVER-coerce.
 */

describe('normalizeRecord — the pinned envelope (§3.3)', () => {
  it('preserves id + createdTime and keeps fields RAW (never coerces)', () => {
    const out = normalizeRecord({
      id: 'recABC123',
      createdTime: '2026-07-20T10:00:00.000Z',
      fields: {
        Status: 'Done',
        Score: 87, // a number stays a number → `Score gt 80` compares numerically
        Amount: 42.5, // a "currency" field is already a number — no money pass
        Active: false, // a boolean stays a boolean, distinct from absent
        Tags: ['a', 'b']
      }
    })
    expect(out.record.id).toBe('recABC123')
    expect(out.record.createdTime).toBe('2026-07-20T10:00:00.000Z')
    expect(out.record.fields).toEqual({
      Status: 'Done',
      Score: 87,
      Amount: 42.5,
      Active: false,
      Tags: ['a', 'b']
    })
    expect(typeof out.record.fields.Score).toBe('number')
    expect(out.record.fields.Active).toBe(false)
  })

  it('omits empty cells → undefined so `exists` is honest', () => {
    const out = normalizeRecord({
      id: 'rec1',
      createdTime: '2026-07-20T00:00:00.000Z',
      fields: { Owner: '', Notes: null, Tags: [], Kept: 'x' }
    })
    expect(out.record.fields).toEqual({ Kept: 'x' })
    expect('Owner' in out.record.fields).toBe(false)
  })

  it('never throws on a sparse/garbage record — safe envelope defaults', () => {
    expect(normalizeRecord(undefined).record).toEqual({ id: '', createdTime: '', fields: {} })
    expect(normalizeRecord({ id: 'r' }).record).toEqual({ id: 'r', createdTime: '', fields: {} })
  })
})

describe('normalizePayloadBatch — one seed per changed record (§4)', () => {
  const payload = (over: Partial<RawWebhookPayload>): RawWebhookPayload => ({
    timestamp: '2026-07-20T10:00:00.000Z',
    baseTransactionNumber: 7,
    ...over
  })

  it('maps createdRecordsById → a `created` seed tagged with its table', () => {
    const seeds = normalizePayloadBatch([
      payload({
        changedTablesById: {
          tblIntake: {
            createdRecordsById: {
              recNEW: {
                createdTime: '2026-07-20T10:00:00.000Z',
                cellValuesByFieldName: { Status: 'New', Blank: '' }
              }
            }
          }
        }
      })
    ])
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({
      eventId: 'created:recNEW:7',
      tableId: 'tblIntake',
      changeType: 'created',
      record: { id: 'recNEW', createdTime: '2026-07-20T10:00:00.000Z', fields: { Status: 'New' } }
    })
    // empty→undefined applied to payload cells too.
    expect('Blank' in seeds[0].record.fields).toBe(false)
  })

  it('maps changedRecordsById → an `updated` seed carrying changedFieldNames', () => {
    const seeds = normalizePayloadBatch([
      payload({
        changedTablesById: {
          tblIntake: {
            changedRecordsById: {
              recUPD: {
                cellValuesByFieldName: { Status: 'Triaged' },
                changedFieldNames: ['Status']
              }
            }
          }
        }
      })
    ])
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({
      eventId: 'updated:recUPD:7',
      changeType: 'updated',
      changedFieldNames: ['Status']
    })
  })

  it('maps destroyedRecordIds → a `deleted` seed; batch txn disambiguates ids', () => {
    const seeds = normalizePayloadBatch([
      payload({ changedTablesById: { tblIntake: { destroyedRecordIds: ['recGONE'] } } })
    ])
    expect(seeds).toEqual([
      {
        eventId: 'deleted:recGONE:7',
        tableId: 'tblIntake',
        changeType: 'deleted',
        record: { id: 'recGONE', createdTime: '', fields: {} }
      }
    ])
  })

  it('returns [] for an empty/garbage batch (never throws)', () => {
    expect(normalizePayloadBatch([])).toEqual([])
    expect(normalizePayloadBatch(undefined as unknown as RawWebhookPayload[])).toEqual([])
  })
})
