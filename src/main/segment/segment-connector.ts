import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import {
  SEGMENT_ACTION_IDS,
  SEGMENT_TRIGGER_IDS,
  type SegmentActionId,
  type SegmentTriggerId,
  type SegmentTriggerConfig
} from '../../shared/segment'
import type { SegmentApi } from './segment-client'
import {
  assertNamedTrack,
  eventMatches,
  normalizeSegmentEvent,
  parseTriggerConfig
} from './segment-normalize'
import type { SegmentWebhookDelivery, SegmentWebhookServer } from './segment-webhook-server'

/**
 * The Segment `LiveConnector` (spec §4.2) — the live dispatch behind the registry's
 * pinned `invokeAction`/`subscribe`. It holds NO Segment shape and NO secret:
 * inbound deliveries normalize through `segment-normalize.ts`, writes resolve the
 * client's small result, and every failure REJECTS with the real cause (§11).
 *
 * The one thing this connector does that Stripe's does not (§7): its `subscribe`
 * reads the trigger node's `config` and applies the HARD pre-seed filter
 * (`eventMatches`) BEFORE seeding any run, so a non-matching firehose event seeds
 * ZERO runs — the load-bearing RAM-ceiling defense on the 8 GB machine. And a
 * `track` subscription that does NOT name its event is refused at subscribe time
 * (§7.3) — you structurally cannot author the firehose.
 *
 * Authority is the graph the author drew (§9): the two writes (`track`/`identify`)
 * run ONLY because an `action` node invoked them, behind whatever gate the author
 * placed. Delivering a trigger makes ZERO Segment writes.
 */

interface Subscription {
  handler: (event: unknown) => void
  config: SegmentTriggerConfig
}

const isTriggerId = (v: string): v is SegmentTriggerId =>
  (SEGMENT_TRIGGER_IDS as readonly string[]).includes(v)

const isActionId = (v: string): v is SegmentActionId =>
  (SEGMENT_ACTION_IDS as readonly string[]).includes(v)

export interface SegmentConnectorDeps {
  api: SegmentApi
  webhook?: SegmentWebhookServer
  /** Presence probe for the optional write key (§5, §11). A write rejects before
   *  any call when this returns false. Defaults to always-present (tests). */
  hasWriteKey?: () => boolean
  log?: (message: string) => void
  /** Injectable id minter for a write's messageId (tests). */
  newId?: () => string
}

export class SegmentConnector implements LiveConnector {
  private readonly api: SegmentApi
  private readonly webhook?: SegmentWebhookServer
  private readonly hasWriteKey: () => boolean
  private readonly log: (message: string) => void
  private readonly newId: () => string
  private readonly subscriptions = new Set<Subscription>()
  private webhookWired = false

  constructor(deps: SegmentConnectorDeps) {
    this.api = deps.api
    this.webhook = deps.webhook
    this.hasWriteKey = deps.hasWriteKey ?? (() => true)
    this.log = deps.log ?? ((m) => console.warn(m))
    this.newId = deps.newId ?? randomUUID
  }

  // ── Action dispatch (gated writes) ───────────────────────────────────────────

  // `async` so a synchronous validation throw surfaces as a REJECTED promise —
  // the pinned failure convention.
  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    if (!isActionId(actionId)) {
      throw new Error(`Segment has no action '${actionId}'. Valid actions: track, identify.`)
    }
    // A write into Segment fans out to every downstream destination and needs the
    // source write key — refuse BEFORE any call when none is stored (§11).
    if (!this.hasWriteKey()) {
      throw new Error(
        `This Segment ${actionId} action needs a source write key — none is stored. ` +
          'Add it in Settings, or remove the emit.'
      )
    }
    return actionId === 'track' ? this.track(params) : this.identify(params)
  }

  private async track(params: Record<string, unknown>): Promise<unknown> {
    const event = requireString(params.event, 'track', 'event')
    const identity = requireIdentity(params, 'track')
    const messageId = this.newId()
    const result = await this.api.track({
      event,
      ...identity,
      properties: isObject(params.properties) ? params.properties : undefined,
      messageId
    })
    return { segment: { messageId: result.messageId, type: 'track' as const } }
  }

  private async identify(params: Record<string, unknown>): Promise<unknown> {
    const identity = requireIdentity(params, 'identify')
    const messageId = this.newId()
    const result = await this.api.identify({
      ...identity,
      traits: isObject(params.traits) ? params.traits : undefined,
      messageId
    })
    return { segment: { messageId: result.messageId, type: 'identify' as const } }
  }

  // ── Trigger subscription (webhook-backed, HARD-filtered) ─────────────────────

  /**
   * Subscribe the ONE `event.tracked` trigger with its per-node hard filter
   * (§7.2). The `config` is REQUIRED to be meaningful: a track filter that does
   * not name its event is refused HERE (§7.3) so the firehose is structurally
   * un-authorable. Returns an unsubscribe.
   */
  subscribe(
    triggerId: string,
    handler: (event: unknown) => void,
    config: Record<string, unknown> = {}
  ): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`segment connector: ignoring unknown trigger '${triggerId}'`)
      return () => {}
    }
    const parsed = parseTriggerConfig(config)
    // The structural firehose guard — throws for an un-named track (§7.3).
    assertNamedTrack(parsed)
    const sub: Subscription = { handler, config: parsed }
    this.subscriptions.add(sub)
    this.wireWebhook()
    return () => {
      this.subscriptions.delete(sub)
    }
  }

  /** Attach the single webhook `onEvent` sink once, lazily on first subscribe. */
  private wireWebhook(): void {
    if (this.webhookWired || !this.webhook) return
    this.webhookWired = true
    this.webhook.onEvent((delivery) => this.onDelivery(delivery))
  }

  /**
   * Verified delivery → normalized context → the HARD pre-seed filter (§7.2) →
   * ONLY a match becomes a `SeedEvent`. A non-match is a silent, cheap drop — it
   * starts NO run, spawns NO session, allocates nothing beyond the parse (the
   * RAM-ceiling guarantee). This path makes ZERO Segment writes.
   */
  private onDelivery(delivery: SegmentWebhookDelivery): void {
    const ctx = normalizeSegmentEvent(delivery.body)
    const eventId = ctx.event.messageId || this.newId()
    for (const sub of this.subscriptions) {
      if (!eventMatches(sub.config, ctx)) continue
      sub.handler({ eventId, payload: ctx })
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function requireString(v: unknown, action: string, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Segment action '${action}' needs '${field}' — pass a non-empty ${field}.`)
  }
  return v
}

/** A write needs a `userId` OR an `anonymousId` (Segment requires one). */
function requireIdentity(
  params: Record<string, unknown>,
  action: string
): { userId?: string; anonymousId?: string } {
  const userId =
    typeof params.userId === 'string' && params.userId.length > 0 ? params.userId : undefined
  const anonymousId =
    typeof params.anonymousId === 'string' && params.anonymousId.length > 0
      ? params.anonymousId
      : undefined
  if (userId === undefined && anonymousId === undefined) {
    throw new Error(
      `Segment action '${action}' needs a 'userId' or an 'anonymousId' to identify the user.`
    )
  }
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(anonymousId !== undefined ? { anonymousId } : {})
  }
}
