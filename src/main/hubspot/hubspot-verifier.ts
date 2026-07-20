import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type VerifyContext,
  type WebhookParser,
  type WebhookReceiver,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'
import { normalizeSubscriptionBatch, type HubSpotWebhookEvent } from './hubspot-normalize'
import type { HostedWebhookBinding } from '../hosted/webhook-bindings'

/**
 * HubSpot v3 webhook verification wired to the SHARED receiver (§5). Unlike
 * Shopify/Woo/Linear (each with its own `*-webhook-server.ts`), HubSpot is the
 * design driver for the shared receiver's signed-string COMPOSITION hook (§5.4):
 * its `X-HubSpot-Signature-v3` is a base64 HMAC-SHA256 over
 * `method + requestUri + rawBody + timestamp` — NOT the raw body alone — using
 * the app CLIENT SECRET, with the timestamp in `X-HubSpot-Request-Timestamp`
 * (milliseconds) and a 5-minute staleness reject.
 *
 * The URI HubSpot signs is the PUBLIC delivered URL (the tunnel/relay), NOT the
 * loopback `req.url` — so `publicUrl` MUST be supplied and the receiver feeds it
 * to the composer as `requestUri` (§5.3). Getting this wrong makes every
 * signature silently fail.
 */

export const HUBSPOT_MAX_BODY_BYTES = 1_048_576

export const HUBSPOT_SIGNATURE_HEADER = 'x-hubspot-signature-v3'
export const HUBSPOT_TIMESTAMP_HEADER = 'x-hubspot-request-timestamp'

const DEFAULT_PATH = '/hubspot/webhook'

/** The HubSpot v3 verifier config for the shared receiver: base64 HMAC-SHA256
 *  over `method + requestUri + rawBody + timestamp`, ms timestamp, 5-min window. */
export const HUBSPOT_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: HUBSPOT_SIGNATURE_HEADER,
  encoding: 'base64',
  signsTimestamp: true,
  timestampHeader: HUBSPOT_TIMESTAMP_HEADER,
  timestampUnit: 'milliseconds',
  toleranceSec: 300,
  baseString: ({ method, requestUri, rawBody, timestamp }) =>
    `${method}${requestUri}${rawBody}${timestamp}`
}

/**
 * Timing-safe v3 check (delegates to the shared verifier). The signed string is
 * `method + publicUrl + rawBody + timestamp`; both sides are re-hashed with
 * sha256 so a length mismatch never throws and a malformed base64 signature
 * simply fails to match. An empty client secret is refused outright, a stale
 * (>5 min) or missing timestamp rejects, and a wrong URI rejects. Exposed for
 * direct unit testing; `now` is injectable so a fixed clock drives freshness.
 */
export function verifyHubSpotSignature(
  rawBody: Buffer,
  input: {
    signature: unknown
    timestamp: unknown
    method?: string
    /** The PUBLIC delivered URL HubSpot signed (NOT the loopback path). */
    publicUrl: string
  },
  secret: string,
  now: () => number = Date.now
): boolean {
  const headers: IncomingHttpHeaders = {
    [HUBSPOT_SIGNATURE_HEADER]: typeof input.signature === 'string' ? input.signature : undefined,
    [HUBSPOT_TIMESTAMP_HEADER]: typeof input.timestamp === 'string' ? input.timestamp : undefined
  }
  const context: VerifyContext = {
    method: input.method ?? 'POST',
    requestUri: input.publicUrl
  }
  return verifyWebhookSignature(rawBody, headers, HUBSPOT_VERIFIER, secret, now, context)
}

/** Vendor parse: raw (batched) subscription body → normalized events, or `null`
 *  when nothing usable is present (→ 400, no run seeded). */
export const parseHubSpotBatch: WebhookParser<HubSpotWebhookEvent[]> = (rawBody) => {
  let data: unknown
  try {
    data = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  const events = normalizeSubscriptionBatch(data)
  return events.length > 0 ? events : null
}

export interface HubSpotWebhookOptions {
  /** The webhook APP client secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  /** The PUBLIC delivered URL HubSpot signs (§5.3). Required for verification. */
  publicUrl: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

/**
 * Start the HubSpot webhook receiver over the SHARED `startWebhookReceiver`,
 * supplying the v3 verifier, the batched-subscription parse, and — crucially —
 * `publicUrl` so the composer signs the delivered URL, not the loopback path.
 */
export function startHubSpotWebhookReceiver(
  opts: HubSpotWebhookOptions
): Promise<WebhookReceiver<HubSpotWebhookEvent[]>> {
  return startWebhookReceiver<HubSpotWebhookEvent[]>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: HUBSPOT_VERIFIER,
    parse: parseHubSpotBatch,
    secret: opts.secret,
    publicUrl: opts.publicUrl,
    maxBodyBytes: HUBSPOT_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}

/**
 * The hosted-ingress binding for HubSpot (design §4.3) — the SAME v3 verifier and
 * batched-subscription parse the loopback receiver uses, plus the keychain ref
 * for the app CLIENT SECRET and, crucially, `publicUrl`: HubSpot v3 signs the
 * PUBLIC delivered URL, so the binding carries the provisioned ingress URL and
 * `handleWebhookDelivery` threads it to the composer as `requestUri`. `deliver`
 * is the connector's per-batch sink (`HubspotConnector.deliver`).
 */
export function hubspotWebhookBinding(
  deliver: (events: HubSpotWebhookEvent[]) => void | Promise<void>,
  opts: { publicUrl: string; secretRef?: string }
): HostedWebhookBinding<HubSpotWebhookEvent[]> {
  return {
    integration: 'hubspot',
    verifier: HUBSPOT_VERIFIER,
    parse: parseHubSpotBatch,
    deliver,
    secretRef: opts.secretRef ?? 'webhookClientSecret',
    publicUrl: opts.publicUrl,
    maxBodyBytes: HUBSPOT_MAX_BODY_BYTES
  }
}
