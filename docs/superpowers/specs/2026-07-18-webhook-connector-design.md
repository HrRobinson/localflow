# Generic HTTP / Incoming-Webhook Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Feasibility is **done** (Track A §2,
Track C §4). This is the escape-hatch connector: the catch-all that wires **any**
system with **no bespoke connector**.
**Feature:** A single `http` connector that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`, exposing **two generic actions** — `http.get` (read) and
`http.send` (gated write) — and **one generic trigger** — `webhook.received`. It
lets a flow author reach, or be woken by, **any** system that speaks HTTP:
Stripe, GitHub, Notion, Airtable, Sentry, Datadog, a home-grown internal service,
or — the strategic case — an **n8n / Zapier / Make** workflow. It hardcodes no
vendor: the URL, method, headers, secret, verifier, and inbound path are **per
flow node**, resolved at run time.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`LiveConnector` / `registerConnector` contract in `src/shared/integrations.ts`
and copies the module shape of `src/main/shopify/` (descriptor-as-code,
CredentialStore keychain, presence-derived `status()`, a mocked transport seam).
It reuses the Shopify / Linear connector specs
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`,
`docs/superpowers/specs/2026-07-16-linear-integration-design.md`) as its style
and depth template.

**The one place this connector is different from every fixed-vendor connector,
stated up front.** Shopify/Linear/email/cloud each own a *single* config block
keyed by their `IntegrationId` (`config.json` + one keychain namespace). The
generic HTTP connector cannot: one flow may POST to a Slack relay, GET from a
GitHub API, and receive from a Stripe webhook — three URLs, three secrets, three
verifiers — all under the one `http` id. So its operative config lives **per flow
node** (`FlowNode.config`, which already exists — `src/shared/flows.ts:13-18`),
not per integration. This spec's central design work is the **single-`http`-id,
per-node-config** shape that stays byte-for-byte inside the pinned contract (§4,
§6, §7), and the keychain-key extension it forces (§7).

**A note on ownership.** This spec **owns and pins the generic-HTTP vocabulary**
(§6: the `IntegrationId` addition, the two actions, the one trigger, the
per-node `config` shape, and the context-field shapes). It **consumes** two
sibling-owned shared-infra modules verbatim and does not design their internals:
the **parameterized webhook receiver** `src/main/webhooks/webhook-receiver.ts`
(the `WebhookVerifier` shape, §6.4) and the **shared SSRF guard**
`src/main/net/ssrf-guard.ts` (§4.5). Where a sibling owns a shape, this spec
**names the dependency and stops**.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user, on the canvas, (a) call **any**
HTTP endpoint from a flow — templating the URL / headers / body from run context,
with the auth secret in the OS keychain and the URL forced through the shared
SSRF guard — and (b) wake a flow when **any** external system POSTs to a
per-flow, signed, unguessable webhook URL — so that **n8n / Zapier / Make and the
entire long tail of REST-and-webhook systems are reachable with zero per-vendor
code**.

### Split-ship (the load-bearing scope decision)

Feasibility (Track A §2.f, Track C §4) splits this connector cleanly along the
ingress axis, and the MVP ships the two halves in order:

- **Half 1 — the outgoing action (`http.get` / `http.send`) ships FIRST.** It is
  **GREEN**: pure dial-out, **no ingress requirement**, works fully local-first.
  A keychain secret, a templated request, the SSRF guard, gate the writes. It
  instantly makes the catalog "integrates with anything that has a REST
  endpoint." **This is the MVP walking skeleton (§13).**
- **Half 2 — the incoming trigger (`webhook.received`) FOLLOWS.** It is
  **YELLOW** for two real reasons (§2.3): it inherits the **cloud-ingress**
  tunnel/relay story (localflow has no public endpoint), and it exercises the one
  genuine **architectural extension** — the pinned `subscribe(id, triggerId,
  handler)` seam does not carry per-node config, and the incoming trigger needs
  each node's path + verifier + secret ref (§4.4, §8). Both are addressed here
  and neither is a blocker; they are simply *second*.

### In scope (MVP)

- A new **`http` connector** module set under `src/main/http/`, exposing a static
  `httpDescriptor` (`IntegrationDescriptorDef`) added to `DESCRIPTOR_DEFS`, plus
  the **live dispatch** (`LiveConnector`) registered via `registerConnector`
  (`integration-registry.ts:54`).
- **Outgoing (Half 1):** `http.get` and `http.send` actions. Each flow node
  carries its own request config (URL, method, headers, secret ref, `allowLocal`
  opt-in); the URL / headers / body are **templated from run context** by the
  existing action-runner (`applyTemplate`), and the resolved URL is **forced
  through** `src/main/net/ssrf-guard.ts` before any socket is opened (§4.5).
- **Incoming (Half 2):** a single `webhook.received` trigger backed by the shared
  `src/main/webhooks/webhook-receiver.ts`, configured **per node** with a
  **user-supplied `WebhookVerifier`** (the user picks `scheme: 'hmac' | 'token'`,
  the header name, the algorithm, the encoding). The verified request body
  becomes the trigger payload via `coerceEvent`; `matchesFilter` filters it
  (both already in `trigger-subscriber.ts`).
- **Per-node keychain.** User secrets → keychain via the existing
  `CredentialStore`, under a **per-node composite key** `http:<nodeId>:<field>`
  (§7) — no change to `CredentialStore`'s signature, only its call site.
- **Authority = the flow's gates.** `http.send` is a mutation to an arbitrary
  external system; it is an `action` node the author gates by placing a `gate`
  node before it (the engine already enforces this). `http.get` is a pure read,
  no gate needed. The connector never auto-sends outside the graph the author
  drew.

### Out of scope (MVP) — explicitly deferred

- **A GraphQL variant of `http.send`** (query + variables). A thin fast-follow
  (Track A §2.h); the raw `http.send` already covers a GraphQL POST if the author
  hand-writes the body. Not built now.
- **A scheduled / cron trigger** ("run every N minutes" — the poll-based analog
  of a webhook, Track A §2.h). A natural companion, separately owned.
- **A hosted webhook relay.** MVP's incoming half uses a **user-run dev tunnel**
  (the Shopify/Linear §4.4 "for me" fork). The hosted relay is the product-fork
  change (§12), flagged, not built.
