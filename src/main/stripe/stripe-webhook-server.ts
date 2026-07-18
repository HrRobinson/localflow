import {
  startWebhookReceiver,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'

/**
 * Stripe webhook receiver (spec §4.5, §7). A THIN wrapper over the shared
 * `startWebhookReceiver`: it supplies the Stripe verifier — the reference
 * `signsTimestamp: true` case — and the vendor `parse` (a JSON `event` guard →
 * `StripeWebhookDelivery`). The HTTP + HMAC + timestamp/replay window + size-cap
 * + 200-fast machinery lives in `webhook-receiver.ts`; this file only PINS the
 * Stripe scheme (§7.1). Mirrors `shopify-webhook-server.ts`.
 *
 * Dedup on the event id (`evt_…`) is done CONNECTOR-side (`stripe-connector.ts`):
 * the id is in the parsed BODY, not a header, and the receiver's header-only
 * `dedup` hook can't see it — so the connector keeps the seen-set.
 */

export const STRIPE_MAX_BODY_BYTES = 1_048_576
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature'
const DEFAULT_PATH = '/stripe/webhook'

/**
 * The Stripe verification scheme (§7.1): HMAC-SHA256 (hex) over `"${t}.${rawBody}"`,
 * with the timestamp `t` and signature `v1` parsed from the `Stripe-Signature`
 * header (`t=<ts>,v1=<hex>[,v1=<...>]`), and a 300s replay-tolerance window.
 */
export const STRIPE_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: STRIPE_SIGNATURE_HEADER,
  encoding: 'hex',
  signsTimestamp: true,
  toleranceSec: 300,
  parseHeader: (raw) => {
    // "t=123,v1=abc,v1=def" → { timestamp:"123", signature:"abc" }. Key rotation
    // sends multiple v1s; the receiver's re-hash compare accepts the first that
    // matches (a single active secret verifies the first v1 here).
    let timestamp: string | undefined
    let signature: string | undefined
    for (const part of raw.split(',')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      const k = part.slice(0, eq).trim()
      const v = part.slice(eq + 1).trim()
      if (k === 't') timestamp = v
      else if (k === 'v1' && signature === undefined) signature = v
    }
    if (!timestamp || !signature) return null
    return { timestamp, signature }
  }
}

/** A verified delivery handed to the connector. `data` is the parsed, still-
 *  untrusted `event.data.object`; the connector normalizes it (§7.2). */
export interface StripeWebhookDelivery {
  eventId: string
  type: string
  data: Record<string, unknown>
}

export interface StripeWebhookOptions {
  /** The webhook signing secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface StripeWebhookServer {
  port: number
  onEvent(handler: (delivery: StripeWebhookDelivery) => void): void
  close(): void
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Vendor parse: a well-formed Stripe `event` (has `type` + `data.object`) →
 * `StripeWebhookDelivery`; anything else → null (→ 400, no run seeded, never
 * trust an unexpected shape). Runs AFTER the shared receiver has verified the
 * signature + timestamp over the RAW body.
 */
const parseStripeDelivery: WebhookParser<StripeWebhookDelivery> = (rawBody) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  const type = parsed.type
  if (typeof type !== 'string' || type.length === 0) return null
  const dataObject = isObj(parsed.data) ? parsed.data.object : undefined
  if (!isObj(dataObject)) return null
  const eventId = typeof parsed.id === 'string' ? parsed.id : ''
  return { eventId, type, data: dataObject }
}

export function startStripeWebhookServer(opts: StripeWebhookOptions): Promise<StripeWebhookServer> {
  return startWebhookReceiver<StripeWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: STRIPE_VERIFIER,
    parse: parseStripeDelivery,
    secret: opts.secret,
    maxBodyBytes: STRIPE_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}
