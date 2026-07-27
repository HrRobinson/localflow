import { describe, it, expect } from 'vitest'
import { ResponseStore, type IngestInput } from '../../src/main/api-client/response-store'
import { scrubForms } from '../../src/main/api-client/redact'
import type { ApiGrant } from '../../src/main/api-client/api-grant'
import type { ShapeField } from '../../src/shared/api-client'

const SECRET = 'sk_live_abc123'

// Every `input()` below defaults to `environment: 1, collectionId: 'stripe'`
// (C2 fix): `view`/`pull`/`pullForChain` now take the full grant, not just
// the environment number, so the collection-scope check has something to
// check against.
const GRANT: ApiGrant = { environment: 1, collections: new Set(['stripe']) }
const FOREIGN_ENV_GRANT: ApiGrant = { environment: 2, collections: new Set(['stripe']) }
const FOREIGN_COLLECTION_GRANT: ApiGrant = { environment: 1, collections: new Set(['weather']) }

function input(over: Partial<IngestInput> = {}): IngestInput {
  return {
    environment: 1,
    collectionId: 'stripe',
    status: 200,
    durationMs: 12,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ch_1', access_token: 'tok_secret', data: [{ n: 1 }, { n: 2 }] }),
    secrets: scrubForms(SECRET),
    ...over
  }
}

