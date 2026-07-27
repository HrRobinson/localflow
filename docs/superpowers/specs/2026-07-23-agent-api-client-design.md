# Agent-facing API client — design

Decided with Jonas 2026-07-23. Brainstormed from
`docs/superpowers/notes/2026-07-23-agent-api-client-brainstorm-primer.md`, which
this spec supersedes where they differ — notably: rotation is dropped entirely
(§6), saiife environments are **not** Postman environments (§1), and the response
path gets a structural defence rather than an accepted limitation (§4).

## Why

An agent working against an API today needs the credential in its context. Once a
token is in context it is in a transcript, a session file, a provider request, and
eventually a bug report. Rotating it bounds how long a leaked copy stays useful;
it does nothing about the leak.

saiife can do better than any cloud-hosted API client, because the credential and
the agent are on the same machine and saiife owns the boundary between them. The
agent composes requests, sends them, reads results, and iterates — the whole
workflow — and **the credential never enters its context at any point.**

This is not a new discipline for this codebase. It is the one already enforced at
the renderer boundary (`credential-store.ts`: `revealForConnector` is the sole
plaintext exit, main-process-only, with a grep test asserting zero IPC callers)
and already half-built in the HTTP engine (`http-node-config.ts` resolves a
request carrying only a non-secret `secretRef`; `http-connector.ts` applies the
plaintext at call time and nowhere else). This milestone puts an agent-facing
surface on that engine.

## Guiding principle

**One engine, two callers.** The canvas `http` node and the agent API client
resolve, guard, authenticate, and dial through the same code. Two request
pipelines would mean two credential stores, two audit paths, and two places to
fix an SSRF bug.

**Claims map to tests.** Every security sentence in this spec has a test in §13
that fails when the sentence stops being true. Nothing is claimed beyond what is
asserted — see §11 for what this explicitly does *not* guarantee.

## 1. Scope model

Three concepts, deliberately distinct:

- **Environment** (existing, 1–9) — the customer/project container. M3.5 defines
  it as one-per-customer ("9 customers → 9 environments"), and the operator spec
  makes cross-environment isolation load-bearing, enforced in `pane-registry`
  rather than the UI.
- **Collection** (new) — one API. Owns its origins, its auth config, its saved
  requests, and its credentials. **A collection belongs to exactly one
  environment**, so customer A's agent can never send as customer B. A collection
  used across projects is duplicated per environment, which correctly implies
  separate credential entries.
- **varSet** (new) — a named set of substitution variables within a collection
  (`{{base_url}}`, `{{account_id}}`), e.g. `test` vs `live`. This is what Postman
  calls an "environment". **Never call it an environment in code or copy** — the
  word is taken, and the two are different axes: collection `stripe` × varSet
  `live`.

The collection is the unit of three things at once — credential ownership, origin
scope, and grant — because they are the same thing: "you may act as this API's
client." A separately-authored host/method allowlist was considered and rejected:
it is a second artifact that drifts from the collection it describes.

## 2. The agent interface

Constrained composition. The agent may compose **arbitrary** requests, but only
against a collection's declared origins, with credentials by reference. It is not
limited to requests a human pre-saved (too weak to be useful), and it does not get
unbounded reach (that would make the guard a prerequisite rather than an
enhancement).

Routes land in `control-api.ts` alongside the existing operator routes, under the
`/http/*` prefix, authenticated against `ApiGrantStore` (§6).

```
GET  /http/collections
  → { collections: [{ id, name, origins, varSets: [name],
                      requests: [{ id, name, method, path }] }] }
    Only collections in this grant's scope. Never includes a secret,
    a secretRef value, or a collection outside scope.

POST /http/send
  { collectionId, varSet?,
    requestId?,                          // a saved request, or:
    spec?: { method, path, headers?, body?, timeoutMs? },
    vars?: { [name]: string } }          // overrides for this send
  → { responseId, status, durationMs, contentType, truncated, shape }

GET  /http/responses/:id
  → { responseId, status, durationMs, contentType, truncated, shape }

GET  /http/responses/:id/pull?path=$.data[0].id
  → { path, value }        // unclassified scalar
  → 403 + gate            // withheld (§5)
  → 400 container         // resolves to an object/array — pull a leaf (§4.5)
  → 404                   // unknown response, or unknown path
```