- **Per-node request retries / backoff policy** beyond surfacing the remote's
  `429` + `Retry-After` verbatim (§9). The author decides retry via the graph.
- **A response-schema / JSON-path extractor node.** `http.get` writes the whole
  parsed body to context (§6.5); downstream conditions read it by dotted path.
  A dedicated extractor is later sugar.
- **A local per-path inbound throttle** (abuse guard). Phase 2 (Track A §2.d).

---

## 2. Feasibility + landscape (done — summarized)

### 2.1 Why the generic pair, and why now

Instead of building a bespoke connector per SaaS, ship **two nodes** that wire
ANY system: an outgoing HTTP-request **action** (any system with a REST/GraphQL/
webhook endpoint) and an incoming-webhook **trigger** (any system that can POST).
This covers the 80% long tail — Stripe, GitHub, Notion, Airtable, Sentry,
Datadog, an internal service — with **zero per-vendor code**, and buys time to
decide which vendors deserve a first-class connector (Track A §2, Track C §4).

**It is the n8n / Zapier / Make interop vehicle (Track C §3-4).** n8n interop is
fundamentally *"POST to a workflow's webhook URL"* (outbound) + *"receive a signed
callback"* (inbound) + *"poll an execution"* — so **the generic-webhook connector
covers ~90% of n8n interop with zero n8n-specific code** (Track C §3, the settled
strategic call). localflow does the LLM **judgment** inside a node; n8n does the
deterministic **reach** across its 400+ integrations. This connector is the seam
between the two layers. Zapier's **Catch Hook** (inbound) / **Send Webhook**
(outbound) and Make's **Custom Webhook** / **HTTP module** fall out the same way.

### 2.2 There is no vendor — the user supplies everything

- **Outgoing action:** the user supplies the **URL**, method, headers, and a
  **secret** (bearer token / API key / basic-auth password / HMAC signing key).
  The secret → keychain; the URL and non-secret headers → the node's `config`.
- **Incoming trigger:** the user configures a **`WebhookVerifier`** — either the
  **HMAC scheme** the sender uses (`scheme:'hmac'`, header name + algorithm +
  encoding, recompute over the raw body, timing-safe compare), OR a simpler
  **header-auth token** (`scheme:'token'`, the n8n / Zapier Catch Hook default —
  neither signs by default, so an unguessable path + a checked header token is the
  real control). The secret → keychain.

### 2.3 Constraints (why the incoming half is YELLOW, not GREEN)

1. **Cloud ingress (incoming half only).** localflow is a Finder-launched
   Electron app on an 8 GB Mac behind NAT — **no public HTTPS endpoint**. The
   incoming trigger needs a **user-run tunnel** ("for me") or a **hosted relay**
   ("product"), identical to Shopify/Linear §4.4. **One ingress serves ALL
   generic webhooks** via distinct per-node paths, so the cost is paid once. The
   *outgoing* half dials out and has **no** ingress requirement — it is GREEN and
   ships first.
2. **A genuine architectural tension with the pinned contract.** The descriptor
   model is *static* (`triggers[]` / `actions[]` and `IntegrationId` are fixed at
   author time; `subscribe(id, triggerId, …)` and `invokeAction(id, actionId, …)`
   key off a fixed id). A generic connector configured with **arbitrary** URLs /
   secrets / paths wants **per-node** config. The recommended shape (Track A §2.f
   option b) — a **single `http` id whose per-flow-node `config` carries the
   URL/secret/path** — fits the existing model (`FlowNode.config` already exists)
   and is the one this spec builds. Its cost: the secret lives **per node**, so
   the keychain key scheme (`"<id>:<key>"`) grows a per-node discriminator
   (`"http:<nodeId>:<field>"`, §7), and the incoming `subscribe` seam must be
   handed the node's config (§4.4, §8). Both are addressed; neither is a blocker.
3. **The connector cannot know if an outbound POST is idempotent.** So the safe
   default for `http.send` is *"offer the gate"* — it is a gated `action` node
   (§5). A `GET` is assumed side-effect-free and needs no gate.

### 2.4 Verdict: **GREEN (outgoing) / YELLOW (incoming)**

- **Outgoing `http.get` / `http.send` = GREEN.** Pure dial-out, no ingress,
  keychain secret, SSRF-guarded URL, gate the writes. Shippable on the existing
  pattern with essentially no new architecture.
- **Incoming `webhook.received` = YELLOW.** Buildable today, but gated behind the
  cloud-ingress tunnel/relay story and the per-node-config seam extension (§2.3).
  Ships second.

---

## 3. The core loop → HTTP primitives

localflow's loop is `trigger → read → route → act (gated)`. Each stage maps to a
concrete HTTP primitive and the concrete flow-engine mechanism that runs it:

