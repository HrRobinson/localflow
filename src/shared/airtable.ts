/**
 * Shared Airtable-connector types — the NORMALIZED, stable context/trigger
 * shapes an action writes to run context (spec §3.3) and the pinned trigger/
 * action id vocabulary (spec §3) the flow-templates track consumes verbatim.
 * Imported by main (the connector/normalizer) and any renderer palette surface.
 *
 * NO raw Airtable request/response shape lives here — those are isolated in
 * `src/main/airtable/airtable-api.ts` (the API blast radius, spec §7.1). This
 * file holds ONLY localflow-facing vocabulary. No secret ever lives in these
 * shapes: the personal access token stays in the keychain (spec §5); config.json
 * and these types carry only non-secret references.
 *
 * The one honest normalization guarantee (spec §3.3): Airtable table columns are
 * WHATEVER THE USER DEFINED — there is no canonical field set. So the connector
 * pins the ENVELOPE (`id`, `createdTime`, `fields`, plus change metadata) and
 * leaves cells addressable by name. `fields` is kept RAW (never re-typed, never
 * coerced) with only empty→undefined applied, so `record.fields.Status eq "Done"`
 * and `record.fields.Score gt 80` and `exists record.fields.Owner` all behave.
 */

// ── Pinned structured-data vocabulary ids (spec §3 — templates track consumes) ─

/** Poll-backed trigger ids (spec §3.1). NOT webhook-payload — each is a poll of
 *  the `/payloads` cursor stream in `airtable-poller.ts` (spec §4). */
export const AIRTABLE_TRIGGER_IDS = ['record.created', 'record.updated'] as const
export type AirtableTriggerId = (typeof AIRTABLE_TRIGGER_IDS)[number]

/** Read action ids — pure reads that write facts for conditions (spec §3.2). */
export const AIRTABLE_READ_ACTION_IDS = ['listRecords', 'getRecord'] as const

/** Gated-write action ids — the author places a gate before these (spec §3.2). */
export const AIRTABLE_WRITE_ACTION_IDS = ['createRecord', 'updateRecord'] as const

export type AirtableActionId =
  (typeof AIRTABLE_READ_ACTION_IDS)[number] | (typeof AIRTABLE_WRITE_ACTION_IDS)[number]

/** The change kind a poll observed, per record (spec §3.3). `deleted` is captured
 *  by the CDC stream but not pinned to a trigger in MVP. */
export type AirtableChangeType = 'created' | 'updated' | 'deleted'

// ── Context-field shape (spec §3.3 — PINNED; guarded by the normalize tests) ──

/**
 * The normalized record an action writes under its node id (spec §3.3). Read by
 * downstream edge conditions via dotted paths (`getRecord.record.fields.Status`)
 * and by the agent node as its judgment input.
 */
export interface AirtableRecordContext {
  record: {
    /** Airtable record id, e.g. "recABC123". */
    id: string
    /** ISO 8601 — present on every record. */
    createdTime: string
    /**
     * The record's cells, keyed by FIELD NAME, values as Airtable returns them.
     * Deliberately NOT re-typed: Airtable fields are user-defined, so the author
     * references `record.fields.<Field Name>` and the condition/agent interprets
     * the value. Normalization is limited to: omit empty fields → undefined (so
     * `exists` works), and NEVER coerce — a "currency"-typed field is already a
     * `number`, so it compares numerically with no money pass (spec §3.3, §7.2).
     */
    fields: Record<string, unknown>
  }
}

/**
 * The poll trigger's SeedEvent payload (spec §3.3): the normalized record plus
 * the change envelope, so a template can branch on `changeType` or on which
 * fields changed.
 */
export interface AirtableChangePayload {
  record: AirtableRecordContext['record']
  changeType: AirtableChangeType
  changedFieldNames?: string[]
  baseId: string
  tableId: string
}

/** The `airtable` block of config.json (non-secret refs only — spec §5, §8). The
 *  personal access token (and, phase 2, the webhook MAC secret) is NEVER here;
 *  it lives in the keychain. */
export interface AirtableConfig {
  enabled: true
  /** Base id, `appXXXXXXXXXXXXXX`. Non-secret ref. */
  baseId: string
  /** The watched table (id `tbl…` or display name); also the default write target. */
  tableId: string
  /** Optional view to narrow triggers/`listRecords`. */
  viewId?: string
  /** The `/payloads` cursor stream's webhook id (Strategy A, spec §4.4). */
  webhookId?: string
  /** Poll cadence in seconds; absent ⇒ the poller default (spec §4.2). */
  pollSeconds?: number
  /** Which localflow environment (1-9) hosts Airtable work. */
  environment: number
}
