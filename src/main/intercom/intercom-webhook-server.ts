import {
  startWebhookReceiver,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'

/**
 * Intercom webhook receiver (spec §4.4, §7). A THIN wrapper over the shared
 * `startWebhookReceiver`: it supplies the Intercom verifier — the WEAKEST scheme of
 * the family (HMAC-SHA1, NO timestamp) — and the vendor `parse` (a JSON
 * `notification_event` guard → `IntercomWebhookDelivery`). The HTTP + HMAC +
 * size-cap + 200-fast machinery lives in `webhook-receiver.ts`; this file only PINS
 * the Intercom scheme. Mirrors `stripe-webhook-server.ts`.
 *
 * Because Intercom sends NO timestamp, there is NO replay window at the signature
 * layer (§2.3). Dedup on the notification id is done CONNECTOR-side
 * (`intercom-connector.ts`): the id is in the parsed BODY, not a header, and the
 * receiver's header-only `dedup` hook can't see it — so the connector keeps the
 * seen-set (exactly like Stripe's `evt_…` dedup).
 */

export const INTERCOM_MAX_BODY_BYTES = 1_048_576
export const INTERCOM_SIGNATURE_HEADER = 'x-hub-signature'
const DEFAULT_PATH = '/intercom/webhook'

/**
 * The Intercom verification scheme (§7): HMAC-SHA1 (hex) over the RAW body, with the
 * signature in `X-Hub-Signature: sha1=<hex>` (the `sha1=` prefix is stripped by
 * `parseHeader`). NO timestamp is signed → `signsTimestamp: false` (no replay
 * window at the signature layer; the connector-side id dedup is the mitigation).
 */
export const INTERCOM_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha1',
  header: INTERCOM_SIGNATURE_HEADER,
  encoding: 'hex',
  signsTimestamp: false,
  parseHeader: (raw) => {
    // "sha1=abc123" → { signature: "abc123" }. A missing prefix / empty value is
    // unparseable → the receiver rejects (401), never "verifies" a garbage header.
    const trimmed = raw.trim()
    const sig = trimmed.startsWith('sha1=') ? trimmed.slice('sha1='.length) : ''
    if (sig.length === 0) return null
    return { signature: sig }
  }
}

/** A verified delivery handed to the connector. `item` is the parsed, still-
 *  untrusted conversation (`data.item`); the connector normalizes it (§6.1). */
export interface IntercomWebhookDelivery {
  notificationId: string
  topic: string
  item: Record<string, unknown>
}

export interface IntercomWebhookOptions {
  /** The app client secret (keychain-sourced HMAC key). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface IntercomWebhookServer {
  port: number
  onEvent(handler: (delivery: IntercomWebhookDelivery) => void): void
  close(): void
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Vendor parse: a well-formed Intercom notification (a `topic` + a `data.item`
 * object) → `IntercomWebhookDelivery`; anything else → null (→ 400, no run seeded,
 * never trust an unexpected shape). Runs AFTER the shared receiver has verified the
 * HMAC-SHA1 signature over the RAW body.
 */
const parseIntercomDelivery: WebhookParser<IntercomWebhookDelivery> = (rawBody) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  const topic = parsed.topic
  if (typeof topic !== 'string' || topic.length === 0) return null
  const item = isObj(parsed.data) ? parsed.data.item : undefined
  if (!isObj(item)) return null
  const notificationId = typeof parsed.id === 'string' ? parsed.id : ''
  return { notificationId, topic, item }
}

export function startIntercomWebhookServer(
  opts: IntercomWebhookOptions
): Promise<IntercomWebhookServer> {
  return startWebhookReceiver<IntercomWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: INTERCOM_VERIFIER,
    parse: parseIntercomDelivery,
    secret: opts.secret,
    maxBodyBytes: INTERCOM_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}
