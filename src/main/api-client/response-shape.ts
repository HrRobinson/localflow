import type { ShapeField } from '../../shared/api-client'
import { looksLikeSecretLiteral } from '../http/http-node-config'
import { appendIndex, appendKey, HEADERS_ROOT } from './response-path'

/**
 * PURE: a raw response → its SHAPE (design §4.3). Paths, types and sizes only —
 * a value NEVER appears in the output, which is what lets the shape be handed
 * to an agent verbatim.
 *
 * Classification (design §4.2) has three rules, and rule 3 deliberately reuses
 * the SAME prefix table `looksLikeSecretLiteral` uses on the request side: one
 * table, one place to add a vendor prefix, both directions covered.
 *
 * The KEY predicate is deliberately NOT shared, though (design §4.3): a false
 * negative here writes remote-controlled text verbatim into an untrusted
 * agent's context, while a false positive costs one `<redacted:N>` label — so
 * `looksLikeOpaqueKey` below is response-only and strictly broader than
 * `looksLikeSecretLiteral`, and must never migrate into `http-node-config.ts`.
 */

const SENSITIVE_HEADERS = new Set(['set-cookie', 'authorization', 'proxy-authorization'])

const SENSITIVE_KEY_WORDS = [
  'token',
  'secret',
  'password',
  'credential',
  'api[_-]?key',
  'private[_-]?key',
  'client[_-]?secret',
  'refresh',
  'session',
  'signature'
]
const SENSITIVE_KEY = new RegExp(`(${SENSITIVE_KEY_WORDS.join('|')})`, 'i')

// A literal key that already LOOKS like our own `<redacted:N>` placeholder is
// itself redacted first, so a remote-planted decoy key can never collide with
// a genuinely withheld entry at the same shape path (see `findField`'s
// tie-break in `response-store.ts` for the defence-in-depth half of this).
const PLACEHOLDER_KEY = /^<redacted:\d+>$/
const JWT_KEY = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const AWS_ACCESS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{16}$/
const LONG_HEX_KEY = /^[0-9a-f]{32,}$/i
// Entropy evidence, not just length: a bare 32+ char snake_case/kebab-case
// field name (`payment_method_configuration_details`,
// `content-security-policy-report-only`) also matches `[A-Za-z0-9+/_=-]{32,}`
// on length alone, so length-only swallowed real API field names wholesale.
// Requiring lower+upper+digit keeps the blob/token cases (base64, a mixed-case
// vendor token) while a plain-word identifier — lowercase (or camelCase) with
// underscores/dashes and no digits, or all one case — no longer matches. A
// 32-char lowercase hex string or a bare UUID also stop matching here, but
// both are already covered by `LONG_HEX_KEY` / `BARE_UUID_KEY` above.
//
// A single required digit is not enough on its own, though: camelCase is the
// default serialization for Java/Kotlin/C#/JS backends, and protocol/algorithm
// vocabulary carries exactly one digit routinely (`sha256`, `base64`, `x509`,
// `oauth2`, `http2`, `utf8`, `ipv6`), so `(?=.*\d)` alone still swallowed
// ordinary field names like `sha256FingerprintOfLeafCertificate`. The digit
// LOOKAHEAD above is therefore paired with a digit-DENSITY check in
// `looksLikeOpaqueKey` (4+ digit characters total, not just "at least one") —
// that combination is what actually distinguishes a token/blob from an
// algorithm-flavoured identifier. It is not perfect: an identifier that
// happens to embed a long numeric literal or a versioned algorithm constant
// (`strictTransportSecurityMaxAge31536000`,
// `AWS4_HMAC_SHA256_Credential_Scope`) still clears the 4-digit bar and is
// accepted as an over-redaction, same cost tradeoff as the rest of this
// predicate.
const LONG_BASE64ISH_KEY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9+/_=-]{32,}$/
const MIN_OPAQUE_DIGIT_COUNT = 4
const BARE_UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Response-only (see file header): a key that IS an opaque credential-shaped
 * identifier — a JWT, an AWS access key id, a long hex/base64 blob, a bare
 * UUID — even though it carries none of `looksLikeSecretLiteral`'s vendor
 * prefixes. Deliberately broad: this only ever fires on a key used as an
 * object property name, and the cost of a false positive there is one
 * `<redacted:N>` label, versus a verbatim credential leaked into agent
 * context on a false negative. Ordinary identifiers (`id`, `amount`,
 * `customer_name`, short slugs) are far below the length thresholds here and
 * are unaffected.
 */
