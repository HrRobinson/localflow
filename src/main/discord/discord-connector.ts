import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import {
  DISCORD_TRIGGER_IDS,
  type DiscordApprovalDecision,
  type DiscordApprovalResult,
  type DiscordMessageResult,
  type DiscordTriggerId
} from '../../shared/discord'
import type { ApprovalRequest } from '../flow/types'
import type { DiscordApi } from './discord-client'
import {
  buildNotifyMessage,
  parseCommand,
  parseInteraction,
  parseInteractionEvent,
  parseMessageEvent
} from './discord-components'
import type { DiscordInbound } from './discord-gateway'
import { CONTROL_COMMAND_NAME, type DiscordControlBridge } from './discord-control-bridge'
import type { ControlReply } from '../slack/slack-control-bridge'

/**
 * The Discord `LiveConnector` (spec §4.2, §4.3) — the live dispatch behind the
 * registry's pinned `invokeAction`/`subscribe`. It maps a pinned action id → a
 * `discord-client` call (isolating every Discord shape there), and a pinned
 * trigger id → a subscription fed by the active transport (the Gateway), with
 * `approval.responded` sourced from the approval port's decisions. It holds NO
 * Discord API shape and NO secret. Every action failure REJECTS with the real
 * cause (the pinned convention) — a DENIED approval is a resolved boolean fact,
 * NOT a failure (§6.2). The PEER of `slack-connector.ts`.
 *
 * Authority stays in the graph: a send only runs because an `action` node
 * invoked it, behind whatever `gate`/edge the author drew (§9). The connector
 * never posts on its own.
 */

const isTriggerId = (v: string): v is DiscordTriggerId =>
  (DISCORD_TRIGGER_IDS as readonly string[]).includes(v)

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

/** The approval mechanism the connector shares with the gate path (§6.2). */
export interface ApprovalMechanism {
  requestApproval(req: ApprovalRequest): Promise<boolean>
  handleInteraction(raw: unknown): void
}

export interface InteractionCallbackRef {
  interactionId: string
  token: string
}

export interface DiscordConnectorDeps {
  api: DiscordApi
  /** The channel sends/approvals default to (`defaultChannel`). */
  defaultChannel: string
  /** The shared approval port — enables `postApproval` + interaction routing. */
  approvals?: ApprovalMechanism
  /** The `/saiife` control bridge; a reply is delivered via `onControlReply`. */
  control?: DiscordControlBridge
  /** Sink for a `/saiife` ephemeral reply (callback delivery is deferred). */
  onControlReply?: (ref: InteractionCallbackRef, reply: ControlReply) => void
  log?: (message: string) => void
}

export class DiscordConnector implements LiveConnector {
  private readonly api: DiscordApi
  private readonly defaultChannel: string
  private readonly approvals?: ApprovalMechanism
  private readonly control?: DiscordControlBridge
  private readonly onControlReply?: (ref: InteractionCallbackRef, reply: ControlReply) => void
  private readonly log: (message: string) => void
  private readonly handlers = new Map<DiscordTriggerId, Set<(event: unknown) => void>>()

  constructor(deps: DiscordConnectorDeps) {
    this.api = deps.api
    this.defaultChannel = deps.defaultChannel
    this.approvals = deps.approvals
    this.control = deps.control
    this.onControlReply = deps.onControlReply
    this.log = deps.log ?? ((m) => console.warn(m))
  }

  // ── Action dispatch (§6.2) ───────────────────────────────────────────────────

