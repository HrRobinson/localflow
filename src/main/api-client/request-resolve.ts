import type { Collection, CollectionAuth, CollectionRequest } from '../../shared/api-client'
import type { HttpActionId, HttpMethod } from '../../shared/http'
import { normalizeOrigin, originAllowed } from './origins'

/**
 * PURE resolution (design §3): an agent's send input + its collection → the
 * `params` object the EXISTING `resolveRequest` validates. Holds NO secret — it
 * carries only the collection's non-secret `auth` (scheme + secretRef); the
 * value is revealed later, main-only, in `send.ts`.
 *
 * Validate-at-the-boundary, matching `http-node-config.ts`: an unknown variable,
 * an unknown saved request, an unknown varSet, or a URL outside the collection's
 * origins is a LOUD throw, never a silent default.
 */

/** An ad-hoc request the agent composed. */
export interface SendSpec {
  method: HttpMethod
  /** A path joined to the varSet's `base_url`, or a fully-qualified URL. */
  path: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/** The body of `POST /http/send`. Exactly one of `requestId` / `spec`. */
export interface SendInput {
  collectionId: string
  varSet?: string
  requestId?: string
  spec?: SendSpec
  vars?: Record<string, string>
}

const TEMPLATE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/** Replace every `{{name}}` from `vars`; an unknown name is a loud throw. When
 *  `used` is supplied, every referenced name is recorded into it — this is
 *  how the caller learns which vars actually reached the outgoing request
 *  (finding 3: `resolveVarsMap` resolves a `$ref` for every var whether or
 *  not anything ever references it, so a value can join the scrub set
 *  without ever being sent — this is the tracking that closes that gap). */
export function substitute(
  input: string,
  vars: Record<string, string>,
  used?: Set<string>
): string {
  return input.replace(TEMPLATE, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(
        `Unknown variable "{{${name}}}" — add it to the collection's varSet ` +
          `or pass it in \`vars\`.`
      )
    }
    used?.add(name)
    return value
  })
}

/**
 * Chaining (design §4.4): an agent may carry a value from a PAST response into
 * a NEW request without ever reading it — `{ "$ref": "<responseId>:<path>" }`
 * anywhere a string is expected in `spec` or `vars`. The resolver is supplied
 * by `send.ts`, scoped to the grant's environment, so a ref can never reach
 * another environment's response.
 *
 * `withheld` reports whether the field the ref pointed at was withheld from
 * `pull` — i.e. whether an agent could NOT have read this value directly.
 * That, not length, is the axis `chainScrubCandidates` (`redact.ts`) scrubs
 * on: a value that was already readable protects nothing by being scrubbed,
 * while a withheld one must be scrubbed at any length (finding 2).
 */
export type RefResolver = (
  responseId: string,
  path: string
) => { ok: true; value: string; withheld: boolean } | { ok: false; reason: string }

/** A single `$ref` resolution: the value itself, plus whether the field it
 *  came from was withheld (finding 2). Carried alongside every resolved ref
 *  so the caller's scrub-set decision never has to re-derive it. */
export interface RefValue {
  value: string
  withheld: boolean
}

/** An object with EXACTLY one key, `$ref`, holding a string. */
function isRef(v: unknown): v is { $ref: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return (
    keys.length === 1 && keys[0] === '$ref' && typeof (v as { $ref: unknown }).$ref === 'string'
  )
}

/** An object that carries a `$ref` key but fails `isRef`'s exact shape — an
 *  extra key alongside it, or a non-string `$ref` (finding 5). Without this
 *  check such an object silently fell through to the generic string/object
 *  branch below: templated verbatim into a body (sent to the upstream as-is)
 *  or handed to `String.prototype.replace` as a header/path value (an
 *  internal `TypeError`, not a legible refusal). Every position now throws
 *  the SAME malformed-ref error instead. */
function isMalformedRef(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.prototype.hasOwnProperty.call(v, '$ref') && !isRef(v)
}

function malformedRefError(v: object): Error {
  return new Error(
    `Malformed $ref ${JSON.stringify(v)} — expected exactly one key, "$ref", holding a string ` +
      `of the form "<responseId>:<path>".`
  )
}

/** Parse `"<responseId>:<path>"` — split on the FIRST `:` only, since a path
 *  may itself contain `:` — resolve it, and hand back the value AND its
 *  withheld-ness for the caller's scrub-set decision (finding 2). Every
 *  failure mode is a LOUD throw, never a silent empty substitution: a
 *  malformed ref, a resolver that was never supplied, or the resolver's own
 *  refusal (unknown/evicted/foreign-environment response, unresolvable path).
 */
