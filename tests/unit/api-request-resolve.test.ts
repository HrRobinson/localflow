import { describe, it, expect } from 'vitest'
import { resolveSendInput, substitute } from '../../src/main/api-client/request-resolve'
import type { Collection } from '../../src/shared/api-client'

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: 'stripe',
    name: 'Stripe',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com', acct: 'acct_123' } },
    requests: [
      { id: 'charges', name: 'List charges', method: 'GET', path: '/v1/charges' },
      { id: 'acct', name: 'Account', method: 'GET', path: '/v1/accounts/{{acct}}' }
    ],
    ...over
  }
}

describe('substitute', () => {
  it('replaces {{name}} from the variable map', () => {
    expect(substitute('/v1/a/{{id}}/b', { id: '42' })).toBe('/v1/a/42/b')
  })

  it('throws legibly on an unknown variable', () => {
    expect(() => substitute('/v1/{{nope}}', {})).toThrow(/nope/)
  })
})

describe('resolveSendInput', () => {
  it('resolves a saved request against the varSet base_url', () => {
    const { actionId, params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(actionId).toBe('http.get')
    expect(params.url).toBe('https://api.stripe.com/v1/charges')
    expect(params.auth).toEqual({ scheme: 'bearer', secretRef: 'apiKey' })
  })

  it('substitutes variables in a saved request path', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'acct'
    })
    expect(params.url).toBe('https://api.stripe.com/v1/accounts/acct_123')
  })

  it('lets per-send vars override the varSet', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'acct',
      vars: { acct: 'acct_999' }
    })
    expect(params.url).toBe('https://api.stripe.com/v1/accounts/acct_999')
  })

  it('resolves an ad-hoc spec and picks http.send for a mutating verb', () => {
    const { actionId, params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'POST', path: '/v1/charges', body: { amount: 100 } }
    })
    expect(actionId).toBe('http.send')
    expect(params.method).toBe('POST')
    expect(params.body).toEqual({ amount: 100 })
  })

  it('accepts a fully-qualified URL inside the origins', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: 'https://api.stripe.com/v1/x' }
    })
    expect(params.url).toBe('https://api.stripe.com/v1/x')
  })

  it('rejects a resolved URL outside the collection origins', () => {
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: 'https://evil.com/v1/x' }
      })
    ).toThrow(/outside/i)
  })

  it('rejects a base_url that resolves outside the origins', () => {
    const c = collection({ varSets: { bad: { base_url: 'https://evil.com' } } })
    expect(() =>
      resolveSendInput(c, { collectionId: 'stripe', varSet: 'bad', requestId: 'charges' })
    ).toThrow(/outside/i)
  })

  it('requires exactly one of requestId or spec', () => {
    expect(() => resolveSendInput(collection(), { collectionId: 'stripe' })).toThrow(/exactly one/i)
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        requestId: 'charges',
        spec: { method: 'GET', path: '/x' }
      })
    ).toThrow(/exactly one/i)
  })

  it('refuses an origin escape without echoing the varSet value it targeted', () => {
    // The agent controls BOTH halves of the old refusal string: `vars.base_url`
    // (via `vars`, overriding the varSet) forces the refusal, and `{{acct}}`
    // in the saved request's path positions the varSet value it wants read.
    // The refusal must name only the refused ORIGIN, never the resolved URL.
    const SECRET_ACCT = 'acct_SUPERSECRET'
    const c = collection({
      varSets: { test: { base_url: 'https://api.stripe.com', acct: SECRET_ACCT } }
    })
    let message = ''
    try {
      resolveSendInput(c, {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'acct',
        vars: { base_url: 'https://elsewhere.invalid' }
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/outside/i)
    expect(message).toContain('https://elsewhere.invalid')
    expect(message).not.toContain(SECRET_ACCT)
  })

  it('does not echo source.path in the missing-base_url error either', () => {
    const c = collection({
      requests: [{ id: 'x', name: 'x', method: 'GET', path: '/v1/accounts/{{acct}}' }],
      varSets: { test: { acct: 'acct_SUPERSECRET' } }
    })
    let message = ''
    try {
      resolveSendInput(c, { collectionId: 'stripe', varSet: 'test', requestId: 'x' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/relative path/i)
    expect(message).not.toContain('acct_SUPERSECRET')
  })

  it('rejects an agent header that collides with the auth header under a different casing', () => {
    // `Authorization: token abc` is benign enough to pass `looksLikeSecretLiteral`,
    // but `fetch`'s `Headers` fill APPENDS same-name headers rather than
    // replacing, so this would concatenate onto the injected bearer credential.
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges', headers: { Authorization: 'token abc' } }
      })
    ).toThrow(/reserved/i)
  })

  it('rejects the same collision for a header-scheme auth, differently cased', () => {
    const c = collection({ auth: { scheme: 'header', header: 'X-API-Key', secretRef: 'k' } })
    expect(() =>
      resolveSendInput(c, {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges', headers: { 'x-api-key': 'hello' } }
      })
    ).toThrow(/reserved/i)
  })

  it('rejects a whitespace-padded reserved header name too (finding 6)', () => {
    // An exact `=== reserved` check let `'AUTHORIZATION '` evade the clash
    // check, then die inside `fetch` as an "invalid header name" error —
    // mapped by `sendRaw` to a misleading 502 instead of this 400.
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges', headers: { 'AUTHORIZATION ': 'token abc' } }
      })
    ).toThrow(/reserved/i)
  })

  it('allows an unrelated header through untouched', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: '/v1/charges', headers: { 'X-Request-Id': 'abc' } }
    })
    expect(params.headers).toMatchObject({ 'X-Request-Id': 'abc' })
  })

  it('rejects a "__proto__" header key loudly instead of silently dropping it', () => {
    // `headers['__proto__'] = value` on a plain `{}` is a no-op setter call
    // (not a property write), so this header would otherwise vanish before
    // ever reaching `resolveHeaders`/the guard, while the send still reports
    // `ok: true` as if it had gone out. Built via JSON.parse, as a real agent
    // request body would arrive, so `__proto__` lands as a genuine own key
    // (a `{ '__proto__': ... }` object LITERAL would set the prototype
    // instead of creating an own key, which would not reproduce the bug).
    const headers = JSON.parse('{"__proto__":"whatever"}') as Record<string, string>
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges', headers }
      })
    ).toThrow(/__proto__/)
  })

  it('clamps an oversized timeoutMs instead of passing it through unbounded', () => {
    const { params } = resolveSendInput(collection(), {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: '/v1/charges', timeoutMs: 999_999_999 }
    })
    expect(params.timeoutMs).toBeLessThan(999_999_999)
  })

  it('copies collection.auth instead of handing back a live reference', () => {
    const c = collection()
    const { params } = resolveSendInput(c, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(params.auth).not.toBe(c.auth)
    expect(params.auth).toEqual(c.auth)
  })

  it('carries allowLocal: true through when the collection opts in', () => {
    const c = collection({
      allowLocal: true,
      origins: ['http://localhost:3000'],
      varSets: { test: { base_url: 'http://localhost:3000' } }
    })
    const { params } = resolveSendInput(c, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(params.allowLocal).toBe(true)
  })

  it('defaults allowLocal to false when the collection has not opted in', () => {
    const c = collection({ origins: ['http://localhost:3000'] })
    const { params } = resolveSendInput(c, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges',
      vars: { base_url: 'http://localhost:3000' }
    })
    expect(params.allowLocal).toBe(false)
  })

  it('rejects an unknown requestId and an unknown varSet', () => {
    expect(() =>
      resolveSendInput(collection(), { collectionId: 'stripe', requestId: 'nope' })
    ).toThrow(/nope/)
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'nope',
        requestId: 'charges'
      })
    ).toThrow(/nope/)
  })
})