function looksLikeOpaqueKey(key: string): boolean {
  const k = key.trim()
  const digitCount = (k.match(/\d/g) ?? []).length
  return (
    PLACEHOLDER_KEY.test(k) ||
    JWT_KEY.test(k) ||
    AWS_ACCESS_KEY_ID.test(k) ||
    LONG_HEX_KEY.test(k) ||
    (LONG_BASE64ISH_KEY.test(k) && digitCount >= MIN_OPAQUE_DIGIT_COUNT) ||
    BARE_UUID_KEY.test(k)
  )
}

/**
 * How deep an object/array chain is walked before the subtree is truncated
 * instead of recursed into. Chosen well below the empirically-observed
 * recursion depth (~3,211 levels) at which this walker overflows the stack
 * on adversarial input, while remaining far above any depth a real API
 * response is ever nested to (a few dozen levels at most).
 */
const MAX_DEPTH = 500

/** Rule 2 + rule 3: a sensitive key name, or a value that looks like a credential. */
function sensitive(key: string | undefined, value: unknown): boolean {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return true
  if (typeof value === 'string' && looksLikeSecretLiteral(value)) return true
  return false
}

/** Whether every element shares a structural kind, so the array can collapse to `[*]`. */
function homogeneous(values: unknown[]): boolean {
  const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  const first = kind(values[0])
  return values.every((v) => kind(v) === first)
}

/**
 * Whether ANY value inside `value` — itself, or nested arbitrarily deep —
 * would classify as sensitive by the same rules `walk` applies. Used once per
 * element of a homogeneous array so a collapse to `[*]` is classified from
 * every element, not only the representative one it keeps for shape output.
 *
 * This is a boolean-only pass: no `ShapeField`s are built and `.some` short
 * circuits on the first hit, so scanning every element costs the same order
 * as walking one — it is NOT a second full shape build per element.
 */
function anySensitive(value: unknown, key: string | undefined, depth: number): boolean {
  if (sensitive(key, value)) return true
  if (depth >= MAX_DEPTH) return false
  if (Array.isArray(value)) return value.some((v) => anySensitive(v, key, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) =>
        looksLikeSecretLiteral(k) || looksLikeOpaqueKey(k) || anySensitive(v, k, depth + 1)
    )
  }
  return false
}

/** Type + size of a value, without descending — used for the redacted-key placeholder. */
function shallowShape(value: unknown): { type: ShapeField['type']; size?: number } {
  if (value === null) return { type: 'null' }
  if (Array.isArray(value)) return { type: 'array', size: value.length }
  if (typeof value === 'object') {
    return { type: 'object', size: Object.keys(value as Record<string, unknown>).length }
  }
  if (typeof value === 'string') return { type: 'string', size: value.length }
  if (typeof value === 'number') return { type: 'number' }
  return { type: 'boolean' }
}

