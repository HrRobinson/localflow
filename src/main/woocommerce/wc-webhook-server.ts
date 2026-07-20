import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type ShortCircuit,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'
import { normalizeOrder } from './wc-normalize'
import type { WcTriggerPayload } from '../../shared/woocommerce'
import type { HostedWebhookBinding } from '../hosted/webhook-bindings'

/**
 * WooCommerce webhook receiver (spec §4.4, §6.1). Now a THIN wrapper over the
 * shared `startWebhookReceiver`: it supplies the WC verifier
 * (`x-wc-webhook-signature`, base64 HMAC-SHA256), a `preVerify` short-circuit
 * that 200s a ping (no `x-wc-webhook-topic`) BEFORE signature verification, and
 * the vendor `parse` (`parseWcOrderBody` + delivery-id). The HTTP + HMAC +
 * size-cap + 200-fast machinery lives in `webhook-receiver.ts`.
 */

/** Cap on the raw webhook body. Generous but a hard ceiling (matches Linear). */
export const WC_MAX_BODY_BYTES = 1_048_576

/** Header WC signs the raw body with (base64 HMAC-SHA256). */
export const WC_SIGNATURE_HEADER = 'x-wc-webhook-signature'
/** Topic header (`order.created`, …). Absent ⇒ a ping/handshake (spec §2.3). */
export const WC_TOPIC_HEADER = 'x-wc-webhook-topic'
/** Per-delivery id — the idempotency key seeded as `eventId` (spec §4.5). */
export const WC_DELIVERY_ID_HEADER = 'x-wc-webhook-delivery-id'

const DEFAULT_PATH = '/woocommerce/webhook'

/** The WC verification scheme: base64 HMAC-SHA256 over the raw body. */
const WC_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  header: WC_SIGNATURE_HEADER,
  encoding: 'base64'
}

/** The verified, normalized event handed to the connector. */
export interface WcWebhookEvent {
  topic: string
  deliveryId?: string
  payload: WcTriggerPayload
}

export interface WcWebhookOptions {
  /** The webhook signing secret. NEVER logged, echoed, or rendered (spec §5). */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger. NEVER receives the secret or the body (spec §8). */
  log?: (message: string) => void
}

export interface WcWebhookServer {
  port: number
  onEvent(handler: (event: WcWebhookEvent) => void): void
  close(): void
}

/**
 * Timing-safe WC HMAC check (delegates to the shared verifier). Both sides are
 * re-hashed with sha256 so a length mismatch never throws and a malformed base64
 * signature simply fails to match. An empty secret is refused outright rather
 * than "verified" against nothing.
 */
export function verifyWcSignature(rawBody: Buffer, provided: unknown, secret: string): boolean {
  const headers: IncomingHttpHeaders = {
    [WC_SIGNATURE_HEADER]: typeof provided === 'string' ? provided : undefined
  }
  return verifyWebhookSignature(rawBody, headers, WC_VERIFIER, secret)
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Validate a raw WC order body into a normalized payload, or `null` if the shape
 * is untrusted/unusable (no order id). Pure + unit-testable, like `parseHookBody`.
 */
export function parseWcOrderBody(raw: string): WcTriggerPayload | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const payload = normalizeOrder(data)
  // An order with no id is not an order we can act on — reject at the boundary.
  if (payload.order.id.length === 0) return null
  return payload
}

/** WC ping short-circuit: a ping/handshake carries no topic header — 200 it and
 *  spawn NO run, BEFORE signature verification (a ping isn't signed, §2.3). */
const wcPingShortCircuit: ShortCircuit = (headers) => {
  const topic = header(headers[WC_TOPIC_HEADER])
  return topic ? null : 200
}

/** Vendor parse: raw order body → normalized `WcWebhookEvent` (topic + optional
 *  delivery id from headers). Topic presence is guaranteed by `preVerify`. */
const parseWcEvent: WebhookParser<WcWebhookEvent> = (rawBody, headers) => {
  const payload = parseWcOrderBody(rawBody.toString('utf8'))
  if (!payload) return null
  const event: WcWebhookEvent = { topic: header(headers[WC_TOPIC_HEADER]) ?? '', payload }
  const deliveryId = header(headers[WC_DELIVERY_ID_HEADER])
  if (deliveryId) event.deliveryId = deliveryId
  return event
}

export function startWcWebhookServer(opts: WcWebhookOptions): Promise<WcWebhookServer> {
  return startWebhookReceiver<WcWebhookEvent>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: WC_VERIFIER,
    parse: parseWcEvent,
    preVerify: wcPingShortCircuit,
    secret: opts.secret,
    maxBodyBytes: WC_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}

/**
 * The hosted-ingress binding for WooCommerce (design §4.3) — the SAME verifier,
 * parse, and `preVerify` ping short-circuit the loopback server uses, plus the
 * keychain ref for the signing secret. `deliver` is the connector's per-event
 * sink. Mirrors `shopifyWebhookBinding` (a `preVerify` here in place of Shopify's
 * `dedup`).
 */
export function woocommerceWebhookBinding(
  deliver: (event: WcWebhookEvent) => void | Promise<void>,
  opts: { secretRef?: string; publicUrl?: string } = {}
): HostedWebhookBinding<WcWebhookEvent> {
  const binding: HostedWebhookBinding<WcWebhookEvent> = {
    integration: 'woocommerce',
    verifier: WC_VERIFIER,
    parse: parseWcEvent,
    preVerify: wcPingShortCircuit,
    deliver,
    secretRef: opts.secretRef ?? 'webhookSecret',
    maxBodyBytes: WC_MAX_BODY_BYTES
  }
  if (opts.publicUrl) binding.publicUrl = opts.publicUrl
  return binding
}
