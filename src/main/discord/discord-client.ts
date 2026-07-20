import type { DiscordMessageResult } from '../../shared/discord'
import type { DiscordMessageBody } from './discord-components'

/**
 * The Discord **REST** client — the SOLE place any Discord request/response
 * shape lives (the API blast radius, spec §4.1). The `DiscordApi` interface is
 * the seam: `DiscordRestApi` wraps a `DiscordHttpTransport` (the live HTTPS call
 * + `Authorization: Bot <token>`, DEFERRED — see `deferredLiveTransport`), and
 * tests inject a `MockDiscordApi`, so NO live Discord call is ever performed in
 * CI (spec §12). The PEER of `slack-client.ts`.
 *
 * Failure follows the pinned convention: every error path REJECTS with a
 * legible, actionable message carrying the real Discord `{ code, message }`
 * envelope — and NEVER the bot token (spec §8, §11). A per-route `429` is
 * retried honoring `retry_after`; only after exhausting retries does it reject.
 */

// ── The message ref an action / gate writes (channel + message id) ───────────

export type DiscordMessageRef = DiscordMessageResult

/** Discord interaction-callback types this client uses (spec §2.2). */
export const CALLBACK_UPDATE_MESSAGE = 7 // ack + edit the source message in ONE call.
export const CALLBACK_CHANNEL_MESSAGE = 4 // a fresh (optionally ephemeral) reply.
export const CALLBACK_PONG = 1 // answer a PING (HTTP mode only).

export interface PostMessageInput {
  channelId: string
  body: DiscordMessageBody
  /** Reply as a message reference (a thread reply / in-reply-to). */
  messageReference?: string
}

export interface EditMessageInput {
  channelId: string
  messageId: string
  body: DiscordMessageBody
}

export interface RespondToInteractionInput {
  interactionId: string
  token: string
  /** A callback type (`CALLBACK_UPDATE_MESSAGE` acks + edits in one call). */
  type: number
  /** The message body / data for the callback (absent for a bare PONG). */
  body?: DiscordMessageBody
  /** Set for an ephemeral CHANNEL_MESSAGE reply (only the tapper sees it). */
  ephemeral?: boolean
}

/** The seam the connector, approval port, gateway, and control bridge depend on. */
export interface DiscordApi {
  /** `POST /channels/{id}/messages` → the created message ref. */
  postMessage(input: PostMessageInput): Promise<DiscordMessageRef>
  /** `PATCH /channels/{id}/messages/{id}` → resolves on success. */
  editMessage(input: EditMessageInput): Promise<void>
  /** `POST /interactions/{id}/{token}/callback` → ack (+ optional edit/reply). */
  respondToInteraction(input: RespondToInteractionInput): Promise<void>
  /** `PUT /applications/{app}/guilds/{guild}/commands` → register `/localflow`. */
  registerCommands(commands: unknown[]): Promise<void>
  /** `GET /gateway/bot` → the Gateway WSS url. */
  getGatewayUrl(): Promise<{ url: string }>
}

// ── Raw HTTP transport (the live call seam — isolated here) ──────────────────

/** Discord's `{ code, message }` error envelope + the fields the client reads. */
export interface DiscordEnvelope {
  /** Discord numeric error code (present on an error response). */
  code?: number
  /** Discord human message (present on an error response). */
  message?: string
  /** a created/edited message echoes its id. */
  id?: string
  /** `POST …/messages` echoes the channel. */
  channel_id?: string
  /** `GET /gateway/bot` returns the WS url. */
  url?: string
  [key: string]: unknown
}

export interface DiscordHttpResult {
  /** HTTP status — 429 (rate limited) is distinguished from a 2xx body. */
  status: number
  /** `retry_after` seconds on a 429. */
  retryAfter?: number
  body: DiscordEnvelope
}

export type DiscordHttpMethod =
  'postMessage' | 'editMessage' | 'respondToInteraction' | 'registerCommands' | 'getGatewayUrl'

export type DiscordHttpTransport = (req: {
  method: DiscordHttpMethod
  params: Record<string, unknown>
}) => Promise<DiscordHttpResult>

const MAX_RETRIES = 3

/** Map a Discord error response to a legible, actionable message (§11). NEVER
 *  includes the token value; forwards the precise HTTP status Discord returned. */
