import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import { HUBSPOT_TRIGGER_IDS, type HubSpotTriggerId } from '../../shared/hubspot'
import type { HubSpotApi } from './hubspot-api'
import { normalizeCompany, normalizeContact, normalizeDeal } from './hubspot-normalize'
import type { HubSpotWebhookEvent } from './hubspot-normalize'
import type { WebhookReceiver } from '../webhooks/webhook-receiver'

/**
 * The HubSpot `LiveConnector` (§7.1) — the orchestrator the registry delegates
 * to for id `'hubspot'`. It maps a pinned action id → a `hubspot-api` call
 * (isolating every HubSpot shape there) and a pinned trigger id → a shared-
 * receiver subscription. It holds NO HubSpot shape and NO secret: reads
 * normalize through `hubspot-normalize.ts`, writes resolve the api's small
 * result, and every failure REJECTS with the real cause (the pinned convention)
 * — never a token, never a sentinel-success (§3.2).
 *
 * Authority stays in the graph (§7.3): a write only runs because an `action`
 * node invoked it, behind whatever `gate`/edge the author drew. Delivering a
 * trigger makes ZERO api calls — the connector never auto-writes.
 */

const isTriggerId = (v: string): v is HubSpotTriggerId =>
  (HUBSPOT_TRIGGER_IDS as readonly string[]).includes(v)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export interface HubspotConnectorDeps {
  api: HubSpotApi
  /** The shared webhook receiver, when the trigger path is wired (may be absent
   *  in the foundation slice / in action-only tests). */
  webhook?: WebhookReceiver<HubSpotWebhookEvent[]>
  /** Route+reason logger for delivery failures. NEVER receives a secret. */
  log?: (message: string) => void
}

export class HubspotConnector implements LiveConnector {
  private readonly api: HubSpotApi
  private readonly webhook?: WebhookReceiver<HubSpotWebhookEvent[]>
  private readonly log: (message: string) => void
  private readonly handlers = new Map<HubSpotTriggerId, Set<(event: unknown) => void>>()
  private webhookWired = false

  constructor(deps: HubspotConnectorDeps) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  // ── Action dispatch (§3.2 reads + gated writes) ──────────────────────────────

  // `async` so a synchronous validation throw (a missing id) surfaces as a
  // REJECTED promise — the pinned failure convention (§3.2) — never a sync throw
  // the action-runner would see out of band.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getContact':
        return normalizeContact(await this.api.getContact(this.requireId(actionId, params)))
      case 'getDeal':
        return normalizeDeal(await this.api.getDeal(this.requireId(actionId, params)))
      case 'getCompany':
        return normalizeCompany(await this.api.getCompany(this.requireId(actionId, params)))
      case 'searchContacts':
        return this.searchContacts(params)
      case 'createContact':
        return this.createContact(params)
      case 'updateDeal':
        return this.updateDeal(actionId, params)
      case 'logActivity':
        return this.logActivity(params)
      case 'createTask':
        return this.createTask(params)
      default:
        throw new Error(
          `HubSpot has no action '${actionId}'. Valid actions: getContact, getDeal, getCompany, ` +
            'searchContacts, createContact, updateDeal, logActivity, createTask.'
        )
    }
  }

  private async searchContacts(params: Record<string, unknown>): Promise<unknown> {
    const email = optionalString(params.email)
    const query = optionalString(params.query)
    if (!email && !query) {
      throw new Error("HubSpot action 'searchContacts' needs an 'email' or a 'query' to search on.")
    }
    const { results, total } = await this.api.searchContacts({
      email,
      query,
      limit: optionalNumber(params.limit)
    })
    return { contacts: results.map((r) => normalizeContact(r)), total }
  }

  private async createContact(params: Record<string, unknown>): Promise<unknown> {
    const email = optionalString(params.email)
    if (!email) {
      throw new Error("HubSpot action 'createContact' needs a non-empty 'email'.")
    }
    const raw = await this.api.createContact({
      email,
      firstName: optionalString(params.firstName),
      lastName: optionalString(params.lastName),
      company: optionalString(params.company),
      jobTitle: optionalString(params.jobTitle),
      extra: isObject(params.properties) ? asPropertyMap(params.properties) : undefined
    })
    return normalizeContact(raw)
  }

  private async updateDeal(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.requireId(actionId, params)
    const raw = await this.api.updateDeal(id, {
      stage: optionalString(params.stage),
      amount: optionalNumber(params.amount),
      ownerId: optionalString(params.ownerId),
      extra: isObject(params.properties) ? asPropertyMap(params.properties) : undefined
    })
    return normalizeDeal(raw)
  }

  private async logActivity(params: Record<string, unknown>): Promise<unknown> {
    const note = optionalString(params.note)
    if (!note) {
      throw new Error("HubSpot action 'logActivity' needs a non-empty 'note'.")
    }
    const raw = await this.api.createNote({
      note,
      contactId: optionalString(params.contactId),
      dealId: optionalString(params.dealId)
    })
    return { noteId: raw.id }
  }

  private async createTask(params: Record<string, unknown>): Promise<unknown> {
    const subject = optionalString(params.subject)
    if (!subject) {
      throw new Error("HubSpot action 'createTask' needs a non-empty 'subject'.")
    }
    const raw = await this.api.createTask({
      subject,
      body: optionalString(params.body),
      ownerId: optionalString(params.ownerId),
      dueDate: optionalString(params.dueDate),
      contactId: optionalString(params.contactId),
      dealId: optionalString(params.dealId)
    })
    return { taskId: raw.id }
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const raw = params.id
    if (typeof raw === 'string' && raw.length > 0) return raw
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
    throw new Error(
      `HubSpot action '${actionId}' needs a non-empty 'id' — pass one (e.g. "{{t.contactId}}").`
    )
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`hubspot connector: ignoring unknown trigger '${triggerId}'`)
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
    this.webhook.onEvent((events) => this.deliver(events))
  }

  /**
   * Route a verified webhook BATCH (one POST → many events) to every handler
   * subscribed to each event's trigger, as a `{ eventId, payload }` SeedEvent.
   * This is the ONLY path a trigger takes — it makes NO api calls (§7.3).
   * Exposed so an offline test can drive delivery without a live receiver.
   */
  deliver(events: HubSpotWebhookEvent[]): void {
    for (const event of events) {
      const set = this.handlers.get(event.triggerId)
      if (!set || set.size === 0) continue
      const seed = {
        eventId: event.eventId.length > 0 ? event.eventId : randomUUID(),
        payload: event.payload
      }
      for (const handler of set) {
        try {
          handler(seed)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          this.log(`hubspot connector: handler for ${event.triggerId} failed — ${reason}`)
        }
      }
    }
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function optionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Keep only string/number/boolean property values (drop nested/garbage). */
function asPropertyMap(raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}
