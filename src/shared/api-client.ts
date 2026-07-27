import type { HttpAuthScheme, HttpMethod } from './http'

/**
 * Shared agent-API-client vocabulary (design §1, §2). No I/O and NO secret — a
 * collection carries only a non-secret `secretRef` (a keychain field name); the
 * ciphertext lives in `CollectionSecretStore`'s own sidecar.
 */

/** A request saved in a collection by the human curator. */
export interface CollectionRequest {
  id: string
  name: string
  method: HttpMethod
  /** A path joined to the varSet's `base_url`, or a fully-qualified URL. */
  path: string
  headers?: Record<string, string>
  body?: unknown
  /** Present so a `CollectionRequest` and a `SendSpec` are structurally
   *  interchangeable in `resolveSendInput` — without it, reading
   *  `source.timeoutMs` off the union fails to typecheck. */
  timeoutMs?: number
}

/** How the collection's credential is applied. `secretRef` is a NAME, not a secret. */
export interface CollectionAuth {
  scheme: HttpAuthScheme
  /** For the `header` scheme, e.g. "X-API-Key". */
  header?: string
  secretRef?: string
}

/**
 * One API. Owns its origins, auth config, saved requests, and credentials.
 * `environment` is the owning saiife environment (design §1) — a collection is
 * reachable ONLY from its own environment, which is what extends the M3.5
 * isolation guarantee to credentials.
 */
export interface Collection {
  id: string
  name: string
  environment: number
  /** `scheme://host[:port]` only — no paths, no wildcards (design §2). */
  origins: string[]
  /** Opt in to loopback/LAN targets past the SSRF guard, per collection —
   *  human-set at curation, never by the agent. Mirrors the http node's
   *  per-node `allowLocal` (§4.5). Default false. */
  allowLocal?: boolean
  auth: CollectionAuth
  /** Named substitution variable sets, e.g. `test` / `live`. NOT an environment. */
  varSets: Record<string, Record<string, string>>
  requests: CollectionRequest[]
}

/** One field of a response shape — path, type, size. NEVER a value (design §4.3). */
export interface ShapeField {
  path: string
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  /** String length, array length, or object key count. */
  size?: number
  /** Present iff the field is classified sensitive (design §4.2). */
  withheld?: true
  /** Present iff this subtree hit the recursion depth cap and was not descended into. */
  truncated?: true
}

/** What the agent receives for a send or a response read. Carries no values. */
export interface ResponseView {
  responseId: string
  status: number
  durationMs: number
  contentType: string
  truncated: boolean
  shape: ShapeField[]
}

/** The pinned methods a collection request may use — mirrors `HttpMethod`. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

// Renderer views and IPC results - never carry secret material or tokens
// like `IntegrationFieldView`, credential is presence-only

/** A collection as the renderer sees it. `hasSecret` replaces the value. */
export interface CollectionView {
  id: string
  name: string
  environment: number
  origins: string[]
  /** Mirrors `Collection.allowLocal` — not secret, shown/edited in the renderer. */
  allowLocal?: boolean
  auth: CollectionAuth
  /** Presence of the credential named by `auth.secretRef`. Never the value. */
  hasSecret: boolean
  varSets: Record<string, Record<string, string>>
  requests: CollectionRequest[]
}

export type UpsertCollectionResult =
  { ok: true; view: CollectionView } | { ok: false; reason: string }

export type RemoveCollectionResult = { ok: true } | { ok: false; reason: string }

/** Presence only — the value is inbound-only, exactly like `SetSecretResult`. */
export type SetCollectionSecretResult =
  { ok: true; hasSecret: true } | { ok: false; reason: string }

export type ClearCollectionSecretResult = { ok: true } | { ok: false; reason: string }

/** Grant result. Carries the endpoint and holding pane — NEVER the token. */
export type ApiGrantResult =
  { ok: true; endpoint: string; paneId: string } | { ok: false; reason: string }

/** Grant state for one environment. Presence, holder and scope; no material. */
export interface ApiGrantStatus {
  environment: number
  granted: boolean
  paneId?: string
  collectionIds?: string[]
}