describe('ResponseStore', () => {
  it('returns a view with a shape and no values', () => {
    const view = new ResponseStore({}).ingest(input())
    expect(view.status).toBe(200)
    expect(view.responseId).toBeTruthy()
    expect(JSON.stringify(view)).not.toContain('ch_1')
    expect(JSON.stringify(view)).not.toContain('tok_secret')
  })

  it('pulls an unclassified value', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, GRANT, "$['id']")).toEqual({ ok: true, value: 'ch_1' })
  })

  it('refuses to pull a withheld field', () => {
    // `access_token` is a bare `SENSITIVE_KEY` word with no opaque residue,
    // so its key text is kept (response-shape.ts finding 2) and its value is
    // withheld at that same path.
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, GRANT, "$['access_token']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
  })

  it('maps a concrete index onto a collapsed [*] shape path', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, GRANT, "$['data'][0]['n']")).toEqual({ ok: true, value: 1 })
  })

  it('pulls a header, and refuses a sensitive one', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(
      input({ headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } })
    )
    expect(s.pull(responseId, GRANT, "$headers['content-type']")).toEqual({
      ok: true,
      value: 'application/json'
    })
    expect(s.pull(responseId, GRANT, "$headers['set-cookie']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
  })

  it('redacts an AWS-shaped header NAME from both the ingest (send) shape and the re-derived view (I1 follow-up)', () => {
    // The re-review's exact scenario: a credential-shaped header NAME (AWS
    // access key ids are uppercase-only by construction) reflected by a
    // hostile upstream. Before the fix, `ingest`/`shapeOf` lowercased the
    // name before classifying it, so `AWS_ACCESS_KEY_ID` (case-sensitive)
    // never matched and the name leaked verbatim, lowercased, into both the
    // shape `ingest()` returns (the `send` response) and the shape
    // `view()` returns (the `GET /http/responses/:id` re-derivation).
    const key = 'AKIAIOSFODNN7EXAMPLE'
    const s = new ResponseStore({})
    const sendResult = s.ingest(
      input({ headers: { [key]: 'x', 'content-type': 'application/json' } })
    )
    expect(JSON.stringify(sendResult.shape)).not.toContain(key)
    expect(JSON.stringify(sendResult.shape)).not.toContain(key.toLowerCase())

    const rederived = s.view(sendResult.responseId, GRANT)
    expect(rederived).toBeDefined()
    expect(JSON.stringify(rederived?.shape)).not.toContain(key)
    expect(JSON.stringify(rederived?.shape)).not.toContain(key.toLowerCase())
    expect(rederived?.shape.find((f) => f.path === "$headers['<redacted:0>']")).toMatchObject({
      withheld: true
    })
  })

  it('scrubs the injected credential out of the stored body entirely', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(
      input({ body: JSON.stringify({ echoed: SECRET }), secrets: scrubForms(SECRET) })
    )
    const pulled = s.pull(responseId, GRANT, "$['echoed']")
    expect(pulled).toEqual({ ok: true, value: '[redacted]' })
  })

  it('is environment-scoped', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input({ environment: 1 }))
    expect(s.view(responseId, FOREIGN_ENV_GRANT)).toBeUndefined()
    expect(s.pull(responseId, FOREIGN_ENV_GRANT, "$['id']")).toEqual({
      ok: false,
      reason: 'unknown'
    })
  })

  // C2 (CRITICAL): a response must not outlive its grant. Same environment,
  // but a grant whose collection set does not include the response's
  // originating collection must be refused exactly like a foreign
  // environment — this is the "grant moved to a different agent" scenario
  // from the review: `payroll`'s response must not become readable to a
  // grant scoped only to `weather`, even though both share environment 1.
  it('is collection-scoped: a same-environment grant lacking the collection is refused', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input({ environment: 1, collectionId: 'payroll' }))
    expect(s.view(responseId, FOREIGN_COLLECTION_GRANT)).toBeUndefined()
    expect(s.pull(responseId, FOREIGN_COLLECTION_GRANT, "$['id']")).toEqual({
      ok: false,
      reason: 'unknown'
    })
    expect(s.pullForChain(responseId, FOREIGN_COLLECTION_GRANT, "$['id']")).toEqual({
      ok: false,
      reason: 'unknown'
    })
    // The rightful grant (same environment, holds `payroll`) still reads it fine.
    expect(
      s.pull(responseId, { environment: 1, collections: new Set(['payroll']) }, "$['id']")
    ).toEqual({ ok: true, value: 'ch_1' })
  })

  // §4.4 must keep working: cross-collection chaining WITHIN one grant.
  it('still allows cross-collection chaining within the SAME grant (§4.4)', () => {
    const s = new ResponseStore({})
    const multiGrant: ApiGrant = { environment: 1, collections: new Set(['payroll', 'weather']) }
    const { responseId } = s.ingest(input({ environment: 1, collectionId: 'payroll' }))
    expect(s.pullForChain(responseId, multiGrant, "$['id']")).toEqual({
      ok: true,
      value: 'ch_1',
      withheld: false
    })
  })

  it('clearEnvironment drops every response for that environment only', () => {
    const s = new ResponseStore({})
    const { responseId: env1 } = s.ingest(input({ environment: 1 }))
    const { responseId: env2 } = s.ingest(input({ environment: 2 }))
    s.clearEnvironment(1)
    expect(s.view(env1, GRANT)).toBeUndefined()
    expect(s.view(env2, FOREIGN_ENV_GRANT)).toMatchObject({ status: 200 })
  })

  it('reports an unknown path distinctly from an unknown response', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, GRANT, "$['nope']")).toEqual({ ok: false, reason: 'nopath' })
    expect(s.pull('no-such-id', GRANT, "$['id']")).toEqual({ ok: false, reason: 'unknown' })
  })

  it('evicts the oldest response past maxEntries', () => {
    const s = new ResponseStore({ maxEntries: 2 })
    const first = s.ingest(input()).responseId
    s.ingest(input())
    s.ingest(input())
    expect(s.view(first, GRANT)).toBeUndefined()
  })

  it('truncates an oversized body and marks it', () => {
    const s = new ResponseStore({ maxBodyBytes: 10 })
    const big = input({ body: 'x'.repeat(50), headers: { 'content-type': 'text/plain' } })
    expect(s.ingest(big).truncated).toBe(true)
  })

  it('gates and slices truncation on the same unit (bytes, not UTF-16 units)', () => {
    // Each '€' is 1 UTF-16 code unit but 3 UTF-8 bytes. Gating on byte length
    // while slicing on code units could previously store a body up to 3-4x
    // over the nominal byte cap. A cap of 9 lands exactly on a '€' boundary
    // (a multiple of 3), which the bytewise-bounded claim can satisfy by
    // accident — never actually exercising a split character. Use a cap that
    // is NOT a multiple of 3, so the cut lands mid-character and
    // `Buffer#toString` must decode the split tail to U+FFFD (which itself
    // re-encodes to 3 bytes): worst case is `cap + 2`, not the unbounded
    // `cap + up to 2 code units' worth of UTF-8` a UTF-16-based slice risked.
    const s = new ResponseStore({ maxBodyBytes: 10 })
    const big = input({ body: '€'.repeat(50), headers: { 'content-type': 'text/plain' } })
    const { responseId } = s.ingest(big)
    const pulled = s.pull(responseId, GRANT, '$')
    if (!pulled.ok) throw new Error('expected ok')
    expect(Buffer.byteLength(pulled.value as string)).toBeLessThanOrEqual(12)
  })

  it('refuses the exact demonstrated bypass: a secret in a later array element', () => {
    const s = new ResponseStore({})
    const body = JSON.stringify({ data: [{ n: 'hello' }, { n: 'sk_live_realSECRETvalue' }] })
    const { responseId } = s.ingest(input({ body }))
    expect(s.pull(responseId, GRANT, "$['data'][1]['n']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
  })

  it('still pulls an ordinary collapsed value when no element is sensitive', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, GRANT, "$['data'][1]['n']")).toEqual({ ok: true, value: 2 })
  })

  it('refuses a container pull instead of handing back the subtree whole', () => {
    // The exact demonstrated bypass: `pull` refusing a leaf must not be
    // skippable by asking for its parent, its grandparent, or the root.
    const s = new ResponseStore({})
    const body = JSON.stringify({
      data: [{ n: 'hello' }, { n: 'sk_live_realSECRETvalue' }],
      profile: { token: 'a-plain-opaque-session-value' }
    })
    const { responseId } = s.ingest(input({ body }))
    expect(s.pull(responseId, GRANT, "$['data'][1]")).toEqual({ ok: false, reason: 'container' })
    expect(s.pull(responseId, GRANT, "$['data']")).toEqual({ ok: false, reason: 'container' })
    expect(s.pull(responseId, GRANT, "$['profile']")).toEqual({ ok: false, reason: 'container' })
    expect(s.pull(responseId, GRANT, '$')).toEqual({ ok: false, reason: 'container' })
  })

  it('refuses $ on a JSON body truncated past maxBodyBytes (CRITICAL finding 1)', () => {
    // An agent forcing e.g. `?limit=1000` makes an over-cap response the
    // norm, not the edge case. Before the fix, truncation made the JSON
    // unparseable, which fell through to an UNWITHHELD `$` string field —
    // `pull('$')` then returned the whole (truncated) body verbatim,
    // bypassing every withheld classification in one request.
    const s = new ResponseStore({ maxBodyBytes: 20 })
    const body = JSON.stringify({
      id: 'ch_1',
      access_token: 'tok_secret_should_never_leak',
      data: Array.from({ length: 50 }, (_, i) => ({ n: i }))
    })
    const { responseId } = s.ingest(input({ body }))
    const view = s.view(responseId, GRANT)
    expect(view?.truncated).toBe(true)
    expect(s.pull(responseId, GRANT, '$')).toEqual({ ok: false, reason: 'withheld' })
  })

  it('refuses $ on a malformed body mislabelled as application/json', () => {
    // E.g. a proxy's HTML error page served with a JSON content-type, or a
    // stream cut short mid-response — content type claims JSON, the body
    // isn't. Must refuse the same way an over-cap truncation does.
    const s = new ResponseStore({})
    const { responseId } = s.ingest(
      input({
        body: '<html>502 Bad Gateway</html>',
        headers: { 'content-type': 'application/json' }
      })
    )
    expect(s.pull(responseId, GRANT, '$')).toEqual({ ok: false, reason: 'withheld' })
  })

  it('still lets $ resolve the whole body when that body is not JSON', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(
      input({ body: 'plain text body', headers: { 'content-type': 'text/plain' } })
    )
    expect(s.pull(responseId, GRANT, '$')).toEqual({ ok: true, value: 'plain text body' })
  })

  it('resolves a <redacted:N> path internally, while pull still refuses it', () => {
    // Finding 3: `<redacted:N>` must be addressable (readPath maps it back to
    // `Object.keys(parent)[N]`), which the `$ref`-chaining layer (design
    // §4.4) needs to name an authenticated token by path — but that must
    // NEVER make the value itself readable through the normal `pull` gate.
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const s = new ResponseStore({})
    const body = JSON.stringify({ profile: { [`session_${uuid}`]: 'the-real-value' } })
    const { responseId } = s.ingest(input({ body }))

    // pull still refuses it through the normal, non-tampered path.
    expect(s.pull(responseId, GRANT, "$['profile']['<redacted:0>']")).toEqual({
      ok: false,
      reason: 'withheld'
    })

    // Reaching past the `withheld` gate (as the pre-existing "even when the
    // shape did not mark it withheld" test above does) proves the path
    // itself resolves to the correct underlying value, not merely `undefined`.
    const store = s as unknown as { entries: Map<string, { shape: ShapeField[] }> }
    const field = store.entries
      .get(responseId)
      ?.shape.find((f) => f.path === "$['profile']['<redacted:0>']")
    expect(field?.withheld).toBe(true)
    if (field) delete field.withheld
    expect(s.pull(responseId, GRANT, "$['profile']['<redacted:0>']")).toEqual({
      ok: true,
      value: 'the-real-value'
    })
  })

  it('refuses the exact <redacted:N> collision attack body (CRITICAL finding)', () => {
    // A server plants a decoy key literally named `<redacted:1>` alongside a
    // genuinely opaque key that sits at index 1. Before the fix, both shared
    // the shape path `$.<redacted:1>` and `findField`'s `Array#find` returned
    // the non-withheld decoy first, so `pull('$.<redacted:1>')` resolved to
    // the decoy's `readPath` position — but since the real, withheld field is
    // stored at that exact index too, the read landed on THE SECRET VALUE
    // instead of being refused.
    const s = new ResponseStore({})
    const body = JSON.stringify({
      '<redacted:1>': 'decoy',
      '550e8400-e29b-41d4-a716-446655440000': 'THE-SECRET-VALUE'
    })
    const { responseId } = s.ingest(input({ body }))

    expect(s.pull(responseId, GRANT, "$['<redacted:1>']")).toEqual({
      ok: false,
      reason: 'withheld'
    })

    const view = s.view(responseId, GRANT)
    const paths = (view?.shape ?? []).map((f) => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('refuses a sensitive value even when the shape did not mark it withheld', () => {
    // Layer 2 stands alone: clear the shape's own `withheld` classification
    // directly (simulating whatever future classifier gap Layer 1 does not
    // anticipate), then confirm `pull` still refuses the concrete resolved
    // value on its own re-check — the shape's mark is never the only guard.
    const s = new ResponseStore({})
    const body = JSON.stringify({ ordinary_name: 'sk_live_realSECRETvalue' })
    const { responseId } = s.ingest(input({ body }))
    const store = s as unknown as { entries: Map<string, { shape: ShapeField[] }> }
    const field = store.entries.get(responseId)?.shape.find((f) => f.path === "$['ordinary_name']")
    expect(field?.withheld).toBe(true)
    if (field) delete field.withheld
    expect(s.pull(responseId, GRANT, "$['ordinary_name']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
  })

  it('refuses a malformed path rather than coercing it', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, GRANT, '$.id')).toEqual({ ok: false, reason: 'nopath' })
    expect(s.pull(responseId, GRANT, 'garbage')).toEqual({ ok: false, reason: 'nopath' })
  })

  it('reads a dotted key without treating it as nesting', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input({ body: JSON.stringify({ 'a.b': 'flat' }) }))
    expect(s.pull(responseId, GRANT, "$['a.b']")).toEqual({ ok: true, value: 'flat' })
  })

  it('pullForChain refuses a null value instead of passing it through (finding 4)', () => {
    // `null` is the absence of a value, not a value — before the fix,
    // `pullForChain`'s container check (`typeof value === 'object' && value
    // !== null`) let `null` through as `{ ok: true, value: null }`, and
    // `send.ts` then put the literal text "null" on the wire via `String(...)`.
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input({ body: JSON.stringify({ maybe: null }) }))
    expect(s.pullForChain(responseId, GRANT, "$['maybe']")).toEqual({ ok: false, reason: 'null' })
  })

  it('pullForChain still passes through a withheld value, unlike pull', () => {
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pull(responseId, GRANT, "$['access_token']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
    expect(s.pullForChain(responseId, GRANT, "$['access_token']")).toEqual({
      ok: true,
      value: 'tok_secret',
      withheld: true
    })
  })

  it('pullForChain reports withheld: false for an ordinary, unclassified field (finding 2)', () => {
    // `chainScrubCandidates` (redact.ts) scrubs a chained value from the NEXT
    // response iff it was withheld — this is the flag that decision rests on.
    const s = new ResponseStore({})
    const { responseId } = s.ingest(input())
    expect(s.pullForChain(responseId, GRANT, "$['id']")).toEqual({
      ok: true,
      value: 'ch_1',
      withheld: false
    })
  })
})
