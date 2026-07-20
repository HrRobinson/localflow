import type { LiveConnector } from '../../shared/integrations'
import type { SalesforceQueryContext, SalesforceTriggerId } from '../../shared/salesforce'
import { SALESFORCE_TRIGGER_IDS } from '../../shared/salesforce'
import type { SalesforceApi } from './salesforce-api'
import type { SalesforcePoller } from './salesforce-poller'
import type { SeedEvent } from '../flow/trigger-subscriber'
import { normalizeRecord } from './salesforce-normalize'

/**
 * The Salesforce `LiveConnector` (spec §4.2) — the orchestrator the registry
 * delegates to for id `'salesforce'`. It owns:
 *  - the **action-dispatch table** (`invokeAction(actionId, params)` → the right
 *    `salesforce-api` call, `salesforce-normalize` mapping the read result), and
 *  - **trigger subscription** (`subscribe(triggerId, handler, config)` →
 *    registers a POLL subscription with `salesforce-poller` and returns an
 *    unsubscribe — NOT a webhook, spec §7).
 *
 * Safety posture (spec §9): the connector exposes FOUR gated mutations
 * (`createRecord`, `createTask`, `updateRecord`, `submitForApproval`) but NEVER
 * fires one on its own — each runs ONLY because an action node invoked
 * `invokeAction`, behind whatever `gate`/edge the author drew. Registering a poll
 * subscription makes ZERO Salesforce writes. Every failure REJECTS with the real
 * `salesforce-api` error (spec §11, the pinned convention); the access token /
 * credential is confined to `salesforce-auth` + the Bearer header and never
 * logged or returned.
 *
 * `invokeAction` is `async` so a synchronous validation throw (a missing `id`)
 * surfaces as a REJECTED promise — the pinned convention — never an out-of-band
 * throw the action-runner would see.
 */

export interface SalesforceConnectorDeps {
  api: SalesforceApi
  poller: SalesforcePoller
  /** Org instance URL for the normalized record's Lightning deep-link (§6.3). */
  instanceUrl?: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const TRIGGER_IDS: ReadonlySet<string> = new Set<SalesforceTriggerId>(SALESFORCE_TRIGGER_IDS)

export class SalesforceConnector implements LiveConnector {
  private readonly api: SalesforceApi
  private readonly poller: SalesforcePoller
  private readonly instanceUrl?: string

  constructor(deps: SalesforceConnectorDeps) {
    this.api = deps.api
    this.poller = deps.poller
    this.instanceUrl = deps.instanceUrl
  }

  // ── Action dispatch (spec §6.2 reads, §6.2 gated writes) ────────────────────

  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      // ── Reads (no gate — pure reads write facts for conditions, §6.2) ─────────
      case 'query':
        return this.query(params)
      case 'getRecord':
        return this.getRecord(params)
      // ── Gated writes (the author places a gate before these, §9) ─────────────
      case 'createRecord':
        return this.api.createRecord(
          this.requireObject('createRecord', params),
          this.requireFields('createRecord', params)
        )
      case 'createTask':
        // A typed specialization of createRecord for the Task activity object —
        // the canonical CRM worker verb (spec §6.2). `fields` carries Subject,
        // WhoId, WhatId, ActivityDate, OwnerId.
        return this.api.createRecord('Task', this.requireFields('createTask', params))
      case 'updateRecord':
        await this.api.updateRecord(
          this.requireObject('updateRecord', params),
          this.requireId('updateRecord', params),
          this.requireFields('updateRecord', params)
        )
        return { id: this.requireId('updateRecord', params), success: true }
      case 'submitForApproval':
        // The distinctive native-gate action — hands the human decision to the
        // org's own Approval Process (spec §9). MVP is fire-and-forget: it submits
        // and resolves; the flow continues.
        return this.api.submitForApproval({
          recordId: this.requireRecordId('submitForApproval', params),
          approverId: optionalStr(params.approverId),
          comments: optionalStr(params.comments)
        })
      default:
        throw new Error(
          `Salesforce has no action '${actionId}'. Valid actions: query, getRecord, ` +
            `createRecord, createTask, updateRecord, submitForApproval.`
        )
    }
  }

  private async query(params: Record<string, unknown>): Promise<SalesforceQueryContext> {
    const soql = optionalStr(params.soql) ?? optionalStr(params.query)
    if (!soql) {
      throw new Error(
        "Salesforce action 'query' needs a 'soql' string (e.g. \"SELECT Id, Name FROM Lead\")."
      )
    }
    const result = await this.api.query(soql)
    const records = result.records.map(
      (r) => normalizeRecord(r, { instanceUrl: this.instanceUrl }).record
    )
    return { records, count: result.totalSize || records.length, done: result.done }
  }

  private async getRecord(params: Record<string, unknown>): Promise<unknown> {
    const object = this.requireObject('getRecord', params)
    const id = this.requireId('getRecord', params)
    const fields = optionalFields(params.fields)
    const raw = await this.api.getRecord(object, id, fields)
    return normalizeRecord(raw, { type: object, instanceUrl: this.instanceUrl })
  }

  private requireObject(actionId: string, params: Record<string, unknown>): string {
    const object = params.object
    if (typeof object !== 'string' || object.length === 0) {
      throw new Error(
        `Salesforce action '${actionId}' needs an 'object' (the sObject API name, e.g. "Lead").`
      )
    }
    return object
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const id = params.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Salesforce action '${actionId}' needs a record 'id' (e.g. "{{t.record.id}}").`
      )
    }
    return id
  }

  private requireRecordId(actionId: string, params: Record<string, unknown>): string {
    const id = params.recordId ?? params.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Salesforce action '${actionId}' needs a 'recordId' (the record to submit for approval).`
      )
    }
    return id
  }

  private requireFields(
    actionId: string,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    if (!isObject(params.fields) || Object.keys(params.fields).length === 0) {
      throw new Error(
        `Salesforce action '${actionId}' needs a non-empty 'fields' object (the field values to write).`
      )
    }
    return params.fields
  }

  // ── Trigger subscription — a POLL, not a webhook (spec §7.1) ─────────────────

  /**
   * Start a persisted-cursor SOQL reconcile poll for this trigger. The flow
   * trigger node's `config` (sObject + optional SOQL `where` + optional `fields`)
   * — forwarded by `subscribeTriggers` → `registry.subscribe` — is read by the
   * poller when it registers the subscription. Returns an unsubscribe that stops
   * the poll. An unknown trigger id yields a no-op unsubscribe (the opt-in default
   * — nothing polls).
   */
  subscribe(
    triggerId: string,
    handler: (event: unknown) => void,
    config: Record<string, unknown> = {}
  ): () => void {
    if (!TRIGGER_IDS.has(triggerId)) return () => {}
    return this.subscribeWithConfig(triggerId as SalesforceTriggerId, config, (seed) =>
      handler(seed)
    )
  }

  /** The config-aware subscription the poller registers against; a named seam so
   *  a test can drive a typed `SalesforceTriggerId` + config directly. */
  subscribeWithConfig(
    triggerId: SalesforceTriggerId,
    config: Record<string, unknown>,
    handler: (event: SeedEvent) => void
  ): () => void {
    return this.poller.subscribe(triggerId, config, handler)
  }
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function optionalFields(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.filter((f): f is string => typeof f === 'string' && f.length > 0)
    return out.length > 0 ? out : undefined
  }
  if (typeof v === 'string' && v.length > 0) {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return undefined
}
