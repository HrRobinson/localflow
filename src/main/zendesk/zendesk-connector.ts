import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import {
  ZENDESK_TICKET_STATUSES,
  ZENDESK_TRIGGER_IDS,
  type ZendeskSettableStatus,
  type ZendeskTriggerId
} from '../../shared/zendesk'
import type { UpdateTicketResult, ZendeskApi } from './zendesk-api'
import {
  eventToPayload,
  normalizeComment,
  normalizeTicket,
  normalizeUser,
  triggersForType
} from './zendesk-normalize'
import type { ZendeskWebhookDelivery, ZendeskWebhookServer } from './zendesk-webhook-server'

/**
 * The Zendesk `LiveConnector` (spec §4.2) — the live dispatch behind the registry's
 * pinned `invokeAction`/`subscribe`. It maps a pinned action id → a `zendesk-api`
 * call (isolating every Zendesk shape there) and a pinned trigger id → a shared
 * webhook subscription. It holds NO Zendesk shape and NO secret: reads normalize
 * through `zendesk-normalize.ts`, mutations resolve the client's small result, and
 * every failure REJECTS with the real cause (the pinned convention) — never a
 * token, never a sentinel-success (§6.2, §11).
 *
 * THE REPLY/NOTE SPLIT IS STRUCTURAL (§6.2, §9). Zendesk folds reply + status +
 * assign into ONE `PUT`; this connector exposes them as DISTINCT action ids that
 * each set only their own fields. `replyToTicket` is the ONLY id that emits
 * `comment.public: true` (customer-facing outbound) and is the ONLY caller of the
 * single private `sendPublicReply` — the never-auto-send send-path (§9). A
 * `setStatus`/`assignTicket` write can NEVER carry a public comment as a side
 * effect. Delivering a trigger makes ZERO Zendesk writes (the never-auto-run
 * guarantee, §9).
 */

export interface ZendeskConnectorDeps {
  api: ZendeskApi
  webhook?: ZendeskWebhookServer
  log?: (message: string) => void
  /** Injectable id minter for a delivery lacking an event id (tests). */
  newId?: () => string
}

const isTriggerId = (v: string): v is ZendeskTriggerId =>
  (ZENDESK_TRIGGER_IDS as readonly string[]).includes(v)

const isSettableStatus = (v: string): v is ZendeskSettableStatus =>
  (ZENDESK_TICKET_STATUSES as readonly string[]).includes(v)

export class ZendeskConnector implements LiveConnector {
  private readonly api: ZendeskApi
  private readonly webhook?: ZendeskWebhookServer
  private readonly log: (message: string) => void
  private readonly newId: () => string
  private readonly handlers = new Map<ZendeskTriggerId, Set<(event: unknown) => void>>()
  private readonly seenEvents = new Set<string>()
  private webhookWired = false

