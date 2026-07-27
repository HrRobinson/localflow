import type {
  HttpActionId,
  HttpAuthScheme,
  HttpMethod,
  ResolvedRequest,
  ResolvedWebhook,
  WebhookVerifierConfig
} from '../../shared/http'

/**
 * PURE resolution (spec §4.2, §10) — a flow node's `config` (already
 * shallow-templated by the action-runner) → a `ResolvedRequest` for an action,
 * or a `ResolvedWebhook` for the trigger. Validate-at-the-boundary
 * (`integration-config.ts` posture): a malformed method, a missing URL, a secret
 * literal smuggled into `config.headers`, or a bad verifier is a LOUD throw,
 * never a silent default. Holds NO secret — it carries only the non-secret
 * `secretRef`; the value is revealed later, main-only, in the connector (§7).
 */

const SEND_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE']
const AUTH_SCHEMES = ['bearer', 'basic', 'header', 'none'] as const

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A value that looks like a secret literal (a token/key), for the §10 guard
 *  that a secret is NEVER placed directly in a header value — only a ref. */
export function looksLikeSecretLiteral(value: string): boolean {
  const v = value.trim()
  if (/^Bearer\s+\S/i.test(v)) return true
  if (/^Basic\s+\S/i.test(v)) return true
  // Common vendor token prefixes (Shopify, Stripe, GitHub, Slack, OpenAI, …).
  if (/^(shpat_|sk_live_|sk_test_|rk_live_|ghp_|xox[baprs]-|glpat-)/.test(v)) return true
  return false
}

/**
 * `elidedHeaderValues`, when supplied, maps a header key → that header's raw
 * value with every `$ref`-derived span blanked to `''` (api-client finding 1,
 * wave 3 — see the note at the bottom of `request-resolve.ts`) — passed as an
 * EXPLICIT parameter, never smuggled through `params`, since `params` is
 * otherwise entirely agent-controlled and this map must not be.
 *
 * WAVE 4 (here): waves 1-3 all ran `looksLikeSecretLiteral` against some
 * transform of the header text and asked "does the AGENT-AUTHORED portion
 * look like a secret". That question lets the agent choose which bytes the
 * predicate sees — `looksLikeSecretLiteral` is anchored at `^`, and elision
 * DELETES bytes, so a chained span sitting at position 0 (or wherever the
 * vendor prefix/scheme keyword lives) donates its leading character(s) to the
 * agent-authored remainder, sliding the prefix out of the anchor's reach:
 * `'{{t}}k_live_STOLEN'` with a one-character chained `t` elides to
 * `'k_live_STOLEN'`, which `looksLikeSecretLiteral` does NOT match, even
 * though the wire value `'sk_live_STOLEN'` plainly does.
 *
 * The fix asks the opposite question: does the FINAL value — real,
 * unmodified, exactly what reaches the wire — look like a credential? If so,
 * is the agent's contribution confined to nothing at all, or to a bare
 * auth-scheme keyword (`Bearer`/`Basic`, matching the two scheme branches
 * `looksLikeSecretLiteral` itself special-cases)? `looksLikeSecretLiteral`
 * runs against `value` — never a transformed/elided copy — so the agent can
 * no longer choose what text the predicate sees; only whether the ALLOWANCE
 * on top of a match applies. Placement of the chained span within the header
 * no longer matters: prefix, suffix, or middle, the guard sees the same real
 * bytes every time.
 *
 * `elidedHeaderValues` (the authored remainder) now feeds only that
 * allowance, never the predicate call. No entry for a key, or no map at all
 * (the flow-node path below, and `http-connector.ts`'s direct call) means
 * `authored` is `undefined`, which is never benign — the real value is
 * guarded unconditionally, exactly as before chaining existed.
 *
 * Known accepted trade: `'sk_live_{{t}}'` legitimately building a key from a
 * chained suffix is now refused, because the agent authored the
 * credential-identifying prefix (`'sk_live_'` is not `''` and is not
 * `Bearer`/`Basic`). Fail-closed is intended — use `auth.secretRef`.
 */
function resolveHeaders(
  raw: unknown,
  elidedHeaderValues?: ReadonlyMap<string, string>
): Record<string, string> {
  if (raw === undefined) return {}
  if (!isObject(raw)) {
    throw new Error('http node has an invalid `headers` — expected an object of string values.')
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new Error(`http node header "${key}" must be a string value.`)
    }
    // The agent-authored remainder (every `$ref`-derived span blanked). Only
    // an EMPTY remainder (the whole value was chained) or a bare scheme
    // keyword (`Bearer {{t}}`) is benign — anything else means the agent
    // authored text that shares the header with a credential-shaped value.
    const authored = elidedHeaderValues?.get(key)
    const benignAuthored =
      authored !== undefined &&
      (authored.trim() === '' || /^(Bearer|Basic)$/i.test(authored.trim()))
    if (looksLikeSecretLiteral(value) && !benignAuthored) {
      throw new Error(
        `http node header "${key}" looks like a secret literal — put the secret in the ` +
          `keychain via \`auth.secretRef\`, never in \`config.headers\`.`
      )
    }
    out[key] = value
  }
  return out
}

