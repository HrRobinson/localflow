import type { SlackMessageResult } from '../../shared/slack'

/**
 * The Slack **Web API** client — the SOLE place any Slack request/response shape
 * lives (the API blast radius, spec §4.1). The `SlackApi` interface is the seam:
 * `SlackWebApi` wraps a `SlackHttpTransport` (the live HTTPS call + `Bearer`
 * auth, DEFERRED — see `deferredLiveTransport`), and tests inject a
 * `MockSlackApi`, so NO live Slack call is ever performed in CI (spec §12).
 *
 * Failure follows the pinned convention: every error path REJECTS with a
 * legible, actionable message carrying the real Slack `ok:false` `error` code —
 * and NEVER the bot token (spec §8, §11). Tiered-rate-limit `429` is retried
 * honoring `Retry-After`; only after exhausting retries does it reject.
 */

// ── The message ref an action writes to context (channel + ts) ───────────────

export type SlackMessageRef = SlackMessageResult

export interface PostMessageInput {
  channel: string
  text?: string
  blocks?: unknown[]
  /** Set to reply in a thread (`chat.postMessage(thread_ts:)`). */
  threadTs?: string
}

export interface UpdateMessageInput {
  channel: string
  ts: string
  text?: string
  blocks?: unknown[]
}

/** The seam the connector, the approval port, and the socket depend on. */
export interface SlackApi {
  /** `chat.postMessage` → the created message ref. */
  postMessage(input: PostMessageInput): Promise<SlackMessageRef>
  /** `chat.update` → resolves on success (no context value). */
  updateMessage(input: UpdateMessageInput): Promise<void>
  /** `apps.connections.open` → the Socket Mode WebSocket URL. */
  openConnection(): Promise<{ url: string }>
}

// ── Raw HTTP transport (the live call seam — isolated here) ──────────────────

/** The `ok:false` error envelope + the fields the client reads back. */
export interface SlackEnvelope {
  ok: boolean
  error?: string
  /** `chat.postMessage` echoes the channel it posted to. */
  channel?: string
  /** the created/updated message timestamp id. */
  ts?: string
  /** `apps.connections.open` returns the WS url. */
  url?: string
  /** `missing_scope` responses carry the scope needed. */
  needed?: string
  [key: string]: unknown
}

export interface SlackHttpResult {
  /** HTTP status — 429 (rate limited) is distinguished from a 200 body. */
  status: number
  /** `Retry-After` seconds on a 429. */
  retryAfter?: number
  body: SlackEnvelope
}

export type SlackHttpMethod = 'chat.postMessage' | 'chat.update' | 'apps.connections.open'

export type SlackHttpTransport = (req: {
  method: SlackHttpMethod
  params: Record<string, unknown>
}) => Promise<SlackHttpResult>

const MAX_RETRIES = 3

/** Map a Slack `ok:false` error code to a legible, actionable message (§11).
 *  NEVER includes the token value; forwards the precise code Slack returned. */