  constructor(deps: ZendeskConnectorDeps) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.log = deps.log ?? ((m) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch ─────────────────────────────────────────────────────────

  // `async` so a synchronous validation throw (a missing id, a bad status)
  // surfaces as a REJECTED promise — the pinned failure convention.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getTicket':
        return normalizeTicket(await this.api.getTicket(this.requireId(actionId, params)))
      case 'getComments': {
        const raws = await this.api.getComments(this.requireId(actionId, params))
        return { comments: raws.map(normalizeComment), count: raws.length }
      }
      case 'searchTickets': {
        const raws = await this.api.searchTickets(this.requireQuery(actionId, params))
        return { tickets: raws.map(normalizeTicket), count: raws.length }
      }
      case 'getUser':
        return normalizeUser(await this.api.getUser(this.requireId(actionId, params)))
      case 'replyToTicket':
        return this.replyToTicket(actionId, params)
      case 'addInternalNote':
        return this.addInternalNote(actionId, params)
      case 'setStatus':
        return this.setStatus(actionId, params)
      case 'assignTicket':
        return this.assignTicket(actionId, params)
      case 'tagTicket':
        return this.tagTicket(actionId, params)
      default:
        throw new Error(
          `Zendesk has no action '${actionId}'. Valid actions: getTicket, getComments, ` +
            'searchTickets, getUser, replyToTicket, addInternalNote, setStatus, assignTicket, tagTicket.'
        )
    }
  }

  /**
   * Public reply to the customer (§6.2) — GATED, never-auto-send (§9). This is the
   * SOLE caller of `sendPublicReply`, the ONLY code path that emits
   * `comment.public: true`. A grep test asserts one non-test caller of that path.
   */
  private async replyToTicket(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<UpdateTicketResult> {
    const ticketId = this.requireId(actionId, params)
    const body = this.requireBody(actionId, params)
    return this.sendPublicReply(ticketId, body)
  }

  /** The never-auto-send public-reply send-path (§9). Isolated so it has exactly
   *  ONE non-test caller (`replyToTicket`), reached only behind the author's gate. */
  private sendPublicReply(ticketId: string, body: string): Promise<UpdateTicketResult> {
    return this.api.updateTicket({ ticketId, comment: { body, public: true } })
  }

  /** Internal note (§6.2) — the connector HARD-SETS `public: false`; never
   *  customer-facing, so the author MAY leave it un-gated. */
  private addInternalNote(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<UpdateTicketResult> {
    const ticketId = this.requireId(actionId, params)
    const body = this.requireBody(actionId, params)
    return this.api.updateTicket({ ticketId, comment: { body, public: false } })
  }

  /** Set ticket status (§6.2) — carries NO comment (a status write can never
   *  smuggle a public reply). */
  private setStatus(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<UpdateTicketResult> {
    const ticketId = this.requireId(actionId, params)
    const status = String(params.status ?? '').toLowerCase()
    if (!isSettableStatus(status)) {
      throw new Error(
        `Zendesk action 'setStatus' needs a status of ${ZENDESK_TICKET_STATUSES.join(' | ')} — got '${String(params.status)}'.`
      )
    }
    return this.api.updateTicket({ ticketId, status })
  }

  /** Assign the ticket (§6.2) — routing, low-risk; carries NO comment. */
  private assignTicket(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<UpdateTicketResult> {
    const ticketId = this.requireId(actionId, params)
    const assigneeId = optionalString(params.assigneeId)
    const groupId = optionalString(params.groupId)
    if (assigneeId === undefined && groupId === undefined) {
      throw new Error(
        "Zendesk action 'assignTicket' needs an 'assigneeId' or a 'groupId' to assign to."
      )
    }
    return this.api.updateTicket({ ticketId, assigneeId, groupId })
  }

  /** Tag the ticket (§6.2) — low-risk annotate via `PUT /tickets/{id}/tags`. */
  private tagTicket(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<{ ticketId: string; tags: string[] }> {
    const ticketId = this.requireId(actionId, params)
    const tags = Array.isArray(params.tags)
      ? params.tags.filter((t): t is string => typeof t === 'string')
      : undefined
    if (!tags || tags.length === 0) {
      throw new Error("Zendesk action 'tagTicket' needs a non-empty 'tags' string array.")
    }
    return this.api.setTags({ ticketId, tags })
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const id = params.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Zendesk action '${actionId}' needs a ticket id — pass 'id' (e.g. "{{t.ticketId}}").`
      )
    }
    return id
  }

  private requireBody(actionId: string, params: Record<string, unknown>): string {
    const body = params.body
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new Error(`Zendesk action '${actionId}' needs a non-empty 'body' to post.`)
    }
    return body
  }

  private requireQuery(actionId: string, params: Record<string, unknown>): string {
    const query = params.query
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error(
        `Zendesk action '${actionId}' needs a search 'query' (e.g. "requester:buyer@x.com").`
      )
    }
    return query
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`zendesk connector: ignoring unknown trigger '${triggerId}'`)
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
   * Verified delivery → normalized trigger payload → matching handlers. Dedup on
   * the delivery/event id so an at-least-once redelivery never seeds a second run
   * (§7.1). This path makes ZERO Zendesk writes — delivering a trigger NEVER
   * mutates a ticket (the never-auto-run guarantee, §9).
   */
  private onDelivery(delivery: ZendeskWebhookDelivery): void {
    const eventId = delivery.eventId || this.newId()
    if (this.seenEvents.has(eventId)) return
    this.seenEvents.add(eventId)
    const payload = eventToPayload(delivery.type, delivery.data, eventId)
    if (!payload) return
    const seed = { eventId, payload }
    for (const triggerId of triggersForType(delivery.type)) {
      for (const handler of this.handlers.get(triggerId) ?? []) handler(seed)
    }
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