function resolveAuth(raw: unknown): ResolvedRequest['auth'] {
  if (raw === undefined) return { scheme: 'none' }
  if (!isObject(raw)) throw new Error('http node has an invalid `auth` — expected an object.')
  const rawScheme = raw.scheme
  if (typeof rawScheme !== 'string' || !(AUTH_SCHEMES as readonly string[]).includes(rawScheme)) {
    throw new Error(
      `http node has an invalid auth scheme ${JSON.stringify(rawScheme)} (expected ${AUTH_SCHEMES.join('/')}).`
    )
  }
  const scheme = rawScheme as HttpAuthScheme
  if (scheme === 'none') return { scheme: 'none' }
  const secretRef = raw.secretRef
  if (typeof secretRef !== 'string' || secretRef.length === 0) {
    throw new Error(
      `http node auth scheme "${scheme}" needs a \`secretRef\` (the keychain field name — NOT the secret).`
    )
  }
  if (scheme === 'header') {
    if (typeof raw.header !== 'string' || raw.header.length === 0) {
      throw new Error('http node auth scheme \'header\' needs a `header` name, e.g. "X-API-Key".')
    }
    return { scheme, header: raw.header, secretRef }
  }
  return { scheme, secretRef }
}

/** Serialize a body to a request-string, reporting the content-type it implies.
 *  A string body passes through untouched; an object/array is JSON-stringified. */
function resolveBody(raw: unknown): { body?: string; contentType?: string } {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'string') return { body: raw }
  if (typeof raw === 'number' || typeof raw === 'boolean') return { body: String(raw) }
  return { body: JSON.stringify(raw), contentType: 'application/json' }
}

/**
 * Resolve an `http.get` / `http.send` node's params → a `ResolvedRequest`. The
 * URL is required and non-empty; `http.get` forces `GET`; `http.send` accepts
 * only a mutating verb (default `POST`). Throws legibly at the boundary.
 */
export function resolveRequest(
  actionId: HttpActionId,
  params: Record<string, unknown>,
  elidedHeaderValues?: ReadonlyMap<string, string>
): ResolvedRequest {
  const url = params.url
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error(`http node is missing a URL — set \`url\` on the '${actionId}' node.`)
  }

  let method: HttpMethod
  if (actionId === 'http.get') {
    method = 'GET'
  } else {
    const raw = params.method ?? 'POST'
    if (typeof raw !== 'string' || !(SEND_METHODS as readonly string[]).includes(raw)) {
      throw new Error(
        `http node has an invalid method ${JSON.stringify(raw)} (expected ${SEND_METHODS.join('/')}).`
      )
    }
    method = raw as HttpMethod
  }

  const headers = resolveHeaders(params.headers, elidedHeaderValues)
  const auth = resolveAuth(params.auth)

  const resolved: ResolvedRequest = {
    method,
    url: url.trim(),
    headers,
    auth,
    allowLocal: params.allowLocal === true
  }

  if (method !== 'GET') {
    const { body, contentType } = resolveBody(params.body)
    if (body !== undefined) resolved.body = body
    if (
      contentType &&
      headers['content-type'] === undefined &&
      headers['Content-Type'] === undefined
    ) {
      headers['content-type'] = contentType
    }
  }

  if (
    typeof params.timeoutMs === 'number' &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
  ) {
    resolved.timeoutMs = params.timeoutMs
  }

  return resolved
}

const VERIFIER_SCHEMES = ['hmac', 'token'] as const

/** Resolve a `webhook.received` node's config → a `ResolvedWebhook` (Half 2).
 *  Validates the inbound path, the verifier scheme/header, and the secretRef. */
export function resolveWebhook(config: Record<string, unknown>): ResolvedWebhook {
  const inboundPath = config.inboundPath
  if (typeof inboundPath !== 'string' || !inboundPath.startsWith('/')) {
    throw new Error(
      'http webhook node needs an `inboundPath` starting with "/" (an unguessable per-flow path).'
    )
  }
  const secretRef = config.secretRef
  if (typeof secretRef !== 'string' || secretRef.length === 0) {
    throw new Error(
      'http webhook node needs a `secretRef` (the keychain field name — NOT the secret).'
    )
  }
  const rawVerifier = config.verifier
  if (!isObject(rawVerifier)) {
    throw new Error('http webhook node needs a `verifier` object (scheme + header).')
  }
  const scheme = rawVerifier.scheme
  if (typeof scheme !== 'string' || !(VERIFIER_SCHEMES as readonly string[]).includes(scheme)) {
    throw new Error(
      `http webhook verifier has an invalid scheme ${JSON.stringify(scheme)} (expected hmac/token).`
    )
  }
  if (typeof rawVerifier.header !== 'string' || rawVerifier.header.length === 0) {
    throw new Error('http webhook verifier needs a `header` name carrying the signature/token.')
  }
  return {
    path: inboundPath,
    secretRef,
    verifier: rawVerifier as unknown as WebhookVerifierConfig
  }
}
