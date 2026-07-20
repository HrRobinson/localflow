import type { IncomingHttpHeaders } from 'node:http'
import {
  startWebhookReceiver,
  verifyWebhookSignature,
  type ShortCircuit,
  type WebhookParser,
  type WebhookVerifier
} from '../webhooks/webhook-receiver'
import type { HostedWebhookBinding } from '../hosted/webhook-bindings'

/**
 * GitHub webhook receiver (§4.4). GitHub does NOT get a bespoke webhook server —
 * this is a THIN wrapper over the SHARED `startWebhookReceiver`: it supplies the
 * GitHub verifier (`X-Hub-Signature-256`, hex HMAC-SHA256 over the raw body, with
 * the `sha256=` prefix stripped via `parseHeader`), a `dedup` short-circuit
 * closing over a seen-set of `X-GitHub-Delivery` ids (200 + drop a redelivery,
 * AFTER verify / BEFORE parse), and the vendor `parse` (JSON-object guard +
 * `X-GitHub-Event` type → `GitHubWebhookDelivery`). The HTTP + HMAC + size-cap +
 * 200-fast machinery lives in `webhook-receiver.ts`. Mirrors
 * `shopify-webhook-server.ts`.
 */

export const GITHUB_MAX_BODY_BYTES = 1_048_576

export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256'
export const GITHUB_EVENT_HEADER = 'x-github-event'
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery'

const DEFAULT_PATH = '/github/webhook'

/**
 * The pinned GitHub verifier (§4.4): hex-encoded HMAC-SHA256 over the raw body,
 * with GitHub's `sha256=` prefix stripped before the timing-safe compare.
 */
export const GITHUB_VERIFIER: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: GITHUB_SIGNATURE_HEADER,
  encoding: 'hex',
  parseHeader: (raw) => {
    const value = raw.startsWith('sha256=') ? raw.slice('sha256='.length) : raw
    return value.length > 0 ? { signature: value } : null
  }
}

/** A verified, novel delivery handed to the connector. `payload` is the parsed,
 *  still-untrusted JSON body — the connector normalizes it (§4.2). */
export interface GitHubWebhookDelivery {
  deliveryId: string
  /** The `X-GitHub-Event` type, e.g. 'issues', 'pull_request', 'check_run'. */
  event: string
  payload: Record<string, unknown>
}

export interface GitHubWebhookServer {
  port: number
  onEvent(handler: (delivery: GitHubWebhookDelivery) => void): void
  close(): void
}

export interface GitHubWebhookOptions {
  /** The webhook signing secret (keychain-sourced). NEVER logged or rendered. */
  secret: string
  path?: string
  host?: string
  port?: number
  /** Route+reason logger — NEVER receives the secret or the body. */
  log?: (message: string) => void
}

/**
 * Timing-safe HMAC-SHA256 check over the raw body (delegates to the shared
 * verifier). Exported for direct unit testing of the pinned GitHub scheme.
 */
export function verifyGitHubSignature(rawBody: Buffer, provided: unknown, secret: string): boolean {
  const headers: IncomingHttpHeaders = {
    [GITHUB_SIGNATURE_HEADER]: typeof provided === 'string' ? provided : undefined
  }
  return verifyWebhookSignature(rawBody, headers, GITHUB_VERIFIER, secret)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/** 200 + drop a repeated `X-GitHub-Delivery` (GitHub redelivery is expected). */
function makeGitHubDedup(): ShortCircuit {
  const seen = new Set<string>()
  return (headers) => {
    const id = header(headers[GITHUB_DELIVERY_HEADER])
    if (id.length > 0 && seen.has(id)) return 200
    if (id.length > 0) seen.add(id)
    return null
  }
}

/** Vendor parse: JSON-object guard → `GitHubWebhookDelivery` (delivery id + event
 *  type from headers, still-untrusted JSON payload). */
const parseGitHubDelivery: WebhookParser<GitHubWebhookDelivery> = (rawBody, headers) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return null
  }
  if (!isObj(parsed)) return null
  const event = header(headers[GITHUB_EVENT_HEADER])
  if (event.length === 0) return null
  return {
    deliveryId: header(headers[GITHUB_DELIVERY_HEADER]),
    event,
    payload: parsed
  }
}

export function startGitHubWebhookServer(opts: GitHubWebhookOptions): Promise<GitHubWebhookServer> {
  return startWebhookReceiver<GitHubWebhookDelivery>({
    path: opts.path ?? DEFAULT_PATH,
    verifier: GITHUB_VERIFIER,
    parse: parseGitHubDelivery,
    dedup: makeGitHubDedup(),
    secret: opts.secret,
    maxBodyBytes: GITHUB_MAX_BODY_BYTES,
    host: opts.host,
    port: opts.port,
    log: opts.log
  })
}

/**
 * The hosted-ingress binding for GitHub (design §4.3) — the SAME verifier, parse,
 * and dedup the loopback server uses, plus the keychain ref for the signing
 * secret. `deliver` is the connector's per-delivery sink (the callback it passes
 * to `webhook.onEvent` today). A fresh dedup seen-set is created per binding,
 * exactly like `startGitHubWebhookServer`. Mirrors `shopifyWebhookBinding`.
 */
export function githubWebhookBinding(
  deliver: (delivery: GitHubWebhookDelivery) => void | Promise<void>,
  opts: { secretRef?: string; publicUrl?: string } = {}
): HostedWebhookBinding<GitHubWebhookDelivery> {
  const binding: HostedWebhookBinding<GitHubWebhookDelivery> = {
    integration: 'github',
    verifier: GITHUB_VERIFIER,
    parse: parseGitHubDelivery,
    dedup: makeGitHubDedup(),
    deliver,
    secretRef: opts.secretRef ?? 'webhookSecret',
    maxBodyBytes: GITHUB_MAX_BODY_BYTES
  }
  if (opts.publicUrl) binding.publicUrl = opts.publicUrl
  return binding
}