| Stage | HTTP primitive | localflow / flow-engine mechanism |
|---|---|---|
| **trigger** | An external system POSTs to this flow's unguessable, signed webhook URL. | `webhook-receiver` verifies the node's `WebhookVerifier` → normalizes to a `SeedEvent` (`{ eventId, payload: { webhook: {...} } }`) → the connector's `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in the trigger node's context slot (`trigger-subscriber.ts`). |
| **read** | An outgoing `GET` to any endpoint (fetch JSON). | An `action` node (`http.get`) → `registry.invokeAction('http', 'http.get', params)` → the connector resolves the node's request, runs it through `http-client` (SSRF-guarded) → **resolves** the normalized `{ http: { status, headers, body } }`, which the action-runner writes to context under the node id (`action-runner.ts`). |
| **route** | *(none — pure localflow)* | `selectEdges` evaluates edge conditions over what the read wrote (`context.ts`) — e.g. `field: 'fetch.http.status', op: 'eq', value: 200`. **No LLM decides routing** — deterministic value compares. |
| **gate** | *(none — pure localflow)* | A `gate` node the author placed pauses the run `needs-you`; the human approves in the cockpit. An `http.send` node sits **downstream of the gate the author drew** (the natural pairing with the Slack/SMS approval round-trip, Track A §1.g). |
| **act** | An outgoing `POST`/`PUT`/`PATCH`/`DELETE` with a body. | The gated `http.send` action → `invokeAction` → `http-client` (SSRF-guarded). **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* HTTP error (status + body excerpt), never a bare "failed". |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities* (a read, a gated send, a trigger); the *flow* decides which
runs, in what order, behind which gates. There is no "connector default policy"
that fires an outbound POST on its own — the connector only does what an action
node invokes.

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/http/`, mirroring
`src/main/shopify/` (the connector-spec module pattern:
`*-descriptor` / `*-connector` / `*-client` / `*-config` / `*-normalize`). It is
**opt-in**: with no `http` node in any flow and no stored per-node secret, the
descriptor's `status()` reports `needs-config` and the engine refuses any `http`
node before any network call (`action-runner.ts`) — localflow's "works with no
integration" guarantee is unchanged.

Architecturally the connector is a **live implementation behind the registry's
pinned `invokeAction` / `subscribe`**, registered via
`registry.registerConnector('http', httpConnector)`
(`integration-registry.ts:54` — Shopify/WooCommerce are the first live
connectors; `http` slots into the same map). **All HTTP transport shapes are
isolated in `http-client.ts`** (the blast radius for any transport change),
exactly as Shopify isolated its GraphQL in `shopify-admin.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/http/http-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'http'`, the generic actions/trigger of §6, and the **descriptor-level** config fields of §6.6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the action/trigger ids. Mirrors `shopify-descriptor.ts`. |
| `src/main/http/http-connector.ts` | The `LiveConnector` impl + orchestrator. `invokeAction('http.get'\|'http.send', params)` → resolve the node request (`http-node-config`) → `http-client`. `subscribe('webhook.received', handler)` → register the node's path + verifier with the shared `webhook-receiver` (§4.4). Owns nothing vendor-specific. |
| `src/main/http/http-client.ts` | The outbound HTTP transport. **All** request/response shapes live *only* here. **Calls `ssrf-guard` on the resolved URL before opening any socket** (§4.5), honoring the node's `allowLocal` opt-in. Isolated behind an `HttpTransport` interface so tests inject a `MockHttpTransport` (§10). Surfaces the remote's status + `Retry-After` verbatim (§9). |
| `src/main/http/http-node-config.ts` | **Pure** resolution: a flow node's `config` + the action-runner's templated `params` → a `ResolvedRequest` (method, url, headers, body, secretRef, allowLocal) for actions, or a `ResolvedWebhook` (path, `WebhookVerifier`, secretRef) for the trigger. Validate-at-the-boundary (`integration-config.ts` posture): a malformed method / missing URL / bad verifier is a **loud reject**, never a silent default. |
| `src/main/http/http-normalize.ts` | **Pure** mapping: a raw HTTP response → the pinned `HttpResponseContext` (§6.5); a verified inbound request → a `SeedEvent` carrying `WebhookContext` (§6.5). JSON is parsed when the content-type says so, else the body is a string. Unit-testable in isolation (mirrors `shopify-normalize.ts` purity). |
| `src/shared/http.ts` | Shared types (`ResolvedRequest`, `HttpResponseContext`, `WebhookContext`, the per-node `config` shapes of §6.6) needed by both main and the renderer palette. |

**Consumed shared-infra (sibling-owned — named, not designed here):**

| Module | This connector's use |
|---|---|
| `src/main/webhooks/webhook-receiver.ts` | The parameterized receiver. The incoming trigger registers a per-node **path** + a user-supplied **`WebhookVerifier`** (§6.4); the receiver does createServer + `MAX_BODY_BYTES` + 200-fast + `responded`/error guards + the verifier's timing-safe check over the **raw** body, then emits the verified request. Generalizes what `shopify-webhook-server.ts` / `linear-webhook-server.ts` each hand-rolled. |
| `src/main/net/ssrf-guard.ts` | The shared URL guard. `http-client` calls it on every resolved outbound URL: https-only (http allowed only under the node's `allowLocal` opt-in), resolve + reject loopback / RFC-1918 / link-local / metadata (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. `169.254.169.254`, `::1`, `fc00::/7`), reject embedded credentials. Generalizes WooCommerce's `wc-ssrf.ts` into one shared guard (Track C §6). |
| `src/main/integrations/credential-store.ts` | The `safeStorage` keychain, reused with a **per-node composite key** (§7) — `revealForConnector('http', '<nodeId>:<field>')`, the sole main-process-only plaintext exit. |

### 4.3 Wiring the live dispatch into the merged registry

Unchanged from the Shopify seam — the registry already supports it. `src/main/
index.ts` constructs the `HttpConnector` (given the `CredentialStore`, the shared
`webhook-receiver`, and the `ssrf-guard`) and calls
`registry.registerConnector('http', httpConnector)`. The pinned
`invokeAction`/`subscribe` (`integration-registry.ts:73-95`) already delegate to a
registered connector or fall back to the legible "not wired yet" reject / no-op
unsubscribe. **The pinned contract is byte-for-byte unchanged.**

### 4.4 The incoming half — ingress + the per-node-config seam extension

Two things the incoming trigger needs that the outgoing action does not:

- **Cloud ingress.** Identical to Shopify/Linear §4.4. **MVP ("for me"):** a
  developer tunnel (ngrok / Cloudflare Tunnel) forwards to the local
  `webhook-receiver`; the flow node's `config.inboundPath` is the unguessable
  path segment appended to the tunnel base (stored as a non-secret ref). **One
  tunnel serves every generic webhook** via distinct paths. **Phase 2
  ("product"):** a hosted relay that authenticates then forwards (§12).
- **The per-node config channel (the architectural extension).** The pinned
  `subscribe(id, triggerId, handler)` (`integrations.ts`) carries **no node
  config** — fine for fixed-vendor connectors whose config lives per-id, but the
  `http` trigger needs *this node's* path + verifier + secret ref. Today
  `trigger-subscriber.ts:59` calls `registry.subscribe(trigger.integration,
  trigger.ref, handler)` with no config. **Extension:** `trigger-subscriber.ts`
  forwards the trigger node's `config` (and node id) to `subscribe`, so the
  connector can register the route + verifier for that node. This is a small,
  additive change to the subscribe seam (an extra arg, or a reserved config
  channel); it is the one genuine contract extension the incoming half requires,
  and it is why the incoming half ships **second** (§13, open decision §12.1).

Regardless of ingress, the receiver **verifies before parsing** (a body-parser
that consumes the stream first breaks HMAC — the receiver reads raw bytes),
enforces `MAX_BODY_BYTES`, and responds **200 fast** — the run starts after the
response so the sender's delivery-timeout is met and a slow flow never causes a
redelivery storm. A forged / oversized / malformed / unverified delivery is
dropped (4xx/401) and **never** seeds a run.

### 4.5 The outgoing half — the SSRF guard is non-negotiable

`http.send` / `http.get` take a **user-supplied, context-templated URL**, then
make a **main-process (server-side) request** to it. Without a guard this is a
textbook SSRF pivot (an attacker-controlled trigger payload templated into a URL
that hits `169.254.169.254` or a LAN box). So **`http-client` routes every
resolved URL through `src/main/net/ssrf-guard.ts` before opening a socket**:

- **Default:** https-only; resolve the host and **reject** loopback / RFC-1918 /
  link-local / cloud-metadata ranges; reject embedded credentials
  (`https://user:pass@…`). The URL is re-checked **after** templating (the
  template output is what dials), not just the static config.
