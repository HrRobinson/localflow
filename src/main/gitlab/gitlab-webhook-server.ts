import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type ShortCircuit,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'
import { webhookToSeed } from './gitlab-normalize'
import type { GitLabTriggerId, GitLabTriggerPayload } from '../../shared/gitlab'

/**
 * GitLab webhook receiver (spec §4.4, §5.2) — a THIN wrapper over the SHARED
 * `startWebhookReceiver`. GitLab's ONLY webhook authenticity control is the weak
 * `X-Gitlab-Token` shared secret (a plaintext bearer, NOT an HMAC over the body),
 * modeled by the receiver's `token` scheme. The connector compensates with
 * posture (§5.2): an UNGUESSABLE receiver path, HTTPS-only ingress, and — on the
 * LAN bind — an IP allowlist. This module supplies the token verifier, a `dedup`
 * short-circuit over `X-Gitlab-Event-UUID`, and the vendor `parse` that maps the
 * `X-Gitlab-Event` header + body to a trigger via `webhookToSeed`. The HTTP +
 * size-cap + timing-safe compare + 200-fast machinery lives in the shared receiver.
 */

/** Cap on the raw webhook body (matches every current connector). */
export const GITLAB_MAX_BODY_BYTES = 1_048_576

/** GitLab's shared-secret header (compared timing-safely to the stored secret). */
export const GITLAB_TOKEN_HEADER = 'x-gitlab-token'
/** Names the event kind: `Issue Hook`, `Merge Request Hook`, `Pipeline Hook`. */
export const GITLAB_EVENT_HEADER = 'x-gitlab-event'
/** Per-delivery id — the idempotency key seeded as `eventId` (§4.4 dedup). */
export const GITLAB_EVENT_UUID_HEADER = 'x-gitlab-event-uuid'

/** A high-entropy default; the connector should override with its own generated
 *  unguessable segment (§5.2). Placeholder-shaped so a missing config is obvious. */
const DEFAULT_PATH = '/gitlab/webhook'

/** The GitLab verification scheme: a plain shared secret in `X-Gitlab-Token`. */
const GITLAB_VERIFIER: WebhookVerifier = {
  scheme: 'token',
  header: GITLAB_TOKEN_HEADER
}

/** The verified, filtered event handed to the connector. */
export interface GitLabWebhookEvent {
  triggerId: GitLabTriggerId
  deliveryId?: string
  payload: GitLabTriggerPayload
}

export interface GitLabWebhookOptions {
  /** The webhook secret token. NEVER logged, echoed, or rendered (spec §5). */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger. NEVER receives the secret or the body (spec §11). */
  log?: (message: string) => void
}

export interface GitLabWebhookServer {
  port: number
  onEvent(handler: (event: GitLabWebhookEvent) => void): void
  close(): void
}

/**
 * Timing-safe `X-Gitlab-Token` check (delegates to the shared verifier). An empty
 * secret is refused outright rather than "verified" against nothing.
 */
export function verifyGitLabToken(provided: unknown, secret: string): boolean {
  const headers: IncomingHttpHeaders = {
    [GITLAB_TOKEN_HEADER]: typeof provided === 'string' ? provided : undefined
  }
  // The token scheme ignores the body; pass an empty buffer.
  return verifyWebhookSignature(Buffer.alloc(0), headers, GITLAB_VERIFIER, secret)
}

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/** GitLab dedup: 200 + drop a repeated `X-Gitlab-Event-UUID` (redelivery is
 *  expected). Owns its own seen-set and records the id when it continues. */
function makeGitLabDedup(): ShortCircuit {
  const seen = new Set<string>()
  return (headers) => {
    const uuid = header(headers[GITLAB_EVENT_UUID_HEADER])
    if (uuid.length > 0 && seen.has(uuid)) return 200
    if (uuid.length > 0) seen.add(uuid)
    return null
  }
}

/**
 * Vendor parse: `X-Gitlab-Event` header + raw body → a filtered
 * `GitLabWebhookEvent`, or `null` when the event is unsupported or fails the
 * trigger filter (a non-`open` issue/MR or a non-`failed` pipeline — so no run is
 * ever seeded on an irrelevant delivery, §4.4).
 */
export const parseGitLabEvent: WebhookParser<GitLabWebhookEvent> = (rawBody, headers) => {
  const event = header(headers[GITLAB_EVENT_HEADER])
  let data: unknown
  try {
    data = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  const seed = webhookToSeed(event, data)
  if (!seed) return null
  const out: GitLabWebhookEvent = { triggerId: seed.triggerId, payload: seed.payload }
  const uuid = header(headers[GITLAB_EVENT_UUID_HEADER])
  if (uuid.length > 0) out.deliveryId = uuid
  return out
}

export function startGitLabWebhookServer(opts: GitLabWebhookOptions): Promise<GitLabWebhookServer> {
  return startWebhookReceiver<GitLabWebhookEvent>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: GITLAB_VERIFIER,
    parse: parseGitLabEvent,
    dedup: makeGitLabDedup(),
    secret: opts.secret,
    maxBodyBytes: GITLAB_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}
