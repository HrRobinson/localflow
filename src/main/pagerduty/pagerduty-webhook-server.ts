import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'

/**
 * PagerDuty webhook receiver (spec §4.4). A THIN wrapper over the shared
 * `startWebhookReceiver`: it supplies the pinned v3 `WebhookVerifier` — HMAC-
 * SHA256 **hex** over the raw body, header `X-PagerDuty-Signature`, with a
 * `parseHeader` that selects the `v1=` signature from the (possibly comma-
 * separated) header value — and the vendor `parse` (JSON-object guard → the
 * unwrapped `event` envelope). The HTTP + HMAC + size-cap + 200-fast machinery
 * lives in `webhook-receiver.ts`; this file owns NONE of it.
 *
 * **First consumer of the shared receiver's `parseHeader` hook.** PagerDuty v3
 * signs the RAW BODY ALONE — no timestamp — so `signsTimestamp` stays at its
 * default (false); we deliberately do NOT use the Stripe/Slack timestamp path.
 *
 * **Dedup lives in the connector, not here.** PagerDuty's redelivery-safe
 * idempotency id is `event.id`, which rides in the BODY (unlike Sentry's
 * `Request-ID` header). The shared receiver's `dedup` short-circuit only sees
 * headers and would have to answer 4xx (→ a redelivery storm) if it dropped from
 * `parse`. So the receiver always 200-fasts a verified, parseable delivery and
 * the connector's `onDelivery` de-dupes over a seen-set of `event.id` before
 * seeding a run (§4.4). The 200-on-duplicate + zero-second-run guarantee is
 * preserved either way.
 */

/** Generous cap on the raw body — a v3 incident envelope is large. */
export const PAGERDUTY_MAX_BODY_BYTES = 1_048_576

export const PAGERDUTY_SIGNATURE_HEADER = 'x-pagerduty-signature'

const DEFAULT_PATH = '/pagerduty/webhook'

/**
 * Select the `v1=` signature from the (possibly comma-separated) header value.
 *
 * **Rotation caveat (the YELLOW edge — §2.3.2, §13.2).** During a subscription's
 * secret rotation PagerDuty may send TWO comma-separated `v1=` signatures (old +
 * new secret). This picks the FIRST `v1=`; if that was signed with the OTHER
 * active secret, verification fails until rotation settles. The steady state (one
 * active secret, one signature) is clean.
 *
 * TODO(§13.2 — any-of-N rotation): teach the shared receiver an "any-of-N
 * candidate signatures/secrets" mode so a rotation window that presents multiple
 * `v1=` signatures verifies against either the old or new stored secret. MVP
 * accepts the brief manual-rotation gap; single-secret is the only shape today.
 */
export function selectV1Signature(raw: string): { signature: string } | null {
  const v1 = raw
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.startsWith('v1='))
  return v1 ? { signature: v1.slice('v1='.length) } : null
}

/** The pinned PagerDuty v3 verification scheme (spec §4.4). */
export const PAGERDUTY_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: PAGERDUTY_SIGNATURE_HEADER,
  encoding: 'hex',
  // v3 signs the raw body alone — no timestamp. parseHeader picks `v1=`.
  parseHeader: selectV1Signature
}

/** A verified, parseable delivery handed to the connector. `data` is the parsed,
 *  still-untrusted incident node from `event.data` — the connector normalizes it. */
export interface PagerDutyWebhookDelivery {
  /** `event.id` — the redelivery-safe idempotency id (connector dedups on it). */
  id: string
  /** `event.event_type`, e.g. `incident.triggered`. */
  eventType: string
  /** `event.resource_type`, e.g. `incident`. */
  resourceType: string
  /** `event.data` — the still-untrusted incident node. */
  data: Record<string, unknown>
}

export interface PagerDutyWebhookOptions {
  /** The webhook v3 signing secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

export interface PagerDutyWebhookServer {
  port: number
  onEvent(handler: (delivery: PagerDutyWebhookDelivery) => void): void
  close(): void
}

/**
 * Timing-safe HMAC-SHA256 (hex) check over the raw body against the `v1=`
 * signature (delegates to the shared verifier + the pinned verifier's
 * `parseHeader`). An empty secret is refused outright.
 */
export function verifyPagerDutySignature(
  rawBody: Buffer,
  provided: unknown,
  secret: string
): boolean {
  const headers: IncomingHttpHeaders = {
    [PAGERDUTY_SIGNATURE_HEADER]: typeof provided === 'string' ? provided : undefined
  }
  return verifyWebhookSignature(rawBody, headers, PAGERDUTY_VERIFIER, secret)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Vendor parse: JSON-object guard → the unwrapped v3 `event` envelope. Returns
 *  null (→ 400, no run) when the body isn't a JSON object carrying an `event`. */
const parsePagerDutyDelivery: WebhookParser<PagerDutyWebhookDelivery> = (rawBody) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed) || !isObj(parsed.event)) return null
  const event = parsed.event
  const eventType = typeof event.event_type === 'string' ? event.event_type : ''
  if (eventType.length === 0) return null
  return {
    id: typeof event.id === 'string' ? event.id : '',
    eventType,
    resourceType: typeof event.resource_type === 'string' ? event.resource_type : '',
    data: isObj(event.data) ? event.data : {}
  }
}

export function startPagerDutyWebhookServer(
  opts: PagerDutyWebhookOptions
): Promise<PagerDutyWebhookServer> {
  return startWebhookReceiver<PagerDutyWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: PAGERDUTY_VERIFIER,
    parse: parsePagerDutyDelivery,
    secret: opts.secret,
    maxBodyBytes: PAGERDUTY_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}