- **Opt-in local target:** a node whose author sets `config.allowLocal: true`
  may dial `http://localhost…` / a LAN host — for the legitimate "POST to my
  local n8n / a dev service" case. This is an explicit, per-node, author-visible
  opt-in; the default is guarded. (Mirrors the PostHog/WooCommerce SSRF posture,
  Track C §6, hoisted to the shared guard.)

### 4.6 Reused localflow surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `LiveConnector` / `registerConnector` contract this connector satisfies;
  `IntegrationId` (edited, §6.0); `IntegrationStatus`.
- `src/main/integrations/integration-registry.ts` — `registerConnector('http',…)`
  (§4.3); `status('http')` derived from config + credential presence.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain,
  per-node composite key (§7); `revealForConnector` (main-only plaintext exit).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, param templating (`applyTemplate`), and how
  the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — `subscribe` seeds runs; `coerceEvent` /
  `matchesFilter` normalize the webhook `SeedEvent` (extended per §4.4 to forward
  node config).
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`fetch.http.body.id`) + boolean routing + `{{…}}` templating
  of URL/headers/body.
- `src/main/webhooks/webhook-receiver.ts`, `src/main/net/ssrf-guard.ts` — the two
  consumed shared-infra modules (§4.2).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `httpDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected | needs-config | error | disabled`) as it does for the others.

**The status wrinkle a per-node connector introduces.** Fixed-vendor `status()`
reads a *single* per-id credential set. The `http` connector has **no per-id
secret** — its secrets are per node. So `status('http')` is derived from the
**descriptor-level** config block only (§6.6): `connected` when the `http`
integration is enabled (the author has opted in), `needs-config` when it is
absent, `disabled` when configured-but-off, `error` when a descriptor-level
stored secret can't be decrypted. **Per-node readiness (does *this* node have its
secret?) is checked at run time inside the connector, not by `status()`** — an
`http.send` node whose `http:<nodeId>:authSecret` is missing **rejects** with a
legible message (§9), rather than being blocked by a global status. This is the
honest consequence of per-node config: `status()` answers "is the connector
enabled?", the run answers "is this node configured?". (Flagged as open decision
§12.2 — whether the canvas should surface per-node readiness pre-run.)

---

## 6. Pinned generic-HTTP vocabulary (verbatim)

> **This section is the contract.** The canvas palette and the flow-templates
> track read these ids and this per-node `config` shape verbatim. A snapshot test
> in `http-descriptor.ts` guards the ids; the `config` and context shapes are
> guarded by the `http-node-config.ts` / `http-normalize.ts` tests.

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'http'`:

```ts
export type IntegrationId = 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'http'
```

Three companion touch-points move in lockstep (each a one-line add):
`INTEGRATION_IDS` (the stable order array, `integrations.ts`), the
`INTEGRATION_IDS` allow-list in `flow-model.ts`, and `DESCRIPTOR_DEFS`
(`descriptors/index.ts`). No other `IntegrationId` consumer changes — they
iterate the array.

### 6.1 Trigger (one, generic)

| trigger id | label | backing | note |
|---|---|---|---|
| `webhook.received` | An external system POSTed to my webhook URL | The shared `webhook-receiver`, configured **per node** with the user's `WebhookVerifier` (§6.4) + unguessable path. | The whole verified request becomes the payload (§6.5). `matchesFilter` filters on any field. |

### 6.2 Actions (two, generic)

| action id | label | method | gate? | writes to context |
|---|---|---|---|---|
| `http.get` | Fetch JSON from a URL (read) | `GET` (fixed) | no — pure read | `HttpResponseContext` (§6.5) |
| `http.send` | Send a body to a URL (gated write) | `POST` / `PUT` / `PATCH` / `DELETE` (per node) | **yes** — author places a gate | `HttpResponseContext` (§6.5) |

**Failure convention (pinned):** an action that fails **rejects** its promise
with the real cause (status + a body excerpt); a resolved promise (any value) is
success and its value becomes the node's context output
(`action-runner.ts`, `integrations.ts:33-43`). The connector never resolves a
sentinel-failure and never swallows a non-2xx (§9).

### 6.3 Per-node `config` shape (the heart of the design — §7)

Unlike fixed-vendor connectors, the operative config lives on **each flow node**
(`FlowNode.config`, `src/shared/flows.ts:18`). Pinned shapes (`src/shared/
http.ts`):

```ts
// An http.get / http.send action node's config.
export interface HttpActionNodeConfig {
  url: string                       // may contain {{context}} templates
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'  // http.send only; GET is fixed for http.get
  headers?: Record<string, string>  // values may be templated; NEVER a raw secret literal
  body?: unknown                    // http.send only; JSON or string; may be templated
  auth?: {
    scheme: 'bearer' | 'basic' | 'header' | 'none'
    header?: string                 // for 'header' scheme, e.g. "X-API-Key"
    secretRef: string               // the per-node keychain FIELD name (§7); NOT the secret
  }
  allowLocal?: boolean              // opt into loopback/LAN targets past the SSRF guard (§4.5)
  timeoutMs?: number
}

