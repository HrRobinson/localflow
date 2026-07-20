import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type ShortCircuit,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'
import type { HostedWebhookBinding } from '../hosted/webhook-bindings'

/**
 * Sentry webhook receiver (spec §4.4). A THIN wrapper over the shared
 * `startWebhookReceiver`: it supplies the Sentry verifier — HMAC-SHA256 **hex**
 * over the raw body against the keychain Client Secret, header
 * `Sentry-Hook-Signature` — a `dedup` short-circuit closing over a seen-set of
 * `Request-ID`s (200 + drop a redelivery, AFTER verify / BEFORE parse), and the
 * vendor `parse` (JSON-object guard + `Sentry-Hook-Resource` routing →
 * `SentryWebhookDelivery`). The HTTP + HMAC + size-cap + 200-fast machinery lives
 * in `webhook-receiver.ts`.
 */

/** Generous cap on the raw body — an alert event with a stack trace is large. */
export const SENTRY_MAX_BODY_BYTES = 1_048_576

export const SENTRY_SIGNATURE_HEADER = 'sentry-hook-signature'
export const SENTRY_RESOURCE_HEADER = 'sentry-hook-resource'
export const SENTRY_REQUEST_ID_HEADER = 'request-id'

const DEFAULT_PATH = '/sentry/webhook'

/** The Sentry verification scheme: hex HMAC-SHA256 over the raw body. */
export const SENTRY_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: SENTRY_SIGNATURE_HEADER,
  encoding: 'hex'
}

/** A verified, novel delivery handed to the connector. `payload` is the parsed,
 *  still-untrusted JSON body — the connector normalizes it (§4.2). */
export interface SentryWebhookDelivery {
  requestId: string
  /** `Sentry-Hook-Resource` — `issue` | `event_alert`. */
  resource: string
  /** The body's `action` field, e.g. `created` | `unresolved` | `triggered`. */
  action?: string
  payload: Record<string, unknown>
}

export interface SentryWebhookOptions {
  /** The webhook Client Secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface SentryWebhookServer {
  port: number
  onEvent(handler: (delivery: SentryWebhookDelivery) => void): void
  close(): void
}

/**
 * Timing-safe HMAC-SHA256 (hex) check over the raw body (delegates to the shared
 * verifier). Both sides are re-hashed with sha256 so a length mismatch never
 * throws and a malformed hex signature simply fails to match. An empty secret is
 * refused outright (an empty-key HMAC is forgeable by anyone who knows the body).
 */
export function verifySentrySignature(rawBody: Buffer, provided: unknown, secret: string): boolean {
  const headers: IncomingHttpHeaders = {
    [SENTRY_SIGNATURE_HEADER]: typeof provided === 'string' ? provided : undefined
  }
  return verifyWebhookSignature(rawBody, headers, SENTRY_VERIFIER, secret)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/** The Sentry dedup short-circuit: 200 + drop a repeated `Request-ID`. Owns its
 *  own unbounded seen-set and records the id when it decides to continue. */
function makeSentryDedup(): ShortCircuit {
  const seen = new Set<string>()
  return (headers) => {
    const requestId = header(headers[SENTRY_REQUEST_ID_HEADER])
    if (requestId.length > 0 && seen.has(requestId)) return 200
    if (requestId.length > 0) seen.add(requestId)
    return null
  }
}

/** Vendor parse: JSON-object guard → `SentryWebhookDelivery` (resource + request
 *  id from headers, action from the body, still-untrusted JSON payload). */
const parseSentryDelivery: WebhookParser<SentryWebhookDelivery> = (rawBody, headers) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  const delivery: SentryWebhookDelivery = {
    requestId: header(headers[SENTRY_REQUEST_ID_HEADER]),
    resource: header(headers[SENTRY_RESOURCE_HEADER]),
    payload: parsed
  }
  if (typeof parsed.action === 'string') delivery.action = parsed.action
  return delivery
}

export function startSentryWebhookServer(opts: SentryWebhookOptions): Promise<SentryWebhookServer> {
  return startWebhookReceiver<SentryWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: SENTRY_VERIFIER,
    parse: parseSentryDelivery,
    dedup: makeSentryDedup(),
    secret: opts.secret,
    maxBodyBytes: SENTRY_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}

/**
 * The hosted-ingress binding for Sentry (design §4.3) — the SAME verifier, parse,
 * and dedup the loopback server uses, plus the keychain ref for the Client
 * Secret. `deliver` is the connector's per-delivery sink. A fresh dedup seen-set
 * is created per binding, exactly like `startSentryWebhookServer`. Mirrors
 * `shopifyWebhookBinding`.
 */
export function sentryWebhookBinding(
  deliver: (delivery: SentryWebhookDelivery) => void | Promise<void>,
  opts: { secretRef?: string; publicUrl?: string } = {}
): HostedWebhookBinding<SentryWebhookDelivery> {
  const binding: HostedWebhookBinding<SentryWebhookDelivery> = {
    integration: 'sentry',
    verifier: SENTRY_VERIFIER,
    parse: parseSentryDelivery,
    dedup: makeSentryDedup(),
    deliver,
    secretRef: opts.secretRef ?? 'webhookSecret',
    maxBodyBytes: SENTRY_MAX_BODY_BYTES
  }
  if (opts.publicUrl) binding.publicUrl = opts.publicUrl
  return binding
}