`method` is constrained to the existing pinned `HttpMethod`
(`GET|POST|PUT|PATCH|DELETE`, `src/shared/http.ts`). That covers v1; nothing
pinned widens.

Pinned to remove ambiguity:

- **Exactly one** of `requestId` or `spec` is present; both or neither → 400.
- **`origins`** are `scheme://host[:port]` only — no paths, no wildcards in v1.
  Comparison is exact after URL normalisation.
- **`spec.path`** may be either a path (`/v1/charges`), joined to the varSet's
  `base_url`, or a fully-qualified URL. Either way the *resolved* URL must fall
  inside `origins` — the check is on the resolved string, never on the input form.
- **`responseId`** is opaque and environment-scoped. `r3` in these examples is
  illustrative, not a format.

Any string value in `spec`, `headers`, `body`, or `vars` may instead be a
reference to a previous response:

```json
{ "$ref": "r3:$.access_token" }
```

Resolved in the main process at send time (§4).

## 3. The request path

```
POST /http/send
  ↓  request-resolve.ts    collection + varSet + spec + $refs → params   (pure)
  ↓  resolveRequest()      EXISTING, verbatim — validates; rejects secret literals
  ↓  origin check          resolved URL ∈ collection.origins  (AFTER templating)
  ↓  applyAuth()           extracted (§7); secret revealed here, main-only
  ↓  HttpClient.sendRaw()  EXISTING guard: SSRF + DNS-rebind + dial
  ↓  response-store        full body held in main
  → { responseId, status, shape }                              no values
```

Two properties come free from reusing `resolveRequest` verbatim:

- `looksLikeSecretLiteral` (`http-node-config.ts`) already rejects a header value
  that looks like a credential (`Bearer …`, `sk_live_…`, `ghp_…`, …). Written to
  stop a human flow-author pasting a token; it is exactly the check needed when
  the author is an agent.
- Auth intent travels as `{ scheme, header?, secretRef }` and holds no plaintext,
  so nothing between the agent and `applyAuth` can leak a credential it never had.

The **origin check** is new and runs after templating, for the same reason the
SSRF guard does (`http-client.ts` §4.5): a `{{base_url}}` that resolves outside
the collection's origins must be caught on the resolved string, not the template.

## 4. The response model

**A response is a handle the agent operates on, not a payload it receives.**

The full body is held in `response-store.ts` in main memory, scoped to the
environment, size-bounded with LRU eviction. History *metadata* (method, URL,
status, timing, timestamp, collection) persists as the audit trail; **bodies never
persist to disk.** Durable record, ephemeral payload.

### 4.1 Two tiers

- **Scrub — absolute.** The exact value of the credential injected into the
  request, plus its base64 and URL-encoded forms, is replaced with `[redacted]` in
  the stored body at ingest. Not withheld, not gate-able, **unreachable by any
  path**. There is no legitimate reason for an agent to read back the credential
  it just sent. Exact-match, therefore fully testable — this is the tier the
  guarantee rests on.

  Any value resolved from a `$ref` into a request **joins that request's scrub
  set**, so a token chained forward cannot come back in the next response.

- **Withhold — gated.** Fields classified sensitive are visible in the shape,
  chainable by reference, and readable only through the approval gate (§5).

**Accepted, bounded risk: chaining as a confirmation oracle.** Scrub-on-echo (the
"joins that request's scrub set" line above) stops a chained withheld value coming
back in the CLEAR. It does not stop an agent that already has a candidate value
from confirming a guess: chain the candidate into a junk header sent to an
origin the grant already covers, and read whether the field comes back
`[redacted]` in that response — a match confirms the guess without ever
reading the real field through the gate. This is inherent to scrub-on-echo as
the compensating control for `pullForChain` bypassing the withheld gate, not a
bug in it, and it is not fixed here. It is bounded by the field's own entropy
(a UUID-shaped token is not practically guessable this way; a 4-digit PIN is)
and by the fact that the agent must already hold a candidate — the withheld
tier was never a defence against an agent that already knows the value, only
against one that doesn't. Do not claim this closed; it isn't.