// A webhook.received trigger node's config.
export interface HttpTriggerNodeConfig {
  inboundPath: string               // unguessable per-flow path segment (non-secret ref)
  verifier: WebhookVerifier         // §6.4 — user-supplied; its secret is a keychain ref
  secretRef: string                 // the per-node keychain FIELD name holding the verifier secret
}
```

The critical property: **a secret is never a literal in `config`** — `config`
holds only a `secretRef` (a keychain *field name*, non-secret), and the ciphertext
lives in the keychain under `http:<nodeId>:<secretRef>` (§7). `config` is safe to
write to `config.json` / a template / the transcript; the secret is not, and never
is.

### 6.4 The `WebhookVerifier` (consumed verbatim from the shared receiver)

Owned by `src/main/webhooks/webhook-receiver.ts`; reproduced only to state how the
trigger uses it. The user configures it per node:

```ts
// OWNED BY the shared webhook-receiver — this connector supplies a USER-CONFIGURED instance.
interface WebhookVerifier {
  scheme: 'hmac' | 'token'
  header: string            // header carrying the signature/token, e.g. "X-Signature-256"
  algo?: string             // hmac: 'sha256' | 'sha1'
  encoding?: string         // hmac: 'hex' | 'base64'
  signsTimestamp?: boolean  // hmac: include a timestamp header in the signed material (Slack-style replay defense)
  // …the receiver owns the rest
}
```

- `scheme: 'hmac'` — recompute the HMAC over the **raw** body with the keychain
  secret and timing-safe-compare against `header` (Stripe/GitHub/Shopify-style
  signed webhooks). The **user supplies** `header` / `algo` / `encoding` because
  every sender differs.
- `scheme: 'token'` — compare a shared **token** in `header` against the keychain
  secret (the n8n Header-Auth / Zapier Catch Hook / Make default — they don't sign
  by default; an unguessable path + a checked header token is the real control).

The receiver refuses an empty secret outright and never logs the secret or the
body — route + reason only.

### 6.5 Context-field shapes (what a node writes for later conditions)

A read/send action writes under its node id; the trigger writes to the trigger
node's context slot. Pinned shapes (`src/shared/http.ts`), produced by
`http-normalize.ts`:

```ts
// Written by http.get / http.send under the node id, e.g. context['fetch'].
export interface HttpResponseContext {
  http: {
    status: number                        // e.g. 200
    ok: boolean                           // status in 200-299
    headers: Record<string, string>       // response headers (lowercased keys)
    body: unknown                         // parsed JSON if content-type is JSON, else the string body
  }
}

// The webhook.received payload (via coerceEvent) → the trigger node's context slot.
export interface WebhookContext {
  webhook: {
    headers: Record<string, string>       // request headers (lowercased; verifier header stripped is optional)
    body: unknown                         // parsed JSON if JSON, else the raw string
    query: Record<string, string>         // parsed query string
  }
}
```

Downstream conditions read these by dotted path — `field: 'fetch.http.status'`,
`field: 'fetch.http.body.id'`, `field: 'webhook.body.type'` — and the richer
`FlowEdgeCondition` operators (owned by the conditions track) apply directly:
`http.status` as a number for `gt`/`lt`, `http.ok` as a boolean for `truthy`,
`webhook.body.*` for `eq`/`contains`. The templates track and the conditions track
rely on these exact paths.

### 6.6 Descriptor-level config fields (the opt-in block, not the per-node config)

The `http` descriptor still needs a *small* per-id config block (for `status()`
and the ingress base): non-secret `environment` (number 1-9, which env hosts HTTP
work) and non-secret `ingressBaseUrl` (the tunnel/relay base the per-node
`inboundPath` is appended to — the incoming half only). **No secret lives at the
descriptor level** — all secrets are per node (§7). This is what makes `status()`
per-id-thin (§5).

---

## 7. Per-node config + the keychain-key design (the central extension)

### 7.1 Where each piece of config lives

| Piece | Lives in | Why |
|---|---|---|
| URL, method, headers, body, `secretRef`, `allowLocal`, `verifier`, `inboundPath` | the **flow node's `config`** (`FlowNode.config`) | Per-node by nature — one flow reaches many endpoints. Non-secret, so safe in `config.json` / a template. |
| The actual **secret** (bearer token / basic password / API key / HMAC key) | the **keychain**, under `http:<nodeId>:<secretRef>` | Never a literal in `config`; the ciphertext never leaves `CredentialStore` except via `revealForConnector` (main-only). |
| `environment`, `ingressBaseUrl` | the descriptor-level `http` config block (§6.6) | Per-id, drives `status()` + the ingress base. |

### 7.2 The keychain-key extension — a composite `key`, no signature change

`CredentialStore` keys secrets as `keyOf(id, key) => "${id}:${key}"`
(`credential-store.ts:27`), and `revealForConnector(id: IntegrationId, key:
string)` (`credential-store.ts:99`) is the plaintext exit. Fixed-vendor connectors
call it with a static field name — `revealForConnector('shopify', 'adminToken')`
→ keychain key `shopify:adminToken`.

**The per-node scheme reuses this verbatim by making `key` a composite** — the
node id joined with the field:

```
revealForConnector('http', `${nodeId}:${secretRef}`)
   → keyOf('http', '<nodeId>:authSecret')
   → keychain key  "http:<nodeId>:authSecret"