function walk(
  value: unknown,
  path: string,
  key: string | undefined,
  out: ShapeField[],
  depth: number,
  // Set only when a collapsed `[*]` array had a sensitive value in SOME
  // element other than the representative being walked here (see the
  // homogeneous-array branch below). Containers keep their own classification
  // regardless — forcing it there would hide the very leaf this exists to
  // reveal — but every leaf beneath them inherits it, since a leaf reached
  // through the collapsed path could concretely resolve to any element's.
  forceWithheld = false
): void {
  const isContainer = value !== null && typeof value === 'object'
  const withheld = isContainer ? sensitive(key, value) : sensitive(key, value) || forceWithheld
  const mark = withheld ? { withheld: true as const } : {}
  const truncated = depth >= MAX_DEPTH
  const truncMark = truncated ? { truncated: true as const } : {}

  if (value === null) {
    out.push({ path, type: 'null', ...mark })
    return
  }
  if (Array.isArray(value)) {
    out.push({ path, type: 'array', size: value.length, ...mark, ...truncMark })
    // A withheld container is not descended into — its children are sensitive
    // too, and their shape would itself be a hint. A truncated container is
    // not descended into either — the depth cap has been reached.
    if (withheld || truncated || value.length === 0) return
    if (homogeneous(value)) {
      const collapsedForce = forceWithheld || value.some((v) => anySensitive(v, key, depth + 1))
      walk(value[0], appendIndex(path, '*'), key, out, depth + 1, collapsedForce)
    } else {
      value.forEach((v, i) => walk(v, appendIndex(path, i), key, out, depth + 1, forceWithheld))
    }
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    out.push({ path, type: 'object', size: entries.length, ...mark, ...truncMark })
    if (withheld || truncated) return
    entries.forEach(([k, v], i) => {
      // The KEY itself, not just the value, can be the secret (a map keyed by
      // an opaque token/session id) — or the key NAME can carry a sensitive
      // word PLUS opaque material appended (`session_<uuid>`, `api_key_prod`)
      // without ever being caught by the value-side rules. Either way, redact
      // the segment and stop there — do NOT withhold the whole parent, that
      // would erase every sibling's shape. `looksLikeOpaqueKey` is checked
      // here in ADDITION to `looksLikeSecretLiteral`, never in place of it
      // (see file header).
      //
      // A bare `SENSITIVE_KEY` match is deliberately NOT sufficient on its
      // own: a sensitive *word* (`session_count`, `token_type`,
      // `refresh_interval_seconds`) is author-chosen vocabulary describing an
      // ordinary field, not remote-controlled opaque material — the
      // risk-asymmetry argument that justifies `looksLikeOpaqueKey` being
      // broad does not extend to it. Redacting the key segment on the word
      // alone erased ordinary metadata names wholesale (`$.access_token`
      // could no longer appear per design §4.3's own example). The value is
      // still withheld via `sensitive()` below regardless — only the KEY
      // TEXT requires the extra 20+ char opaque residue after the sensitive
      // word is stripped out.
      const sensitiveWordKey = SENSITIVE_KEY.test(k)
      const keyIsOpaque =
        looksLikeSecretLiteral(k) ||
        looksLikeOpaqueKey(k) ||
        (sensitiveWordKey && /[A-Za-z0-9_-]{20,}/.test(k.replace(SENSITIVE_KEY, '')))
      if (keyIsOpaque) {
        const shallow = shallowShape(v)
        out.push({ path: appendKey(path, `<redacted:${i}>`), ...shallow, withheld: true })
        return
      }
      walk(v, appendKey(path, k), k, out, depth + 1, forceWithheld)
    })
    return
  }
  if (typeof value === 'string') {
    out.push({ path, type: 'string', size: value.length, ...mark })
    return
  }
  if (typeof value === 'number') {
    out.push({ path, type: 'number', ...mark })
    return
  }
  out.push({ path, type: 'boolean', ...mark })
}

/**
 * The full shape: header fields under `$headers.<name>`, then body fields under
 * `$`. One uniform path space, so a pull uses the same syntax for either.
 *
 * `headers` keys are expected in their ORIGINAL case, not pre-lowercased —
 * the opaque-key classification below needs it (see the loop comment). The
 * emitted path is lowercased internally regardless of what case this
 * receives.
 */