**Accepted, bounded risk: echo-laundering.** Any allowance made for a chained
value — including the header guard in `http-node-config.ts` that lets a
`$ref`-derived credential-shaped value through where an agent-authored literal
would be refused — is launderable through an echo: an agent can `POST` its own
literal to any origin the grant already covers that reflects request data back
in its response, then chain that reflected value forward as if it had come
from a trusted upstream. This is inherent to §4.4's ungated chaining (a `$ref`
carries no provenance beyond "some past response in this environment"), it
predates and is untouched by any of the header-guard fixes, and it bounds how
much that guard — or any future one built the same way — can ever be worth.
It is a hygiene tripwire against accidental/incidental hardcoding, not a
containment boundary against a deliberately adversarial agent. Do not
overclaim it.

**Checked and closed: U+200B does not defeat `looksLikeSecretLiteral`'s guard in
practice.** `looksLikeSecretLiteral` trims with `String.prototype.trim()`, which
does not strip U+200B (zero-width space, category Cf, not Zs), so a header value
of `'​sk_live_STOLEN'` slips past the predicate's `^`-anchored checks; the
open question was whether that value ever reaches the wire through the real
transport. It does not: verified empirically against a real loopback
`node:http` server through the real `FetchHttpTransport` (`http-client.ts`), the
WHATWG `Headers` implementation requires every header name/value to be
ByteString-convertible (code points ≤ 255), and U+200B is 0x200B, so `fetch()`
throws before a socket ever opens — for both a header value and a header name.
Not exploitable; no code change made.

**Accepted, bounded risk: the one-bit prefix oracle.** With a non-benign
authored remainder and a leading chained span — e.g. header `'{{t}}X'` — whether
the send is refused now depends on the *chained* value: `t = sk_live_CHAINED_REAL`
is refused, `t = ordinary_value` is allowed. That tells the agent one bit —
whether a withheld chained value matches the `looksLikeSecretLiteral` table —
before any dial, without the agent ever holding the value itself. It is bounded:
one bit, from a fixed 8-entry table, about a value the agent already knows is
sensitive (it chose to chain a *withheld* field); and §4.2 rule 3 means many
fields are withheld *because* they match that same table, so the agent often
already knows the answer this oracle would give. The obvious fix — refuse
unconditionally whenever a header has any ref contribution plus a non-benign
remainder — was considered and rejected: it costs the legitimate, common
`v1-{{t}}` pattern (a literal version prefix concatenated with a chained key),
which is worth more than closing a one-bit leak about a value the agent already
suspects. Documented, not fixed.

### 4.2 Classification

`response-shape.ts`, pure and table-driven:

1. Header names: `set-cookie`, `authorization`, `proxy-authorization`.
2. Key names matching
   `token|secret|password|credential|api[_-]?key|private[_-]?key|client[_-]?secret|refresh|session|signature`.
3. Values matching **the same prefix table `looksLikeSecretLiteral` uses**
   (`http-node-config.ts`). One table, one place to add a vendor prefix, both
   directions covered.

### 4.3 The shape

```
r3  200  312ms  application/json
$.data                    array[3]
$.data[*].id              string(24)
$.data[*].amount          number
$.data[*].created         number
$.access_token            string(64)  [withheld]
```

Paths, types, and sizes — never values. Homogeneous arrays collapse to `[*]`,
which is most of the token saving. A non-JSON body is modelled as a single field
`$` of type `string(N)`, so one uniform model covers every content type. An
over-cap body is stored truncated and **marked truncated in the shape**, never
silently.

Three rules below were added during implementation, each after review found a
concrete leak in the design as originally written. They are load-bearing, not
polish:

- **Object keys are classified before they enter a path.** A path is built by
  concatenating keys, so a secret-shaped *key* is a full literal-text leak —
  strictly worse than a missed *value*, which only ever costs a type/size hint.
  A key matching `looksLikeSecretLiteral`, the sensitive-key-name pattern, or
  (response side only) `looksLikeOpaqueKey` is emitted as `<redacted:N>` (N =
  its index within its parent), marked withheld, and not descended into.
  Withholding the whole parent was rejected: one odd key would erase an entire
  map's shape. The vendor-prefix **table** behind `looksLikeSecretLiteral` is
  shared between the request and response sides — one place to add a vendor
  prefix, both directions covered — but the response-side key **predicate**
  additionally runs `looksLikeOpaqueKey` (JWTs, AWS access key ids, long
  hex/base64 blobs, bare UUIDs), which has no request-side counterpart and
  must not be merged into one predicate: a false positive on the request side
  blocks a header a human or agent wrote (loud, recoverable), while a false
  negative on the response side writes a remote-controlled key verbatim into
  untrusted agent context, so the two sides deliberately carry different risk
  tolerances.
- **A collapsed array is classified from every element, not the first.** The
  shape walks `value[0]` to build the `[*]` subtree, but classification scans all
  elements and forces `withheld` onto the collapsed leaves if any element would
  classify. Otherwise `[{"n":"hi"},{"n":"sk_live_…"}]` shapes `$.data[*].n` as
  ordinary and the second element is readable.
- **The walk is depth-capped.** Recursion stops at a fixed depth and marks the
  node `truncated`, rather than exhausting the stack partway through and leaving
  a half-built shape. The JSON-parse failure path builds a fresh result, never
  appending onto a partial one.

### 4.4a Path segments are unquoted — a layer-4 prerequisite

The path grammar (`.`, `[N]`, `[*]`, `<redacted:N>`) is unescaped over an
alphabet the **remote fully controls**, so ambiguous paths are constructible: a
literal key containing a dot collides with a nested path (`{"a.b":x}` and
`{"a":{"b":y}}` both yield `$.a.b`), and a remote once impersonated the
`<redacted:N>` token itself to read the value behind a real redaction.

Two defences make this safe *at this layer*: `findField` prefers the withheld
entry, so ambiguity fails closed whatever caused it; and `pull` returns scalars
only (§4.5). Both were verified against tokens that were never specifically
patched.

**Neither survives layer 4.** A `$ref` deliberately targets withheld fields, so
"prefer withheld" stops disambiguating, and the chained value may not be the one
the agent named — while a path becomes load-bearing for a *write into a new
request*. The fix is to quote segments in JSONPath bracket-string form
(`$['a.b']`, `$['<redacted:1>']`), which makes every path a unique address by
construction and demotes both current defences to belt-and-braces. It changes the
agent-facing path syntax, so it belongs at the **head of the layer-4 plan**, not
bolted on afterwards.

### 4.5 `pull` returns scalars only

