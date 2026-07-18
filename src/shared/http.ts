/**
 * Shared generic-HTTP connector vocabulary (spec §6) — the PINNED ids, the
 * per-node `config` shapes, the resolved-request/webhook shapes, and the
 * context-field shapes an `http` node writes. Imported by main (the connector,
 * the resolver, the normalizer) and any renderer palette surface. Contains NO
 * I/O and NO secret — a secret is NEVER a literal here; `config` carries only a
 * non-secret `secretRef` (a keychain field name), the ciphertext lives in the
 * keychain under the composite key `http:<nodeId>:<secretRef>` (§7).
 */

// ── Pinned ids (§6.1, §6.2) — the palette + templates track consume these ────

/** The two generic actions. `http.get` is a pure read; `http.send` is a gated
 *  write (the author places a `gate` before it). */
export const HTTP_ACTION_IDS = ['http.get', 'http.send'] as const
export type HttpActionId = (typeof HTTP_ACTION_IDS)[number]

/** The one generic trigger (Half 2 — the incoming webhook). */
export const HTTP_TRIGGER_IDS = ['webhook.received'] as const
export type HttpTriggerId = (typeof HTTP_TRIGGER_IDS)[number]

/**
 * The reserved params key the action-runner injects so the per-node connector
 * can build its composite keychain key `http:<nodeId>:<secretRef>` (§7.3). The
 * pinned `invokeAction(id, actionId, params)` carries only `params`, so the node
 * id rides inside `params` under this key. Underscore-prefixed to never collide
 * with a user-authored config field.
 */
export const NODE_ID_PARAM = '__nodeId'

/** HTTP verbs. `http.get` fixes `GET`; `http.send` picks a mutating verb. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** How the per-node secret is applied to the outbound request. `none` needs no
 *  secret; `header` names the header the secret is placed in (e.g. `X-API-Key`). */
export type HttpAuthScheme = 'bearer' | 'basic' | 'header' | 'none'

// ── Per-node config (§6.3 — the heart of the design; safe in config.json) ────

/** An `http.get` / `http.send` action node's config. Non-secret by construction
 *  — `auth.secretRef` is a keychain FIELD NAME, never the secret itself. */
export interface HttpActionNodeConfig {
  /** May contain `{{context}}` templates; re-guarded AFTER templating (§4.5). */
  url: string
  /** `http.send` only; `GET` is fixed for `http.get`. */
  method?: HttpMethod
  /** Header values may be templated; NEVER a raw secret literal (§6.3). */
  headers?: Record<string, string>
  /** `http.send` only; JSON object or string; serialized by the resolver. */
  body?: unknown
  auth?: {
    scheme: HttpAuthScheme
    /** For the `header` scheme, e.g. "X-API-Key". */
    header?: string
    /** The per-node keychain FIELD name (§7); NOT the secret. */
    secretRef?: string
  }
  /** Opt into loopback/LAN targets past the SSRF guard, per node only (§4.5). */
  allowLocal?: boolean
  timeoutMs?: number
}

/**
 * The user-facing subset of the shared receiver's `WebhookVerifier` (§6.4). Kept
 * structurally identical so the connector passes an instance straight through to
 * `webhook-receiver`, but declared here (not imported from main) so the renderer
 * palette can read it without pulling a main-process module into the web bundle.
 */
export type WebhookVerifierConfig =
  | {
      scheme: 'hmac'
      header: string
      algo?: 'sha256' | 'sha1'
      encoding?: 'hex' | 'base64'
      signsTimestamp?: boolean
      timestampHeader?: string
      timestampUnit?: 'seconds' | 'milliseconds'
      toleranceSec?: number
    }
  | { scheme: 'token'; header: string }

/** A `webhook.received` trigger node's config (Half 2). */
export interface HttpTriggerNodeConfig {
  /** Unguessable per-flow path segment (non-secret ref). */
  inboundPath: string
  /** User-supplied verification scheme (§6.4). */
  verifier: WebhookVerifierConfig
  /** The per-node keychain FIELD name holding the verifier secret. */
  secretRef: string
}

// ── Resolved shapes (§4.2) — what the pure resolver hands the transport ──────

/** The auth intent carried past the resolver; the secret VALUE is revealed only
 *  in the connector (main-only), never in this pure shape. */
export interface ResolvedAuth {
  scheme: HttpAuthScheme
  header?: string
  secretRef?: string
}

/** A fully-resolved outbound request — method, final (templated) URL, headers,
 *  serialized body — ready for the SSRF guard + transport. Holds NO secret. */
export interface ResolvedRequest {
  method: HttpMethod
  url: string
  headers: Record<string, string>
  body?: string
  auth: ResolvedAuth
  allowLocal: boolean
  timeoutMs?: number
}

/** A fully-resolved inbound webhook registration (Half 2). */
export interface ResolvedWebhook {
  path: string
  verifier: WebhookVerifierConfig
  secretRef: string
}

// ── Context-field shapes (§6.5 — PINNED; guarded by the normalize tests) ─────

/** Written by `http.get` / `http.send` under the node id, e.g. context['fetch']. */
export interface HttpResponseContext {
  http: {
    /** e.g. 200. */
    status: number
    /** status in 200-299. */
    ok: boolean
    /** response headers (lowercased keys). */
    headers: Record<string, string>
    /** parsed JSON when the content-type is JSON, else the string body. */
    body: unknown
  }
}

/** The `webhook.received` payload (via `coerceEvent`) → the trigger node's slot. */
export interface WebhookContext {
  webhook: {
    /** request headers (lowercased keys). */
    headers: Record<string, string>
    /** parsed JSON when JSON, else the raw string. */
    body: unknown
    /** parsed query string. */
    query: Record<string, string>
  }
}