function resolveRefValue(raw: { $ref: string }, resolveRef: RefResolver | undefined): RefValue {
  const sep = raw.$ref.indexOf(':')
  if (sep < 0) {
    throw new Error(`Malformed $ref "${raw.$ref}" — expected the form "<responseId>:<path>".`)
  }
  if (resolveRef === undefined) {
    throw new Error(`A $ref ("${raw.$ref}") was used but no ref resolver was supplied.`)
  }
  const responseId = raw.$ref.slice(0, sep)
  const path = raw.$ref.slice(sep + 1)
  const result = resolveRef(responseId, path)
  if (!result.ok) {
    throw new Error(`$ref "${raw.$ref}" could not be resolved — ${result.reason}.`)
  }
  return { value: result.value, withheld: result.withheld }
}

/** A string field's raw value: either a `$ref` object (resolved, no
 *  templating — a chained value is substituted verbatim) or a plain string
 *  (templated against `vars`). Every resolved ref value is pushed onto
 *  `refValues` for the caller's scrub set — unconditionally, because a ref
 *  used directly in a field like this one always reaches the outgoing
 *  request (contrast `resolveVarsMap`, whose refs may not). `used` records
 *  which `{{name}}` vars this field referenced. */
function resolveStringField(
  raw: unknown,
  vars: Record<string, string>,
  resolveRef: RefResolver | undefined,
  refValues: RefValue[],
  used: Set<string>
): string {
  if (isRef(raw)) {
    const resolved = resolveRefValue(raw, resolveRef)
    refValues.push(resolved)
    return resolved.value
  }
  if (isMalformedRef(raw)) throw malformedRefError(raw as object)
  return substitute(raw as string, vars, used)
}

/** Resolve `$ref`s inside a vars map BEFORE templating, so `{{name}}` sees the
 *  resolved value rather than the ref object. A var's resolved ref value is
 *  recorded into `varRefValues` by name, NOT pushed straight onto the scrub
 *  set — `resolveSendInput` folds in only the names `used` ends up
 *  containing once path/headers/body have all been templated, since this
 *  runs for EVERY var whether or not anything ever references it (finding 3:
 *  without that filter, an agent can confirm a withheld value by chaining it
 *  into an unreferenced var and watching whether it comes back redacted,
 *  with no upstream involvement at all). */
function resolveVarsMap(
  vars: Record<string, unknown>,
  resolveRef: RefResolver | undefined,
  varRefValues: Map<string, RefValue>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) {
    if (isRef(v)) {
      const resolved = resolveRefValue(v, resolveRef)
      varRefValues.set(k, resolved)
      out[k] = resolved.value
    } else if (isMalformedRef(v)) {
      throw malformedRefError(v as object)
    } else {
      out[k] = v as string
    }
  }
  return out
}

/** Deep-substitute a JSON body's string leaves (keys are left untouched). A
 *  `$ref` leaf is resolved (not templated); every other leaf is templated. */
function substituteBody(
  value: unknown,
  vars: Record<string, string>,
  resolveRef: RefResolver | undefined,
  refValues: RefValue[],
  used: Set<string>
): unknown {
  if (isRef(value)) {
    const resolved = resolveRefValue(value, resolveRef)
    refValues.push(resolved)
    return resolved.value
  }
  if (isMalformedRef(value)) throw malformedRefError(value as object)
  if (typeof value === 'string') return substitute(value, vars, used)
  if (Array.isArray(value))
    return value.map((v) => substituteBody(v, vars, resolveRef, refValues, used))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      out[k] = substituteBody(v, vars, resolveRef, refValues, used)
    return out
  }
  return value
}

/** The RAW header value with every `$ref`-derived span replaced by `''` — a
 *  bare `$ref` (the whole header came from chaining) becomes `''` outright; a
 *  plain string is re-templated against `elidedVars` (a copy of `vars` with
 *  every `$ref`-resolved var name zeroed), so a `{{name}}` bound to a chained
 *  var vanishes while ordinary template vars and literal text survive
 *  untouched. Only ever called on a raw value `resolveStringField` has
 *  ALREADY resolved successfully, so every `{{name}}` it references is known
 *  to exist in `elidedVars` too (same keys as `vars`) — this can never throw. */
function elideRefSpans(raw: unknown, elidedVars: Record<string, string>): string {
  if (isRef(raw)) return ''
  return substitute(raw as string, elidedVars)
}

