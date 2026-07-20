/**
 * Shared Salesforce-connector types (spec §4.2 shared row, §6.3). Kept in
 * `shared` because both the main-process connector and any future renderer
 * palette surface need the same vocabulary. No secrets ever live in these shapes
 * — the JWT private key / consumer secret / minted access token stay in the
 * keychain / process memory (spec §8); config.json and these types carry only
 * non-secret references (client id, instance/login URL, integration username)
 * and normalized CRM facts.
 *
 * The context-field PATHS (`record.*`) are the CONTRACT the flow canvas palette
 * and the conditions track read verbatim (spec §6). `salesforce-normalize.ts` is
 * the single place a raw Salesforce record is mapped into these shapes — numbers
 * stay numbers, booleans stay booleans, the 15-char Id is widened to 18, and a
 * Lightning deep-link is built — so downstream edge conditions are deterministic
 * value compares (spec §6.3).
 */

/** The two POLLED triggers (spec §6.1). Not webhooks — each is backed by a SOQL
 *  reconcile poll in `salesforce-poller.ts` (spec §7), differing only in the
 *  timestamp field it cursors on. */
export type SalesforceTriggerId = 'record.created' | 'record.updated'

/** The stable-order trigger id list (the runtime companion of the union) — the
 *  connector narrows against it and the descriptor snapshot test pins it. */
export const SALESFORCE_TRIGGER_IDS: readonly SalesforceTriggerId[] = [
  'record.created',
  'record.updated'
]

/** The two reads + the four gated writes (spec §6.2). */
export type SalesforceActionId =
  'query' | 'getRecord' | 'createRecord' | 'createTask' | 'updateRecord' | 'submitForApproval'

/** The pure reads (no gate — write facts for conditions, spec §6.2). */
export const SALESFORCE_READ_ACTION_IDS: readonly SalesforceActionId[] = ['query', 'getRecord']

/** The gated writes the author places a gate before (spec §6.2, §9). */
export const SALESFORCE_WRITE_ACTION_IDS: readonly SalesforceActionId[] = [
  'createRecord',
  'createTask',
  'updateRecord',
  'submitForApproval'
]

/** A JSON-typed Salesforce field value — numbers stay numbers so a downstream
 *  `record.fields.Amount gt 100000` compares numerically (spec §6.3). */
export type SalesforceFieldValue = string | number | boolean | null

/** A single normalized Salesforce record (spec §6.3) — the generic envelope,
 *  because a Salesforce org is schemaless-per-org (any sObject, any fields). */
export interface SalesforceRecord {
  /** 18-char Salesforce Id (normalized from a 15-char case-sensitive Id). */
  id: string
  /** sObject API name, e.g. "Lead". */
  type: string
  /** The requested fields, JSON-typed (the `attributes` envelope stripped). */
  fields: Record<string, SalesforceFieldValue>
  /** ISO 8601 (from `CreatedDate`). */
  createdDate: string
  /** ISO 8601 (from `LastModifiedDate`) — the `record.updated` reconcile field. */
  lastModifiedDate: string
  /** Lightning deep-link (non-secret) for the cockpit. */
  url: string
}

/** What a `getRecord` / a poll SeedEvent writes to context (spec §6.3). */
export interface SalesforceRecordContext {
  record: SalesforceRecord
}

/** What the `query` action writes to context (spec §6.3). MVP surfaces the first
 *  page + `count`; `done` reflects the SOQL result so a future "fetch all" is
 *  additive. */
export interface SalesforceQueryContext {
  records: SalesforceRecord[]
  count: number
  done: boolean
}

/** The `salesforce` block of config.json (non-secret refs only — spec §5, §8).
 *  The JWT private key / consumer secret is NEVER here; it lives in the keychain. */
export interface SalesforceConfig {
  enabled: true
  /** Connected-app / External-Client-App consumer key (client id). Non-secret. */
  clientId: string
  /** Login / token host — `https://login.salesforce.com` / `test.salesforce.com`
   *  / a My Domain host. User-supplied → SSRF-guarded (spec §4.4). */
  loginUrl: string
  /** Org instance URL (`https://<mydomain>.my.salesforce.com`); if omitted, taken
   *  from the token response. User-supplied → SSRF-guarded (spec §4.4). */
  instanceUrl?: string
  /** The `sub` of a JWT-bearer assertion (the dedicated Integration User). */
  username?: string
  /** REST API version (e.g. `v62.0`); absent ⇒ the pinned default in the api. */
  apiVersion?: string
  /** Default sObject for triggers (e.g. `Lead`); a node's `config.object` wins. */
  defaultObject?: string
  /** Poll cadence in seconds; absent ⇒ the poller default (spec §7.1, §2.2). */
  pollSeconds?: number
  /** Which localflow environment (1-9) hosts Salesforce work. */
  environment: number
}
