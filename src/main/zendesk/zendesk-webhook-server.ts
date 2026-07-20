import {
  startWebhookReceiver,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'

/**
 * Zendesk webhook receiver (spec §4.5, §7). A THIN wrapper over the shared
 * `startWebhookReceiver`: it supplies the Zendesk verifier and the vendor `parse`
 * (a JSON guard → `ZendeskWebhookDelivery`). The HTTP + HMAC + size-cap + 200-fast
 * machinery lives in `webhook-receiver.ts`; this file only PINS the Zendesk scheme
 * (§7.1). Mirrors `stripe-webhook-server.ts`.
 *
 * Dedup on the delivery/event id is done CONNECTOR-side (`zendesk-connector.ts`):
 * the id is in the parsed BODY, not a header, so the connector keeps the seen-set.
 */

export const ZENDESK_MAX_BODY_BYTES = 1_048_576
export const ZENDESK_SIGNATURE_HEADER = 'x-zendesk-webhook-signature'
export const ZENDESK_TIMESTAMP_HEADER = 'x-zendesk-webhook-signature-timestamp'
const DEFAULT_PATH = '/zendesk/webhook'

/**
 * The Zendesk verification scheme (§7.1). Zendesk signs
 * `Base64(HMAC-SHA256(secret, timestamp + rawBody))` — timestamp in a SEPARATE
 * header, base string a BARE concatenation (no separator, unlike Stripe's
 * `${t}.${body}`).
 *
 * SHIPPED SIGNATURE-ONLY (`signsTimestamp: false`). Zendesk's timestamp is
 * ISO-8601 (`2026-07-20T14:31:08Z`); the shared receiver's replay-window math does
 * `Number(resolved)` and treats the value as epoch, which renders `NaN` → every
 * delivery would be rejected. So the replay WINDOW is deferred until the receiver
 * gains an ISO-8601 timestamp unit. The HMAC still binds the timestamp on the wire
 * (Zendesk signs it), and the `baseString` composer below is already written as
 * `${timestamp}${rawBody}` so that flipping `signsTimestamp: true` — once the
 * receiver populates `timestamp` from `timestampHeader` — enables the full
 * timestamp-bound + replay-windowed check with NO other change here.
 *
 * TODO iso8601 replay-window: receiver-track — support a `timestampUnit:'iso8601'`
 * (or a `parseTimestamp` hook) so `signsTimestamp: true` parses Zendesk's ISO
 * timestamp for the replay window; then flip `signsTimestamp` to true below.
 */
export const ZENDESK_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: ZENDESK_SIGNATURE_HEADER,
  encoding: 'base64',
  signsTimestamp: false, // TODO iso8601 replay-window: flip to true once the receiver parses ISO-8601
  timestampHeader: ZENDESK_TIMESTAMP_HEADER,
  toleranceSec: 300,
  // Base string = `${timestamp}${rawBody}` (bare concat). Until `signsTimestamp`
  // is true the receiver passes timestamp:'' (the interim signature-only path).
  baseString: ({ timestamp, rawBody }) => `${timestamp}${rawBody}`
}

/** A verified delivery handed to the connector. `data` is the parsed, still-
 *  untrusted body; the connector normalizes it (§7.2). */
export interface ZendeskWebhookDelivery {
  eventId: string
  type: string
  data: Record<string, unknown>
}

export interface ZendeskWebhookOptions {
  /** The webhook signing secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface ZendeskWebhookServer {
  port: number
  onEvent(handler: (delivery: ZendeskWebhookDelivery) => void): void
  close(): void
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Vendor parse: a well-formed Zendesk delivery (has a string `type`) →
 * `ZendeskWebhookDelivery`; anything else → null (→ 400, no run seeded, never
 * trust an unexpected shape). Runs AFTER the shared receiver has verified the
 * signature over the RAW body. The Admin-Center webhook is templated to POST
 * `{ type, id, ticket, comment? }`; the whole body flows through as `data` for
 * `eventToPayload` (§7.2).
 */
const parseZendeskDelivery: WebhookParser<ZendeskWebhookDelivery> = (rawBody) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  const type = parsed.type
  if (typeof type !== 'string' || type.length === 0) return null
  const eventId = typeof parsed.id === 'string' ? parsed.id : ''
  return { eventId, type, data: parsed }
}

export function startZendeskWebhookServer(
  opts: ZendeskWebhookOptions
): Promise<ZendeskWebhookServer> {
  return startWebhookReceiver<ZendeskWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: ZENDESK_VERIFIER,
    parse: parseZendeskDelivery,
    secret: opts.secret,
    maxBodyBytes: ZENDESK_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}
