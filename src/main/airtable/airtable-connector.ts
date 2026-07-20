import type { LiveConnector } from '../../shared/integrations'
import type { AirtableTriggerId } from '../../shared/airtable'
import { AIRTABLE_TRIGGER_IDS } from '../../shared/airtable'
import type { SeedEvent } from '../flow/trigger-subscriber'
import type { AirtableApi, WriteRecordInput } from './airtable-api'
import type { AirtablePoller } from './airtable-poller'
import { normalizeRecord } from './airtable-normalize'

/**
 * The Airtable `LiveConnector` (spec §7.1) — the orchestrator the registry
 * delegates to for id `'airtable'`. It owns:
 *  - the **action-dispatch table** (`invokeAction(actionId, params)` → the right
 *    `airtable-api` call, `airtable-normalize` mapping the result), and
 *  - **trigger subscription** (`subscribe(triggerId, handler, config)` → registers
 *    a POLL subscription with `airtable-poller`, reading the node `config` for the
 *    base/table/webhook — NOT a webhook-payload ingress, spec §4).
 *
 * Safety posture (spec §7.3): the connector exposes two gated writes
 * (`createRecord`, `updateRecord`) but NEVER fires them on its own — they run ONLY
 * because an action node invoked `invokeAction`. Registering a poll subscription
 * makes ZERO Airtable writes. Every failure REJECTS with the real `airtable-api`
 * error (spec §9, the pinned convention); the personal access token is confined to
 * `airtable-api`'s Bearer header and never logged or returned.
 *
 * Live wiring (binding `airtable-api`'s `reveal` seam to the CredentialStore
 * plaintext exit + a real HTTP transport, and starting the poller's real cadence
 * timer) is DEFERRED (spec §7.1); this is the offline, mock-seam-tested core.
 */

export interface AirtableConnectorDeps {
  api: AirtableApi
  poller: AirtablePoller
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const TRIGGER_IDS: ReadonlySet<string> = new Set<AirtableTriggerId>(AIRTABLE_TRIGGER_IDS)

/** Read a required record id (`recordId`, falling back to `id`) — the `requireId`
 *  guard shape shared with the other connectors. */
function requireRecordId(params: Record<string, unknown>, label: string): string {
  const raw = params.recordId ?? params.id
  if (typeof raw === 'string' && raw.length > 0) return raw
  throw new Error(`Airtable ${label} needs a non-empty recordId — none was supplied to the action.`)
}

/** Read a required `{ fields }` bag for a write — a synchronous validation throw
 *  surfaces as a REJECTED promise (spec §3.2 dispatch is `async`). */
function requireFields(params: Record<string, unknown>, label: string): Record<string, unknown> {
  if (isObject(params.fields) && Object.keys(params.fields).length > 0) return params.fields
  throw new Error(`Airtable ${label} needs a non-empty 'fields' object — none was supplied.`)
}

export class AirtableConnector implements LiveConnector {
  private readonly api: AirtableApi
  private readonly poller: AirtablePoller

  constructor(deps: AirtableConnectorDeps) {
    this.api = deps.api
    this.poller = deps.poller
  }

  // ── Action dispatch (spec §3.2 reads, §3.2 gated writes) ────────────────────

  // `async` so a synchronous validation throw (a missing recordId / fields)
  // surfaces as a REJECTED promise — the pinned failure convention (spec §3.2) —
  // never a sync throw the action-runner would see out of band.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'listRecords': {
        const { records } = await this.api.listRecords({
          filterByFormula: optionalStr(params.filterByFormula),
          view: optionalStr(params.view),
          pageSize: optionalNum(params.pageSize),
          fields: optionalStrArray(params.fields)
        })
        const normalized = records.map((r) => normalizeRecord(r))
        return { records: normalized, count: normalized.length }
      }
      case 'getRecord':
        return normalizeRecord(await this.api.getRecord(requireRecordId(params, 'getRecord')))
      // ── Gated writes (author places a gate before these, spec §7.3) ──────────
      case 'createRecord': {
        const input: WriteRecordInput = { fields: requireFields(params, 'createRecord') }
        if (params.typecast === true) input.typecast = true
        return normalizeRecord(await this.api.createRecord(input))
      }
      case 'updateRecord': {
        const recordId = requireRecordId(params, 'updateRecord')
        const input: WriteRecordInput = { fields: requireFields(params, 'updateRecord') }
        if (params.typecast === true) input.typecast = true
        return normalizeRecord(await this.api.updateRecord(recordId, input))
      }
      default:
        throw new Error(
          `Unknown Airtable action "${actionId}" — the connector services listRecords, ` +
            `getRecord, createRecord, updateRecord.`
        )
    }
  }

  // ── Trigger subscription — a POLL, not a webhook (spec §4) ──────────────────

  /**
   * Start a persisted-cursor reconcile poll for this trigger. The flow trigger
   * node's `config` (baseId / tableId / viewId / webhookId) — forwarded by
   * `subscribeTriggers` → `registry.subscribe` — is read by the poller when it
   * registers the subscription. Returns an unsubscribe that stops the poll. An
   * unknown trigger id yields a no-op unsubscribe (the opt-in default — nothing
   * polls), keeping the pinned `subscribe(): () => void`.
   */
  subscribe(
    triggerId: string,
    handler: (event: unknown) => void,
    config: Record<string, unknown> = {}
  ): () => void {
    if (!TRIGGER_IDS.has(triggerId)) return () => {}
    // Pass the REAL trigger node config through to the poller — WITHOUT baseId /
    // tableId / webhookId, the poll can't know what to fetch and no run is seeded.
    return this.subscribeWithConfig(triggerId as AirtableTriggerId, config, (seed) => handler(seed))
  }

  /**
   * The config-aware subscription the poller registers against. `subscribe`
   * delegates here after narrowing the trigger id; kept as a named seam so a test
   * can drive a typed `AirtableTriggerId` + config directly.
   */
  subscribeWithConfig(
    triggerId: AirtableTriggerId,
    config: Record<string, unknown>,
    handler: (event: SeedEvent) => void
  ): () => void {
    return this.poller.subscribe(triggerId, config, handler)
  }
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function optionalNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function optionalStrArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((el): el is string => typeof el === 'string' && el.length > 0)
  return out.length > 0 ? out : undefined
}
