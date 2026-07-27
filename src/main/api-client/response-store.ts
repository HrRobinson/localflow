import { randomUUID } from 'node:crypto'
import type { ResponseView, ShapeField } from '../../shared/api-client'
import { looksLikeSecretLiteral } from '../http/http-node-config'
import type { ApiGrant } from './api-grant'
import { collapseIndices, HEADERS_ROOT, parsePath } from './response-path'
import { scrub } from './redact'
import { shapeOf } from './response-shape'

/**
 * Full response bodies, held in MAIN memory only (design §4). The agent never
 * receives a body — it receives a `ResponseView` (shape, no values) and pulls
 * individual paths. Scoped to the CALLER'S GRANT — both the environment AND
 * the collection set (finding C2) — so a grant on A can never read a response
 * produced in B, and a grant that does not (or no longer) hold the response's
 * originating collection can never read it either, even within the SAME
 * environment: a response must not outlive the grant that produced it. A
 * grant is a fixed, in-memory snapshot (`ApiGrantStore.resolve` returns a
 * fresh copy per call), so this check is always against the CURRENT scope of
 * the token that resolved it, never a stale one. LRU-bounded and
 * process-lifetime: bodies NEVER persist to disk (history metadata does,
 * elsewhere).
 *
 * `ingest` applies the credential scrub BEFORE anything is stored, so the
 * absolute tier holds even against a later code path that reads `body` directly.
 */

export interface IngestInput {
  environment: number
  collectionId: string
  status: number
  durationMs: number
  headers: Record<string, string>
  body: string
  /** Every encoding of the credential injected into the request (`scrubForms`). */
  secrets: string[]
}

export type PullResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'unknown' | 'withheld' | 'nopath' | 'container' | 'null' }

/**
 * `pullForChain`'s result — like `PullResult`, except a success also reports
 * whether the field was withheld from `pull` (finding 2). `chainScrubCandidates`
 * (`redact.ts`) scrubs a chained value from the NEXT response iff it was
 * withheld — length is not the right axis: a value that was already readable
 * protects nothing by being scrubbed, while a withheld one leaks in the clear
 * on echo if it is not, however short.
 */
export type ChainPullResult =
  | { ok: true; value: unknown; withheld: boolean }
  | { ok: false; reason: 'unknown' | 'nopath' | 'container' | 'null' }

interface StoredResponse {
  id: string
  environment: number
  /** The collection this response was produced against — the C2 scope check
   *  (`resolve`) requires the CALLER's grant to still hold this collection,
   *  not merely to match on environment. */
  collectionId: string
  status: number
  durationMs: number
  contentType: string
  truncated: boolean
  headers: Record<string, string>
  /** Already scrubbed at ingest. */
  body: string
  shape: ShapeField[]
}

const DEFAULT_MAX_ENTRIES = 50
const DEFAULT_MAX_BODY_BYTES = 1_000_000

export class ResponseStore {
  // Insertion-ordered, so the first key is always the oldest — FIFO eviction
  // by insertion order. A `pull`/`view` read does NOT move an entry, so this
  // is not LRU: an entry evicts on age alone, however recently it was read.
  private readonly entries = new Map<string, StoredResponse>()
  private readonly maxEntries: number
  private readonly maxBodyBytes: number

  constructor(deps: { maxEntries?: number; maxBodyBytes?: number }) {
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  }

