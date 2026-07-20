import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import { INTERCOM_TRIGGER_IDS, type IntercomTriggerId } from '../../shared/intercom'
import type { IntercomApi } from './intercom-api'
import {
  normalizeContact,
  normalizeConversation,
  notificationToPayload,
  triggersForTopic
} from './intercom-normalize'
import type { IntercomWebhookDelivery, IntercomWebhookServer } from './intercom-webhook-server'

/**
 * The Intercom `LiveConnector` (spec §4.2) — the live dispatch behind the registry's
 * pinned `invokeAction`/`subscribe`. It maps a pinned action id → an `intercom-api`
 * call (isolating every Intercom shape there) and a pinned trigger id → a shared
 * webhook subscription. It holds NO Intercom shape and NO secret: reads normalize
 * through `intercom-normalize.ts`, writes resolve the client's small result, and
 * every failure REJECTS with the real cause (the pinned convention) — never a key,
 * never a sentinel-success (§6.2, §11).
 *
 * Authority is the graph the author drew (§9). The three writes are gated actions:
 * NONE ever auto-runs — a write runs ONLY because an `action` node invoked it,
 * behind whatever gate/edge the author placed. `replyToConversation` is
 * CUSTOMER-FACING (a real message to a real customer), so its gate is enforced at
 * flow-validate (never-auto-send, §9); the connector never sends a reply on trigger
 * delivery. Delivering a trigger makes ZERO Intercom writes.
 *
 * Because Intercom sends NO timestamp, the connector DEDUPS on the notification id
 * (in the body → connector-side, like Stripe's `evt_…`), so a redelivery OR a replay
 * of a seen id never seeds a second run (§2.3, §7).
 */

export interface IntercomConnectorDeps {
  api: IntercomApi
  webhook?: IntercomWebhookServer
  log?: (message: string) => void
  /** Injectable id minter for a delivery lacking a notification id (tests). */
  newId?: () => string
}

const isTriggerId = (v: string): v is IntercomTriggerId =>
  (INTERCOM_TRIGGER_IDS as readonly string[]).includes(v)

export class IntercomConnector implements LiveConnector {
  private readonly api: IntercomApi
  private readonly webhook?: IntercomWebhookServer
  private readonly log: (message: string) => void
  private readonly newId: () => string
  private readonly handlers = new Map<IntercomTriggerId, Set<(event: unknown) => void>>()
  private readonly seenNotifications = new Set<string>()
  private webhookWired = false

  constructor(deps: IntercomConnectorDeps) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.log = deps.log ?? ((m) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch ─────────────────────────────────────────────────────────

  // `async` so a synchronous validation throw (a missing id/body) surfaces as a
  // REJECTED promise — the pinned failure convention.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'getConversation':
        return normalizeConversation(
          await this.api.getConversation(this.requireId(actionId, params))
        )
      case 'getContact':
        return normalizeContact(await this.api.getContact(this.requireId(actionId, params)))
      case 'replyToConversation':
        return this.reply(actionId, params)
      case 'closeConversation':
        return this.close(actionId, params)
      case 'tagConversation':
        return this.tag(actionId, params)
      default:
        throw new Error(
          `Intercom has no action '${actionId}'. Valid actions: getConversation, getContact, ` +
            `replyToConversation, closeConversation, tagConversation.`
        )
    }
  }

  /** The CUSTOMER-FACING reply (§6.2, §9) — only an approved gate reaches this
   *  node. The `body` is the context-held draft the human approved. */
  private async reply(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.requireId(actionId, params)
    const body = optionalString(params.body)
    if (body === undefined) {
      throw new Error(
        `Intercom action 'replyToConversation' needs a 'body' — the approved reply text ` +
          `(e.g. "{{draft}}"). A customer reply never sends without one.`
      )
    }
    return this.api.replyToConversation({
      conversationId,
      body,
      adminId: optionalString(params.adminId)
    })
  }

  /** Close the conversation (§6.2) — INTERNAL state; gated like any mutation. */
  private async close(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.requireId(actionId, params)
    return this.api.closeConversation({
      conversationId,
      adminId: optionalString(params.adminId),
      body: optionalString(params.body)
    })
  }

  /** Tag the conversation (§6.2) — INTERNAL state; low-risk annotate, still gated. */
  private async tag(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.requireId(actionId, params)
    const tagId = optionalString(params.tagId)
    if (tagId === undefined) {
      throw new Error(
        `Intercom action 'tagConversation' needs a 'tagId' — the Intercom tag to attach.`
      )
    }
    return this.api.tagConversation({
      conversationId,
      tagId,
      adminId: optionalString(params.adminId)
    })
  }

  private requireId(actionId: string, params: Record<string, unknown>): string {
    const id = params.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Intercom action '${actionId}' needs an id — pass 'id' (e.g. "{{t.conversationId}}").`
      )
    }
    return id
  }

  // ── Trigger subscription (webhook-backed) ────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`intercom connector: ignoring unknown trigger '${triggerId}'`)
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
   * the notification id so an at-least-once redelivery OR a replay never seeds a
   * second run (§2.3, §7). This path makes ZERO Intercom writes — delivering a
   * trigger NEVER sends a reply (the never-auto-send guarantee, §9).
   */
  private onDelivery(delivery: IntercomWebhookDelivery): void {
    const notificationId = delivery.notificationId || this.newId()
    if (this.seenNotifications.has(notificationId)) return
    this.seenNotifications.add(notificationId)
    const payload = notificationToPayload(delivery.topic, delivery.item, notificationId)
    if (!payload) return
    const seed = { eventId: notificationId, payload }
    for (const triggerId of triggersForTopic(delivery.topic)) {
      for (const handler of this.handlers.get(triggerId) ?? []) handler(seed)
    }
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