```

This is the recommended `http:<nodeId>:<field>` discriminator (Track A §2.f,
§4). **`CredentialStore` needs no change** — its `key` parameter is already a free
string; the composite simply lives inside it. `has` / `set` / `clear` /
`revealForConnector` all work unchanged; `clear('http')` (no field) still wipes
every `http:*` key via the existing prefix match (`credential-store.ts:87`), which
is the right teardown when the `http` integration is disconnected.

### 7.3 Getting the node id to the connector at run time (the seam detail)

The per-node key needs the **node id** at invoke/subscribe time. Two seams:

- **Trigger (subscribe):** already addressed by the §4.4 extension —
  `trigger-subscriber.ts` forwards the trigger node's `config` **and id** to
  `subscribe`, so the connector reads `http:<nodeId>:<secretRef>` when it registers
  the verifier.
- **Action (invokeAction):** the pinned `invokeAction(id, actionId, params)`
  carries only `params`. The action-runner already builds `params` from the node's
  templated `config`, so the node's `secretRef` and (crucially) its **node id**
  ride inside `params` — either the runner injects a reserved `__nodeId` key, or
  the node id is the discriminator the runner already knows (it writes context
  under the node id). The connector reads `params.__nodeId` + `config.auth
  .secretRef` → `revealForConnector('http', '<nodeId>:<secretRef>')`. This is the
  minimal additive seam and is flagged as open decision §12.1 (node-id vs a
  user-named shared credential label).

### 7.4 The alternative considered and rejected (N user-named instances)

Track A §2.f option (a) — N user-named *instances* of one `http` descriptor —
was rejected: it requires a multi-instance config shape the current
single-entry-per-id `config.json` doesn't support, and multi-instance `status()` /
registry keying, a much larger contract change. The per-node shape (option b)
stays inside the pinned contract and reuses `FlowNode.config` + the composite
keychain key. **A user-named *credential label*** (`http:<label>:token`, shareable
across nodes) is retained as an *option within* the per-node scheme (§12.1), not as
a separate instance model.

---

## 8. Data flow — two real loops, node by node

### 8.1 Outgoing (Half 1, GREEN) — "read an API, route on it, POST back behind a gate"

**Scenario:** *"When a flow needs it, GET an order's status from an internal API;
if it's `failed`, POST an alert to our ops webhook — but only after I approve."*

```
[action: http.get "fetch"]          config.url="https://api.internal/orders/{{t.orderId}}"
        │                            auth={scheme:'bearer', secretRef:'apiToken'}
        │  invokeAction('http','http.get',params) → resolve → ssrf-guard(url) → GET
        │  writes context['fetch'] = HttpResponseContext
        ▼
[router]                            edge: field='fetch.http.body.status', op='eq', value='failed'
        ▼
[gate: "approve alert"]             pauses run needs-you; human reviews in cockpit
        │  approved ─► [action: http.send "alert"]  method=POST
        │                url="https://ops.example.com/hooks/{{env.opsPath}}"
        │                body={ text: "Order {{t.orderId}} failed" }
        │                auth={scheme:'header', header:'X-API-Key', secretRef:'opsKey'}
        │                → ssrf-guard(url) → POST → resolves { http:{status:200,...} }
        │  rejected ─► run ends 'rejected' (a human "no" is not a failure)
```

1. **`http.get` reads.** The action-runner templates `config.url` (`{{t.orderId}}`
   → the real id via `applyTemplate`), confirms `status('http') === 'connected'`,
   calls `invokeAction`. The connector resolves the request
   (`http-node-config`), reveals `http:<nodeId>:apiToken`, **runs the URL through
   `ssrf-guard`**, dials via `http-client`, normalizes → resolves
   `HttpResponseContext`; the runner writes `context['fetch']`.
2. **Router branches** on `fetch.http.body.status` — deterministic, no LLM.
3. **Gated send.** The `gate` pauses `needs-you`; on approval `http.send` resolves
   `apiToken`→ wait, `opsKey`, guards the URL, POSTs. A non-2xx or transport error
   **rejects** with the real cause (§9); on success the resolved response is in
   context. On a human "no" the run ends `rejected` cleanly.

### 8.2 Incoming (Half 2, YELLOW) — the n8n / Zapier round-trip

**Scenario:** *"An n8n workflow (or a Stripe `payment_failed`) POSTs to my flow;
an agent investigates; behind a Slack approval, I POST a signed callback to
another n8n workflow."* This is the **interop vehicle** end-to-end (Track C §3-4):

```
[trigger: webhook.received]        config.inboundPath="/wh/9f3a-…"  (unguessable)
        │                          config.verifier={scheme:'token', header:'X-Auth'}  secretRef:'inKey'
        │  external system POSTs → webhook-receiver verifies X-Auth against http:<nodeId>:inKey
        │  200-fast, then coerceEvent → context['t'] = { webhook:{ headers, body, query } }
        ▼
[agent: investigate]               reads webhook.body, forms a judgment (the localflow edge)
        ▼
[gate: Slack approval]             Track A §1.g — the send is parked on the human's tap
        ▼
[action: http.send "callback"]     POST to the n8n Webhook Trigger URL; body signed if the node
                                   configures an outbound HMAC header; ssrf-guard(url) → POST
