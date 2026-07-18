import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import {
  SENTRY_TRIGGER_IDS,
  type SentryStatusDetails,
  type SentryTriggerId
} from '../../shared/sentry'
import type { SentryApi } from './sentry-api'
import { normalizeEvent, normalizeIssue, triggersFor, webhookToPayload } from './sentry-normalize'
import type { SentryWebhookDelivery, SentryWebhookServer } from './sentry-webhook-server'

/**
 * The Sentry `LiveConnector` (spec §4.2, §4.3) — the live dispatch behind the
 * registry's pinned `invokeAction`/`subscribe`. It maps a pinned action id → a
 * `sentry-api` call (isolating every Sentry shape there) and a pinned trigger id
 * → a webhook subscription, applying the `substatus:'regressed'` filter for the
 * DERIVED `issue.regressed` trigger. It holds NO Sentry shape and NO secret:
 * reads normalize through `sentry-normalize.ts`, mutations resolve the api's
 * small result, and every failure REJECTS with the real cause (the pinned
 * convention) — never a token, never a sentinel-success (spec §6.2, §11).
 *
 * Authority stays in the graph: a mutation only runs because an `action` node
 * invoked it, behind whatever `gate`/edge (or merged-PR signal) the author drew
 * (§9). The connector never auto-mutates.
 */

const isTriggerId = (v: string): v is SentryTriggerId =>
  (SENTRY_TRIGGER_IDS as readonly string[]).includes(v)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export interface SentryConnectorDeps {
  api: SentryApi
  webhook?: SentryWebhookServer
  log?: (message: string) => void
  /** Injectable id minter for a SeedEvent lacking a delivery id (tests). */
  newId?: () => string
}

export class SentryConnector implements LiveConnector {
  private readonly api: SentryApi
  private readonly webhook?: SentryWebhookServer
  private readonly log: (message: string) => void
  private readonly newId: () => string
  private readonly handlers = new Map<SentryTriggerId, Set<(event: unknown) => void>>()
  private webhookWired = false

  constructor(deps: SentryConnectorDeps) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.log = deps.log ?? ((m) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch ─────────────────────────────────────────────────────────

  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getIssue':
        return normalizeIssue(await this.api.getIssue(this.requireId(actionId, params)))
      case 'getEvent':
        return normalizeEvent(
          await this.api.getEvent({
            id: this.requireId(actionId, params),
            eventId: optionalString(params.eventId)
          })
        )
      case 'searchIssues': {
        const issues = await this.api.searchIssues({ query: optionalString(params.query) })
        return { issues: issues.map((i) => normalizeIssue(i)), count: issues.length }
      }
      case 'resolveIssue':
        return this.api.resolveIssue({
          id: this.requireId(actionId, params),
          statusDetails: optionalStatusDetails(params.statusDetails)
        })
      case 'ignoreIssue':
        return this.api.ignoreIssue({
          id: this.requireId(actionId, params),
          statusDetails: optionalStatusDetails(params.statusDetails)
        })
      case 'assignIssue':
        return this.api.assignIssue({
          id: this.requireId(actionId, params),
          assignedTo: this.requireAssignee(params)
        })
      case 'commentIssue':
        return this.api.commentIssue({
          id: this.requireId(actionId, params),
          text: this.requireText(params)
        })
      default:
        throw new Error(
          `Sentry has no action '${actionId}'. Valid actions: getIssue, getEvent, searchIssues, resolveIssue, assignIssue, ignoreIssue, commentIssue.`
        )
    }
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const id = params.id
    if (typeof id === 'string' && id.length > 0) return id
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
    throw new Error(
      `Sentry action '${actionId}' needs an issue id — pass 'id' (e.g. "{{trigger.issueId}}").`
    )
  }

  private requireAssignee(params: Record<string, unknown>): string {
    const to = params.assignedTo
    if (typeof to === 'string' && to.length > 0) return to
    throw new Error(
      "Sentry action 'assignIssue' needs 'assignedTo' — a 'user:<id>' or 'team:<id>' actor."
    )
  }

  private requireText(params: Record<string, unknown>): string {
    const text = params.text
    if (typeof text === 'string' && text.length > 0) return text
    throw new Error("Sentry action 'commentIssue' needs a non-empty 'text'.")
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`sentry connector: ignoring unknown trigger '${triggerId}'`)
      return () => {}
    }
    let set = this.handlers.get(triggerId)
    if (!set) {
      set = new Set()
      this.handlers.set(triggerId, set)
    }
    set.add(handler)
    this.wireWebhook()
    return () => {
      set!.delete(handler)
    }
  }

  /** Attach the single webhook `onEvent` sink once, lazily on first subscribe. */
  private wireWebhook(): void {
    if (this.webhookWired || !this.webhook) return
    this.webhookWired = true
    this.webhook.onEvent((delivery) => this.onDelivery(delivery))
  }

  /**
   * Verified, deduped delivery → normalized trigger payload → matching handlers.
   * The `issue.regressed` filter lives in `triggersFor`: an `unresolved` issue
   * event whose `substatus !== 'regressed'` maps to NO trigger and seeds no run.
   */
  private onDelivery(delivery: SentryWebhookDelivery): void {
    const raw = { ...delivery.payload, action: delivery.action ?? delivery.payload.action }
    const payload = webhookToPayload(delivery.resource, raw)
    if (!payload) return
    const seed = { eventId: delivery.requestId || this.newId(), payload }
    for (const triggerId of triggersFor(delivery.resource, payload)) {
      for (const handler of this.handlers.get(triggerId) ?? []) handler(seed)
    }
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Pass a `statusDetails` object through when present (the engine templates its
 *  string leaves — e.g. `inCommit.commit` — leaving the object structure intact). */
function optionalStatusDetails(v: unknown): SentryStatusDetails | undefined {
  return isObject(v) ? (v as SentryStatusDetails) : undefined
}
