# Final whole-feature review — agent API client

Reviewed 2026-07-24 against `83fec79..53446aa` (115 commits, API-client scoped).
**Verdict: Needs fixes before merge.** 2 Critical, 4 Important.

All Criticals/Importants below were CONFIRMED with executed probes (real
`ApiSender`, `ResponseStore`, `handleRequest`, `HttpConnector`, real
`FetchHttpTransport` with only DNS stubbed). None were on the prior backlog.

---

## C1 — withheld gate bypassable via the transport error string

`src/main/http/http-client.ts:136-140` + `src/main/api-client/send.ts:130-135`

`sendRaw` does `const code = err.code ?? err.message` and splices it into the
returned error. `ApiSender.send` returns it verbatim; `control-api.ts:256` hands
it to the agent. **No error string in `ApiSender` passes through `scrub()`** —
though the scrub set (`scrubForms(secret)` + `chainScrubCandidates(refValues)`)
is in hand at that point.

`undici`'s `Headers.append` embeds the entire header value in its TypeError when
the value contains an embedded LF or NUL. (Trailing LF/CR, TAB and DEL are
accepted; embedded LF and NUL reject *with the value in the message*.)

Confirmed: upstream returns a `private_key` PEM. Shape marks it `withheld`.
`pull` → `{ok:false, reason:'withheld'}`. Then chaining it into a header:

    spec.headers = { "x-probe": { "$ref": "<rid>:$['private_key']" } }
    → {"ok":false,"status":502,"error":"Couldn't reach api.example.com
       (Headers.append: \"-----BEGIN PRIVATE KEY-----\nMIIEvQ…-STOLEN-PEM-MARKER
       \n-----END PRIVATE KEY-----\" is an invalid header value.) — check the URL…"}

Agent reads a withheld field in the clear: no gate, no audit signal, no upstream
cooperation. Any withheld value containing a newline is exposed (PEM keys,
multi-line descriptions). Same path leaks the collection credential if a stored
secret contains an embedded LF/NUL — lower reachability (the `<input>` strips
CR/LF on paste), but `apiClient:setCollectionSecret` (`index.ts:1944-1959`) does
no character validation.

**Why green:** `tests/unit/api-send.test.ts:219-230` forces a synthetic
`ECONNREFUSED` through `MockHttpTransport`, which never validates headers — the
only leaking path is never entered.

**Fix:** in `sendRaw` never interpolate `err.message` for a transport failure
(use `err.code` or a fixed string). Belt-and-braces: run every error string
`ApiSender.send` returns through `scrub()`. Test with the REAL
`FetchHttpTransport` and a control-char-bearing value; assert the rejection
contains neither the value nor `Headers.append`.

## C2 — responses outlive their grant, readable across collection scope

`src/main/api-client/response-store.ts:195-198`, `src/main/index.ts:1245-1248`

`resolve` checks **only `environment`**, never `grant.collections`.
`IngestInput.collectionId` (`response-store.ts:22`) is accepted then **dropped** —
`StoredResponse` (`:46-57`) has no such field. `revokeApiAccess` revokes the token
and unbinds the pane but never touches the store; `ResponseStore` has no clear
method at all.

Confirmed. Env 1, collections `payroll` and `weather`:

1. Agent 1 (granted `{payroll}`) sends → response holds `salary: 123456` and a
   withheld `access_token: 'sk_live_payrolltoken'`.
2. Human grants agent 2 `{weather}` — `grantApiAccess` revokes then re-mints, i.e.
   the grant *moves*. This is the documented normal workflow, not an edge case.
3. Agent 2 (cannot see `payroll` in `GET /http/collections`):
   - `GET /http/responses/<rid>` → **200**, full shape of payroll's response
   - `pull $['salary']` → **200, `123456`**
   - chains `$['access_token']` into a header to `https://weather.test`
     → **header arrived as `sk_live_payrolltoken`**

Breaks "Revocation is instant" and the §6 exposure-window claim, and breaks the
collection boundary in a way §4.4 never sanctioned — §4.4 allows cross-collection
chaining *within one grant*, not across grants.

**Fix:** store `collectionId` on `StoredResponse`; filter `view`/`pull`/
`pullForChain` by `grant.collections.has(stored.collectionId)` in addition to
environment. Preserves §4.4 exactly. Add `ResponseStore.clearEnvironment(env)`
called from `revokeApiAccess` as defence in depth.

---

## I1 — response header NAMES bypass both scrub and classifier

`response-store.ts:86-89`, `response-shape.ts:255-264`

`ingest` does `headers[k.toLowerCase()] = scrub(v, secrets)` — value scrubbed, key
never. `shapeOf`'s header loop writes every header name verbatim into a shape path
via `appendKey(HEADERS_ROOT, lower)`, with no `looksLikeSecretLiteral` /
`looksLikeOpaqueKey` check — unlike `walk`, where a credential-shaped body key is
redacted to `<redacted:N>` because a secret-shaped key is a full literal-text leak
(spec §4.3).

Confirmed: upstream reflects the received API key as a response header name →
`{"path":"$headers['sk_live_stolencred12345']","type":"string","size":1}` in the
shape handed to the agent. Falsifies §4.1's "unreachable by any path" and §13's
"it appears in none of the shape". Also an unclassified channel for arbitrary
remote-controlled text into agent context. (Names are lowercased at ingest, so a
mixed-case credential is mangled but still strongly leaked.)

**Fix:** scrub the key as well as the value in `ingest`; run `walk`'s key predicate
over header names in `shapeOf`, emitting `<redacted:N>` + `withheld`. The probe at
`tests/unit/api-client-security.test.ts:128` is neutered by its fixture
(`headers: {'x-echo': SECRET}` — value, not name); adding `[SECRET]: 'x'` turns a
vacuous assertion into a failing one.

## I2 — three IPC handlers have no environment scope

`src/main/index.ts:1927`, `:1942`, `:1962`; `collection-store.ts:37`

`removeCollection`, `setCollectionSecret`, `clearCollectionSecret` take no
`environment`; main enforces the boundary nowhere else. `apiSecrets.set/clear`
don't even check the collection exists. A renderer scoped to env 1 can delete an
env-5 collection, overwrite an env-5 credential (integrity, not confidentiality),
wipe every credential, or write an orphan ciphertext under an unenumerable id.

`CollectionStore`'s class doc says the guarantee is "enforced in the store rather
than the UI"; `get`/`list` honour it, `remove` does not. `upsertCollection`
(`:1900-1925`) gets it right — `apiCollections.get(raw.id, env)`, foreign id mints
a fresh UUID — and is the pattern to copy.

Not remotely reachable today (the renderer isn't an attack surface here), but the
spec makes store-level enforcement load-bearing and `collection-store.test.ts:50-55`
is single-environment, so nothing pins it.

## I3 — deleting a collection orphans its credential ciphertext forever

`src/main/index.ts:1938`

`removeCollection` calls `apiCollections.remove(id)` and never `apiSecrets.clear(id)`.
Ids are `randomUUID()` and never reused, so the encrypted key in
`userData/api-secrets.enc` becomes permanently unreachable (`has`, `clear`,
`revealSecret` all need the id). The user believes deletion removed the credential;
it stays on disk indefinitely. The e2e (`api-client.spec.ts:110-124`) clears the
secret first, then removes — walking around the case.

## I4 — moving a pane between environments keeps its API grant, invisibly

`src/main/index.ts:1450-1452`, `session-manager.ts` `setEnvironment`, reconciliation
at `index.ts:1337-1343`

`session:setEnvironment` mutates `rec.info.environment` (and every member of the
pane's group) and touches neither `apiGrants` nor `apiGrantBinding`. Reconciliation
only asks whether the bound pane id is still in `manager.list()` — it is — so nothing
revokes. The live pty keeps `SAIIFE_API_TOKEN`; `ApiGrantStore.resolve` still returns
the old environment and the send is scoped off that. Env B's Cockpit shows "No API
grant" and no `data-api-granted` dot, while a pane visibly in env B is an active API
client for env A's collections and credentials. Breaks §6's "always visibly
indicated". `setEnvironment` moves whole groups, so this can fire for panes the user
did not individually move.

**Fix:** revoke in the `session:setEnvironment` handler when a moved pane holds a
grant. Re-minting for the new environment is NOT correct — different scope, silent
re-grant would surprise.

---

## Minor

1. **Template lookup falls through to `Object.prototype`** — `request-resolve.ts:48-58`.
   `{{constructor}}` substitutes `function Object() { [native code] }`,
   `{{__proto__}}` → `[object Object]`. CONFIRMED. Violates "an unknown variable is a
   LOUD throw". No secret exposure (`elidedVars` inherits identically, so no guard
   bypass). Fix: `Object.prototype.hasOwnProperty.call(vars, name)` or a null-prototype map.
2. **Response eviction is global, not per-environment** — `response-store.ts:105-109`.
   CONFIRMED: 3 sends in env 1 evict env 2's response at `maxEntries: 3`. Availability
   only.
3. **`__proto__` body/var key silently dropped** — `request-resolve.ts:209-214`, `:176-188`.
   CONFIRMED. Header keys fail *loud* (`:402-407`); body and var keys fail *silent*.
4. **Spec drift** (accepted-risk paragraphs themselves verified accurate, incl. the
   U+200B closure reproducing the `>255 ByteString` rejection):
   - §4.1 "**Any** value resolved from a `$ref` … joins that request's scrub set" —
     code scrubs only *withheld* values that actually reached the wire.
   - §4 "LRU eviction" — code is explicitly FIFO and says so.
   - §4 history metadata listing "URL" — nothing persists yet, and `control-api.ts:250-255`
     deliberately omits the URL.
   - `SKILL.md` "The chained value is also scrubbed from the response that comes back" —
     withheld ones only.
5. `saiife-api.mjs` — `response`/`pull` interpolate `responseId` without
   `encodeURIComponent`. Agent-supplied, no boundary crossed; inconsistent with the
   neighbouring `path` param.
6. `api-collections.json` validation permits `http://` origins even when `allowLocal`
   is false, so the send fails later at the SSRF guard rather than at curation.
7. Uncommitted `package-lock.json` — 12 unrelated `libc` field deletions from an npm
   version difference. Revert before merge.

## Test quality (beyond the fixtures hiding C1 and I1)

- `api-client-routes.test.ts:87-93` — `'lists only in-scope collections'` never inspects
  `res.json.collections`. One collection, in env 1, in scope → neither `.list(environment)`
  nor the grant filter is exercised negatively. A route returning every collection in every
  environment passes.
- `api-request-resolve.test.ts:220` — `expect(params.timeoutMs).toBeLessThan(999_999_999)`
  where `MAX_TIMEOUT_MS` is `120_000`. Passes for a clamp that isn't one.
- `api-send.test.ts:340` — `'…and scrubs it from the next response'` asserts only
  `JSON.stringify(second.view).not.toContain(…)`, and `ResponseView` has no value slot.
  The fixture echoes the header back and never reads it. Same at
  `api-client-security.test.ts:209-210`, `api-client.spec.ts:370`.
- `api-client-ui.spec.ts:69` — "Value must never appear in the DOM" via `innerText()`,
  which never includes an `<input>` value, on a `type="password"` field whose value is
  React state. Cannot detect the regression it names; assert `.api-secret` count 0 or
  `inputValue() === ''`.
- `collection-validate.test.ts:137-138` — needle `'sk_'` never appears in the input, and
  `Collection` has no `secret` key. Entirely vacuous.
- The wider `JSON.stringify(view|shape).not.toContain(<value>)` family is documentation,
  not coverage. Sibling assertions using an object **key** as the needle ARE real, because
  keys reach the path — those are the model.
- The `tok_…` fixtures previously flagged are fine now: in every surviving case the field
  is withheld via the `SENSITIVE_KEY` name rule and the tests say so.

## Cleared, with what was run

- **Environment isolation across `/http/*`** — grant on env 1 with deliberately over-broad
  scope `{envA, envB}`: send to env-2 collection → 403 `unknown collection`;
  `GET /http/collections` returns env-1 only; view/pull of an env-2 response → 404; `$ref`
  to it → 400 "no longer held, re-send". All four correct.
- **Token separation** — API token on `/panes` → 403; operator token on `/http/collections`
  → 403. Neither store resolves the other's token.
- **Origin allowlist** — 12 cases correct: default-port normalisation, host case, trailing
  dot (fails closed), Cyrillic homograph, suffix `api.test.evil.com`, userinfo both
  positions, scheme mismatch, port mismatch, tab/newline smuggling. Both sides go through
  WHATWG `URL`, so the origin check and `fetch` can't disagree.
- **Flow-node path unweakened** — hardcoded `Bearer sk_live_…` in a canvas node still
  refused; `elidedHeaderValues` smuggled through `params` has no effect (explicit third
  parameter); connector still refuses `169.254.169.254` with zero socket attempts;
  `guardUrl` still blocks loopback/`::1`/metadata without `allowLocal`. `send()` semantics
  byte-identical for the connector.
- **`allowLocal` not agent-reachable** — `spec.allowLocal: true` ignored; `params` built
  fresh from `collection.allowLocal === true`.
- **Credential echo in body** — raw, base64, `encodeURIComponent`, form-encoded, as a body
  key, and in a `text/plain` `$` — all `[redacted]`.
- **Renderer/preload** — one `contextBridge.exposeInMainWorld`, no generic `invoke`
  passthrough, eight named channels. No handler returns credential or token material;
  `grantApiAccess` returns `{ok, endpoint, paneId}` and the token goes only into
  `updateSpecEnv`, not persisted (`persistence.ts` doesn't serialise `spec.env`).
  `revealSecret` has exactly one caller. Renderer holds the credential only in write-only
  `SecretField` state.
- **Grant/revoke on pane deletion correct** — `bind` precedes the close; `closeTerminal`
  retains the session record so `grantApiAccess`'s own close+restart doesn't self-revoke;
  `deleteSession` removes from the map before firing; restart-failure path revokes AND
  unbinds. No path mints without binding or unbinds without revoking.
- **README §26** — the qualifier the engine spec required before shipping is in place.

## Backlog triage

`progress.md` holds no ~10-Minor list. Two genuinely open items, neither blocking:
- `parsePath` accepts `$[01]` (leading-zero index) though `appendIndex` never emits it.
  Strictness gap; `collapseIndices`/`findField` normalise it.
- Known flake `api-client-ui.spec.ts:29` under concurrent load. (Line 69 in the same file
  should be strengthened regardless — see test quality.)

Wave-5's three Minors are handled in `3e087c5`, `52fc571`, `03aee9b`; the U+200B one was
re-verified empirically.

**Nothing in the backlog blocks merge. C1, C2, I1–I4 do.**