  ingest(input: IngestInput): ResponseView {
    const scrubbed = scrub(input.body, input.secrets)
    // Gate AND slice on the same unit (bytes) — `.slice(0, maxBodyBytes)` on
    // the JS string counts UTF-16 code units, so a multibyte body gated by a
    // byte-length check could previously be stored at up to 3-4x the nominal
    // cap. `Buffer#toString` decodes a byte range cleanly (a boundary that
    // splits a multibyte character decodes to U+FFFD, never throws).
    const bytes = Buffer.from(scrubbed, 'utf8')
    const truncated = bytes.byteLength > this.maxBodyBytes
    const body = truncated ? bytes.toString('utf8', 0, this.maxBodyBytes) : scrubbed

    const headers: Record<string, string> = {}
    // `shapeOf` classifies a header NAME's shape on its ORIGINAL case (I1
    // follow-up, `response-shape.ts`) — three of its opaque-key patterns (AWS
    // access key id, JWT, mixed-case base64 blob) are case-sensitive and can
    // never match once lowercased. `headers` below (storage, `content-type`
    // lookup, and the shape's emitted PATH) stays lowercased exactly as
    // before; `shapeHeaders` carries the same scrubbed values keyed by the
    // pre-lowercase name, for classification only.
    const shapeHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.headers)) {
      // I1: the KEY is scrubbed too, not just the value — a header NAME can
      // literally BE the credential (an upstream that reflects the API key it
      // received as a header name, not just a value). Exact-match `scrub`
      // against this request's own scrub set catches that case; `shapeOf`'s
      // classifier (below, via `looksLikeSecretLiteral`/`looksLikeOpaqueKey`)
      // is the independent, broader net for a credential-SHAPED name that
      // was never in this request's own scrub set at all.
      const scrubbedValue = scrub(v, input.secrets)
      headers[scrub(k.toLowerCase(), input.secrets)] = scrubbedValue
      // Own-secret exact scrub still applies here too — on the ORIGINAL-case
      // `k`, not the lowercased form, so this stays a plain application of
      // the same `scrub` used above (no new matching logic), just without
      // the lowercasing that would defeat the case-sensitive classifiers.
      shapeHeaders[scrub(k, input.secrets)] = scrubbedValue
    }
    const contentType = headers['content-type'] ?? ''

    const stored: StoredResponse = {
      id: randomUUID(),
      environment: input.environment,
      collectionId: input.collectionId,
      status: input.status,
      durationMs: input.durationMs,
      contentType,
      truncated,
      headers,
      body,
      shape: shapeOf(body, contentType, shapeHeaders, truncated)
    }

    this.entries.set(stored.id, stored)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }

    return toView(stored)
  }

  view(id: string, grant: ApiGrant): ResponseView | undefined {
    const stored = this.resolve(id, grant)
    return stored ? toView(stored) : undefined
  }

  pull(id: string, grant: ApiGrant, path: string): PullResult {
    const stored = this.resolve(id, grant)
    if (stored === undefined) return { ok: false, reason: 'unknown' }

    const field = findField(stored.shape, path)
    if (field === undefined) return { ok: false, reason: 'nopath' }
    if (field.withheld) return { ok: false, reason: 'withheld' }

    const value = readPath(stored, path)
    if (value === undefined) return { ok: false, reason: 'nopath' }

    // `pull` hands back SCALARS ONLY. A container (object or array) is refused
    // even when the shape never marked it `withheld` — a container keeps its
    // OWN classification independent of its children's (see
    // `response-shape.ts`), by design, so one sensitive child never blanks out
    // the whole object's shape. Without this, `$.data[1]` or `$` could be used
    // to read a subtree whole, defeating every per-field withholding above it
    // in a single request. There is no legitimate caller for a subtree read:
    // the shape already describes structure, so a pull is always for a leaf.
    if (typeof value === 'object' && value !== null) {
      return { ok: false, reason: 'container' }
    }

    // The enforcement boundary: `field.withheld` was computed from the SHAPE,
    // which — for a collapsed homogeneous array — can be classified from a
    // different element than the concrete one `path` resolves to here. Never
    // trust that classification alone; re-check the actual resolved value
    // before it leaves main. Holds even if the shape's own classification did
    // not (defence in depth), not only for the collapsed-array case.
    if (typeof value === 'string' && looksLikeSecretLiteral(value)) {
      return { ok: false, reason: 'withheld' }
    }

    return { ok: true, value }
  }

  /**
   * Chaining (design §4.4) — identical to `pull` except it does NOT refuse a
   * withheld field or one that merely looks like a secret literal: passing a
   * value from one response into the next request is not the same as an
   * agent READING it, so that half of `pull`'s gate is deliberately absent
   * here. A container is still refused (no subtree reads, same as `pull`),
   * as is an unknown/evicted/foreign-environment response — chaining is
   * ungated, not unscoped. Do NOT relax `pull` itself for this; `pull` stays
   * the agent-facing read path and keeps refusing withheld fields.
   */
  pullForChain(id: string, grant: ApiGrant, path: string): ChainPullResult {
    const stored = this.resolve(id, grant)
    if (stored === undefined) return { ok: false, reason: 'unknown' }

    const field = findField(stored.shape, path)
    if (field === undefined) return { ok: false, reason: 'nopath' }

    const value = readPath(stored, path)
    if (value === undefined) return { ok: false, reason: 'nopath' }

    // `null` is the ABSENCE of a value, not a value to chain — `String(null)`
    // would otherwise put the literal text `"null"` on the wire as a silent
    // substitution, which is exactly what chaining must never do (finding 4).
    // Refused here, uniformly with the container refusal below, rather than
    // letting it fall through the `typeof value === 'object'` check (`null`
    // is famously `typeof` `'object'` too, but IS excluded by the `!== null`
    // guard there — this is the check that used to be missing).
    if (value === null) return { ok: false, reason: 'null' }

    if (typeof value === 'object') {
      return { ok: false, reason: 'container' }
    }

    // `field.withheld` — computed from the SHAPE just like `pull`'s gate
    // above — is handed back here rather than discarded (finding 2): it is
    // exactly the signal the caller needs to decide whether this chained
    // value must be scrubbed from whatever comes back next.
    return { ok: true, value, withheld: field.withheld === true }
  }

  /**
   * The C2 scope check: BOTH the environment AND the caller's grant must
   * currently hold the response's originating collection. Environment alone
   * (the pre-fix check) let a response outlive the grant that produced it —
   * a second grant on the SAME environment (the documented "move the
   * capability to another agent" workflow: `grantApiAccess` revokes then
   * re-mints) inherited every response the FIRST grant's sends had produced,
   * across every collection, forever (until eviction). Checking
   * `grant.collections.has(stored.collectionId)` closes that while leaving
   * §4.4's cross-collection chaining — reading/chaining collection B's
   * response while acting under a grant that also holds collection A —
   * untouched: both collections being in the SAME grant's set is exactly what
   * this allows.
   */
  private resolve(id: string, grant: ApiGrant): StoredResponse | undefined {
    const stored = this.entries.get(id)
    if (stored === undefined) return undefined
    if (stored.environment !== grant.environment) return undefined
    if (!grant.collections.has(stored.collectionId)) return undefined
    return stored
  }

  /**
   * Defence in depth for C2: drop every response for `environment` outright,
   * independent of any grant check above. Intended to be called from
   * `revokeApiAccess` so a revoked grant's responses stop existing at all,
   * rather than relying solely on the next grant's (possibly identical, if
   * re-granted with the same scope) collection set to keep them out of reach.
   */
  clearEnvironment(environment: number): void {
    for (const [id, stored] of this.entries) {
      if (stored.environment === environment) this.entries.delete(id)
    }
  }
}

