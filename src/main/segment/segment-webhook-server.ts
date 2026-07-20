import {
  startWebhookReceiver,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'

/**
 * Segment webhook receiver (spec §4.2, §7). A THIN wrapper over the shared
 * `startWebhookReceiver`: it supplies the Segment verifier — the `X-Signature`
 * hex HMAC-**SHA1** over the RAW body (the SAME `algo:'sha1'` path Intercom uses,
 * no new crypto) — and the vendor `parse` (a JSON-object guard →
 * `SegmentWebhookDelivery`). The HTTP + HMAC + size-cap + 200-fast machinery
 * lives in `webhook-receiver.ts`; this file only PINS the Segment scheme. Mirrors
 * `stripe-webhook-server.ts`.
 *
 * Also exported: `SEGMENT_VERIFIER` (reused by the hosted binding, §4.4) so the
 * loopback server and the phase-5 relay verify identically.
 */

export const SEGMENT_MAX_BODY_BYTES = 1_048_576
export const SEGMENT_SIGNATURE_HEADER = 'x-signature'
const DEFAULT_PATH = '/segment/webhook'

/**
 * The Segment verification scheme (§4.2): hex-encoded HMAC-**SHA1** of the RAW
 * request body, keyed by the destination's shared secret, in the `X-Signature`
 * header. Verified BEFORE parse (a body-parser that consumes the stream first
 * breaks the HMAC — the receiver reads raw bytes).
 */
export const SEGMENT_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha1',
  header: SEGMENT_SIGNATURE_HEADER,
  encoding: 'hex'
}

/** A verified delivery handed to the connector. `body` is the parsed, still-
 *  untrusted Segment event envelope; the connector normalizes it (§6.5). */
export interface SegmentWebhookDelivery {
  body: Record<string, unknown>
}

export interface SegmentWebhookOptions {
  /** The webhook shared secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface SegmentWebhookServer {
  port: number
  onEvent(handler: (delivery: SegmentWebhookDelivery) => void): void
  close(): void
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Vendor parse: a JSON OBJECT (the Segment event envelope) → `SegmentWebhookDelivery`;
 * anything else (array, primitive, malformed JSON) → null (→ 400, no run seeded,
 * never trust an unexpected shape). Runs AFTER the shared receiver has verified the
 * SHA1 signature over the RAW body.
 */
const parseSegmentDelivery: WebhookParser<SegmentWebhookDelivery> = (rawBody) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  return { body: parsed }
}

export function startSegmentWebhookServer(
  opts: SegmentWebhookOptions
): Promise<SegmentWebhookServer> {
  return startWebhookReceiver<SegmentWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: SEGMENT_VERIFIER,
    parse: parseSegmentDelivery,
    secret: opts.secret,
    maxBodyBytes: SEGMENT_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}
