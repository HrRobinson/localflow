import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiSender } from '../../src/main/api-client/send'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import { CollectionSecretStore } from '../../src/main/api-client/collection-secrets'
import { ResponseStore } from '../../src/main/api-client/response-store'
import { HttpClient, MockHttpTransport, type HttpRequest } from '../../src/main/http/http-client'
import type { SecretBackend } from '../../src/main/integrations/credential-store'
import type { Collection } from '../../src/shared/api-client'

const SECRET = 'sk_live_abc123'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: 'stripe',
    name: 'Stripe',
    environment: 1,
    origins: ['https://api.stripe.com'],
    auth: { scheme: 'bearer', secretRef: 'apiKey' },
    varSets: { test: { base_url: 'https://api.stripe.com' } },
    requests: [{ id: 'charges', name: 'Charges', method: 'GET', path: '/v1/charges' }],
    ...over
  }
}

type Canned = { status: number; headers: Record<string, string>; body: string }

function harness(
  responder: (req: HttpRequest) => Canned,
  col: Collection = collection()
): { sender: ApiSender; transport: MockHttpTransport; responses: ResponseStore } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-send-'))
  const collections = new CollectionStore({ file: join(dir, 'collections.json') })
  collections.upsert(col)
  const secrets = new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') })
  secrets.set(col.id, 'apiKey', SECRET)
  const transport = new MockHttpTransport(responder)
  const responses = new ResponseStore({})
  return {
    sender: new ApiSender({
      collections,
      secrets,
      client: new HttpClient({ transport }),
      responses
    }),
    transport,
    responses
  }
}

const grant = { environment: 1, collections: new Set(['stripe']) }

