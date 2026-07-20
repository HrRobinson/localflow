import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'
import type { LinearSessionAction, LinearSessionEvent } from '../../shared/linear'
import type { HostedWebhookBinding } from '../hosted/webhook-bindings'

/**
 * Receiver for Linear `AgentSessionEvent` webhooks (spec §4.4, §6.1). Now a THIN
 * wrapper over the shared `startWebhookReceiver`: it supplies the Linear verifier
 * config (`linear-signature`, hex HMAC-SHA256) and the vendor `parse`
 * (`parseLinearEvent`). All the security-critical HTTP + HMAC + size-cap +
 * 200-fast machinery lives in `webhook-receiver.ts`; this file keeps only the
 * Linear-specific vocabulary and public surface.
 */

/** Cap on the raw webhook body. Generous vs `hook-server`'s 4 KB — a Linear
 *  payload carries an issue's `promptContext` — but still a hard ceiling. */
export const LINEAR_MAX_BODY_BYTES = 1_048_576

/** Header Linear signs the raw body with (hex HMAC-SHA256). */
export const LINEAR_SIGNATURE_HEADER = 'linear-signature'

const DEFAULT_PATH = '/linear/webhook'
const VALID_ACTIONS: ReadonlySet<string> = new Set<LinearSessionAction>(['created', 'prompted'])

/** The Linear verification scheme: hex HMAC-SHA256 over the raw body. */
const LINEAR_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  header: LINEAR_SIGNATURE_HEADER,
  encoding: 'hex'
}

export interface LinearWebhookOptions {
  /** The webhook signing secret. NEVER logged, echoed, or rendered. */
  secret: string
  /** Path the webhook posts to. Defaults to `/linear/webhook`. */
  path?: string
  /** Bind host — the dev tunnel forwards here (spec §4.4). Default 127.0.0.1. */
  host?: string
  /** Port; default 0 (ephemeral, resolved after listen). */
  port?: number
  /** Route+reason logger. NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface LinearWebhookServer {
  port: number
  /** Register the single handler that receives verified, parsed events. */
  onEvent(handler: (event: LinearSessionEvent) => void): void
  close(): void
}

/**
 * Timing-safe HMAC check (delegates to the shared verifier). Both sides are
 * re-hashed with sha256 so a length mismatch never throws and a malformed hex
 * signature simply fails to match; an empty secret is refused outright.
 */
export function verifyLinearSignature(rawBody: Buffer, provided: unknown, secret: string): boolean {
  const headers: IncomingHttpHeaders = {
    [LINEAR_SIGNATURE_HEADER]: typeof provided === 'string' ? provided : undefined
  }
  return verifyWebhookSignature(rawBody, headers, LINEAR_VERIFIER, secret)
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Best-effort extract of the human's reply on a `prompted` event. Linear's
 *  Developer-Preview shape is isolated here (spec §4.2): a top-level `prompt`
 *  or a nested `agentActivity.content.body`. */
function extractPrompt(data: Record<string, unknown>): string | undefined {
  const top = asString(data.prompt)
  if (top) return top
  const activity = data.agentActivity
  if (typeof activity === 'object' && activity !== null) {
    const content = (activity as Record<string, unknown>).content
    if (typeof content === 'object' && content !== null) {
      return asString((content as Record<string, unknown>).body)
    }
  }
  return undefined
}

/**
 * Validate a raw webhook body into a `LinearSessionEvent`, or `null` if the
 * shape is untrusted/unsupported. Pure and unit-testable in isolation, like
 * `parseHookBody`.
 */
export function parseLinearEvent(raw: string): LinearSessionEvent | null {
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    const d = data as Record<string, unknown>
    const action = d.action
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) return null

    const session = d.agentSession
    if (typeof session !== 'object' || session === null || Array.isArray(session)) return null
    const s = session as Record<string, unknown>
    const id = asString(s.id)
    if (!id) return null

    const event: LinearSessionEvent = {
      action: action as LinearSessionAction,
      agentSession: { id }
    }

    const promptContext = asString(s.promptContext)
    if (promptContext) event.agentSession.promptContext = promptContext
    const sessionState = asString(s.state)
    if (sessionState) event.agentSession.state = sessionState

    const issue = s.issue
    if (typeof issue === 'object' && issue !== null && !Array.isArray(issue)) {
      const iss = issue as Record<string, unknown>
      const issueId = asString(iss.id)
      if (issueId) {
        event.agentSession.issue = { id: issueId }
        const identifier = asString(iss.identifier)
        if (identifier) event.agentSession.issue.identifier = identifier
        const title = asString(iss.title)
        if (title) event.agentSession.issue.title = title
      }
    }

    if (action === 'prompted') {
      const prompt = extractPrompt(d)
      if (prompt) event.prompt = prompt
    }

    return event
  } catch {
    return null
  }
}

export function startLinearWebhookServer(opts: LinearWebhookOptions): Promise<LinearWebhookServer> {
  return startWebhookReceiver<LinearSessionEvent>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: LINEAR_VERIFIER,
    parse: (rawBody) => parseLinearEvent(rawBody.toString('utf8')),
    secret: opts.secret,
    maxBodyBytes: LINEAR_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}

/**
 * The hosted-ingress binding for Linear (design §4.3) — the SAME verifier and
 * parse the loopback server uses, plus the keychain ref for the signing secret.
 * Linear has no dedup hook (mirrors `startLinearWebhookServer`). `deliver` is the
 * connector's per-event sink. Mirrors `shopifyWebhookBinding`.
 */
export function linearWebhookBinding(
  deliver: (event: LinearSessionEvent) => void | Promise<void>,
  opts: { secretRef?: string; publicUrl?: string } = {}
): HostedWebhookBinding<LinearSessionEvent> {
  const binding: HostedWebhookBinding<LinearSessionEvent> = {
    integration: 'linear',
    verifier: LINEAR_VERIFIER,
    parse: (rawBody) => parseLinearEvent(rawBody.toString('utf8')),
    deliver,
    secretRef: opts.secretRef ?? 'webhookSecret',
    maxBodyBytes: LINEAR_MAX_BODY_BYTES
  }
  if (opts.publicUrl) binding.publicUrl = opts.publicUrl
  return binding
}