function isAbsolute(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

/** Ceiling for an agent-supplied `timeoutMs` (design §3 stopgap — a full
 *  per-collection budget is out of scope for v1). Generous for a slow
 *  upstream call, but bounded so a spec can't hang a send indefinitely. */
const MAX_TIMEOUT_MS = 120_000

/** The header name (lowercased) this collection's auth writes onto the
 *  outgoing request, or undefined for `scheme: 'none'`. Used to refuse an
 *  agent-supplied header that would collide with it under a different casing
 *  — `fetch`'s `Headers` fill APPENDS same-name headers rather than replacing,
 *  so a differently-cased agent header survives alongside the injected
 *  credential header and is concatenated onto it on the wire. */
function reservedAuthHeaderName(auth: CollectionAuth): string | undefined {
  if (auth.scheme === 'none') return undefined
  if (auth.scheme === 'header') return (auth.header ?? 'authorization').toLowerCase()
  return 'authorization'
}

export function resolveSendInput(
  collection: Collection,
  input: SendInput,
  resolveRef?: RefResolver
): {
  actionId: HttpActionId
  params: Record<string, unknown>
  refValues: RefValue[]
  /** Every header name (exact key, as it appears in `params.headers`) → that
   *  header's RAW value with every `$ref`-derived span blanked: a bare
   *  `$ref` becomes `''`, and a templated `{{name}}` bound to a `$ref`-
   *  resolved var becomes `''` too. A header with no ref contribution at all
   *  simply maps to its own literal value — unchanged, nothing blanked —
   *  so the guard sees exactly what it always saw for an ordinary header.
   *  `resolveRequest` runs `looksLikeSecretLiteral` against THIS text for
   *  EVERY header, never the real value and never skipped (finding 1,
   *  wave 3 — see the note at the bottom of this file for why exempting a
   *  whole header was wrong). */
  elidedHeaderValues: Map<string, string>
} {
  const hasRequestId = input.requestId !== undefined
  const hasSpec = input.spec !== undefined
  if (hasRequestId === hasSpec) {
    throw new Error('Send exactly one of `requestId` (a saved request) or `spec` (an ad-hoc one).')
  }

  const refValues: RefValue[] = []
  // Populated by `resolveVarsMap` — a var NAME → its resolved ref (value +
  // withheld-ness), for every var whose raw entry was a `$ref` — regardless
  // of whether the var ends up referenced anywhere. Folded into `refValues`
  // at the very end, filtered down to the names `usedVarNames` actually
  // collected (finding 3).
  const varRefValues = new Map<string, RefValue>()
  // Every `{{name}}` actually referenced by `path`, a header value, or a body
  // leaf that reaches the wire — plus `base_url` when a relative path
  // consults it directly (that one lookup bypasses the `{{}}` template
  // mechanism `substitute` tracks).
  const usedVarNames = new Set<string>()

  let varSet: Record<string, string> = {}
  if (input.varSet !== undefined) {
    const found = collection.varSets[input.varSet]
    if (found === undefined) {
      const known = Object.keys(collection.varSets).join(', ') || '(none)'
      throw new Error(`Unknown varSet "${input.varSet}" — this collection has: ${known}.`)
    }
    varSet = found
  }
  // `$ref`s in `vars` are resolved BEFORE templating, so `{{name}}` below sees
  // the resolved value rather than the ref object.
  const vars = resolveVarsMap({ ...varSet, ...(input.vars ?? {}) }, resolveRef, varRefValues)
  // `vars` with every `$ref`-resolved name zeroed to `''` — the substitution
  // target for `elideRefSpans` below, computed once `varRefValues` is fully
  // populated (every var's ref, if any, is resolved by `resolveVarsMap` above
  // regardless of whether anything ends up referencing it).
  const elidedVars: Record<string, string> = { ...vars }
  for (const name of varRefValues.keys()) elidedVars[name] = ''

  let source: CollectionRequest | SendSpec
  if (hasRequestId) {
    const found = collection.requests.find((r) => r.id === input.requestId)
    if (found === undefined) {
      throw new Error(`Unknown requestId "${input.requestId}" in collection "${collection.id}".`)
    }
    source = found
  } else {
    source = input.spec as SendSpec
  }

  const path = resolveStringField(source.path, vars, resolveRef, refValues, usedVarNames)
  let url: string
  if (isAbsolute(path)) {
    url = path
  } else {
    const base = vars.base_url
    if (base === undefined) {
      // Never echo `source.path` (or the substituted `path`) here — a curator
      // template may position a var an agent chose specifically so it lands
      // in this message (the same class of channel closed below for the
      // origin refusal). The agent already knows what it sent: an ad-hoc
      // spec's path is its own input, and a saved request's path is already
      // visible via `GET /http/collections`.
      throw new Error(
        'This request has a relative path but no `base_url` variable is set — ' +
          'add one to the varSet or send a fully-qualified URL.'
      )
    }
    // Read directly off `vars`, not through `substitute`'s `{{}}` mechanism —
    // so it must be marked used here explicitly, or a `base_url` chained via
    // `$ref` would be wrongly treated as never having reached the request.
    usedVarNames.add('base_url')
    url = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  }

  if (!originAllowed(url, collection.origins)) {
    // Report only the refused ORIGIN, never the resolved url. `vars.base_url`
    // and `{{name}}` placement in `source.path` are both agent-controlled, so
    // echoing the full resolved url turns this refusal into a one-request
    // read primitive for any varSet value (design's `varSets` are exposed to
    // the agent only as key names via `GET /http/collections`, never values).
    const origin = normalizeOrigin(url)
    throw new Error(
      origin === null
        ? 'Refusing to send — the resolved URL is not a valid http(s) address.'
        : `Refusing to send to origin "${origin}" — outside collection "${collection.id}"'s ` +
            `declared origins (${collection.origins.join(', ')}).`
    )
  }

  const reserved = reservedAuthHeaderName(collection.auth)
  const sourceHeaders = source.headers ?? {}
  if (reserved !== undefined) {
    // Trimmed before the comparison: an exact `=== reserved` check let a
    // whitespace-padded name (`'AUTHORIZATION '`) evade this clash check,
    // then die inside `fetch` as an "invalid header name" `TypeError` —
    // which `sendRaw` maps to a 502, a misleading error class for what is
    // really the same reserved-header collision this check exists to catch
    // with a clear 400.
    const clash = Object.keys(sourceHeaders).find((k) => k.trim().toLowerCase() === reserved)
    if (clash !== undefined) {
      // `fetch`'s `Headers` fill APPENDS rather than replaces same-name
      // headers, so a differently-cased agent header (e.g. `Authorization`
      // beside the injected lowercase `authorization`) would survive as a
      // second value and be comma-concatenated onto the collection's
      // credential on the wire — collection auth must stay entirely outside
      // agent influence, benign-looking value or not.
      throw new Error(
        `Header "${clash}" is reserved for this collection's credential (auth writes the ` +
          `"${reserved}" header) — remove it; the agent may not set that header, any casing.`
      )
    }
  }

  // Finding 1, wave 3 (elide, don't exempt — see the note at the bottom of
  // this file): every header is checked by `looksLikeSecretLiteral`, always —
  // but against the value with every `$ref`-derived span blanked, so the
  // guard only ever sees the AGENT-AUTHORED portion of the header. A header
  // with no ref contribution elides to itself, so nothing changes for an
  // ordinary header.
  const headers: Record<string, string> = {}
  const elidedHeaderValues = new Map<string, string>()
  for (const [k, v] of Object.entries(sourceHeaders)) {
    const headerUsedVars = new Set<string>()
    const resolved = resolveStringField(v, vars, resolveRef, refValues, headerUsedVars)
    headers[k] = resolved
    // A header key that can't round-trip through a plain object (`__proto__`
    // is the practical case: `headers['__proto__'] = <string>` is a silent
    // no-op setter call, not a property write) must fail LOUD, not vanish —
    // otherwise the header is dropped, `resolveHeaders`/the guard never sees
    // it, and the send still reports `ok: true` as if it had gone out.
    if (!Object.prototype.hasOwnProperty.call(headers, k) || headers[k] !== resolved) {
      throw new Error(
        `Header key ${JSON.stringify(k)} can't be used — it would be silently dropped instead ` +
          `of sent. Choose a different header name.`
      )
    }
    elidedHeaderValues.set(k, elideRefSpans(v, elidedVars))
    for (const name of headerUsedVars) usedVarNames.add(name)
  }

  const params: Record<string, unknown> = {
    url,
    method: source.method,
    headers,
    // Copied, not a live reference — `params` is handed onward and must never
    // let a caller's mutation reach back into the collection's own auth config.
    auth: { ...collection.auth },
    // The COLLECTION's opt-in, never the agent's — the agent has no upsert
    // path (§ design), so this can only be true if a human set it at curation.
    allowLocal: collection.allowLocal === true
  }
  // Finding 3: `resolveRequest` (`http-node-config.ts`) drops the body
  // entirely for a GET — so a body `$ref` (direct, or via a var only
  // referenced inside the body) never reaches the wire on a GET and must not
  // join the scrub set, exactly like the var-fold filter below. Resolved
  // into LOCAL collections first, folded into the real ones only if the body
  // actually reaches the outgoing request.
  const bodyRefValues: RefValue[] = []
  const bodyUsedVars = new Set<string>()
  if (source.body !== undefined) {
    params.body = substituteBody(source.body, vars, resolveRef, bodyRefValues, bodyUsedVars)
  }
  if (source.method !== 'GET') {
    refValues.push(...bodyRefValues)
    for (const name of bodyUsedVars) usedVarNames.add(name)
  }
  if (source.timeoutMs !== undefined) {
    params.timeoutMs = Math.min(source.timeoutMs, MAX_TIMEOUT_MS)
  }

  // Fold in a var's ref value ONLY if `path`/headers/body actually referenced
  // it somewhere above — never unconditionally (finding 3). `resolveVarsMap`
  // resolves a `$ref` for every var whether or not anything uses it, so an
  // unfiltered fold would let an agent join the scrub set with a value that
  // was never sent upstream: chain it into an unused var, then read whether
  // the same string comes back `[redacted]` in the NEXT response — a
  // value-confirmation oracle with no gate, no upstream involvement, and no
  // audit signal.
  for (const [name, resolved] of varRefValues) {
    if (usedVarNames.has(name)) refValues.push(resolved)
  }

  return {
    actionId: source.method === 'GET' ? 'http.get' : 'http.send',
    params,
    refValues,
    elidedHeaderValues
  }
}

/**
 * Finding 1 — `http-node-config.ts`'s `resolveHeaders` throws when a header
 * value `looksLikeSecretLiteral`, a check that exists to catch an agent
 * hardcoding a real credential straight into `config.headers` instead of
 * using `auth.secretRef`. A `$ref`-chained value is the OPPOSITE of that: it
 * came out of a past response and the agent never saw it, yet it is exactly
 * the class of value (a vendor token, a `Bearer …` string) that check is
 * built to reject.
 *
 * WAVE 1 tried MASKING: replace every ref-resolved value with an opaque
 * sentinel before validation, splice the real values back in after. That
 * broke two ways at once — it is a SUBSTRING replace over every header,
 * agent-authored ones included, so an agent-hardcoded literal in one header
 * plus a one-character chained value in another shattered the literal's
 * shape before the guard ever saw it (the guard became opt-out by the
 * caller); and the fixed-length sentinels themselves could collide with real
 * header content, corrupting the round-trip silently.
 *
 * WAVE 2 tried PROVENANCE: track, per header, whether that header's value had
 * ANY `$ref` contribution, and skip `looksLikeSecretLiteral` ENTIRELY for a
 * header so marked. That closed the cross-header attack (a literal in one
 * header, a chained value in a different one) but not the INTRA-header one:
 * nothing stopped the agent from putting its own literal and a chained ref in
 * the SAME header —
 * `{ 'x-stolen': 'sk_live_STOLEN_HARDCODED{{t}}' }` with `t` a one-character
 * chained var — which still counted as "had a $ref contribution" and exempted
 * the WHOLE header, so the hardcoded literal rode along unchecked. Worse,
 * when the chained span resolved to `''` (any prior response field holding an
 * empty string), the literal reached the wire byte-exact.
 *
 * WAVE 3 (here) drops the exemption concept entirely: `resolveHeaders` runs
 * `looksLikeSecretLiteral` against EVERY header, always — no header is ever
 * skipped. What changes is WHAT TEXT it checks: `resolveSendInput` computes,
 * per header, `elidedHeaderValues` — that header's raw value with every
 * `$ref`-derived span blanked to `''` (a bare `$ref` → `''`; a `{{name}}`
 * bound to a chained var → `''`; everything else, including a header with no
 * ref contribution at all, passed through unchanged). The guard only ever
 * sees the AGENT-AUTHORED portion of a header's value — `sk_live_STOLEN_
 * HARDCODED{{t}}` elides to `sk_live_STOLEN_HARDCODED` (still refused,
 * `t` resolving to `''` or not makes no difference), while `Bearer {{t}}`
 * elides to `Bearer ` (passes — `looksLikeSecretLiteral`'s `/^Bearer\s+\S/`
 * needs a non-space character after the space, which the elided text lacks).
 * No bytes are ever rewritten on the value that actually reaches the wire —
 * elision only ever feeds the guard's OWN decision — so there is nothing to
 * collide and nothing to splice back.
 */
