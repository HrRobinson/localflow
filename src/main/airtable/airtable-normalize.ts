import type { RawAirtableRecord, RawWebhookPayload } from './airtable-api'
import type { AirtableChangeType, AirtableRecordContext } from '../../shared/airtable'

/**
 * PURE mapping (spec §3.3, §10) — the CORRECTNESS BOUNDARY the conditions track +
 * the agent depend on. Two maps, both side-effect-free and defensive (they never
 * trust Airtable's shape by type), mirroring `posthog-normalize.ts`'s purity so
 * every mapping is exhaustively unit-testable with no live base (spec §10):
 *
 *  1. a raw record (`{ id, createdTime, fields }`) → the pinned
 *     `AirtableRecordContext` envelope, and
 *  2. a raw `/payloads` batch → one `AirtableChangeSeed` per changed record with
 *     its `changeType` + `changedFieldNames`.
 *
 * The narrow, HONEST guarantee (spec §3.3): ENVELOPE stability + empty→undefined
 * + NEVER-coerce. Airtable fields are user-defined, so a "currency" field is
 * already a `number` and a checkbox already a `boolean` — the normalizer copies
 * cells THROUGH untouched, only dropping empty values so `exists` works. Pinning
 * a fixed field schema would be a lie; the envelope is the contract.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Whether a cell value is "empty" and should be omitted (→ undefined), so a
 * downstream `exists record.fields.Owner` is honest. Airtable omits empty cells
 * from a record's `fields` already, but a webhook payload can carry an explicit
 * empty string / empty array / null — normalize those away too. NEVER coerces a
 * present value (0, false, '' distinctions are the AUTHOR's to interpret except
 * for the truly-absent cases below).
 */
function isEmptyCell(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.length === 0
  if (Array.isArray(v)) return v.length === 0
  return false
}

/** Copy a cell bag THROUGH untouched, dropping only empty cells (never coerce). */
function normalizeFields(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isObject(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (isEmptyCell(v)) continue
    out[k] = v
  }
  return out
}

/**
 * Normalize a raw record into the pinned `AirtableRecordContext` (spec §3.3):
 * envelope stability (`id`, `createdTime`), empty→undefined, never-coerce.
 */
export function normalizeRecord(raw: RawAirtableRecord | unknown): AirtableRecordContext {
  const r = isObject(raw) ? raw : {}
  return {
    record: {
      id: str(r.id),
      createdTime: str(r.createdTime),
      fields: normalizeFields(r.fields)
    }
  }
}

/** A single record change lifted out of a `/payloads` batch, ready for the poller
 *  to filter by `(tableId, changeType)` and hand off as a SeedEvent (spec §4). */
export interface AirtableChangeSeed {
  /** The idempotency key `trigger-subscriber.coerceEvent` dedups on — stable per
   *  (changeType, record, base transaction). */
  eventId: string
  tableId: string
  changeType: AirtableChangeType
  record: AirtableRecordContext['record']
  /** For `updated` changes: which fields changed (a template can narrow on it). */
  changedFieldNames?: string[]
}

/**
 * Map a raw `/payloads` batch → one `AirtableChangeSeed` per changed record
 * (spec §4). Walks every table's `createdRecordsById` / `changedRecordsById` /
 * `destroyedRecordIds`, tagging each with its `tableId` so the poller can fan a
 * single fetched batch out to whichever subscriptions match. `baseTransactionNumber`
 * disambiguates a record touched in two different transactions.
 */
export function normalizePayloadBatch(payloads: RawWebhookPayload[]): AirtableChangeSeed[] {
  const seeds: AirtableChangeSeed[] = []
  if (!Array.isArray(payloads)) return seeds
  for (const payload of payloads) {
    if (!isObject(payload)) continue
    const txn =
      typeof payload.baseTransactionNumber === 'number' ? payload.baseTransactionNumber : 0
    const tables = isObject(payload.changedTablesById) ? payload.changedTablesById : {}
    for (const [tableId, changes] of Object.entries(tables)) {
      if (!isObject(changes)) continue

      const created = isObject(changes.createdRecordsById) ? changes.createdRecordsById : {}
      for (const [recordId, rec] of Object.entries(created)) {
        seeds.push({
          eventId: `created:${recordId}:${txn}`,
          tableId,
          changeType: 'created',
          record: {
            id: recordId,
            createdTime: isObject(rec) ? str(rec.createdTime) : '',
            fields: isObject(rec) ? normalizeFields(rec.cellValuesByFieldName) : {}
          }
        })
      }

      const changed = isObject(changes.changedRecordsById) ? changes.changedRecordsById : {}
      for (const [recordId, rec] of Object.entries(changed)) {
        const changedFieldNames =
          isObject(rec) && Array.isArray(rec.changedFieldNames)
            ? rec.changedFieldNames.filter((n): n is string => typeof n === 'string')
            : undefined
        seeds.push({
          eventId: `updated:${recordId}:${txn}`,
          tableId,
          changeType: 'updated',
          record: {
            id: recordId,
            createdTime: isObject(rec) ? str(rec.createdTime) : '',
            fields: isObject(rec) ? normalizeFields(rec.cellValuesByFieldName) : {}
          },
          ...(changedFieldNames && changedFieldNames.length > 0 ? { changedFieldNames } : {})
        })
      }

      const destroyed = Array.isArray(changes.destroyedRecordIds) ? changes.destroyedRecordIds : []
      for (const recordId of destroyed) {
        if (typeof recordId !== 'string' || recordId.length === 0) continue
        seeds.push({
          eventId: `deleted:${recordId}:${txn}`,
          tableId,
          changeType: 'deleted',
          record: { id: recordId, createdTime: '', fields: {} }
        })
      }
    }
  }
  return seeds
}
