import type {
  Collection,
  CollectionAuth,
  CollectionRequest,
  CollectionView
} from '../../shared/api-client'
import { HTTP_METHODS } from '../../shared/api-client'
import { looksLikeSecretLiteral } from '../http/http-node-config'
import { normalizeOrigin } from './origins'

/**
 * PURE validation for `apiClient:upsertCollection`, extracted so it is testable
 * without an Electron IPC harness — the same reason `control-api.ts` is pure
 * over its inputs. The handler is a thin wrapper.
 *
 * The load-bearing rule is the varSet check. varSet values are persisted to
 * `api-collections.json` in PLAINTEXT, while credentials belong in the keychain
 * under `auth.secretRef`. Typing an API key into a varSet is an easy mistake —
 * both are "things you type into a collection" — so a secret-shaped value is
 * REFUSED here, before anything reaches disk. This reuses the same shared
 * prefix table `looksLikeSecretLiteral` applies on the request side.
 */

const AUTH_SCHEMES = ['bearer', 'basic', 'header', 'none'] as const

export type ValidateResult = { ok: true; collection: Collection } | { ok: false; reason: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const fail = (reason: string): ValidateResult => ({ ok: false, reason })

function validateAuth(
  raw: unknown
): { ok: true; auth: CollectionAuth } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: 'auth must be an object' }
  const scheme = raw.scheme
  if (typeof scheme !== 'string' || !(AUTH_SCHEMES as readonly string[]).includes(scheme)) {
    return { ok: false, reason: `auth.scheme must be one of ${AUTH_SCHEMES.join('/')}` }
  }
  if (scheme === 'none') return { ok: true, auth: { scheme: 'none' } }

  const secretRef = raw.secretRef
  if (typeof secretRef !== 'string' || secretRef.trim().length === 0) {
    return { ok: false, reason: `auth.secretRef is required for the "${scheme}" scheme` }
  }
  if (scheme === 'header') {
    const header = raw.header
    if (typeof header !== 'string' || header.trim().length === 0) {
      return {
        ok: false,
        reason: 'auth.header is required for the "header" scheme, e.g. X-API-Key'
      }
    }
    return {
      ok: true,
      auth: { scheme: 'header', header: header.trim(), secretRef: secretRef.trim() }
    }
  }
  return { ok: true, auth: { scheme: scheme as 'bearer' | 'basic', secretRef: secretRef.trim() } }
}

function validateVarSets(
  raw: unknown
): { ok: true; varSets: Record<string, Record<string, string>> } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, varSets: {} }
  if (!isObject(raw))
    return { ok: false, reason: 'varSets must be an object of named variable sets' }

  const out: Record<string, Record<string, string>> = {}
  for (const [setName, set] of Object.entries(raw)) {
    if (!isObject(set)) return { ok: false, reason: `varSet "${setName}" must be an object` }
    const vars: Record<string, string> = {}
    for (const [key, value] of Object.entries(set)) {
      if (typeof value !== 'string') {
        return { ok: false, reason: `varSet "${setName}" variable "${key}" must be a string` }
      }
      if (looksLikeSecretLiteral(value)) {
        return {
          ok: false,
          reason:
            `varSet "${setName}" variable "${key}" looks like a credential. varSets are ` +
            'stored in plain text — put the secret in the keychain via auth.secretRef instead.'
        }
      }
      vars[key] = value
    }
    out[setName] = vars
  }
  return { ok: true, varSets: out }
}

function validateRequests(
  raw: unknown
): { ok: true; requests: CollectionRequest[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, requests: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'requests must be an array' }

  const out: CollectionRequest[] = []
  for (const entry of raw) {
    if (!isObject(entry)) return { ok: false, reason: 'each request must be an object' }
    const { id, name, method, path } = entry
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { ok: false, reason: 'each request needs a non-empty id' }
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, reason: `request "${id}" needs a non-empty name` }
    }
    if (typeof method !== 'string' || !(HTTP_METHODS as readonly string[]).includes(method)) {
      return {
        ok: false,
        reason: `request "${id}" method must be one of ${HTTP_METHODS.join('/')}`
      }
    }
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { ok: false, reason: `request "${id}" needs a non-empty path` }
    }
    out.push({
      id: id.trim(),
      name: name.trim(),
      method: method as CollectionRequest['method'],
      path: path.trim()
    })
  }
  return { ok: true, requests: out }
}

/**
 * Validate a renderer-supplied collection payload. `id` and `environment` are
 * supplied by the CALLER, never trusted from the payload: the id is minted
 * main-side on create and carried through on update, and the environment comes
 * from the clamped IPC argument.
 */
export function validateCollection(raw: unknown, environment: number, id: string): ValidateResult {
  if (!isObject(raw)) return fail('collection must be an object')

  const name = raw.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    return fail('collection needs a non-empty name')
  }

  if (!Array.isArray(raw.origins) || raw.origins.length === 0) {
    return fail('collection needs at least one origin (scheme://host[:port])')
  }
  const origins: string[] = []
  for (const entry of raw.origins) {
    if (typeof entry !== 'string') return fail('each origin must be a string')
    const normalized = normalizeOrigin(entry)
    if (normalized === null) {
      const msg = `"${entry}" is not a usable origin — expected scheme://host[:port] over http(s)`
      return fail(msg)
    }
    origins.push(normalized)
  }

  const auth = validateAuth(raw.auth)
  if (!auth.ok) return fail(auth.reason)

  const varSets = validateVarSets(raw.varSets)
  if (!varSets.ok) return fail(varSets.reason)

  const requests = validateRequests(raw.requests)
  if (!requests.ok) return fail(requests.reason)

  return {
    ok: true,
    collection: {
      id,
      name: name.trim(),
      environment,
      origins,
      // Human-set at curation only — the agent has no upsert path (see
      // `request-resolve.ts`'s docs). Coerced to a strict boolean so any
      // truthy-but-not-`true` payload value (a stray string, say) can't opt in.
      allowLocal: raw.allowLocal === true,
      auth: auth.auth,
      varSets: varSets.varSets,
      requests: requests.requests
    }
  }
}

/** Project a stored collection into its renderer view — presence, never value. */
export function toCollectionView(collection: Collection, hasSecret: boolean): CollectionView {
  return {
    id: collection.id,
    name: collection.name,
    environment: collection.environment,
    origins: collection.origins,
    allowLocal: collection.allowLocal,
    auth: collection.auth,
    hasSecret,
    varSets: collection.varSets,
    requests: collection.requests
  }
}