function toView(s: StoredResponse): ResponseView {
  return {
    responseId: s.id,
    status: s.status,
    durationMs: s.durationMs,
    contentType: s.contentType,
    truncated: s.truncated,
    shape: s.shape
  }
}

/**
 * Match a concrete pull path against the shape, which may have collapsed a
 * homogeneous array to `[*]`. An agent reads `$['data'][*]['n']` in the shape
 * and pulls `$['data'][0]['n']`, so a concrete index must find the collapsed
 * field.
 */
function findField(shape: ShapeField[], path: string): ShapeField | undefined {
  // The withheld tie-break stays as defence in depth. With quoted segments a
  // remote can no longer construct two entries sharing a path, so this should
  // never fire — but it fails closed if anything ever does.
  const exacts = shape.filter((f) => f.path === path)
  const exact = exacts.find((f) => f.withheld) ?? exacts[0]
  if (exact !== undefined) return exact
  const collapsed = collapseIndices(path)
  const collapsedMatches = shape.filter((f) => f.path === collapsed)
  return collapsedMatches.find((f) => f.withheld) ?? collapsedMatches[0]
}

/**
 * Read a concrete path out of the stored headers or body.
 *
 * Mirrors `shapeOf`'s own JSON/string gating exactly (contentType includes
 * `json` AND the body actually parses) so `readPath` never resolves a value
 * of a different shape than the one the caller was told about: a non-JSON
 * body is modelled as a single string field at `$`, and only `$` resolves for
 * it — every other path is `nopath`, just as it has no shape entry either.
 */
function readPath(stored: StoredResponse, path: string): unknown {
  const steps = parsePath(path)
  if (steps === null) return undefined

  const isHeaders = path.startsWith(HEADERS_ROOT)
  if (isHeaders) {
    if (steps.length !== 1 || steps[0].kind !== 'key') return undefined
    return stored.headers[steps[0].key]
  }

  const isJson = stored.contentType.toLowerCase().includes('json')
  let current: unknown
  if (isJson) {
    try {
      current = JSON.parse(stored.body)
    } catch {
      return steps.length === 0 ? stored.body : undefined
    }
  } else {
    return steps.length === 0 ? stored.body : undefined
  }
  if (steps.length === 0) return current

  for (const step of steps) {
    if (current === null || current === undefined) return undefined
    if (step.kind === 'wild') return undefined
    if (Array.isArray(current)) {
      if (step.kind !== 'index') return undefined
      current = current[step.index]
      continue
    }
    if (typeof current !== 'object') return undefined
    if (step.kind !== 'key') return undefined
    const obj = current as Record<string, unknown>
    // A `<redacted:N>` segment came from `response-shape.ts` walking THIS same
    // object's entries in order and redacting entry N's key, so
    // `Object.keys(obj)[N]` recovers the real property name. This does NOT make
    // the value readable — `pull` checks the shape's `withheld` mark first.
    const redacted = /^<redacted:(\d+)>$/.exec(step.key)
    current = redacted ? obj[Object.keys(obj)[Number(redacted[1])]] : obj[step.key]
  }
  return current
}