const okResolver = (id: string, path: string) =>
  id === 'r1' && path === "$['access_token']"
    ? ({ ok: true, value: 'tok_chained', withheld: false } as const)
    : ({ ok: false, reason: 'no longer held, re-send' } as const)

/** Like `okResolver`, but the resolved field reports as withheld — for
 *  exercising finding 2's withheld-based scrub-set filtering. */
const withheldResolver = (id: string, path: string) =>
  id === 'r1' && path === "$['access_token']"
    ? ({ ok: true, value: 'tok_chained', withheld: true } as const)
    : ({ ok: false, reason: 'no longer held, re-send' } as const)

describe('resolveSendInput $ref', () => {
  it('substitutes a ref in a header value and reports it for scrubbing', () => {
    const { params, refValues } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: { 'x-auth': { $ref: "r1:$['access_token']" } as unknown as string }
        }
      },
      okResolver
    )
    expect((params.headers as Record<string, string>)['x-auth']).toBe('tok_chained')
    expect(refValues).toEqual([{ value: 'tok_chained', withheld: false }])
  })

  it('carries withheld: true through from the resolver (finding 2)', () => {
    const { refValues } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: { 'x-auth': { $ref: "r1:$['access_token']" } as unknown as string }
        }
      },
      withheldResolver
    )
    expect(refValues).toEqual([{ value: 'tok_chained', withheld: true }])
  })

  it('substitutes a ref in a body leaf', () => {
    const { params } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'POST',
          path: '/v1/charges',
          body: { token: { $ref: "r1:$['access_token']" } as unknown as string }
        }
      },
      okResolver
    )
    expect(params.body).toEqual({ token: 'tok_chained' })
  })

  it('substitutes a ref in vars', () => {
    const { params } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/a/{{t}}' },
        vars: { t: { $ref: "r1:$['access_token']" } as unknown as string }
      },
      okResolver
    )
    expect(params.url).toBe('https://api.stripe.com/v1/a/tok_chained')
  })

  it('throws loudly on an unresolvable ref — never a silent empty substitution', () => {
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/v1/a',
            headers: { x: { $ref: 'gone:$' } as unknown as string }
          }
        },
        okResolver
      )
    ).toThrow(/no longer held/)
  })

  it('throws on a malformed ref string', () => {
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/a',
            headers: { x: { $ref: 'nocolon' } as unknown as string }
          }
        },
        okResolver
      )
    ).toThrow(/\$ref/)
  })

  it('throws when a ref appears with no resolver supplied', () => {
    expect(() =>
      resolveSendInput(collection(), {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/a', headers: { x: { $ref: 'r1:$' } as unknown as string } }
      })
    ).toThrow(/\$ref/)
  })

  it('does not join the scrub set with a ref resolved into an unreferenced var (finding 3)', () => {
    // `t` is resolved (its `$ref` is fetched) but never referenced by any
    // `{{t}}` anywhere in path/headers/body — so it must not appear in
    // `refValues`. Without this, an agent could chain a withheld value into
    // an unused var purely to confirm it later via the next response's
    // redaction, with no upstream involvement at all.
    const { refValues } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'charges',
        vars: { t: { $ref: "r1:$['access_token']" } as unknown as string }
      },
      okResolver
    )
    expect(refValues).toEqual([])
  })

  it('does join the scrub set when the var IS referenced', () => {
    const { refValues } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/a/{{t}}' },
        vars: { t: { $ref: "r1:$['access_token']" } as unknown as string }
      },
      okResolver
    )
    expect(refValues).toEqual([{ value: 'tok_chained', withheld: false }])
  })

  it('counts a ref resolved into base_url as reached (finding 3)', () => {
    // `base_url` is read directly off `vars`, not through the `{{}}` template
    // mechanism `substitute` tracks — it must still count as reached.
    const c = collection({ varSets: { test: {} } })
    const { params, refValues } = resolveSendInput(
      c,
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges' },
        vars: { base_url: { $ref: 'r1:$.base' } as unknown as string }
      },
      (id, path) =>
        id === 'r1' && path === '$.base'
          ? ({ ok: true, value: 'https://api.stripe.com', withheld: false } as const)
          : ({ ok: false, reason: 'nope' } as const)
    )
    expect(params.url).toBe('https://api.stripe.com/v1/charges')
    expect(refValues).toEqual([{ value: 'https://api.stripe.com', withheld: false }])
  })

  it('throws the same malformed-ref error for a $ref object with extra keys (finding 5)', () => {
    // Header position: previously fell through to `substitute`, which calls
    // `.replace` on a non-string and threw an unrelated internal TypeError.
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/v1/charges',
            headers: {
              x: { $ref: "r1:$['access_token']", note: 'x' } as unknown as string
            }
          }
        },
        okResolver
      )
    ).toThrow(/malformed \$ref/i)
  })

  it('throws the same malformed-ref error in a body leaf (finding 5)', () => {
    // Body position: previously fell through to the generic object branch
    // and was templated (and sent) VERBATIM instead of being refused.
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'POST',
            path: '/v1/charges',
            body: { token: { $ref: "r1:$['access_token']", note: 'x' } as unknown as string }
          }
        },
        okResolver
      )
    ).toThrow(/malformed \$ref/i)
  })

  it('throws the same malformed-ref error in vars (finding 5)', () => {
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: { method: 'GET', path: '/v1/a/{{t}}' },
          vars: { t: { $ref: "r1:$['access_token']", note: 'x' } as unknown as string }
        },
        okResolver
      )
    ).toThrow(/malformed \$ref/i)
  })

  it('throws the same malformed-ref error for a non-string $ref value', () => {
    expect(() =>
      resolveSendInput(
        collection(),
        {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/v1/charges',
            headers: { x: { $ref: 123 } as unknown as string }
          }
        },
        okResolver
      )
    ).toThrow(/malformed \$ref/i)
  })
})

