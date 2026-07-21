import { randomUUID } from 'node:crypto'
import type { LiveConnector } from '../../shared/integrations'
import {
  SLACK_TRIGGER_IDS,
  type SlackApprovalDecision,
  type SlackApprovalResult,
  type SlackMessageResult,
  type SlackTriggerId
} from '../../shared/slack'
import type { ApprovalRequest } from '../flow/types'
import type { SlackApi } from './slack-client'
import { buildNotifyMessage, parseMessageEvent, parseSlashCommand } from './slack-blocks'
import type { SlackInbound } from './slack-socket'
import { CONTROL_COMMAND, type SlackControlBridge, type ControlReply } from './slack-control-bridge'

/**
 * The Slack `LiveConnector` (spec §4.2, §4.3) — the live dispatch behind the
 * registry's pinned `invokeAction`/`subscribe`. It maps a pinned action id → a
 * `slack-client` call (isolating every Slack shape there), and a pinned trigger
 * id → a subscription fed by the active transport (Socket Mode or Events), with
 * `approval.responded` sourced from the approval port's decisions. It holds NO
 * Slack API shape and NO secret. Every action failure REJECTS with the real
 * cause (the pinned convention) — a DENIED approval is a resolved boolean fact,
 * NOT a failure (§6.2).
 *
 * Authority stays in the graph: a send only runs because an `action` node
 * invoked it, behind whatever `gate`/edge the author drew (§9). The connector
 * never posts on its own.
 */

const isTriggerId = (v: string): v is SlackTriggerId =>
  (SLACK_TRIGGER_IDS as readonly string[]).includes(v)

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

/** The approval mechanism the connector shares with the gate path (§6.2). */
export interface ApprovalMechanism {
  requestApproval(req: ApprovalRequest): Promise<boolean>
  handleInteraction(raw: unknown): void
}

export interface SlackConnectorDeps {
  api: SlackApi
  /** The channel sends/approvals default to (`defaultChannel`). */
  defaultChannel: string
  /** The shared approval port — enables `postApproval` + interaction routing. */
  approvals?: ApprovalMechanism
  /** The `/saiife` control bridge; a reply is delivered via `onControlReply`. */
  control?: SlackControlBridge
  /** Sink for a `/saiife` ephemeral reply (response_url delivery is deferred). */
  onControlReply?: (payload: { responseUrl: string }, reply: ControlReply) => void
  log?: (message: string) => void
}

export class SlackConnector implements LiveConnector {
  private readonly api: SlackApi
  private readonly defaultChannel: string
  private readonly approvals?: ApprovalMechanism
  private readonly control?: SlackControlBridge
  private readonly onControlReply?: (payload: { responseUrl: string }, reply: ControlReply) => void
  private readonly log: (message: string) => void
  private readonly handlers = new Map<SlackTriggerId, Set<(event: unknown) => void>>()

  constructor(deps: SlackConnectorDeps) {
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
          `Slack has no action '${actionId}'. Valid actions: postMessage, postApproval, replyInThread.`
        )
    }
  }

  private async postMessage(params: Record<string, unknown>): Promise<SlackMessageResult> {
    const channel = str(params.channel) ?? this.defaultChannel
    const text = this.requireText('postMessage', params)
    const blocks = Array.isArray(params.blocks) ? (params.blocks as unknown[]) : undefined
    const built = buildNotifyMessage(text, blocks)
    return this.api.postMessage({ channel, text: built.text, blocks: built.blocks })
  }

  private async replyInThread(params: Record<string, unknown>): Promise<SlackMessageResult> {
    const channel = str(params.channel) ?? this.defaultChannel
    const threadTs = str(params.threadTs) ?? str(params.thread_ts) ?? str(params.ts)
    if (!threadTs) {
      throw new Error(
        "Slack action 'replyInThread' needs a 'threadTs' (the parent message ts, e.g. \"{{post.ts}}\")."
      )
    }
    const text = this.requireText('replyInThread', params)
    return this.api.postMessage({ channel, text, threadTs })
  }

  private async postApproval(params: Record<string, unknown>): Promise<SlackApprovalResult> {
    if (!this.approvals) {
      throw new Error(
        "Slack action 'postApproval' needs Slack connected as the approval surface — it isn't wired in this build."
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
      throw new Error(`Slack action '${actionId}' needs a non-empty '${key}'.`)
    }
    return v
  }

  // ── Trigger subscription (§6.1) ──────────────────────────────────────────────

  subscribe(triggerId: string, handler: (event: unknown) => void): () => void {
    if (!isTriggerId(triggerId)) {
      this.log(`slack connector: ignoring unknown trigger '${triggerId}'`)
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

  // ── Inbound routing (transport-agnostic: Socket Mode or Events) ──────────────

  /** Route a normalized inbound envelope from the active transport. */
  handleInbound(inbound: SlackInbound): void {
    switch (inbound.type) {
      case 'interactive':
        // Button taps drive the approval port; it emits `approval.responded` via
        // `onApprovalDecision` (wired at startup), so we don't double-parse here.
        this.approvals?.handleInteraction(inbound.payload)
        return
      case 'events_api': {
        const payload = parseMessageEvent(inbound.payload)
        if (payload) this.dispatch('message.received', { eventId: payload.ts, payload })
        return
      }
      case 'slash_commands': {
        const slash = parseSlashCommand(inbound.payload)
        if (!slash) return
        if (slash.command === CONTROL_COMMAND) {
          if (this.control) {
            const reply = this.control.handle(slash)
            this.onControlReply?.({ responseUrl: slash.responseUrl }, reply)
          }
          return // the reserved control command is NOT a slash.command trigger.
        }
        this.dispatch('slash.command', { eventId: randomUUID(), payload: slash })
        return
      }
    }
  }

  /** The approval port's `onDecision` sink → the `approval.responded` trigger. */
  onApprovalDecision(decision: SlackApprovalDecision): void {
    this.dispatch('approval.responded', {
      eventId: `${decision.runId}:${decision.nodeId}`,
      payload: decision
    })
  }

  private dispatch(triggerId: SlackTriggerId, seed: unknown): void {
    for (const handler of this.handlers.get(triggerId) ?? []) {
      try {
        handler(seed)
      } catch (err) {
        this.log(
          `slack connector: '${triggerId}' handler failed — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
}
