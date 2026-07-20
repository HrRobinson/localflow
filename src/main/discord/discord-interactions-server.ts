import type { DiscordInbound } from './discord-gateway'

/**
 * The **HTTP Interactions** path (spec §4.4, §13.1, §13.7) — the ingress-based
 * ALTERNATIVE to the Gateway, for users who already run HTTPS ingress. DEFERRED
 * for the Gateway-only MVP (§1, §14 Phase 3): this module ships the PURE parse
 * (PING→PONG + interaction normalization to the same `DiscordInbound` the
 * Gateway emits) so the connector, approval port, and control bridge stay
 * transport-agnostic — but the live MOUNT is NOT wired.
 *
 * THE ONE REAL DIVERGENCE FROM SLACK (§2.3, §4.4, §13.7): Discord's Interactions
 * Endpoint is verified with the application's **Ed25519 PUBLIC key** over
 * `timestamp + rawBody` — an ASYMMETRIC scheme. The shared `WebhookVerifier`
 * (`webhook-receiver.ts`) is a union of `scheme: 'hmac' | 'token'` — BOTH
 * symmetric-secret schemes. So this path requires a NEW `scheme: 'ed25519'`
 * variant carrying a PUBLIC key (not a `secret`), an Ed25519 verify over
 * `timestamp+body`, AND a PING/PONG handshake that answers 200 WITH a body
 * (`{ type: 1 }`) — which the current "200-fast, no body" receiver does not do.
 * This is a shared-receiver extension a shared-infra owner must land; it is NOT
 * needed for the Gateway-only MVP. `DEFERRED_ED25519_VERIFIER` documents the
 * intended shape without adding the (unbuilt) union member.
 */

/** The intended `ed25519` verifier shape for the shared receiver — DEFERRED
 *  (§13.7). Documented here so the shared-infra owner can size the extension; it
 *  is NOT wired (the shared union has no `ed25519` member yet). The publicKey is
 *  a PUBLIC, non-secret value that may live in config.json (§5, §8). */
export const DEFERRED_ED25519_VERIFIER = {
  scheme: 'ed25519' as const,
  signatureHeader: 'X-Signature-Ed25519',
  timestampHeader: 'X-Signature-Timestamp',
  // signed message = timestamp + rawBody ; verify against the application PUBLIC key.
  note: 'shared-receiver extension — not built for the Gateway-only MVP (§13.7)'
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const INTERACTION_PING = 1
export const CALLBACK_PONG = 1

/** The result of parsing a (verified) Interactions body: an inbound to route, a
 *  PING to answer with a PONG, or null (unsupported/malformed). */
export type DiscordInteractionParse =
  { kind: 'inbound'; inbound: DiscordInbound } | { kind: 'pong' } | null

/**
 * Parse a verified Interactions-endpoint JSON body. Answers the one-time (and
 * per-delivery) `PING` (type 1) with a `pong` marker — the `url_verification`
 * analog — and normalizes any other interaction to the SAME
 * `{ type: 'interaction' }` inbound the Gateway emits. Pure — null on malformed.
 * (Message events do NOT arrive here — they still require the Gateway, §13.1.)
 */
export function parseInteractionRequest(rawBody: Buffer): DiscordInteractionParse {
  let json: unknown
  try {
    json = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(json)) return null
  if (json.type === INTERACTION_PING) return { kind: 'pong' }
  if (typeof json.type === 'number') {
    return { kind: 'inbound', inbound: { type: 'interaction', payload: json } }
  }
  return null
}