describe('ApiSender', () => {
  it('applies the credential to the outgoing request', async () => {
    const { sender, transport } = harness(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"ch_1"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result.ok).toBe(true)
    expect(transport.requests[0].headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(transport.requests[0].url).toBe('https://api.stripe.com/v1/charges')
  })

  it('returns a shape with no values', async () => {
    const { sender } = harness(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"ch_secret_value"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(JSON.stringify(result)).not.toContain('ch_secret_value')
  })

  it('returns a non-2xx as a normal result, not an error', async () => {
    const { sender } = harness(() => ({
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"no such charge"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.view.status).toBe(404)
  })

  it('never lets a non-2xx body reach the caller as text', async () => {
    const { sender } = harness(() => ({
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: '{"leaked":"sensitive-error-detail"}'
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(JSON.stringify(result)).not.toContain('sensitive-error-detail')
  })

  it('scrubs an echoed credential out of the stored response', async () => {
    const { sender, responses } = harness(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ echoed: SECRET })
    }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!result.ok) throw new Error('expected ok')
    expect(responses.pull(result.view.responseId, grant, "$['echoed']")).toEqual({
      ok: true,
      value: '[redacted]'
    })
  })

  it('refuses a collection outside the grant scope', async () => {
    const { sender } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(
      { environment: 1, collections: new Set(['other']) },
      { collectionId: 'stripe', varSet: 'test', requestId: 'charges' }
    )
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('gives identical wording for out-of-scope and non-existent', async () => {
    const { sender } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const outOfScope = await sender.send(
      { environment: 1, collections: new Set(['other']) },
      { collectionId: 'stripe', varSet: 'test', requestId: 'charges' }
    )
    const missing = await sender.send(
      { environment: 1, collections: new Set(['ghost']) },
      { collectionId: 'ghost', varSet: 'test', requestId: 'charges' }
    )
    if (outOfScope.ok || missing.ok) throw new Error('expected failures')
    expect(outOfScope.error).toBe(missing.error)
  })

  it('refuses a foreign-environment collection', async () => {
    const { sender } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(
      { environment: 2, collections: new Set(['stripe']) },
      { collectionId: 'stripe', varSet: 'test', requestId: 'charges' }
    )
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('rejects an agent-authored secret literal header', async () => {
    const { sender, transport } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: {
        method: 'GET',
        path: '/v1/charges',
        headers: { authorization: 'Bearer sk_live_stolen' }
      }
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(transport.requests).toHaveLength(0)
  })

  it('rejects a URL outside the collection origins without dialling', async () => {
    const { sender, transport } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: 'https://evil.com/x' }
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(transport.requests).toHaveLength(0)
  })

  it('surfaces a missing credential legibly and never dials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-send-'))
    const collections = new CollectionStore({ file: join(dir, 'collections.json') })
    collections.upsert(collection())
    const transport = new MockHttpTransport(() => ({ status: 200, headers: {}, body: '{}' }))
    const sender = new ApiSender({
      collections,
      // No secret was ever set.
      secrets: new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') }),
      client: new HttpClient({ transport }),
      responses: new ResponseStore({})
    })
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    if (!result.ok) expect(result.error).toMatch(/no credential/i)
    expect(transport.requests).toHaveLength(0)
  })

  it('never renders the credential in an error message', async () => {
    const { sender } = harness(() => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
    })
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('maps a real transport failure to 502 (worth a retry)', async () => {
    const { sender, transport } = harness(() => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
    })
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: false, status: 502 })
    expect(transport.requests).toHaveLength(1)
  })

  it('refuses a loopback target when the collection has not opted in', async () => {
    const { sender, transport } = harness(
      () => ({ status: 200, headers: {}, body: '{}' }),
      collection({
        origins: ['http://localhost:3000'],
        varSets: { test: { base_url: 'http://localhost:3000' } }
      })
    )
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(transport.requests).toHaveLength(0)
  })

  it('allows a loopback target when the collection opts in with allowLocal', async () => {
    const { sender, transport } = harness(
      () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"id":"ch_1"}'
      }),
      collection({
        allowLocal: true,
        origins: ['http://localhost:3000'],
        varSets: { test: { base_url: 'http://localhost:3000' } }
      })
    )
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    expect(result).toMatchObject({ ok: true })
    expect(transport.requests[0].url).toBe('http://localhost:3000/v1/charges')
  })

  it('maps an SSRF guard rejection to 400, not 502 (never worth a retry)', async () => {
    // Embedded credentials in the URL trip `checkBaseUrl` inside
    // `HttpClient.sendRaw`'s `guardUrl` — a guard rejection of the REQUEST,
    // not a transport failure against the upstream, so it must not be
    // reported (and therefore retried) the same way a dead upstream is.
    const { sender, transport } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
    const result = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: 'https://user:pass@api.stripe.com/v1/charges' }
    })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(transport.requests).toHaveLength(0)
  })

  it('chains a withheld value without reading it, and scrubs it from the next response', async () => {
    // First send: the upstream returns a withheld access_token. Second send:
    // the canned response echoes back whatever `x-auth` header it received,
    // so the scrub assertion below is meaningful rather than a coincidental
    // string match (mirrors the "scrubs an echoed credential" test above).
    const { sender, responses } = harness((req) =>
      req.headers['x-auth'] !== undefined
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ echoed: req.headers['x-auth'] })
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ access_token: 'tok_secret_value' })
          }
    )
    const first = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!first.ok) throw new Error('expected ok')
    const rid = first.view.responseId
    // The agent cannot READ it...
    expect(responses.pull(rid, grant, "$['access_token']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
    // ...but CAN chain it, ungated, and it is scrubbed from the echo that follows.
    const second = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: {
        method: 'GET',
        path: '/v1/charges',
        headers: { 'x-auth': { $ref: `${rid}:$['access_token']` } as unknown as string }
      }
    })
    if (!second.ok) throw new Error('expected ok')
    expect(JSON.stringify(second.view)).not.toContain('tok_secret_value')
  })

  describe('finding 1 — a chained real-vendor-shaped token succeeds; a literal one is still refused', () => {
    // Before the fix, `resolveHeaders`'s `looksLikeSecretLiteral` guard — built
    // to catch an agent HARDCODING a credential into `config.headers` — also
    // rejected the exact class of value chaining exists to carry: a value
    // resolved from a PAST response the agent never saw. Every value below
    // is shaped like a real vendor token/credential.
    const REAL_SHAPED_TOKENS = [
      'sk_live_realtoken99',
      'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'xoxb-1-2-abc',
      'shpat_deadbeef',
      'Bearer abc.def'
    ]

    it.each(REAL_SHAPED_TOKENS)(
      'chains "%s" into a header successfully, but refuses the same text as a literal',
      async (token) => {
        const { sender, transport } = harness((req): Canned =>
          req.headers['x-auth'] !== undefined
            ? { status: 200, headers: {}, body: '{}' }
            : {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ token })
              }
        )
        const first = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          requestId: 'charges'
        })
        if (!first.ok) throw new Error('expected ok')
        const rid = first.view.responseId

        const chained = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/v1/charges',
            headers: { 'x-auth': { $ref: `${rid}:$['token']` } as unknown as string }
          }
        })
        expect(chained).toMatchObject({ ok: true })
        // Not just "didn't 400" — the REAL value reached the wire, not a
        // leftover sentinel.
        expect(transport.requests[1]?.headers['x-auth']).toBe(token)

        // The identical text, agent-AUTHORED (no `$ref`), is still refused —
        // that asymmetry is the whole point of finding 1.
        const literal = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          spec: { method: 'GET', path: '/v1/charges', headers: { 'x-auth': token } }
        })
        expect(literal).toMatchObject({ ok: false, status: 400 })
      }
    )

    it('REFUSES an agent-authored literal even with a chained junk value in another header (attack)', async () => {
      // The demonstrated bypass of the prior (masking) fix: mask every
      // ref-resolved value as a SUBSTRING replace over every header,
      // agent-authored ones included. Chaining one junk character (`e`) —
      // present in `sk_live_STOLEN_HARDCODED` — shattered the literal's
      // prefix before `looksLikeSecretLiteral` ever ran, and unmasking
      // restored it verbatim: the guard became opt-out by the caller.
      // Provenance tracks ref contribution PER HEADER, so a ref in one
      // header must never exempt a different, agent-authored header.
      const { sender, transport } = harness((req): Canned =>
        req.headers['x-junk'] !== undefined
          ? { status: 200, headers: {}, body: '{}' }
          : {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ junk: 'e' })
            }
      )
      const first = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'charges'
      })
      if (!first.ok) throw new Error('expected ok')
      const rid = first.view.responseId

      const attack = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: {
            'x-stolen': 'sk_live_STOLEN_HARDCODED',
            'x-junk': { $ref: `${rid}:$['junk']` } as unknown as string
          }
        }
      })
      expect(attack).toMatchObject({ ok: false, status: 400 })
      // Only the first send ever dialed — the attack request never went out.
      expect(transport.requests).toHaveLength(1)
    })

    it('lets a single-character chained value and a long chained token both arrive intact', async () => {
      // The exact scenario a fixed-length sentinel could collide on: a
      // one-character chained value alongside a long one. With provenance
      // there is no rewrite at all, so there is nothing to collide.
      const { sender, transport } = harness((req): Canned =>
        req.headers['x-junk'] !== undefined
          ? { status: 200, headers: {}, body: '{}' }
          : {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ junk: 'e', token: 'sk_live_realtoken99' })
            }
      )
      const first = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'charges'
      })
      if (!first.ok) throw new Error('expected ok')
      const rid = first.view.responseId

      const second = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: {
            'x-junk': { $ref: `${rid}:$['junk']` } as unknown as string,
            'x-auth': { $ref: `${rid}:$['token']` } as unknown as string
          }
        }
      })
      expect(second).toMatchObject({ ok: true })
      expect(transport.requests[1]?.headers['x-junk']).toBe('e')
      expect(transport.requests[1]?.headers['x-auth']).toBe('sk_live_realtoken99')
    })
  })

  describe('finding 1, wave 3 — elide the ref-derived span, do not exempt the header', () => {
    // Wave 2's fix ("provenance") exempted a header ENTIRELY once ANY part of
    // its value carried a `$ref` contribution. That closed the cross-header
    // attack above but left an intra-header hole wide open: an agent literal
    // and a chained ref living in the SAME header value still counted as
    // "had a $ref contribution" and exempted the whole thing.

    it('REFUSES an agent literal and a one-character chained var in the SAME header', async () => {
      const { sender, transport } = harness((req): Canned =>
        req.headers['x-stolen'] !== undefined
          ? { status: 200, headers: {}, body: '{}' }
          : {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ letter: 'e' })
            }
      )
      const first = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'charges'
      })
      if (!first.ok) throw new Error('expected ok')
      const rid = first.view.responseId

      const attack = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        spec: {
          method: 'GET',
          path: '/v1/charges',
          headers: { 'x-stolen': 'sk_live_STOLEN_HARDCODED{{t}}' }
        },
        vars: { t: { $ref: `${rid}:$['letter']` } as unknown as string }
      })
      expect(attack).toMatchObject({ ok: false, status: 400 })
      // Only the first send ever dialed — the attack request never went out.
      expect(transport.requests).toHaveLength(1)
    })

    it.each([
      ['sk_live_ prefix', 'sk_live_STOLEN_HARDCODED{{t}}'],
      ['Bearer  scheme', 'Bearer STOLEN_HARDCODED{{t}}'],
      ['ghp_ prefix', 'ghp_STOLEN_HARDCODED{{t}}']
    ])(
      'REFUSES the %s attack even when the chained span resolves to the empty string',
      async (_label, headerTemplate) => {
        // The exact byte-exact-bypass the bug report calls out: under the old
        // (masking) mechanism, a chained span resolving to `''` let the
        // hardcoded literal reach the wire unchanged, defeating the guard for
        // every branch of `looksLikeSecretLiteral`. Elision does not care
        // what the chained value actually resolves to — the span is always
        // blanked before the guard runs — so this must refuse identically.
        const { sender, transport } = harness((req): Canned =>
          req.headers['x-stolen'] !== undefined
            ? { status: 200, headers: {}, body: '{}' }
            : {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ letter: '' })
              }
        )
        const first = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          requestId: 'charges'
        })
        if (!first.ok) throw new Error('expected ok')
        const rid = first.view.responseId

        const attack = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/v1/charges',
            headers: { 'x-stolen': headerTemplate }
          },
          vars: { t: { $ref: `${rid}:$['letter']` } as unknown as string }
        })
        expect(attack).toMatchObject({ ok: false, status: 400 })
        expect(transport.requests).toHaveLength(1)
      }
    )

    it('succeeds for a legitimately chained "Bearer {{t}}" — the full value arrives intact', async () => {
      const { sender, transport } = harness((req): Canned =>
        req.headers['x-auth'] !== undefined
          ? { status: 200, headers: {}, body: '{}' }
          : {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: 'realtoken99' })
            }
      )
      const first = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'charges'
      })
      if (!first.ok) throw new Error('expected ok')
      const rid = first.view.responseId

      const second = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges', headers: { 'x-auth': 'Bearer {{t}}' } },
        vars: { t: { $ref: `${rid}:$['token']` } as unknown as string }
      })
      expect(second).toMatchObject({ ok: true })
      expect(transport.requests[1]?.headers['x-auth']).toBe('Bearer realtoken99')
    })

    it('succeeds for a chained token concatenated with genuinely innocuous text', async () => {
      const { sender, transport } = harness((req): Canned =>
        req.headers['x-auth'] !== undefined
          ? { status: 200, headers: {}, body: '{}' }
          : {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: 'abc123' })
            }
      )
      const first = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        requestId: 'charges'
      })
      if (!first.ok) throw new Error('expected ok')
      const rid = first.view.responseId

      const second = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges', headers: { 'x-auth': 'v1-{{t}}' } },
        vars: { t: { $ref: `${rid}:$['token']` } as unknown as string }
      })
      expect(second).toMatchObject({ ok: true })
      expect(transport.requests[1]?.headers['x-auth']).toBe('v1-abc123')
    })
  })

  describe('finding 1, wave 4 — guard the REAL value; only an empty/scheme-word remainder is benign', () => {
    // Waves 1-3 all ran `looksLikeSecretLiteral` against some TRANSFORM of the
    // agent-authored text. `looksLikeSecretLiteral` is anchored at `^`, and
    // elision DELETES bytes — so a chained span sitting at position 0 donates
    // its leading character(s) to the agent-authored remainder, sliding the
    // vendor prefix (or the `Bearer`/`Basic` scheme word) out of the anchor's
    // reach: `'{{t}}k_live_STOLEN'` with a one-character chained `t` elides to
    // `'k_live_STOLEN'`, which the predicate does not match, even though the
    // wire value `'sk_live_STOLEN'` plainly does. Wave 4 guards the REAL,
    // final value instead — the agent can no longer choose which bytes the
    // predicate sees — and only allows a match through when its own
    // contribution is empty or an exact scheme keyword.

    it.each([
      ['sk_live_ prefix donation', '{{t}}k_live_STOLEN_HARDCODED', 's'],
      ['Bearer scheme donation', '{{t}}earer STOLEN_HARDCODED', 'B'],
      ['ghp_ prefix donation', '{{t}}hp_STOLEN_HARDCODED', 'g']
    ])(
      'REFUSES the %s attack — the agent donates the leading byte(s)',
      async (_label, headerTemplate, donor) => {
        const { sender, transport } = harness((req): Canned =>
          req.headers['x-stolen'] !== undefined
            ? { status: 200, headers: {}, body: '{}' }
            : {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ letter: donor })
              }
        )
        const first = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          requestId: 'charges'
        })
        if (!first.ok) throw new Error('expected ok')
        const rid = first.view.responseId

        const attack = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/v1/charges',
            headers: { 'x-stolen': headerTemplate }
          },
          vars: { t: { $ref: `${rid}:$['letter']` } as unknown as string }
        })
        expect(attack).toMatchObject({ ok: false, status: 400 })
        // Only the first send ever dialed — the attack request never went out.
        expect(transport.requests).toHaveLength(1)
      }
    )

    it('REFUSES a plain agent-authored var, unrelated to chaining (regression guard)', async () => {
      const { sender, transport } = harness(() => ({ status: 200, headers: {}, body: '{}' }))
      const result = await sender.send(grant, {
        collectionId: 'stripe',
        varSet: 'test',
        spec: { method: 'GET', path: '/v1/charges', headers: { 'x-stolen': '{{v}}' } },
        vars: { v: 'sk_live_STOLEN_HARDCODED' }
      })
      expect(result).toMatchObject({ ok: false, status: 400 })
      expect(transport.requests).toHaveLength(0)
    })

    it.each([
      ['sk_live_ prefix', 'sk_l{{t}}ve_STOLEN_HARDCODED', 'i'],
      ['Bearer scheme', 'Be{{t}}rer STOLEN_HARDCODED', 'a']
    ])(
      'REFUSES a %s donated from the MIDDLE of the string, not just the front',
      async (_label, headerTemplate, donor) => {
        const { sender, transport } = harness((req): Canned =>
          req.headers['x-stolen'] !== undefined
            ? { status: 200, headers: {}, body: '{}' }
            : {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ letter: donor })
              }
        )
        const first = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          requestId: 'charges'
        })
        if (!first.ok) throw new Error('expected ok')
        const rid = first.view.responseId

        const attack = await sender.send(grant, {
          collectionId: 'stripe',
          varSet: 'test',
          spec: {
            method: 'GET',
            path: '/v1/charges',
            headers: { 'x-stolen': headerTemplate }
          },
          vars: { t: { $ref: `${rid}:$['letter']` } as unknown as string }
        })
        expect(attack).toMatchObject({ ok: false, status: 400 })
        expect(transport.requests).toHaveLength(1)
      }
    )
  })

  it('leaves the next response parseable for a short NON-withheld chained value (finding 2)', async () => {
    // Length is not the scrub axis — withheld-ness is. `page` is an ordinary,
    // non-sensitive field, so its chained value must never join the scrub
    // set, however short: scrubbing it here would protect nothing (it was
    // already readable straight off the first response) while risking an
    // exact-match `split`/`join` corrupting unrelated bytes in the next body
    // by coincidence — `"total":100` losing its `1`, or the body failing to
    // parse entirely and collapsing to one withheld `$`.
    const { sender, responses } = harness((req) =>
      req.headers['x-page'] !== undefined
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'ch_1', total: 100, items: 1, ok: true })
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ page: 1 })
          }
    )
    const first = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!first.ok) throw new Error('expected ok')
    const rid = first.view.responseId

    const second = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: {
        method: 'GET',
        path: '/v1/charges',
        headers: { 'x-page': { $ref: `${rid}:$['page']` } as unknown as string }
      }
    })
    if (!second.ok) throw new Error('expected ok')
    // The body parsed and every value survived intact — no `1` was eaten out
    // of `100`, and the shape was never collapsed to one withheld `$` string.
    expect(responses.pull(second.view.responseId, grant, "$['id']")).toEqual({
      ok: true,
      value: 'ch_1'
    })
    expect(responses.pull(second.view.responseId, grant, "$['total']")).toEqual({
      ok: true,
      value: 100
    })
    expect(responses.pull(second.view.responseId, grant, "$['items']")).toEqual({
      ok: true,
      value: 1
    })
  })

  it('scrubs a short WITHHELD chained value from the next response (finding 2)', async () => {
    // The leak the length threshold opened: a withheld value shorter than the
    // old 8-character minimum was chained out and never scrubbed, so an
    // upstream echo handed it back in the clear on the very next response —
    // exactly what §4.1's withhold tier exists to prevent. `session_id`
    // matches the sensitive-key pattern, so it is withheld regardless of how
    // short its value is.
    const SHORT_WITHHELD = 'S-4821'
    const { sender, responses } = harness((req) =>
      req.headers['x-sess'] !== undefined
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ echoed: SHORT_WITHHELD })
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: SHORT_WITHHELD })
          }
    )
    const first = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!first.ok) throw new Error('expected ok')
    const rid = first.view.responseId
    expect(responses.pull(rid, grant, "$['session_id']")).toEqual({ ok: false, reason: 'withheld' })

    const second = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: {
        method: 'GET',
        path: '/v1/charges',
        headers: { 'x-sess': { $ref: `${rid}:$['session_id']` } as unknown as string }
      }
    })
    if (!second.ok) throw new Error('expected ok')
    expect(responses.pull(second.view.responseId, grant, "$['echoed']")).toEqual({
      ok: true,
      value: '[redacted]'
    })
  })

  it('does not add a GET body ref to the scrub set — its body never reaches the wire (finding 3)', async () => {
    // `resolveRequest` (`http-node-config.ts`) drops the body entirely for a
    // GET. Before the fix, a body `$ref` joined the scrub set unconditionally
    // regardless of method — so chaining a withheld value into a GET spec's
    // body (which the upstream never sees) still scrubbed it from later
    // responses, an oracle with no upstream involvement at all: chain a
    // guessed value into a dead GET body, then watch whether it comes back
    // redacted elsewhere.
    const CANDIDATE = 'tok_get_body_dropped_xyz'
    const { sender, responses } = harness((req) =>
      req.headers['probe'] !== undefined
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ echoed: CANDIDATE })
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ access_token: CANDIDATE })
          }
    )
    const first = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!first.ok) throw new Error('expected ok')
    const rid = first.view.responseId
    expect(responses.pull(rid, grant, "$['access_token']")).toEqual({
      ok: false,
      reason: 'withheld'
    })

    const second = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: {
        method: 'GET',
        path: '/v1/charges',
        headers: { probe: 'yes' },
        body: { junk: { $ref: `${rid}:$['access_token']` } as unknown as string }
      }
    })
    if (!second.ok) throw new Error('expected ok')
    // The GET body ref resolved without error, but never reached the wire —
    // and never joined the scrub set — so the same value echoed elsewhere
    // survives intact.
    expect(responses.pull(second.view.responseId, grant, "$['echoed']")).toEqual({
      ok: true,
      value: CANDIDATE
    })
  })

  it('does not redact a value chained into an unreferenced var (finding 3)', async () => {
    // `unused` is resolved (its `$ref` is fetched, since `resolveVarsMap`
    // resolves every var) but never appears in `path`/`headers`/`body` as
    // `{{unused}}` — so it must never join the scrub set. Before the fix, an
    // agent could exploit exactly this to confirm a withheld value: chain it
    // into an unused var, then read whether the SAME string comes back
    // `[redacted]` in the next response, with no upstream involvement at all.
    const CANDIDATE = 'tok_unused_value_xyz'
    const { sender, responses } = harness((req) =>
      req.headers['probe'] !== undefined
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ echoed: CANDIDATE })
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ secret: CANDIDATE })
          }
    )
    const first = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!first.ok) throw new Error('expected ok')
    const rid = first.view.responseId

    const second = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: { method: 'GET', path: '/v1/charges', headers: { probe: 'yes' } },
      vars: { unused: { $ref: `${rid}:$['secret']` } as unknown as string }
    })
    if (!second.ok) throw new Error('expected ok')
    expect(responses.pull(second.view.responseId, grant, "$['echoed']")).toEqual({
      ok: true,
      value: CANDIDATE
    })
  })

  it('refuses to chain a null value rather than sending the literal "null" (finding 4)', async () => {
    const { sender, transport } = harness((req): Canned =>
      req.headers['x-auth'] !== undefined
        ? { status: 200, headers: {}, body: '{}' }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ maybe: null })
          }
    )
    const first = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      requestId: 'charges'
    })
    if (!first.ok) throw new Error('expected ok')
    const rid = first.view.responseId

    const second = await sender.send(grant, {
      collectionId: 'stripe',
      varSet: 'test',
      spec: {
        method: 'GET',
        path: '/v1/charges',
        headers: { 'x-auth': { $ref: `${rid}:$['maybe']` } as unknown as string }
      }
    })
    expect(second).toMatchObject({ ok: false, status: 400 })
    // Only the first send ever dialed — the second refused before sending.
    expect(transport.requests).toHaveLength(1)
  })
})