The withheld tier is enforced per field, so any read that returns a **subtree**
bypasses it wholesale — a container's own shape entry is deliberately not
withheld (one sensitive child must not blank out the object's shape), so
`pull('$.profile')` would hand back a withheld `$.profile.token` inside it, and
`pull('$')` would return the entire body.

Therefore a pull resolving to an object or an array is **refused**, with a
distinct `container` reason and a 400 that tells the caller to read the shape and
pull a leaf path instead. `$` on a non-JSON body remains readable, because there
it *is* a scalar — the shape models it as a single string field.

This is a structural fix rather than a per-case one: there is no recursive
redaction to get subtly wrong, and no bulk-read path left to audit. It also
matches how the surface was always meant to be used — read the shape, then pull
the values you need.

### 4.4 Why this is better UX, not a security tax

- Iterating on a request — most of the work — needs the *shape*, not the values.
  A 404's shape tells you what you got wrong without burning 40KB of JSON.
- **Chaining works by reference.** Passing a value through is not reading it, so a
  withheld field can be chained **without the gate**. The canonical flow
  (authenticate → use the token → call the API) never prompts anyone, and the
  agent orchestrates it without ever seeing the token.

**Chaining is scoped by environment, not by collection — deliberately.** Decided
with Jonas 2026-07-24, after a review flagged it: with a grant over
`{stripe, internal}`, a withheld token from the internal auth API *can* be chained
into a request to `api.stripe.com`. That is the point of granting a collection
**set** — "get a token from the auth service, then call the API" is itself a
cross-collection flow, and refusing it would force unrelated origins to be merged
into one collection to work around the restriction.

The accepted risk, stated plainly: any collection in a grant is a possible sink
for another collection's withheld values. It is bounded — every origin involved
was curated and granted by the human, and the scrub set still stops the value
coming *back* — but the outbound path is open by design. **Do not "fix" this by
requiring a collection match**; that would break the canonical flow. If it ever
needs narrowing, audit the crossing rather than forbid it.
- Agents drowning in raw API JSON is a real and universal problem. Solving it
  happens to also be the security story.

## 5. The approval gate

A pull of a withheld field routes to an approval prompt showing the pane, the
collection, the request, the path, and the value's **type and length** — never the
value. Approve or deny.

- Approval covers that exact `(responseId, path)` pair — a retry does not
  re-prompt, a fresh response does.
- Every decision lands in `guard-audit.jsonl` with `--audit-tag <paneId>`, reusing
  the per-pane attribution that already exists for guard decisions.
- Unanswered on timeout → deny, recorded as a denial.
- A denial names the alternative: *"denied; you can chain this field by reference
  without reading it"* — pointing the agent at the legitimate path instead of
  dead-ending it.

The gate keeps the default guarantee true while making the human the one who
breaks it, deliberately and on the record. Because chaining is ungated, it stays
rare.

## 6. Grant lifecycle

Rotation is **dropped**. The primer proposed a 12-hour rotating hash; once the
agent holds nothing that dereferences to a secret, a clock defends against almost
nothing:

- A leaked handle reused later — real, but the session boundary closes it more
  precisely.
- **Confused deputy** (agent reads a malicious file and is induced to call the
  proxy) — a shorter timer is *zero* defence; the attack happens inside the live
  window. Only origin scoping and the gate touch this.
- Long-lived ambient authority — real, and addressed by session binding.

**The grant's lifetime is the session that holds it.** No clock, no grace window,
no renewal handshake, no mid-task failure at hour 12. The claim becomes *"the
exposure window is the agent session, and you can end it at any moment"* — sharper
than a rotation interval and true by construction.

> **Not yet true.** Today the grant is in-memory and dies on a process restart,
> but NOT when the holding pane/session exits — binding the grant to the
> session's own lifecycle needs a hook this branch doesn't add. Session binding
> lands in the follow-on plan; until then the claim above is the design intent,
> not a tested guarantee.

Posture mirrors the operator grant (*"opt-in, consent-gated, revocable, and always
visibly indicated"*):

- Granting is a per-environment action naming a **collection set** — "let an agent
  in this environment send as `stripe-test` and `internal-api`", not "let an agent
  make HTTP calls".
- In-memory; does not survive a restart, matching `OperatorGrantStore`.
- Revocation is instant — the token stops resolving on the next request.
- A visible indicator on the environment whenever an API grant is live.

**`ApiGrantStore` is separate from `OperatorGrantStore`, with separate tokens.**
Hanging collection scope on the existing grant would silently give every operator
grant API-send capability. `control-api.ts` already refuses that kind of quiet
widening (see the `OPERATOR_TERMINAL_AGENTS` rationale). `/http/*` authenticates
against `ApiGrantStore`; existing routes against `OperatorGrantStore`; **no token
grants both.** A pane may hold both, granted and revoked separately.

## 7. Reuse, and the two refactors it needs

**Extract `applyAuth`.** Currently private on `HttpConnector`
(`http-connector.ts`). Move to `src/main/http/apply-auth.ts` as
`applyAuth(request, secret)`, with the *reveal* staying at the caller so each
caller owns its keyspace: the connector reveals via `HttpTokenStore(nodeId)`, the
API client via `CollectionSecrets(collectionId)`. One auth code path, two owners,
one place to fix an auth bug.

**Add `HttpClient.sendRaw()`.** `HttpClient.send()` rejects on any non-2xx and
embeds a 500-character body excerpt in the error message (`http-client.ts`).
Correct for the canvas connector — a failed call should fail the node loudly —
and wrong here twice over: a 404 is a normal, informative result an agent must
iterate on, and **the body excerpt would route raw response content into an error
string, bypassing the shape/withhold model entirely.** `sendRaw()` returns
`HttpRawResponse` for any status; `send()` is left exactly as it is for the
connector that depends on it. The API client uses `sendRaw` and classifies every
status uniformly.

**Collection secrets get a dedicated store, not the `http` keyspace and not a new
`IntegrationId`.** Reusing `http` would put collection secrets and canvas-node
secrets in one namespace, where a collection named `orders` collides with a node
named `orders`. Adding an `IntegrationId` would leak a non-integration into
descriptor/registry enumeration.

`hosted-token-store.ts` already establishes the pattern for exactly this case —
*"its OWN tiny store (not `CredentialStore`) so `IntegrationId` stays clean —
'hosted' is not an integration and must not leak into descriptor/registry
enumeration"*. `CollectionSecretStore` follows it: its own `safeStorage`-encrypted
sidecar file, the same injected `SecretBackend` seam, atomic temp+rename writes,
one main-process-only `revealSecret` exit, and the same legible
availability/decrypt errors that never render a value. A separate file makes
collision with the `http` keyspace structurally impossible rather than carefully
avoided.

## 8. The human surface

Deliberately small for v1:

- Curate collections — origins, auth config (scheme + secretRef), saved requests,
  varSets.
- Enter credentials (presence-only in the renderer, per `CredentialStore`).
- Read full responses, unredacted, always.
- Approve/deny gate prompts.
- Grant/revoke per environment, with the visible indicator.

Sends the agent makes appear in the **existing operator cockpit action log** —
not a second log view.

## Components / file structure

**Main — new (`src/main/api-client/`):**

- `collection-store.ts` — non-secret collection data in userData: environment,
  origins, auth config, saved requests, varSets.
- `collection-secrets.ts` — `CollectionSecretStore`, a dedicated keychain store
  on the `hosted-token-store.ts` pattern (§7). Its own sidecar file; `revealSecret`
  is the sole plaintext exit, main-process-only.
- `request-resolve.ts` — pure: collection + varSet + spec + `$ref`s → params for
  `resolveRequest`; plus the origin check.
- `response-store.ts` — full bodies, main-only, environment-scoped, LRU-bounded;
  ingest applies the scrub set.
- `response-shape.ts` — pure: body → shape descriptor + withheld-field set.
- `redact.ts` — pure: exact-value scrub (raw, base64, URL-encoded).
- `send.ts` — orchestration.
- `api-grant.ts` — `ApiGrantStore`: mint, resolve constant-time, revoke,
  collection scope.

**Main — changed:**

- `src/main/http/apply-auth.ts` — extracted from `http-connector.ts` (§7).
- `src/main/http/http-client.ts` — `sendRaw()` added; `send()` unchanged.
- `src/main/control-api.ts` — the `/http/*` route block.

**Renderer:** collection curation, credential entry, response viewer, gate prompt,
grant toggle + indicator.

## Error handling

- **No grant / revoked mid-send** → 403, same shape as the existing control API.
- **Collection out of grant scope** → 403 with *identical wording* whether it does
  not exist or is out of scope — never leak a foreign collection's existence
  (mirrors the `unknown group` handling in `control-api.ts`).
- **URL outside the collection's origins** → 400 naming the allowed origins.
- **Secret literal in an agent-authored header** → rejected by the existing
  `looksLikeSecretLiteral`, told to use a ref.
- **Private/loopback/metadata target** → the existing SSRF guard message,
  unchanged.
- **Missing or undecryptable credential** → the existing `CredentialStore` wording
  ("re-enter it"), never ciphertext.
- **`$ref` to an unknown, evicted, or foreign-environment response** → 404, "no
  longer held, re-send" — honest, never a silent empty substitution.
- **Response evicted before a pull** → 404, same wording.
- **Gate denied** → 403 naming the chain-by-reference alternative.
- **Gate unanswered** → deny on timeout, recorded as a denial.
- **Oversized response** → stored truncated, marked truncated in the shape.
- **Remote non-2xx** → a normal result carrying status + shape, never an
  exception, never a body excerpt in an error string.

## Security & isolation

- **The credential never enters the agent's context.** The agent names a
  `secretRef`; plaintext materialises only in `applyAuth`, main-process-only, at
  call time.
- **The credential cannot come back.** Exact-value scrub at response ingest,
  including chained values.
- **Environment isolation.** Collections and responses are environment-owned; a
  grant on A cannot reach B, enforced in the store, not the UI.
- **Origin scoping.** Every resolved URL must fall inside the collection's
  declared origins, checked after templating.
- **Capability separation.** Operator and API grants are distinct tokens; neither
  authenticates the other's routes.
- **Session-bound, instantly revocable, visibly indicated.**
- **Auditable.** Every send in the cockpit log and history; every gate decision in
  `guard-audit.jsonl` with pane attribution.

## Out of scope (v1, YAGNI)

- **An HTTP rule pack for `saiifeguard`** — adjudicating `DELETE` against a
  production host, or writes to money endpoints, the way it adjudicates shell.
  Likely the most differentiating idea in the whole area, which is exactly why it
  deserves its own spec rather than being smuggled into this one. The gate
  machinery reused in §5 is the groundwork.
- Mocking, monitors, test scripting, codegen, team sync.
- Response summarisation by a model in the main process (a different trust
  boundary, and a different product).
- Idle-based grant expiry — defer until there is a reason for it.
- OAuth flows, cookie jars, multipart/file upload bodies, streaming responses.
- `HEAD`/`OPTIONS` — outside the pinned `HttpMethod`.

## What this does NOT guarantee

Stated plainly, because §Guiding principle forbids claiming past the tests:

**A brand-new secret in an unremarkable-looking field the agent deliberately pulls
is not structurally prevented.** If an API returns a session key under
`data.attributes.value`, classification will not flag it and the agent may pull it
(through the gate). Per-collection annotation narrows this; nothing closes it.

The guarantee is about **the credential**, and it is absolute. It is not "no
sensitive data ever reaches the agent" — that claim is not checkable, and the
withhold tier is defence in depth, not a proof.

**Also:** the README's "No telemetry. Nothing leaves your machine." (line 26)
needs a qualifier before this ships. These are the user's own deliberate API
calls, not telemetry, but the sentence as written is falsified by an API client.

## Build order

Each layer is shippable and testable before the next.

1. **Collections** — `collection-store`, `collection-secrets`, curation UI,
   credential entry. No agent surface yet.
2. **Grant** — `ApiGrantStore`, grant/revoke, visible indicator. Capability
   exists; no routes yet.
3. **Send** — `request-resolve`, origin check, `apply-auth` extraction,
   `sendRaw`, `response-store`, `response-shape`, `/http/send`, `/http/responses`,
   `/http/collections`. Withheld pulls **hard-refuse** at this layer — a safe
   intermediate.
4. **Chaining** — `$ref` resolution, chained values joining the scrub set.
5. **Gate** — the approval gate replaces the hard refuse; cockpit log + history.

## Testing

**Unit:** var and `$ref` resolution; the origin check in and out of bounds; shape
emission, array collapsing, non-JSON as `$`, truncation marking; each
classification rule; exact-value scrub across raw/base64/URL-encoded forms; grant
constant-time resolve, revocation, and collection scoping; collection keyspace
separation from `http`.

**e2e** via `MockHttpTransport` — no real sockets, matching the existing
convention: full send → shape → pull → chain; an auth-then-call chain where the
token is never pulled; gate approve and gate deny.

**Security probes:**

- A **grep test** that `collection-secrets`' reveal path has zero IPC/renderer
  callers, mirroring the existing `revealForConnector` test.
- Against a canned response that **deliberately echoes the injected credential**:
  it appears in none of the shape, any pull result, any error message, the history
  record, or the cockpit log.
- An agent-authored `Authorization: Bearer sk_live_…` header is rejected.
- A grant on environment A cannot send in an environment-B collection, nor `$ref`
  an environment-B response.
- A non-2xx body reaches the agent only through the shape model.
- An operator token cannot authenticate `/http/*`; an API token cannot
  authenticate `/panes`.

## Open questions / seams

Design-stable regardless of resolution; confirm during planning.

- The gate's timeout value, aligned to whatever convention the existing approval
  gates already use.
- Response-store bounds — per-environment count cap vs total byte cap, and the
  truncation threshold.
- Whether `looksLikeSecretLiteral`'s prefix table moves to a shared module now
  that §4.2 is a second consumer, or is imported from `http-node-config.ts`
  as-is.
- The exact README wording fix (§What this does NOT guarantee).