```

`localflow does the thinking; n8n does the reaching` (Track C §3): the inbound
POST wakes the flow, the agent node judges, and the gated `http.send` fires the
n8n workflow that deterministically fans out to Salesforce / Jira / Notion —
**five systems localflow never integrated**, reached through one generic pair.

---

## 9. Error handling

localflow's principle (error-message-style memory; `credential-store.ts`,
`action-runner.ts`): **every failure is human-readable, actionable, and carries
the real underlying cause. No silent catch. No bare "failed" / "not found".** An
action signals failure by **rejecting** with that message; the action-runner
prefixes it with the node/action and surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **SSRF-blocked outbound URL** | the resolved host + IP it resolved to | **Rejects before any socket**: "Refusing to call `<url>` — it resolves to a private/loopback/metadata address (`<ip>`). Set `allowLocal: true` on this node only if you intend a local target." (§4.5). |
| **Per-node secret missing** | the composite key that missed | Rejects: "This http node needs its secret — none is stored at `http:<nodeId>:<secretRef>`. Set it on the node in the canvas." (per-node readiness is a run-time check, §5). |
| **Per-node secret undecryptable** | the `safeStorage` decrypt error via `{ cause }` | Rejects: "Stored secret for this http node can't be decrypted (safeStorage: `<reason>`) — re-enter it." Value never included. |
| **Remote non-2xx (4xx/5xx)** | the status + a bounded body excerpt (never a secret) | `http.send`/`http.get` **reject**: "`POST <url>` returned 422 — `<body excerpt>`." The connector never swallows a non-2xx into a resolved value. |
| **Remote rate-limit (429)** | the status + the remote's `Retry-After` **verbatim** | Rejects: "`<url>` is rate-limited (429; Retry-After: 30s) — the remote asked us to back off." Not silently retried; the author decides retry via the graph (§1 out-of-scope). |
| **Transport error (DNS/TLS/timeout/refused)** | the Node error code (`ENOTFOUND`/`ECONNREFUSED`/`ETIMEDOUT`) via `{ cause }` | Rejects: "Couldn't reach `<host>` (`ENOTFOUND`) — check the URL and that the host is reachable." Respects `config.timeoutMs`. |
| **Malformed node config** | the offending field | `http-node-config` **rejects at the boundary**: "http node has an invalid method `<x>` (expected POST/PUT/PATCH/DELETE)" / "http node is missing a URL." Never a silent default. |
| **`status('http') !== 'connected'`** | the derived reason (not enabled / disabled / descriptor-secret decrypt error) | The action-runner fails the node *before* any call: "Flow needs HTTP connected — enable it in Settings." (`action-runner.ts`). |
| **Webhook verifier failed (HMAC/token mismatch)** | signature mismatch (never the body or secret) | Receiver `console.warn` **route + reason only**; 401; **no run started**. Mirrors the shopify/linear receiver discipline. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | Receiver 4xx; dropped; **no run**. Never seeds a run on unvalidated shape. |
| **Ingress/tunnel down** (incoming half) | the unreachable `ingressBaseUrl` | Startup/health check fails loudly: "Webhook ingress `<url>` is unreachable — no external events will arrive." Never a silent dead trigger. |

The connector **never** catches-and-drops, and **never renders a secret** — no
error message, log line, or context field ever contains the bearer token, basic
password, API key, HMAC secret, or the raw signed body (§4.5, §7). Where the
remote returns a precise error, the connector forwards *that* (bounded, secret-
scrubbed) rather than minting a vaguer one.

---

## 10. Testing strategy (offline / mockable — no live network in CI)

Testable **without any live endpoint**, matching localflow's seams (pure modules,
injected transport, fixture events):

- **`HttpTransport` interface + `MockHttpTransport` seam.** `http-client.ts` is
  written *against* an `HttpTransport` interface; the real impl wraps the fetch/
  socket transport. Tests inject a `MockHttpTransport` returning canned status +
  headers + body (incl. 4xx/429-with-`Retry-After`/5xx and transport-error
  throws). **No test opens a real socket**; CI has no network. (Same posture as
  Shopify's `MockShopifyApi`.)
- **SSRF-block tests (the security boundary — guarded hardest).** Drive
  `http-client` through the shared `ssrf-guard` with URLs resolving to loopback
  (`127.0.0.1`, `::1`), RFC-1918 (`10.x`, `192.168.x`, `172.16.x`), link-local /
  metadata (`169.254.169.254`), embedded-credential URLs, and plain `http://`
  without `allowLocal` — **assert each is rejected before the mock transport is
  called**, and assert `allowLocal: true` permits a loopback target. Assert the
  guard re-checks the URL **after** templating (a template that expands to a
  metadata IP is blocked).
- **Verifier tests** — feed the shared `webhook-receiver` fixture requests with
  **valid and invalid HMAC** (`sha256`/`sha1`, `hex`/`base64`, with and without
  `signsTimestamp`) and **valid/invalid token** requests; assert only
  valid+verified+novel deliveries produce a `SeedEvent`, and that an empty secret
  is refused. (The receiver's own suite owns the depth; the connector asserts it
  wires a user-configured verifier correctly.)
- **`http-node-config.ts` unit tests** — pure: assert a node `config` + templated
  params → the right `ResolvedRequest` / `ResolvedWebhook`; assert malformed
  method / missing URL / bad verifier **reject at the boundary**; assert a secret
  literal accidentally placed in `config.headers` is caught, not sent.
- **`http-normalize.ts` unit tests** — pure: raw response → `HttpResponseContext`
  (JSON vs string body by content-type, lowercased header keys, `ok` derivation);
  raw inbound request → `WebhookContext` (`headers`/`body`/`query`).
- **Per-node keychain test** — `revealForConnector('http', '<nodeId>:secret')`
  round-trip via a fake `SecretBackend`; assert two nodes' secrets are isolated
  (`http:A:token` vs `http:B:token`); a regression guard asserts **no secret value
  appears** in any emitted log/console/error string (the secret rule).
- **Engine integration test (offline)** — wire the real `FlowEngine` + registry +
  the `http` connector over a `MockHttpTransport`, drive §8.1: `http.get` writes
  context → router selects the `failed` edge → the gate pauses `needs-you` → on
  approval `http.send` calls the mock; assert a non-2xx **rejects** the run with
  the real cause. Deterministic via the engine's injected `now()`.
- **Snapshot test on `httpDescriptor`** — pins the `http.get` / `http.send` /
  `webhook.received` ids the palette + templates track consume.

No test requires a live endpoint or network; the real transport is exercised only
in manual dogfooding.

---

## 11. Authority & safety

**Primary control — the flow's gates (already enforced).** `http.send` is a
mutation to an arbitrary external system; the connector cannot know if it is
idempotent, so it is a gated `action` node — the author places a `gate` before it
(the natural pairing with the Slack/SMS approval round-trip, Track A §1.g). The
engine honors the gate; a human "no" ends the run `rejected` (not a failure); a
send with no path to it never runs. **The connector never auto-sends outside the
graph the author drew.** `http.get` is a pure read and needs no gate.

**The SSRF guard is a deterministic floor under the gates (§4.5)** — even a
mis-authored flow or an attacker-templated URL cannot pivot to an internal/
metadata address unless the author explicitly set `allowLocal` on that node. This
is the lfguard posture (a deterministic guard, no model in the loop) applied to
outbound HTTP.

**Never render secrets (§7, §9).** Every per-node secret lives in the keychain;
`config` carries only a `secretRef`; no error, log, or context field ever contains
the token or the signed body.

---

## 12. Open decisions (FLAGGED — not resolved here)

