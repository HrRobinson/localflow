import type {
  SalesforceFieldValue,
  SalesforceRecord,
  SalesforceRecordContext
} from '../../shared/salesforce'

/**
 * PURE map from a raw Salesforce record (the SOQL/REST JSON, with its
 * `attributes` envelope) to the pinned `record.*` context shape (spec §6.3), and
 * from a normalized record to a poll `SeedEvent`. Side-effect-free and defensive
 * — it never trusts Salesforce's shape by type, mirroring `posthog-normalize.ts`
 * / `wc-normalize.ts` purity so every mapping is exhaustively unit-testable with
 * no live org (spec §12).
 *
 * This is the CORRECTNESS BOUNDARY the conditions track depends on:
 *  - the 15-char case-sensitive Id is widened to the canonical 18-char Id, so a
 *    record keyed either way compares equal (spec §6.3, §2.3);
 *  - `attributes` (the `{ type, url }` envelope + any nested-object envelopes) is
 *    stripped so it can't misroute a condition;
 *  - a number stays a NUMBER and a boolean a BOOLEAN, so `record.fields.Amount gt
 *    100000` / `record.fields.IsConverted truthy` are deterministic value compares;
 *  - a Lightning deep-link URL is built (non-secret) for the cockpit.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** The Salesforce reserved fields that carry the record's own metadata — pulled
 *  out of the generic `fields` bag so `fields` holds only the org's data. */
const RESERVED = new Set(['attributes', 'Id', 'CreatedDate', 'LastModifiedDate'])

/**
 * Coerce one SOQL field value into the JSON-typed `SalesforceFieldValue`. Numbers
 * and booleans pass through as-is (the reason we normalize — conditions compare
 * them by type); strings pass through; `null` stays null; a nested object/array
 * (a relationship subquery or a compound field like `Address`) is dropped to
 * `null` in MVP (the flat generic envelope — spec §6.3 surfaces scalar fields).
 */
function coerceField(v: unknown): SalesforceFieldValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v
  return null
}

/**
 * Widen a 15-char case-sensitive Salesforce Id to its canonical 18-char form by
 * appending the 3-char case checksum. A value that is already 18 chars (or is not
 * a 15-char id) is returned unchanged — the normalizer must be idempotent so a
 * record fetched either way keys the same (spec §2.3). The algorithm is
 * Salesforce's documented base-32 case-fold over three 5-char chunks.
 */
export function to18(id: string): string {
  if (id.length !== 15) return id
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
  let suffix = ''
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0
    for (let bit = 0; bit < 5; bit++) {
      const ch = id[chunk * 5 + bit]
      if (ch >= 'A' && ch <= 'Z') bits |= 1 << bit
    }
    suffix += alphabet[bits]
  }
  return id + suffix
}

/** Build the Lightning deep-link for a record (non-secret). Absent instance URL
 *  ⇒ empty string (the cockpit simply has no link), never a throw. */
function lightningUrl(instanceUrl: string | undefined, id: string): string {
  if (!instanceUrl || id.length === 0) return ''
  const base = instanceUrl.replace(/\/+$/, '')
  return `${base}/lightning/r/${id}/view`
}

/**
 * Normalize a raw Salesforce record into the pinned `record.*` context (spec
 * §6.3). `type` falls back to `attributes.type` (the sObject name SOQL always
 * returns) when the caller doesn't pass one; `instanceUrl` builds the deep-link.
 */
export function normalizeRecord(
  raw: unknown,
  opts: { type?: string; instanceUrl?: string } = {}
): SalesforceRecordContext {
  const r = isObject(raw) ? raw : {}
  const attributes = isObject(r.attributes) ? r.attributes : {}
  const type = opts.type && opts.type.length > 0 ? opts.type : str(attributes.type)
  const id = to18(str(r.Id))

  const fields: Record<string, SalesforceFieldValue> = {}
  for (const [key, value] of Object.entries(r)) {
    if (RESERVED.has(key)) continue
    fields[key] = coerceField(value)
  }

  const record: SalesforceRecord = {
    id,
    type,
    fields,
    createdDate: str(r.CreatedDate),
    lastModifiedDate: str(r.LastModifiedDate),
    url: lightningUrl(opts.instanceUrl, id)
  }
  return { record }
}
