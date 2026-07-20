import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type ShortCircuit,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'

/**
 * Shopify webhook receiver (spec §4.4, §7). Now a THIN wrapper over the shared
 * `startWebhookReceiver`: it supplies the Shopify verifier (`x-shopify-hmac-sha256`,
 * base64 HMAC-SHA256), a `dedup` short-circuit closing over a seen-set of
 * `X-Shopify-Webhook-Id`s (200 + drop a redelivery, AFTER verify / BEFORE parse),
 * and the vendor `parse` (JSON-object guard → `ShopifyWebhookDelivery`). The HTTP
 * + HMAC + size-cap + 200-fast machinery lives in `webhook-receiver.ts`.
 */

/** Generous cap on the raw body — an order payload is larger than a hook ping. */
export const SHOPIFY_MAX_BODY_BYTES = 1_048_576

export const SHOPIFY_HMAC_HEADER = 'x-shopify-hmac-sha256'
export const SHOPIFY_TOPIC_HEADER = 'x-shopify-topic'
export const SHOPIFY_WEBHOOK_ID_HEADER = 'x-shopify-webhook-id'

const DEFAULT_PATH = '/shopify/webhook'

/** The Shopify verification scheme: base64 HMAC-SHA256 over the raw body. */
const SHOPIFY_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  header: SHOPIFY_HMAC_HEADER,
  encoding: 'base64'
}

/** A verified, novel delivery handed to the connector. `payload` is the parsed,
 *  still-untrusted JSON body — the connector normalizes it (§4.2). */
export interface ShopifyWebhookDelivery {
  webhookId: string
  topic: string
  payload: Record<string, unknown>
}

export interface ShopifyWebhookOptions {
  /** The webhook signing secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface ShopifyWebhookServer {
  port: number
  onEvent(handler: (delivery: ShopifyWebhookDelivery) => void): void
  close(): void
}

/**
 * Timing-safe HMAC-SHA256 check over the raw body (delegates to the shared
 * verifier). Both sides are re-hashed with sha256 so a length mismatch never
 * throws and a malformed base64 signature simply fails to match. An empty secret
 * is refused outright (an empty-key HMAC is forgeable by anyone who knows the body).
 */
export function verifyShopifySignature(
  rawBody: Buffer,
  provided: unknown,
  secret: string
): boolean {
  const headers: IncomingHttpHeaders = {
    [SHOPIFY_HMAC_HEADER]: typeof provided === 'string' ? provided : undefined
  }
  return verifyWebhookSignature(rawBody, headers, SHOPIFY_VERIFIER, secret)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/** The Shopify dedup short-circuit: 200 + drop a repeated `X-Shopify-Webhook-Id`.
 *  Owns its own unbounded seen-set (byte-equivalent to the previous closure Set)
 *  and records the id when it decides to continue. */
function makeShopifyDedup(): ShortCircuit {
  const seenWebhookIds = new Set<string>()
  return (headers) => {
    const webhookId = header(headers[SHOPIFY_WEBHOOK_ID_HEADER])
    if (webhookId.length > 0 && seenWebhookIds.has(webhookId)) return 200
    if (webhookId.length > 0) seenWebhookIds.add(webhookId)
    return null
  }
}

/** Vendor parse: JSON-object guard → `ShopifyWebhookDelivery` (webhook id +
 *  topic from headers, still-untrusted JSON payload). */
const parseShopifyDelivery: WebhookParser<ShopifyWebhookDelivery> = (rawBody, headers) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  return {
    webhookId: header(headers[SHOPIFY_WEBHOOK_ID_HEADER]),
    topic: header(headers[SHOPIFY_TOPIC_HEADER]),
    payload: parsed
  }
}

export function startShopifyWebhookServer(
  opts: ShopifyWebhookOptions
): Promise<ShopifyWebhookServer> {
  return startWebhookReceiver<ShopifyWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: SHOPIFY_VERIFIER,
    parse: parseShopifyDelivery,
    dedup: makeShopifyDedup(),
    secret: opts.secret,
    maxBodyBytes: SHOPIFY_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}