export function shapeOf(
  body: string,
  contentType: string,
  headers: Record<string, string>,
  truncated = false
): ShapeField[] {
  const out: ShapeField[] = []

  // I1: the header NAME, not just its value, can be the leak — an upstream
  // that reflects a received API key as a response header NAME (not a
  // value) previously wrote it straight into the shape path, unclassified.
  // `ingest` (`response-store.ts`) exact-scrubs a name that IS one of THIS
  // request's own known secrets; this is the broader, independent net for a
  // name that merely LOOKS like a credential (a JWT, an AWS key id, an
  // opaque blob) regardless of whose secret it is — the same predicate
  // `walk` applies to a body KEY, for the identical reason (file header).
  // Redact to `<redacted:N>` (N = the header's position, mirroring `walk`'s
  // scheme) rather than leaving the real name in the path, exactly as a
  // credential-shaped body key is redacted rather than shown.
  // Classify each header NAME on the case it arrives in (`name`), not the
  // lowercased form (`lower`): three of `looksLikeOpaqueKey`'s patterns — the
  // AWS access key id, the JWT, the mixed-case base64 blob — are
  // case-sensitive and can NEVER match once the name has been lowercased, so
  // classifying `lower` here silently let exactly those shapes back through
  // when they arrived as a header name (they were, and still are, caught on
  // the body-key side, which never lowercases before `looksLikeOpaqueKey`
  // runs). `lower` remains what's used for the `SENSITIVE_HEADERS` membership
  // check and the emitted PATH — headers are case-insensitive on the wire and
  // this path space is uniformly lowercased by design; only the predicate
  // needs the original text. The caller (`response-store.ts`) hands this
  // function the pre-lowercase name for exactly this reason — the dict it
  // stores/looks headers up under stays lowercased separately.
  let headerIndex = 0
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    const nameIsOpaque = looksLikeSecretLiteral(name) || looksLikeOpaqueKey(name)
    const withheld = SENSITIVE_HEADERS.has(lower) || looksLikeSecretLiteral(value) || nameIsOpaque
    out.push({
      path: nameIsOpaque
        ? appendKey(HEADERS_ROOT, `<redacted:${headerIndex}>`)
        : appendKey(HEADERS_ROOT, lower),
      type: 'string',
      size: value.length,
      ...(withheld ? { withheld: true as const } : {})
    })
    headerIndex++
  }

  if (contentType.toLowerCase().includes('json')) {
    // Only the parse itself is guarded — `walk` has its own depth cap and
    // never throws, so a partial walk must never be able to leak into the
    // fallback below.
    let parsed: unknown
    let isJson = true
    try {
      parsed = JSON.parse(body)
    } catch {
      isJson = false
    }
    if (isJson) {
      walk(parsed, '$', undefined, out, 0)
      return out
    }
    // Content type claimed `json` but the body did not parse — either the
    // store truncated it before this ran (any response over `maxBodyBytes`
    // becomes unparseable JSON) or the body itself is malformed/mislabelled
    // (a proxy's HTML error page served as `application/json`, a stream cut
    // short). Either way this may still be a fragment of a structured body an
    // agent should not read in bulk. Do NOT fall through to the plain-string
    // branch below — that would emit an unwithheld `$: string(N)` and let
    // `pull('$')` return the whole thing verbatim, defeating every per-field
    // withholding rule in one request. The `$`-is-readable carve-out (design
    // §4.5, "`$` on a non-JSON body remains readable") applies ONLY when the
    // content type never claimed JSON in the first place — that case is the
    // fallthrough below, unaffected by this branch.
    out.push({
      path: '$',
      type: 'string',
      size: body.length,
      withheld: true,
      ...(truncated ? { truncated: true as const } : {})
    })
    return out
  }
  // A non-JSON content type is modelled as a plain, readable string — it was
  // never claimed to be structured data, so there is no shape to defeat.
  // `out` may already hold header fields, but never any body fields — the
  // branch above always returns before falling through here.
  walk(body, '$', undefined, out, 0)
  return out
}