function messageForError(method: SlackHttpMethod, env: SlackEnvelope): string {
  const code = env.error ?? 'unknown_error'
  switch (code) {
    case 'invalid_auth':
    case 'token_revoked':
    case 'account_inactive':
      return `Slack rejected the bot token (\`${code}\`) — it was revoked or is wrong; re-enter it in Settings.`
    case 'missing_scope': {
      const needed = typeof env.needed === 'string' ? env.needed : 'the required scope'
      return `Slack refused \`${method}\`: the app is missing the \`${needed}\` scope — add it in the app config and reinstall.`
    }
    case 'channel_not_found':
    case 'not_in_channel':
      return `Slack can't post to that channel (\`${code}\`) — the bot isn't a member; \`/invite\` the bot or pick another channel.`
    default:
      return `Slack \`${method}\` failed: \`${code}\`.`
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class SlackWebApi implements SlackApi {
  private readonly transport: SlackHttpTransport
  private readonly sleep: (ms: number) => Promise<void>

  constructor(deps: { transport: SlackHttpTransport; sleep?: (ms: number) => Promise<void> }) {
    this.transport = deps.transport
    this.sleep = deps.sleep ?? delay
  }

  async postMessage(input: PostMessageInput): Promise<SlackMessageRef> {
    const params: Record<string, unknown> = { channel: input.channel }
    if (input.text !== undefined) params.text = input.text
    if (input.blocks !== undefined) params.blocks = input.blocks
    if (input.threadTs !== undefined) params.thread_ts = input.threadTs
    const body = await this.call('chat.postMessage', params)
    if (typeof body.channel !== 'string' || typeof body.ts !== 'string') {
      throw new Error(
        'Slack `chat.postMessage` returned no channel/ts — the message was not posted.'
      )
    }
    return { channel: body.channel, ts: body.ts }
  }

  async updateMessage(input: UpdateMessageInput): Promise<void> {
    const params: Record<string, unknown> = { channel: input.channel, ts: input.ts }
    if (input.text !== undefined) params.text = input.text
    if (input.blocks !== undefined) params.blocks = input.blocks
    await this.call('chat.update', params)
  }

  async openConnection(): Promise<{ url: string }> {
    const body = await this.call('apps.connections.open', {})
    if (typeof body.url !== 'string') {
      throw new Error(
        "Slack `apps.connections.open` returned no url — the Socket Mode WS can't open."
      )
    }
    return { url: body.url }
  }

  /** One call with 429 backoff + the pinned `ok:false` reject convention. */
  private async call(
    method: SlackHttpMethod,
    params: Record<string, unknown>
  ): Promise<SlackEnvelope> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.transport({ method, params })
      if (result.status === 429) {
        if (attempt >= MAX_RETRIES) {
          const secs = result.retryAfter ?? 1
          throw new Error(
            `Slack throttled \`${method}\` (retry in ~${secs}s) — give it a moment and retry.`
          )
        }
        await this.sleep((result.retryAfter ?? 1) * 1000)
        continue
      }
      if (!result.body.ok) throw new Error(messageForError(method, result.body))
      return result.body
    }
  }
}

/**
 * A transport that fails LOUDLY if a live Slack call is attempted before the
 * live HTTPS binding lands (foundation slice — spec §11). The connector, blocks,
 * approval port, and dispatch table are all in place and mock-tested; only the
 * real network exit is deferred. Mirrors Shopify's `deferredLiveTransport`.
 */
export function deferredLiveTransport(): SlackHttpTransport {
  return () =>
    Promise.reject(
      new Error(
        'Slack live Web API is not wired yet — the offline connector core is in place, ' +
          'but the real HTTPS transport + Bearer auth land in a follow-up (spec §8, §11).'
      )
    )
}

// ── Test double (spec §12) ───────────────────────────────────────────────────

export interface MockSlackApiScript {
  /** Force a rejection from postMessage with this Slack error code. */
  postError?: string
  /** Force a rejection from updateMessage with this Slack error code. */
  updateError?: string
  /** The url `openConnection` resolves to. */
  socketUrl?: string
}

/** In-memory `SlackApi` that records every call — the offline test seam (§12). */
export class MockSlackApi implements SlackApi {
  readonly calls = {
    postMessage: [] as PostMessageInput[],
    updateMessage: [] as UpdateMessageInput[],
    openConnection: 0
  }
  private ts = 1000

  constructor(private readonly script: MockSlackApiScript = {}) {}

  postMessage(input: PostMessageInput): Promise<SlackMessageRef> {
    this.calls.postMessage.push(input)
    if (this.script.postError) {
      return Promise.reject(
        new Error(messageForError('chat.postMessage', { ok: false, error: this.script.postError }))
      )
    }
    this.ts += 1
    return Promise.resolve({ channel: input.channel, ts: `${this.ts}.000100` })
  }

  updateMessage(input: UpdateMessageInput): Promise<void> {
    this.calls.updateMessage.push(input)
    if (this.script.updateError) {
      return Promise.reject(
        new Error(messageForError('chat.update', { ok: false, error: this.script.updateError }))
      )
    }
    return Promise.resolve()
  }

  openConnection(): Promise<{ url: string }> {
    this.calls.openConnection += 1
    return Promise.resolve({ url: this.script.socketUrl ?? 'wss://slack.mock/socket' })
  }
}
