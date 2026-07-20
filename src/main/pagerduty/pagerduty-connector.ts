import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import { PAGERDUTY_TRIGGER_IDS, type PagerDutyTriggerId } from '../../shared/pagerduty'
import type { PagerDutyApi } from './pagerduty-api'
import {
  normalizeIncident,
  normalizeService,
  triggersFor,
  webhookToPayload
} from './pagerduty-normalize'
import type { PagerDutyWebhookDelivery, PagerDutyWebhookServer } from './pagerduty-webhook-server'

/**
 * The PagerDuty `LiveConnector` (spec §4.2, §4.3) — the live dispatch behind the
 * registry's pinned `invokeAction`/`subscribe`. It maps a pinned action id → a
 * `pagerduty-api` call (isolating every PagerDuty shape there) and a pinned
 * trigger id → a webhook subscription. It holds NO PagerDuty shape and NO secret:
 * reads normalize through `pagerduty-normalize.ts`, mutations resolve the api's
 * small result, and every failure REJECTS with the real cause (the pinned
 * convention) — never a token, never a sentinel-success (§6.2, §11).
 *
 * **Authority stays in the graph (§9).** Every mutation
 * (`acknowledgeIncident`/`resolveIncident`/`escalateIncident`/`addNote`) runs
 * ONLY because an `action` node invoked it, behind whatever `gate`/edge the author
 * drew — INCLUDING `acknowledge`. The connector NEVER auto-mutates: a verified
 * webhook fans a SeedEvent to trigger handlers and writes NOTHING.
 *
 * **Dedup on `event.id` lives here** (§4.4): PagerDuty's redelivery id rides in
 * the body, so `onDelivery` drops a repeated `event.id` before seeding a run
 * (the webhook receiver 200-fasts every verified, parseable delivery).
 */

const isTriggerId = (v: string): v is PagerDutyTriggerId =>
  (PAGERDUTY_TRIGGER_IDS as readonly string[]).includes(v)

export interface PagerDutyConnectorDeps {
  api: PagerDutyApi
  webhook?: PagerDutyWebhookServer
  log?: (message: string) => void
  /** Injectable id minter for a SeedEvent lacking a delivery id (tests). */
  newId?: () => string
}

export class PagerDutyConnector implements LiveConnector {
  private readonly api: PagerDutyApi
  private readonly webhook?: PagerDutyWebhookServer
  private readonly log: (message: string) => void
  private readonly newId: () => string
  private readonly handlers = new Map<PagerDutyTriggerId, Set<(event: unknown) => void>>()
  /** Seen `event.id`s — the redelivery-safe idempotency guard (§4.4). */
  private readonly seen = new Set<string>()
  private webhookWired = false

  constructor(deps: PagerDutyConnectorDeps) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.log = deps.log ?? ((m) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch ─────────────────────────────────────────────────────────

  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getIncident':
        return normalizeIncident(await this.api.getIncident(this.requireId(actionId, params)))
      case 'getService':
        return normalizeService(await this.api.getService(this.requireId(actionId, params)))
      case 'acknowledgeIncident':
        return this.api.acknowledgeIncident({ id: this.requireId(actionId, params) })
      case 'resolveIncident':
        return this.api.resolveIncident({ id: this.requireId(actionId, params) })
      case 'escalateIncident':
        return this.api.escalateIncident({
          id: this.requireId(actionId, params),
          escalationLevel: optionalLevel(params.escalationLevel)
        })
      case 'addNote':
        return this.api.addNote({
          id: this.requireId(actionId, params),
          note: this.requireNote(params)
        })
      default:
        throw new Error(
          `PagerDuty has no action '${actionId}'. Valid actions: getIncident, getService, acknowledgeIncident, resolveIncident, escalateIncident, addNote.`
        )
    }
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const id = params.id
    if (typeof id === 'string' && id.length > 0) return id
    throw new Error(
      `PagerDuty action '${actionId}' needs an incident id — pass 'id' (e.g. "{{trigger.incident.id}}").`
    )
  }

  private requireNote(params: Record<string, unknown>): string {
    const note = params.note
    if (typeof note === 'string' && note.length > 0) return note
    throw new Error("PagerDuty action 'addNote' needs a non-empty 'note'.")
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`pagerduty connector: ignoring unknown trigger '${triggerId}'`)
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
   * Verified, parseable delivery → dedup on `event.id` → normalized trigger
   * payload → matching handlers. A repeated `event.id` (a redelivery) is dropped
   * and seeds NO second run. The connector writes NOTHING — it only starts a run.
   */
  private onDelivery(delivery: PagerDutyWebhookDelivery): void {
    // An empty dedup id is NOT indexed as "seen" (an empty key would collapse
    // every id-less delivery into one and silently drop the rest) — we still
    // process it, just without redelivery suppression for that lone case.
    if (delivery.id.length > 0) {
      if (this.seen.has(delivery.id)) return
      this.seen.add(delivery.id)
    }
    const payload = webhookToPayload(delivery.eventType, delivery.data)
    if (!payload) return
    const seed = { eventId: delivery.id || this.newId(), payload }
    for (const triggerId of triggersFor(delivery.eventType)) {
      for (const handler of this.handlers.get(triggerId) ?? []) handler(seed)
    }
  }
}

function optionalLevel(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}
