/**
 * The load-bearing security probes for the agent API client (design §Security &
 * isolation). Each maps to a sentence the project wants to be able to say out
 * loud about the product:
 *
 * 1. The reveal exit (`revealSecret` / `CollectionSecretStore`) is reachable
 *    only from main — no preload or renderer file ever touches it.
 * 2. A credential a hostile server echoes back — in the body, in a header, or
 *    in any encoding — never reaches the agent, whether read as the shape or
 *    pulled by path.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiSender } from '../../src/main/api-client/send'
import { CollectionStore } from '../../src/main/api-client/collection-store'
import { CollectionSecretStore } from '../../src/main/api-client/collection-secrets'
import { ResponseStore } from '../../src/main/api-client/response-store'
import { HttpClient, MockHttpTransport } from '../../src/main/http/http-client'
import type { SecretBackend } from '../../src/main/integrations/credential-store'

// See design §4.4: `pullForChain` is the mechanism these probes exercise —
// chaining deliberately bypasses `pull`'s withheld gate (passing a value
// through is not reading it), while still refusing a container, an unknown
// path, and a foreign-environment response.

// Deliberately NOT a vendor-prefixed literal: `looksLikeSecretLiteral` in
// `http-node-config.ts` would withhold those at the CLASSIFICATION tier
// regardless of whether the ingest-time exact-value `scrub()` ran at all, so
// a prefixed secret would test the classifier, not the scrub. It also carries
// a space, a `+`, and a `!` so the four `scrubForms` encodings — raw, base64,
// `encodeURIComponent`, and true `application/x-www-form-urlencoded` — are
// pairwise distinct: the space becomes `%20` under `encodeURIComponent` but
// `+` under form-encoding, and `!` stays bare under `encodeURIComponent` but
// is percent-encoded under form-encoding. A break in any single encoding
// inside `scrubForms` is therefore individually detectable below.
const SECRET = 'agent secret+value!'

const backend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => Buffer.from(b.toString('utf8'), 'base64').toString('utf8')
}

// Matches the established convention in `tests/unit/integration-secret-safety.test.ts`
// (which asserts the same property for `revealForConnector`): a small PRIVATE
// generator per test file — there is no shared test util — that recurses and
// filters by extension. The extension filter is required: `src/renderer` has
// subdirectories and a non-TS `index.html`.
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) yield full
  }
}

describe('security probe: the reveal exit is main-process-only', () => {
  it('has zero callers in preload or renderer', () => {
    const root = join(__dirname, '..', '..', 'src')
    for (const dir of ['preload', 'renderer']) {
      for (const file of walk(join(root, dir))) {
        const source = readFileSync(file, 'utf8')
        expect(source, `${file} must not reveal plaintext`).not.toContain('revealSecret')
        expect(source, `${file} must not import the secret store`).not.toContain(
          'CollectionSecretStore'
        )
      }
    }
  })
})

describe('security probe: an echoed credential is scrubbed to an exact value', () => {
  // Error-path coverage for the same property lives in `api-send.test.ts`;
  // this file only exercises the shape and `pull`, so the title says just that.
  it('comes back as [redacted], never the raw value, from the shape and every pull', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-sec-'))
    const collections = new CollectionStore({ file: join(dir, 'collections.json') })
    collections.upsert({
      id: 'echo',
      name: 'Echo',
      environment: 1,
      origins: ['https://api.test'],
      auth: { scheme: 'bearer', secretRef: 'apiKey' },
      varSets: { d: { base_url: 'https://api.test' } },
      requests: [{ id: 'r', name: 'r', method: 'GET', path: '/echo' }]
    })
    const secrets = new CollectionSecretStore({ backend, file: join(dir, 'secrets.enc') })
    secrets.set('echo', 'apiKey', SECRET)
    const responses = new ResponseStore({})

    // A deliberately hostile response: it echoes the credential in the body
    // (raw, base64, `encodeURIComponent`, and true
    // `application/x-www-form-urlencoded` via `URLSearchParams` — the four
    // encodings `scrubForms` covers), in a header, and nested inside an array.
    const formEncoded = new URLSearchParams([['x', SECRET]]).toString().slice(2)
    const transport = new MockHttpTransport(() => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-echo': SECRET,
        // I1: the credential reflected as a header NAME, not just a value —
        // the fixture this probe was missing. Before the fix, `ingest` only
        // scrubbed header VALUES, so this key reached the shape verbatim.
        [SECRET]: 'x'
      },
      body: JSON.stringify({
        raw: SECRET,
        b64: Buffer.from(SECRET, 'utf8').toString('base64'),
        url: encodeURIComponent(SECRET),
        form: formEncoded,
        nested: { deep: [SECRET] }
      })
    }))

    const sender = new ApiSender({
      collections,
      secrets,
      client: new HttpClient({ transport }),
      responses
    })
    const grant = { environment: 1, collections: new Set(['echo']) }
    const result = await sender.send(grant, { collectionId: 'echo', varSet: 'd', requestId: 'r' })
    if (!result.ok) throw new Error('expected ok')

    // Structural invariant, not scrub coverage: `ShapeField` carries only
    // `path`/`type`/`size`/`withheld`, never a value, so this can never fail —
    // it documents that the shape itself has no slot for a credential.
    expect(JSON.stringify(result.view)).not.toContain(SECRET)

    // `pull()` no longer serves a container path at all (`$`, `$['nested']`,
    // … are refused with `reason: 'container'`), so the only reachable
    // coverage is the individual leaves. Assert the EXACT redacted value,
    // not merely "does not contain the raw secret": a substring check can
    // never fail for the base64 leaf, since a base64 blob never contains its
    // own input text, scrubbed or not.
    const paths = [
      "$['raw']",
      "$['b64']",
      "$['url']",
      "$['form']",
      "$['nested']['deep'][0]",
      "$headers['x-echo']"
    ]
    for (const path of paths) {
      expect(responses.pull(result.view.responseId, grant, path), path).toEqual({
        ok: true,
        value: '[redacted]'
      })
    }
  })
})

describe('security probe: chaining never reveals the chained value', () => {
  it('a chained token reaches the wire but never the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-chain-'))
    const collections = new CollectionStore({ file: join(dir, 'c.json') })
    collections.upsert({
      id: 'chain',
      name: 'Chain',
      environment: 1,
      origins: ['https://api.test'],
      auth: { scheme: 'none' },
      varSets: { d: { base_url: 'https://api.test' } },
      requests: [{ id: 'r', name: 'r', method: 'GET', path: '/first' }]
    })
    const responses = new ResponseStore({})
    let sentAuth = ''
    const transport = new MockHttpTransport((req) => {
      if (req.url.endsWith('/second')) {
        sentAuth = req.headers['x-auth'] ?? ''
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'tok_chain_secret' })
      }
    })
    const sender = new ApiSender({
      collections,
      secrets: new CollectionSecretStore({ backend, file: join(dir, 's.enc') }),
      client: new HttpClient({ transport }),
      responses
    })
    const grant = { environment: 1, collections: new Set(['chain']) }

    const first = await sender.send(grant, { collectionId: 'chain', varSet: 'd', requestId: 'r' })
    if (!first.ok) throw new Error('first failed')
    const rid = first.view.responseId

    // The agent cannot read it.
    expect(responses.pull(rid, grant, "$['access_token']")).toEqual({
      ok: false,
      reason: 'withheld'
    })
    // But it can chain it.
    const second = await sender.send(grant, {
      collectionId: 'chain',
      varSet: 'd',
      spec: {
        method: 'GET',
        path: '/second',
        headers: { 'x-auth': { $ref: `${rid}:$['access_token']` } as unknown as string }
      }
    })
    if (!second.ok) throw new Error('second failed')

    expect(sentAuth).toBe('tok_chain_secret') // reached the wire
    expect(JSON.stringify(second.view)).not.toContain('tok_chain_secret') // not the agent
    expect(JSON.stringify(first.view)).not.toContain('tok_chain_secret')
  })

  it('a $ref to a foreign-environment response is refused, not silently empty', () => {
    // Ingest a response for environment 2, then attempt to chain it from a
    // grant scoped to environment 1.
    const responses = new ResponseStore({})
    const foreign = responses.ingest({
      environment: 2,
      collectionId: 'chain',
      status: 200,
      durationMs: 1,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: 'tok_foreign' }),
      secrets: []
    })
    expect(
      responses.pullForChain(
        foreign.responseId,
        { environment: 1, collections: new Set(['chain']) },
        "$['access_token']"
      )
    ).toMatchObject({
      ok: false
    })
  })
})
