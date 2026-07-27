import { describe, it, expect } from 'vitest'
import { shapeOf } from '../../src/main/api-client/response-shape'
import type { ShapeField } from '../../src/shared/api-client'

const find = (shape: ShapeField[], path: string): ShapeField | undefined =>
  shape.find((f) => f.path === path)

describe('shapeOf', () => {
  it('emits paths, types and sizes but never values', () => {
    const body = JSON.stringify({ id: 'ch_123456', amount: 100, live: true, note: null })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['id']")).toMatchObject({ type: 'string', size: 9 })
    expect(find(shape, "$['amount']")).toMatchObject({ type: 'number' })
    expect(find(shape, "$['live']")).toMatchObject({ type: 'boolean' })
    expect(find(shape, "$['note']")).toMatchObject({ type: 'null' })
    expect(JSON.stringify(shape)).not.toContain('ch_123456')
  })

  it('collapses a homogeneous array to [*]', () => {
    const body = JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['data']")).toMatchObject({ type: 'array', size: 3 })
    expect(find(shape, "$['data'][*]['id']")).toMatchObject({ type: 'string' })
    expect(find(shape, "$['data'][0]['id']")).toBeUndefined()
  })

  it('indexes a heterogeneous array element-by-element', () => {
    const body = JSON.stringify({ mixed: ['a', 1] })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['mixed'][0]")).toMatchObject({ type: 'string' })
    expect(find(shape, "$['mixed'][1]")).toMatchObject({ type: 'number' })
  })

  it('withholds a field whose KEY carries a bare sensitive word, keeping the key text', () => {
    // A bare `SENSITIVE_KEY` word match (with no opaque residue after the
    // word is stripped) withholds the VALUE but must NOT redact the key
    // segment — restoring design §4.3's own example
    // (`$['access_token'] string(64) [withheld]`). Redacting the key text on
    // the word alone would erase ordinary field names like `session_count`.
    const body = JSON.stringify({ access_token: 'x', refresh_token: 'y', api_key: 'z', id: 'ok' })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['access_token']")).toMatchObject({ type: 'string', withheld: true })
    expect(find(shape, "$['refresh_token']")).toMatchObject({ type: 'string', withheld: true })
    expect(find(shape, "$['api_key']")).toMatchObject({ type: 'string', withheld: true })
    expect(shape.filter((f) => f.path.startsWith("$['<redacted:"))).toHaveLength(0)
    expect(find(shape, "$['id']")).toMatchObject({ type: 'string' })
    expect(find(shape, "$['id']")?.withheld).toBeUndefined()
  })

  it('redacts a KEY only when a sensitive word carries opaque residue too', () => {
    // `session_<uuid>` has 20+ opaque chars left after the word "session" is
    // stripped, so the key segment IS redacted (in addition to the value).
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const body = JSON.stringify({ [`session_${uuid}`]: 'x' })
    const shape = shapeOf(body, 'application/json', {})
    expect(JSON.stringify(shape)).not.toContain(uuid)
    expect(find(shape, "$['<redacted:0>']")?.withheld).toBe(true)
  })

  it('keeps ordinary metadata key text beside a sensitive word (finding 2)', () => {
    // None of these carry secret material — only author-chosen vocabulary.
    // The key text must survive; the value may still be marked withheld by
    // the same word match (that half is unchanged and correct).
    const names = [
      'refresh_interval_seconds',
      'session_count',
      'signature_version',
      'token_type',
      'last_refresh_at',
      'sessions_active',
      'password_policy_min_length',
      'credential_expiry_days'
    ]
    const body = JSON.stringify(Object.fromEntries(names.map((n) => [n, 'v'])))
    const shape = shapeOf(body, 'application/json', {})
    for (const n of names) {
      expect(find(shape, `$['${n}']`)).toMatchObject({ type: 'string' })
    }
    expect(shape.filter((f) => f.path.startsWith("$['<redacted:"))).toHaveLength(0)
  })

  it('withholds a field whose VALUE looks like a credential', () => {
    const body = JSON.stringify({ harmless_name: 'sk_live_abc123' })
    expect(find(shapeOf(body, 'application/json', {}), "$['harmless_name']")?.withheld).toBe(true)
  })

  it('does not descend into a withheld object, keeping its bare-word key text', () => {
    // "credentials" matches SENSITIVE_KEY as a bare word (no opaque residue),
    // so the key segment is NOT redacted — but the container is still
    // withheld (via `sensitive()`) and so still not descended into.
    const body = JSON.stringify({ credentials: { inner: 'x' } })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['credentials']")).toMatchObject({ type: 'object', withheld: true })
    expect(find(shape, "$['credentials']['inner']")).toBeUndefined()
  })

  it('withholds sensitive headers and lists the rest', () => {
    const shape = shapeOf('{}', 'application/json', {
      'content-type': 'application/json',
      'set-cookie': 'session=abc',
      authorization: 'Bearer x'
    })
    expect(find(shape, "$headers['content-type']")?.withheld).toBeUndefined()
    expect(find(shape, "$headers['set-cookie']")?.withheld).toBe(true)
    expect(find(shape, "$headers['authorization']")?.withheld).toBe(true)
    expect(JSON.stringify(shape)).not.toContain('session=abc')
  })

  // I1 follow-up: the previous fix (37873b6) classified a header NAME on its
  // LOWERCASED form (`response-shape.ts` used to run `looksLikeOpaqueKey` on
  // `name.toLowerCase()`). Three of that predicate's patterns — AWS access
  // key id, JWT, mixed-case base64 — are case-sensitive and can never match
  // a lowercased string, so exactly the shapes the fix claimed to cover
  // leaked straight through when they arrived as a header NAME instead of a
  // body key. Each case below fails before the fix (the name survives,
  // unredacted, lowercased) and passes after (redacted + withheld).
  it('redacts an AWS-access-key-id-shaped header NAME (I1 follow-up)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE'
    const shape = shapeOf('{}', 'application/json', {
      [key]: 'x',
      'content-type': 'application/json'
    })
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(JSON.stringify(shape)).not.toContain(key.toLowerCase())
    expect(find(shape, "$headers['<redacted:0>']")).toMatchObject({ withheld: true })
    // Regression guard: an ordinary header beside the opaque one still
    // emits normally.
    expect(find(shape, "$headers['content-type']")?.withheld).toBeUndefined()
  })

  it('redacts a JWT-shaped header NAME (I1 follow-up)', () => {
    const key = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ'
    const shape = shapeOf('{}', 'application/json', { [key]: 'x' })
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$headers['<redacted:0>']")).toMatchObject({ withheld: true })
  })

  it('redacts a mixed-case base64-ish header NAME (I1 follow-up)', () => {
    const key = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'
    const shape = shapeOf('{}', 'application/json', { [key]: 'x' })
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$headers['<redacted:0>']")).toMatchObject({ withheld: true })
  })

  it('models a non-JSON body as a single $ string field', () => {
    const shape = shapeOf('<html>hi</html>', 'text/html', {})
    expect(find(shape, '$')).toMatchObject({ type: 'string', size: 15 })
  })

  it('withholds an unparseable JSON body instead of reopening a bulk read', () => {
    // A malformed or mislabelled body — a proxy's HTML error page served as
    // `application/json`, a stream cut short — must not fall through to the
    // unwithheld string field the non-JSON carve-out uses, or `pull('$')`
    // would hand back the entire body verbatim regardless of what it holds.
    const shape = shapeOf('{not json', 'application/json', {})
    expect(find(shape, '$')).toMatchObject({ type: 'string', withheld: true })
  })

  it('marks a truncated JSON body withheld AND truncated', () => {
    const shape = shapeOf('{"a":1', 'application/json', {}, true)
    expect(find(shape, '$')).toMatchObject({
      type: 'string',
      withheld: true,
      truncated: true
    })
  })

  it('still allows $ on a non-JSON body even when the store truncated it', () => {
    // The `$`-is-readable carve-out (design §4.5) applies only when the
    // content type never claimed JSON — truncating a non-JSON body must not
    // start withholding it.
    const shape = shapeOf('plain text', 'text/plain', {}, true)
    expect(find(shape, '$')).toMatchObject({ type: 'string' })
    expect(find(shape, '$')?.withheld).toBeUndefined()
  })

  it('handles an empty body and an empty array', () => {
    expect(find(shapeOf('', 'text/plain', {}), '$')).toMatchObject({ type: 'string', size: 0 })
    const shape = shapeOf(JSON.stringify({ data: [] }), 'application/json', {})
    expect(find(shape, "$['data']")).toMatchObject({ type: 'array', size: 0 })
  })

  it('redacts a secret-shaped KEY from the path, not just a secret-shaped value', () => {
    const key = 'sk_live_51H8abcXYZ123456789'
    const body = JSON.stringify({ [key]: { amount: 100 } })
    const shape = shapeOf(body, 'application/json', {})
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$['<redacted:0>']")?.withheld).toBe(true)
    expect(find(shape, "$['<redacted:0>']['amount']")).toBeUndefined()
  })

  it('disambiguates two secret-shaped keys in one object by index', () => {
    const body = JSON.stringify({
      sk_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 1,
      sk_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 2
    })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['<redacted:0>']")?.withheld).toBe(true)
    expect(find(shape, "$['<redacted:1>']")?.withheld).toBe(true)
  })

  it('still emits and descends into an ordinary key beside a secret-shaped one', () => {
    const body = JSON.stringify({
      sk_live_ccccccccccccccccccccccccccccccccccccc: 1,
      id: { nested: 'x' }
    })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['id']")).toMatchObject({ type: 'object' })
    expect(find(shape, "$['id']")?.withheld).toBeUndefined()
    expect(find(shape, "$['id']['nested']")).toMatchObject({ type: 'string' })
  })

  it('redacts a JWT used as an object key', () => {
    const key = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ'
    const body = JSON.stringify({ [key]: { inner: 'x' } })
    const shape = shapeOf(body, 'application/json', {})
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$['<redacted:0>']")).toMatchObject({ type: 'object', withheld: true })
    expect(find(shape, "$['<redacted:0>']['inner']")).toBeUndefined()
  })

  it('redacts an AWS access key id used as an object key', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE'
    const body = JSON.stringify({ [key]: { inner: 'x' } })
    const shape = shapeOf(body, 'application/json', {})
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$['<redacted:0>']")).toMatchObject({ type: 'object', withheld: true })
    expect(find(shape, "$['<redacted:0>']['inner']")).toBeUndefined()
  })

  it('redacts a long hex string used as an object key', () => {
    const key = 'abcdef0123456789abcdef0123456789'
    const body = JSON.stringify({ [key]: { inner: 'x' } })
    const shape = shapeOf(body, 'application/json', {})
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$['<redacted:0>']")).toMatchObject({ type: 'object', withheld: true })
    expect(find(shape, "$['<redacted:0>']['inner']")).toBeUndefined()
  })

  it('redacts a long base64-ish string used as an object key', () => {
    const key = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'
    const body = JSON.stringify({ [key]: { inner: 'x' } })
    const shape = shapeOf(body, 'application/json', {})
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$['<redacted:0>']")).toMatchObject({ type: 'object', withheld: true })
    expect(find(shape, "$['<redacted:0>']['inner']")).toBeUndefined()
  })

  it('redacts a bare UUID used as an object key', () => {
    const key = '550e8400-e29b-41d4-a716-446655440000'
    const body = JSON.stringify({ [key]: { inner: 'x' } })
    const shape = shapeOf(body, 'application/json', {})
    expect(JSON.stringify(shape)).not.toContain(key)
    expect(find(shape, "$['<redacted:0>']")).toMatchObject({ type: 'object', withheld: true })
    expect(find(shape, "$['<redacted:0>']['inner']")).toBeUndefined()
  })

  it('disambiguates two opaque keys in one object by index', () => {
    const body = JSON.stringify({
      '550e8400-e29b-41d4-a716-446655440000': 1,
      '650e8400-e29b-41d4-a716-446655440111': 2
    })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['<redacted:0>']")?.withheld).toBe(true)
    expect(find(shape, "$['<redacted:1>']")?.withheld).toBe(true)
  })

  it('still emits and descends into ordinary keys beside opaque/sensitive ones', () => {
    // The regression that would make the feature useless: broadening the key
    // predicate must not start swallowing everyday field names.
    const body = JSON.stringify({
      '550e8400-e29b-41d4-a716-446655440000': 'x',
      id: 'ch_123',
      amount: 100,
      created: 1690000000,
      customer_name: 'Ada Lovelace',
      data: [1, 2, 3],
      items: [{ id: 'a' }]
    })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['id']")).toMatchObject({ type: 'string' })
    expect(find(shape, "$['id']")?.withheld).toBeUndefined()
    expect(find(shape, "$['amount']")).toMatchObject({ type: 'number' })
    expect(find(shape, "$['amount']")?.withheld).toBeUndefined()
    expect(find(shape, "$['created']")).toMatchObject({ type: 'number' })
    expect(find(shape, "$['created']")?.withheld).toBeUndefined()
    expect(find(shape, "$['customer_name']")).toMatchObject({ type: 'string' })
    expect(find(shape, "$['customer_name']")?.withheld).toBeUndefined()
    expect(find(shape, "$['data']")).toMatchObject({ type: 'array', size: 3 })
    expect(find(shape, "$['data']")?.withheld).toBeUndefined()
    expect(find(shape, "$['items']")).toMatchObject({ type: 'array', size: 1 })
    expect(find(shape, "$['items'][*]['id']")).toMatchObject({ type: 'string' })
    expect(find(shape, "$['items'][*]['id']")?.withheld).toBeUndefined()
  })

  it('withholds a collapsed [*] field when a LATER element is the sensitive one', () => {
    // The exact bypass: element[0] is ordinary, element[1] carries a secret
    // literal. Classifying only from element[0] would miss it entirely.
    const body = JSON.stringify({ data: [{ n: 'hello' }, { n: 'sk_live_realSECRETvalue' }] })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['data'][*]['n']")?.withheld).toBe(true)
    expect(find(shape, "$['data'][1]['n']")).toBeUndefined()
  })

  it('still allows an ordinary collapsed field when NO element is sensitive', () => {
    const body = JSON.stringify({ data: [{ n: 'hello' }, { n: 'world' }] })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['data'][*]['n']")?.withheld).toBeUndefined()
  })

  it('still emits and descends into ordinary 32+ char field names (finding 1)', () => {
    // `LONG_BASE64ISH_KEY` matched on length alone, so any long snake_case or
    // kebab-case identifier (real Stripe/HTTP-header field names) was swallowed
    // as an opaque key. These must be emitted normally and descended into.
    const names = [
      'payment_method_configuration_details',
      'automatic_payment_methods_enabled',
      'content-security-policy-report-only',
      'customer_shipping_address_line_one',
      'subscription_schedule_current_phase',
      'application_fee_amount_refunded_total',
      'strictTransportSecurityMaxAgeSeconds'
    ]
    const body = JSON.stringify(Object.fromEntries(names.map((n) => [n, { inner: 'x' }])))
    const shape = shapeOf(body, 'application/json', {})
    for (const n of names) {
      const field = find(shape, `$['${n}']`)
      expect(field).toMatchObject({ type: 'object' })
      expect(field?.withheld).toBeUndefined()
      expect(find(shape, `$['${n}']['inner']`)).toMatchObject({ type: 'string' })
    }
  })

  it('keeps camelCase protocol/algorithm names with one digit unredacted (finding 2)', () => {
    // `(?=.*\d)` alone only requires ONE digit, and protocol/algorithm
    // vocabulary carries exactly one routinely (`sha256`, `base64`, `x509`,
    // `oauth2`, `http2`, `utf8`, `ipv6`, `s3`) — camelCase is the default
    // serialization for Java/Kotlin/C#/JS backends, so these over-fired
    // wholesale. Requiring digit DENSITY (4+ digits) instead of mere digit
    // presence keeps these 9 names unredacted.
    const kept = [
      'sha256FingerprintOfLeafCertificate',
      'base64EncodedAttachmentContentBody',
      'x509CertificateChainValidationMode',
      'oAuth2RedirectUriAllowListEntries',
      'http2MaxConcurrentStreamsPerConn',
      'utf8ByteLengthOfSerializedPayload',
      'ipv6AddressPoolAllocationStrategy',
      's3BucketServerSideEncryptionConfig',
      'contentSecurityPolicyLevel3Report'
    ]
    const body = JSON.stringify(Object.fromEntries(kept.map((n) => [n, { inner: 'x' }])))
    const shape = shapeOf(body, 'application/json', {})
    for (const n of kept) {
      const field = find(shape, `$['${n}']`)
      expect(field).toMatchObject({ type: 'object' })
      expect(field?.withheld).toBeUndefined()
      expect(find(shape, `$['${n}']['inner']`)).toMatchObject({ type: 'string' })
    }

    // Two residuals accepted honestly (see the file comment above
    // `LONG_BASE64ISH_KEY`): each embeds 4+ digit characters in its own
    // right (a long numeric literal / a versioned algorithm constant), so
    // the digit-density bar does not save them. Over-redaction, not a leak.
    // The key TEXT itself is opaque-shaped, so `walk` redacts the key
    // segment too (same as any other opaque key) — assert by index, one
    // named explicitly per residual so it is clear which is which.
    const strictTransportSecurityMaxAge31536000 = 0 // index 0: the numeric-literal residual
    const AWS4_HMAC_SHA256_Credential_Scope = 1 // index 1: the versioned-algorithm residual
    const residualBody = JSON.stringify({
      strictTransportSecurityMaxAge31536000: { inner: 'x' },
      AWS4_HMAC_SHA256_Credential_Scope: { inner: 'x' }
    })
    const residualShape = shapeOf(residualBody, 'application/json', {})
    expect(
      find(residualShape, `$['<redacted:${strictTransportSecurityMaxAge31536000}>']`)
    ).toMatchObject({ type: 'object', withheld: true })
    expect(
      find(residualShape, `$['<redacted:${AWS4_HMAC_SHA256_Credential_Scope}>']`)
    ).toMatchObject({
      type: 'object',
      withheld: true
    })
  })

  it('still redacts the secret-ish set fully after the digit-density fix (finding 2)', () => {
    // Zero coverage loss: the repo's own base64 fixture, a GitHub token, a
    // Google API key and a mixed-case random token must all still redact.
    const secretish = {
      base64Fixture: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
      githubToken: 'ghs_1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvWxYz1234',
      googleKey: 'AIzaSyD1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P',
      mixedCaseRandom: 'aB3xY9zQ7mK2pL8nR4tV6wZ1cD5eF0gH2iJ4kM7n'
    }
    for (const key of Object.values(secretish)) {
      const body = JSON.stringify({ [key]: { inner: 'x' } })
      const shape = shapeOf(body, 'application/json', {})
      expect(JSON.stringify(shape)).not.toContain(key)
      expect(find(shape, "$['<redacted:0>']")).toMatchObject({ type: 'object', withheld: true })
    }
  })

  it('redacts a literal key that impersonates a <redacted:N> placeholder (finding 1)', () => {
    // A server plants a decoy key literally named `<redacted:1>` beside a
    // genuinely opaque key that sits at index 1. Both would otherwise produce
    // the identical shape path `$['<redacted:1>']` — ambiguous, and
    // `findField`'s `Array#find` would resolve to whichever is first. The
    // literal decoy key must be treated as opaque in its own right so it is
    // redacted (at ITS OWN index) instead of ever appearing verbatim as a path
    // segment.
    const body = JSON.stringify({
      '<redacted:1>': 'decoy',
      '550e8400-e29b-41d4-a716-446655440000': 'THE-SECRET-VALUE'
    })
    const shape = shapeOf(body, 'application/json', {})
    expect(find(shape, "$['<redacted:0>']")).toMatchObject({ withheld: true })
    expect(find(shape, "$['<redacted:1>']")).toMatchObject({ withheld: true })
    // No two entries share a path for this body — the placeholder collision is
    // the defect being pinned.
    const paths = shape.map((f) => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('a dotted key and a nested path no longer collide', () => {
    // Quoting every key segment (design §4.4a) makes `{"a.b":x}` and
    // `{"a":{"b":y}}` produce distinct addresses — previously both collapsed
    // to the identical dotted path `$.a.b`, letting a remote-controlled key
    // forge a segment boundary.
    const flat = shapeOf(JSON.stringify({ 'a.b': 'x' }), 'application/json', {})
    const nested = shapeOf(JSON.stringify({ a: { b: 'y' } }), 'application/json', {})
    expect(find(flat, "$['a.b']")).toBeDefined()
    expect(find(nested, "$['a']['b']")).toBeDefined()
    // The two addresses are now distinct — previously both were `$.a.b`.
    expect(find(flat, "$['a']['b']")).toBeUndefined()
    expect(find(nested, "$['a.b']")).toBeUndefined()
  })

  it('produces a well-formed shape for deeply-nested input instead of corrupting it', () => {
    const depth = 50000
    const body = '{"child":'.repeat(depth) + '{"leaf":true}' + '}'.repeat(depth)
    const shape = shapeOf(body, 'application/json', {})
    const rootEntries = shape.filter((f) => f.path === '$')
    expect(rootEntries).toHaveLength(1)
    expect(rootEntries[0]).toMatchObject({ type: 'object' })
  })
})