function messageForError(method: DiscordHttpMethod, status: number, env: DiscordEnvelope): string {
  const detail = env.message ? ` — ${env.message}` : ''
  switch (status) {
    case 401:
      return `Discord rejected the bot token (401)${detail} — it's wrong or was regenerated; re-enter it in Settings.`
    case 403:
      return `Discord refused \`${method}\` (403 Missing Access)${detail} — the bot lacks permission; grant it or pick another channel.`
    case 404:
      return `Discord can't find the target for \`${method}\` (404)${detail} — the bot isn't a member or it doesn't exist; invite the bot or pick another channel.`
    default:
      return `Discord \`${method}\` failed (${status})${detail}.`
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class DiscordRestApi implements DiscordApi {
  private readonly transport: DiscordHttpTransport
  private readonly sleep: (ms: number) => Promise<void>

  constructor(deps: { transport: DiscordHttpTransport; sleep?: (ms: number) => Promise<void> }) {
    this.transport = deps.transport
    this.sleep = deps.sleep ?? delay
  }

  async postMessage(input: PostMessageInput): Promise<DiscordMessageRef> {
    const params: Record<string, unknown> = { channelId: input.channelId, body: input.body }
    if (input.messageReference !== undefined) params.messageReference = input.messageReference
    const body = await this.call('postMessage', params)
    if (typeof body.id !== 'string') {
      throw new Error('Discord `POST /messages` returned no id — the message was not posted.')
    }
    return { channelId: input.channelId, messageId: body.id }
  }

  async editMessage(input: EditMessageInput): Promise<void> {
    await this.call('editMessage', {
      channelId: input.channelId,
      messageId: input.messageId,
      body: input.body
    })
  }

  async respondToInteraction(input: RespondToInteractionInput): Promise<void> {
    const params: Record<string, unknown> = {
      interactionId: input.interactionId,
      token: input.token,
      type: input.type
    }
    if (input.body !== undefined) params.body = input.body
    if (input.ephemeral !== undefined) params.ephemeral = input.ephemeral
    await this.call('respondToInteraction', params)
  }

  async registerCommands(commands: unknown[]): Promise<void> {
    await this.call('registerCommands', { commands })
  }

  async getGatewayUrl(): Promise<{ url: string }> {
    const body = await this.call('getGatewayUrl', {})
    if (typeof body.url !== 'string') {
      throw new Error("Discord `GET /gateway/bot` returned no url — the Gateway WS can't open.")
    }
    return { url: body.url }
  }

  /** One call with 429 backoff + the pinned reject convention. */
  private async call(
    method: DiscordHttpMethod,
    params: Record<string, unknown>
  ): Promise<DiscordEnvelope> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.transport({ method, params })
      if (result.status === 429) {
        if (attempt >= MAX_RETRIES) {
          const secs = result.retryAfter ?? 1
          throw new Error(
            `Discord throttled \`${method}\` (retry in ~${secs}s) — give it a moment and retry.`
          )
        }
        await this.sleep((result.retryAfter ?? 1) * 1000)
        continue
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(messageForError(method, result.status, result.body))
      }
      return result.body
    }
  }
}

/**
 * A transport that fails LOUDLY if a live Discord call is attempted before the
 * live HTTPS binding lands (foundation slice — spec §11). The connector,
 * components, approval port, gateway, and dispatch table are all in place and
 * mock-tested; only the real network exit is deferred. Mirrors Slack's
 * `deferredLiveTransport`.
 */
export function deferredLiveTransport(): DiscordHttpTransport {
  return () =>
    Promise.reject(
      new Error(
        'Discord live REST API is not wired yet — the offline connector core is in place, ' +
          'but the real HTTPS transport + Bot auth land in a follow-up (spec §8, §11).'
      )
    )
}

// ── Test double (spec §12) ───────────────────────────────────────────────────

export interface MockDiscordApiScript {
  /** Force a rejection from postMessage with this HTTP status (403/404/429…). */
  postStatus?: number
  /** Force a rejection from editMessage with this HTTP status. */
  editStatus?: number
  /** The url `getGatewayUrl` resolves to. */
  gatewayUrl?: string
}

const errorFor = (method: DiscordHttpMethod, status: number): Error =>
  new Error(messageForError(method, status, { message: `mock ${status}` }))

/** In-memory `DiscordApi` that records every call — the offline test seam (§12). */
export class MockDiscordApi implements DiscordApi {
  readonly calls = {
    postMessage: [] as PostMessageInput[],
    editMessage: [] as EditMessageInput[],
    respondToInteraction: [] as RespondToInteractionInput[],
    registerCommands: [] as unknown[][],
    getGatewayUrl: 0
  }
  private id = 1000

  constructor(private readonly script: MockDiscordApiScript = {}) {}

  postMessage(input: PostMessageInput): Promise<DiscordMessageRef> {
    this.calls.postMessage.push(input)
    if (this.script.postStatus)
      return Promise.reject(errorFor('postMessage', this.script.postStatus))
    this.id += 1
    return Promise.resolve({ channelId: input.channelId, messageId: `${this.id}` })
  }

  editMessage(input: EditMessageInput): Promise<void> {
    this.calls.editMessage.push(input)
    if (this.script.editStatus)
      return Promise.reject(errorFor('editMessage', this.script.editStatus))
    return Promise.resolve()
  }

  respondToInteraction(input: RespondToInteractionInput): Promise<void> {
    this.calls.respondToInteraction.push(input)
    return Promise.resolve()
  }

  registerCommands(commands: unknown[]): Promise<void> {
    this.calls.registerCommands.push(commands)
    return Promise.resolve()
  }

  getGatewayUrl(): Promise<{ url: string }> {
    this.calls.getGatewayUrl += 1
    return Promise.resolve({ url: this.script.gatewayUrl ?? 'wss://gateway.discord.mock' })
  }
}