describe('elidedHeaderValues — elide the ref-derived span, not exempt the header (finding 1, wave 3)', () => {
  // Wave 1 masked ref-resolved values with a sentinel before validation and
  // spliced the real value back in after — a SUBSTRING rewrite over every
  // header, agent-authored ones included, which broke an agent-authored
  // literal sitting next to a short chained value. Wave 2 replaced that with
  // PROVENANCE — exempt a header ENTIRELY if any part of its value came from
  // a `$ref` — which closed the cross-header attack but not the intra-header
  // one: an agent literal and a chained ref in the SAME header still got the
  // whole header exempted (see `api-send.test.ts`'s intra-header attack test
  // for the end-to-end version). `elidedHeaderValues` never exempts anything
  // — every header is checked, always — it only changes WHAT TEXT is checked.

  it('elides a header whose value is directly a $ref to the empty string', () => {
    const { elidedHeaderValues } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: { 'x-auth': { $ref: "r1:$['access_token']" } as unknown as string }
        }
      },
      okResolver
    )
    expect(elidedHeaderValues.get('x-auth')).toBe('')
  })

  it('elides just the templated $ref-resolved var, leaving the rest intact', () => {
    // `Authorization: Bearer {{token}}` where `token` itself came from a
    // `$ref` — the ref contribution is indirect, via the var, not a bare
    // `$ref` object filling the whole header.
    const c = collection({
      requests: [
        {
          id: 'r',
          name: 'r',
          method: 'GET',
          path: '/v1/charges',
          headers: { auth: 'Bearer {{t}}' }
        }
      ]
    })
    const { elidedHeaderValues } = resolveSendInput(
      c,
      {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'r',
        vars: { t: { $ref: "r1:$['access_token']" } as unknown as string }
      },
      okResolver
    )
    expect(elidedHeaderValues.get('auth')).toBe('Bearer ')
  })

  it('elides only the ref-derived span when an agent literal shares the header (the wave-2 hole)', () => {
    const c = collection({
      requests: [
        {
          id: 'r',
          name: 'r',
          method: 'GET',
          path: '/v1/charges',
          headers: { 'x-stolen': 'sk_live_STOLEN_HARDCODED{{t}}' }
        }
      ]
    })
    const { elidedHeaderValues } = resolveSendInput(
      c,
      {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'r',
        vars: { t: { $ref: "r1:$['access_token']" } as unknown as string }
      },
      okResolver
    )
    // The chained span is gone; the agent-authored literal survives whole —
    // exactly the text `looksLikeSecretLiteral` must still refuse.
    expect(elidedHeaderValues.get('x-stolen')).toBe('sk_live_STOLEN_HARDCODED')
  })

  it('leaves an ordinary, non-ref header mapped to its own literal value', () => {
    const { elidedHeaderValues } = resolveSendInput(
      collection(),
      {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: {
            'x-auth': { $ref: "r1:$['access_token']" } as unknown as string,
            'x-plain': 'just a literal'
          }
        }
      },
      okResolver
    )
    expect(elidedHeaderValues.get('x-auth')).toBe('')
    expect(elidedHeaderValues.get('x-plain')).toBe('just a literal')
  })
})
