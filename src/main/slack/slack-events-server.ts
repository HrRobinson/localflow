import type {
  WebhookVerifier,
  WebhookReceiverConfig,
  WebhookReceiver
} from '../webhooks/webhook-receiver'
import { startWebhookReceiver } from '../webhooks/webhook-receiver'
import type { SlackInbound } from './slack-socket'

/**
 * The **Events API** path (spec §4.4, §13.1) — the ingress-based ALTERNATIVE to
 * Socket Mode, for users who already run HTTPS ingress. It CONSUMES the shared
 * `webhook-receiver.ts` (it does NOT reimplement the security-critical HTTP +
 * HMAC code) configured with Slack's verifier, and normalizes a verified event
 * to the SAME `SlackInbound` the socket emits — so the connector, approval port,
 * and control bridge are transport-agnostic.
 *
 * The one Slack-shaped requirement the shared receiver must carry (§2.3, §4.4):
 * the signed base string is `v0:{timestamp}:{rawBody}` and the signature header
 * is `v0=` + hex(HMAC-SHA256). Both are expressed below via `baseString` /
 * `parseHeader` — no change to the shared receiver's core.
 *
 * NOTE (foundation slice): `slackVerifier` + the parsers + the receiver-config
 * builder are complete and exercised against the real shared infra. The live
 * server MOUNT (a second interactivity URL, §13.2) and the `url_verification`
 * response-body echo (the shared receiver answers 200-fast with no body) land
 * with the HTTPS-ingress tier in Phase 3.
 */

/**
 * Slack signing-secret verifier for the shared `webhook-receiver`.
 * Base string = `v0:{timestamp}:{rawBody}`; header = `v0=` + hex(HMAC-SHA256);
 * 5-minute replay tolerance over `X-Slack-Request-Timestamp`.
 */
export const slackVerifier: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: 'x-slack-signature',
  encoding: 'hex',
  signsTimestamp: true,
  timestampHeader: 'x-slack-request-timestamp',
  toleranceSec: 300,
  // Strip the Slack `v0=` signature prefix; the timestamp comes from the header.
  parseHeader: (raw) => (raw.startsWith('v0=') ? { signature: raw.slice(3) } : null),
  // Compose Slack's `v0:{ts}:{body}` base string.
  baseString: ({ timestamp, rawBody }) => `v0:${timestamp}:${rawBody}`
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The result of parsing a verified Events-API body: an inbound, the one-time
 *  challenge to echo, or null (unsupported/malformed). */
export type SlackEventParse =
  | { kind: 'inbound'; inbound: SlackInbound }
  | { kind: 'challenge'; challenge: string }
  | null

/**
 * Parse a verified Events-API JSON body. Answers the one-time `url_verification`
 * handshake (echo `challenge`), and normalizes an `event_callback` to the same
 * `SlackInbound` the socket emits. Pure — null on anything unsupported.
 */
export function parseSlackEventBody(rawBody: Buffer): SlackEventParse {
  let json: unknown
  try {
    json = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(json)) return null
  if (json.type === 'url_verification' && typeof json.challenge === 'string') {
    return { kind: 'challenge', challenge: json.challenge }
  }
  if (json.type === 'event_callback' && isObject(json.event)) {
    return { kind: 'inbound', inbound: { type: 'events_api', payload: json } }
  }
  return null
}

/**
 * Parse a verified interactivity-URL body. Slack posts interactions as a
 * form-encoded `payload=<json>`; normalize to the `interactive` inbound. Pure.
 */
export function parseSlackInteractionBody(rawBody: Buffer): SlackInbound | null {
  const raw = rawBody.toString('utf8')
  const params = new URLSearchParams(raw)
  const payloadStr = params.get('payload') ?? raw
  let json: unknown
  try {
    json = JSON.parse(payloadStr)
  } catch {
    return null
  }
  if (!isObject(json)) return null
  return { type: 'interactive', payload: json }
}

/**
 * Build the `WebhookReceiverConfig` for the Slack events URL, ready to hand to
 * the shared `startWebhookReceiver`. The signing secret is keychain-sourced and
 * NEVER logged; the receiver verifies over the RAW body before any parse.
 */
export function buildSlackEventsReceiverConfig(deps: {
  signingSecret: string
  path?: string
  onInbound: (inbound: SlackInbound) => void
  log?: (message: string) => void
}): WebhookReceiverConfig<SlackInbound> {
  return {
    path: deps.path ?? '/slack/events',
    verifier: slackVerifier,
    secret: deps.signingSecret,
    log: deps.log,
    parse: (rawBody) => {
      const parsed = parseSlackEventBody(rawBody)
      // The challenge is answered out-of-band (Phase 3 mount); a verified
      // event_callback becomes an inbound. Anything else drops (→ 400, no run).
      if (parsed && parsed.kind === 'inbound') return parsed.inbound
      return null
    }
  }
}

/** Start the Events-API receiver on the shared infra (Phase 3 ingress tier). */
export function startSlackEventsServer(deps: {
  signingSecret: string
  path?: string
  port?: number
  onInbound: (inbound: SlackInbound) => void
  log?: (message: string) => void
}): Promise<WebhookReceiver<SlackInbound>> {
  const config = buildSlackEventsReceiverConfig(deps)
  if (deps.port !== undefined) config.port = deps.port
  return startWebhookReceiver(config).then((receiver) => {
    receiver.onEvent((inbound) => deps.onInbound(inbound))
    return receiver
  })
}