  async invokeAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    switch (actionId) {
      case 'postMessage':
        return this.postMessage(params)
      case 'replyInThread':
        return this.replyInThread(params)
      case 'postApproval':
        return this.postApproval(params)
      default:
        throw new Error(
          `Discord has no action '${actionId}'. Valid actions: postMessage, postApproval, replyInThread.`
        )
    }
  }

  private async postMessage(params: Record<string, unknown>): Promise<DiscordMessageResult> {
    const channelId = str(params.channel) ?? str(params.channelId) ?? this.defaultChannel
    const text = this.requireText('postMessage', params)
    const embeds = Array.isArray(params.embeds) ? (params.embeds as unknown[]) : undefined
    return this.api.postMessage({ channelId, body: buildNotifyMessage(text, embeds) })
  }

  private async replyInThread(params: Record<string, unknown>): Promise<DiscordMessageResult> {
    // A Discord thread IS a channel; the reply posts to the thread's channel id.
    const channelId = str(params.thread) ?? str(params.threadId) ?? str(params.channel)
    if (!channelId) {
      throw new Error(
        "Discord action 'replyInThread' needs a 'threadId' (the thread channel id, e.g. \"{{post.channelId}}\")."
      )
    }
    const text = this.requireText('replyInThread', params)
    const messageReference = str(params.messageReference) ?? str(params.messageId)
    return this.api.postMessage({ channelId, body: buildNotifyMessage(text), messageReference })
  }

  private async postApproval(params: Record<string, unknown>): Promise<DiscordApprovalResult> {
    if (!this.approvals) {
      throw new Error(
        "Discord action 'postApproval' needs Discord connected as the approval surface — it isn't wired in this build."
      )
    }
    const prompt = this.requireText('postApproval', params, 'prompt')
    const peek = Array.isArray(params.peek)
      ? params.peek.filter((p): p is string => typeof p === 'string')
      : []
    // A postApproval action self-correlates (the action-runner passes no run/node
    // id); it shares the port's pending-map + interaction routing (§6.2). A DENY
    // resolves { approved: false } — a routing fact, never a rejection.
    const approved = await this.approvals.requestApproval({
      runId: randomUUID(),
      nodeId: 'postApproval',
      prompt,
      peek
    })
    return { approved }
  }

  private requireText(
    actionId: string,
    params: Record<string, unknown>,
    key: 'text' | 'prompt' = 'text'
  ): string {
    const v = params[key]
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`Discord action '${actionId}' needs a non-empty '${key}'.`)
    }
    return v
  }

  // ── Trigger subscription (§6.1) ──────────────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`discord connector: ignoring unknown trigger '${triggerId}'`)
      return () => {}
    }
    let set = this.handlers.get(triggerId)
    if (!set) {
      set = new Set()
      this.handlers.set(triggerId, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  // ── Inbound routing (transport-agnostic: Gateway or HTTP Interactions) ───────

  /** Route a normalized inbound envelope from the active transport. */
  handleInbound(inbound: DiscordInbound): void {
    switch (inbound.type) {
      case 'message': {
        const payload = parseMessageEvent(inbound.payload)
        if (payload) this.dispatch('message.received', { eventId: payload.messageId, payload })
        return
      }
      case 'interaction': {
        this.routeInteraction(inbound.payload)
        return
      }
    }
  }

  private routeInteraction(raw: unknown): void {
    // 1. Approval buttons drive the port; it emits `approval.responded` via
    //    `onApprovalDecision` (wired at startup), so we don't double-parse here.
    if (parseInteraction(raw)) {
      this.approvals?.handleInteraction(raw)
      return
    }
    // 2. The reserved `/saiife` command → the control bridge (NOT a trigger).
    const command = parseCommand(raw)
    if (command && command.name === CONTROL_COMMAND_NAME) {
      if (this.control) {
        const reply = this.control.handle(command)
        this.onControlReply?.({ interactionId: command.interactionId, token: command.token }, reply)
      }
      return
    }
    // 3. Everything else → the generic `interaction` trigger (§6.1).
    const payload = parseInteractionEvent(raw)
    if (payload) this.dispatch('interaction', { eventId: payload.interactionId, payload })
  }

  /** The approval port's `onDecision` sink → the `approval.responded` trigger. */
  onApprovalDecision(decision: DiscordApprovalDecision): void {
    this.dispatch('approval.responded', {
      eventId: `${decision.runId}:${decision.nodeId}`,
      payload: decision
    })
  }

  private dispatch(triggerId: DiscordTriggerId, seed: unknown): void {
    for (const handler of this.handlers.get(triggerId) ?? []) {
      try {
        handler(seed)
      } catch (err) {
        this.log(
          `discord connector: '${triggerId}' handler failed — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
}