1. **Per-node keychain discriminator: node id vs a user-named credential label.**
   The recommended scheme is `http:<nodeId>:<field>` (§7) — simplest, isolates
   every node. But it means a secret can't be *shared* across nodes (the same
   bearer token used by three `http.get` nodes must be entered three times), and
   it needs the node id threaded into `invokeAction`'s `params` (§7.3). The
   alternative — a user-named **credential label** (`http:<label>:token`, the
   `secretRef` is the label, shared across nodes) — is nicer for shared tokens but
   adds a small credential-management surface. **Recommendation:** ship node-id
   keying for the MVP (isolation, no new UI), add named labels as sugar. Decide
   before Half 1 lands (it fixes the `invokeAction` seam shape).
2. **Should `status()` / the canvas surface per-node readiness pre-run?** Per-node
   config makes `status('http')` per-id-thin (§5) — it can't say "node X is
   missing its secret" until the run. A pre-run canvas validation pass (does each
   `http` node have its `secretRef` stored?) would catch it earlier, at the cost
   of a per-node presence check surfaced to the renderer. **Recommendation:** MVP
   fails at run time with a legible message (§9); add a canvas warning later.
3. **How far to templatize the request.** MVP templates the **URL, header values,
   and body** via `applyTemplate` (§6.3). Open: deep-templating a JSON body
   (per-field `{{…}}` substitution into a structured object) vs string-templating
   the whole body; and whether query params get their own templated map vs living
   in the URL. **Recommendation:** string-template the URL + header values; for
   the body, support both a templated string and a shallow object whose string
   values are templated. Decide before the templates track builds starter graphs.
4. **Response-body → context shape when the body is large or non-JSON.** MVP
   writes the whole parsed `body` to context (§6.5). Open: a size cap on what
   lands in context (a 10 MB response shouldn't bloat a run snapshot), and whether
   to expose a JSON-path extractor now vs later. **Recommendation:** cap the
   context body (mirror `MAX_BODY_BYTES`), truncate-with-notice past it; extractor
   is later sugar.
5. **Incoming subscribe-seam extension shape (§4.4).** Forwarding node `config` +
   id to `subscribe` is additive but touches the pinned seam. Open: an extra
   `subscribe` arg vs a reserved config channel vs a separate route-registration
   pass. **Recommendation:** the minimal extra arg on the internal call in
   `trigger-subscriber.ts`; keep the pinned `IntegrationRegistry.subscribe`
   signature stable for fixed-vendor connectors. Owned jointly with the flow-engine
   track; decide when Half 2 starts.

---

## 13. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton") — Half 1, GREEN

**One flow, one `http.get`, one gated `http.send`, happy path, no ingress:**

1. `IntegrationId` gains `'http'` (+ the three lockstep touch-points, §6.0);
   `httpDescriptor` added to `DESCRIPTOR_DEFS`; `status('http')` derives from the
   descriptor-level config block (§5, §6.6).
2. `http-node-config.ts` resolves a node's `config` + templated params →
   `ResolvedRequest`; per-node secret revealed at `http:<nodeId>:<secretRef>`
   (§7).
3. `http-client.ts` behind `HttpTransport`, **calling `ssrf-guard` before every
   dial**; `http-normalize.ts` produces `HttpResponseContext`.
4. `registry.registerConnector('http', httpConnector)` (§4.3): `invokeAction(
   'http','http.get'|'http.send',…)` reaches the connector.
5. On the canvas: `[http.get] → [router] → [gate] → [http.send]` runs end-to-end
   (§8.1). Errors per §9; SSRF blocks per §4.5. **No ingress, no webhook.**

That slice proves the outgoing loop (a flow reads any API, routes on it, and —
behind a gate — POSTs to any endpoint, with the secret in the keychain and the URL
SSRF-guarded) and is dogfoodable immediately with no tunnel.

### Phased roadmap

- **Phase 1 (MVP, GREEN):** the walking skeleton — `http.get` + gated `http.send`,
  per-node config + composite keychain key, SSRF guard, offline tests. No ingress.
- **Phase 2 (Half 2, YELLOW):** the `webhook.received` trigger — the shared
  `webhook-receiver` + user-configured `WebhookVerifier`, the subscribe-seam
  extension (§4.4), a user-run dev tunnel for ingress. Ships the full n8n/Zapier
  round-trip (§8.2).
- **Phase 3 — hardening:** a per-path inbound throttle (abuse guard); a canvas
  per-node readiness warning (§12.2); a context-body size cap (§12.4).
- **Phase 4 — sugar:** a GraphQL variant of `http.send`; a JSON-path response
  extractor; named shared credential labels (§12.1); a scheduled/cron trigger
  (Track A §2.h).
- **Phase 5 — product fork:** a hosted webhook relay replacing the dev tunnel
  (§12; the Shopify/Linear §4.4 phase-2 change) — changes distribution, not the
  connector's dispatch or verification.

---

## Appendix — reused localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `LiveConnector` / `registerConnector` contract this connector satisfies;
  `IntegrationId` (edited, §6.0); `IntegrationStatus`.
- `src/main/integrations/integration-registry.ts` —
  `registerConnector('http', …)` (§4.3); `deriveStatus` gives `http` its per-id
  status (§5).
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain, reused
  with the **per-node composite key** `http:<nodeId>:<field>` (§7);
  `revealForConnector` (main-only plaintext exit); `clear('http')` teardown via
  prefix match.
- `src/main/integrations/integration-config.ts` — the validate-at-the-boundary
  posture `http-node-config` mirrors (malformed → loud reject).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `http`;
  `descriptors/*` is the descriptor-as-code template.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, param templating (`applyTemplate`), the
  node id available for the per-node key (§7.3).
- `src/main/flow/trigger-subscriber.ts` — `subscribe` seeds runs; `coerceEvent` /
  `matchesFilter`; extended (§4.4) to forward the trigger node's `config` + id.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads + `{{…}}` templating of URL/headers/body + boolean routing.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0).
- **`src/main/webhooks/webhook-receiver.ts`** (sibling-owned) — the parameterized
  receiver + the `WebhookVerifier` shape the incoming trigger configures per node
  (§4.2, §6.4).
- **`src/main/net/ssrf-guard.ts`** (sibling-owned) — the shared URL guard every
  outbound request passes before dialing (§4.2, §4.5).
- `guard/` (lfguard) — the deterministic-guard *posture* the SSRF floor borrows (a
  policy floor under the author's gates, no model in the loop).
