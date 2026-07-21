# Shopify Connector — Design

**Date:** 2026-07-17
**Status:** Design (spec) — not started. Design-approval gate for the **ecom
worker** product direction. Anchor connector for "an ecom support worker
assembled on the drag-drop canvas."
**Feature:** A **Shopify connector** that plugs into the just-merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. It lets a flow author wire an ecom worker on the canvas:
a customer message or an order event **triggers** a run, the flow **reads** order
and customer state via Shopify's Admin API, and — behind gates the author places
— **acts** (refund, cancel, re-ship, annotate). It does **not** hardcode a
support pipeline; the authority lives in the flow (conditions on edges, gates
where the author puts them), exactly as the flow engine already enforces.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` contract in `src/shared/integrations.ts` and copies the
module shape of `src/main/integrations/` (CredentialStore keychain,
descriptor-as-code, presence-derived `status()`). It reuses the Linear /
email / cloud connector specs as its style and depth template
(`docs/superpowers/specs/2026-07-16-{linear-integration,email-execution,devops-cloud-execution}-design.md`).

**A note on ownership.** This spec **owns and pins the ecom vocabulary**
(§6: `IntegrationId` addition, triggers, actions, context-field shape). A sibling
**flow-templates** track consumes that vocabulary verbatim; a sibling
**richer-conditions** track owns the `FlowEdgeCondition` upgrade (§10) that will
reference the fields pinned here. Where those tracks own a shape, this spec
**names the dependency and stops** — it does not design their internals.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, an ecom
support worker that wakes on a Shopify order event (or a customer email), reads
the relevant order/customer facts through the Shopify Admin API, routes on those
facts via edge conditions, and performs gated mutations (refund / cancel /
re-ship / note) — with the admin token in the OS keychain, **never** rendered.

### In scope (MVP)

- A new **Shopify connector** module set under `src/main/shopify/`, exposing a
  static `shopifyDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus the **live dispatch** (`invokeAction` / `subscribe`)
  the merged registry currently stubs (`integration-registry.ts` lines 64-86).
- **Auth for the "for me" fork:** a **custom app Admin API access token** (the
  single `X-Shopify-Access-Token` header), stored in the keychain via
  `CredentialStore` (the `safeStorage` pattern the hub already set). The
  distributable-app **OAuth** fork is designed-for but deferred (§8, §13).
- A **GraphQL Admin API client** (`shopify-admin.ts`) — the **sole** place any
  Shopify API shape lives — implementing the read + mutation surface behind the
  pinned actions (§6.2).
- A **webhook receiver** (`shopify-webhook-server.ts`) with **HMAC-SHA256**
  verification (`X-Shopify-Hmac-Sha256` over the **raw** body), `X-Shopify-
  Webhook-Id` dedup, and the same cloud-ingress handling Linear's spec confronts
  (§4.4, §7). It normalizes a verified topic into a `SeedEvent` for the engine.
- The **pinned ecom vocabulary** (§6): three webhook-backed triggers, three read
  actions, four gated-mutation actions, and the **context-field shape** an action
  writes for downstream edge conditions.
- **Authority = the flow's gates.** Every mutation is an `action` node the author
  gates by placing a `gate` node (or a conditional edge) before it. The engine
  already enforces this (`flow-engine.ts` gate handling). No mutation ever runs
  un-gated by construction of the flow the author drew. Plus an **optional,
  deterministic ecom backstop** (per-action limits, e.g. refund ≤ $X) as a
  phased item (§9).
- **Single store, single saiife environment.** Config-as-code `shopify` block
  in `config.json` (non-secret refs only); token + webhook secret in the
  keychain.

### Out of scope (MVP) — explicitly deferred

- **Distributable / public app OAuth install** (multi-store, app-store listing,
  verification). MVP is the **"for me" fork** — one custom app in one store, its
  admin token in the keychain (§8, §13.1).
- **Multi-store fan-out.** The config/token shapes are drawn so a
  `stores: [...]` array is the additive path (§7, §14), not built now.
- **Fulfillment creation / inventory writes / product edits / discounts.** MVP's
  mutation surface is the support-loop four (`refundOrder`, `cancelOrder`,
  `updateShippingAddress`, `addOrderNote`). Everything else is phase 2+.
- **The REST Admin API.** Shopify marked REST **legacy (Oct 1 2024)**; new work
  is **GraphQL-only** (§2). The client is GraphQL from day one — no REST path is
  written, even as a fallback.
- **The richer edge-condition operators** (`gt`/`gte`/`contains`/…). Owned by the
  sibling conditions track (§10); this spec only guarantees its fields are shaped
  to be referenced by them.
- **Flow templates / the "starter ecom worker" graph.** Owned by the templates
  track, which consumes §6 verbatim.
- **Non-Shopify ecom platforms** (WooCommerce, BigCommerce). Justified as
  deferred in §2; the module boundaries are platform-shaped so a peer connector
  can reuse them.

---

## 2. Feasibility + landscape

### 2.1 Landscape — why Shopify first

| Platform | API posture for the pull→read→act loop | Verdict for MVP |
|---|---|---|
| **Shopify** | First-class **GraphQL Admin API** (orders, customers, refunds, returns), a clean **custom-app admin token** for the "for me" fork, **HTTPS webhooks** with standard HMAC signing, and well-documented, generous rate limits. The single largest hosted-commerce install base, so the dogfood + product surface is widest. | **Chosen.** Best API-to-effort ratio; the loop is buildable today. |
| **WooCommerce** | REST API is capable (orders/refunds/customers) but it's **self-hosted WordPress** — auth is per-site consumer key/secret, webhooks depend on the site being reachable and the plugin configured, and every store is a different host/version. High variance, no single identity model. | Deferred. Good *second* target precisely because it's a different auth/ingress shape that validates the connector boundary. |
| **BigCommerce** | Solid REST + GraphQL Storefront, OAuth apps, webhooks with HMAC. Comparable technically to Shopify but a **much smaller install base**, so less dogfood/product leverage per unit of build. | Deferred. Third target; architecturally close to Shopify. |

**Shopify-first rationale:** widest install base (most dogfood + product reach),
the cleanest single-token auth for the "for me" fork, a modern GraphQL surface
that covers the entire support loop, and standard HMAC webhooks that map onto the
same cloud-ingress pattern Linear's spec already solved. Woo/BigCommerce become
*peer connectors* under the same `*-connector` / `*-admin` / `*-webhook-server`
boundaries (§4), each its own auth/ingress shape.

### 2.2 The Shopify Admin API for pull → read → act

Grounded in the current Shopify developer docs (verified 2026-07-17):

- **Go-forward surface is GraphQL.** The **REST Admin API is legacy as of
  2024-10-01**; new apps must build on the **GraphQL Admin API**. We build
  GraphQL-only. (`shopify.dev/docs/api/admin-graphql/latest`.)
- **Read.** `order(id:)` and the `orders(query:)` connection expose the full
  order lifecycle (totals, currency, financial status, fulfillment status,
  line items, shipping address, customer). `customer(id:)` exposes customer
  identity + order history. This fully covers **read** (`getOrder`,
  `getCustomer`, `searchOrders`). GA.
- **Act.** `refundCreate` (create a refund, optionally with restock),
  `orderCancel` (cancel with a reason + optional refund/restock),
  `orderUpdate` (edit attributes incl. shipping address / notes), and
  `orderEditBegin`/`orderEditCommit` for structural edits. This covers the four
  gated mutations. All GA. (Refund *amount* pre-calculation uses
  `refundCreate`'s calculated-refund inputs — the GraphQL equivalent of the old
  REST `refunds/calculate`.)
- **Auth.**
  - **"For me" fork (MVP):** a **custom app created in the Shopify admin** issues
    an **Admin API access token**, sent as the `X-Shopify-Access-Token` header on
    every GraphQL request. Single long-lived secret → keychain. No OAuth dance.
    (`shopify.dev/docs/apps/build/authentication-authorization/access-tokens/
    generate-app-access-tokens-admin`.)
  - **"Product" fork (deferred):** a **distributable app** uses **OAuth
    authorization-code** to mint per-store tokens. Same header at call time; the
    difference is the *acquisition* and *multi-tenant* story (§8, §13.1).
- **Webhooks (push, not poll).** HTTPS webhook subscriptions carry a base64
  **HMAC-SHA256** signature in `X-Shopify-Hmac-Sha256`, computed over the **raw**
  request body with the app secret / webhook signing key. Verify **before**
  parsing (a body-parser that consumes the stream first breaks verification —
  the receiver reads raw bytes). Dedup on `X-Shopify-Webhook-Id`. Topics relevant
  to the loop: **`orders/create`**, **`refunds/create`**, **`orders/edited`**,
  and (for the return-request path) **`returns/request`**. Same **cloud-ingress**
  problem as Linear: Shopify posts from the cloud, so the local receiver needs a
  reachable URL (tunnel in MVP, relay in the product fork — §4.4).
- **Rate limits.** GraphQL uses a **calculated-query-cost** model (cost points):
  a leaky bucket of **1,000 points** with **50 pts/sec** restore on standard
  plans (**2,000 / 100** on Plus); a single query may not exceed **1,000
  points**, and over-budget calls return a throttled error with the bucket state.
  This is generous for the loop (a few small order/customer reads + a mutation
  per run) and is handled with cost-aware backoff in the client (§4, §11).
  Push-over-poll (webhooks) keeps us far under budget.

### 2.3 Constraints (why not pure GREEN-with-no-caveats)

1. **Two triggers are *derived*, not native 1:1 topics.** `order.created` maps
   cleanly to the native `orders/create`. But `order.refundRequested` and
   `order.flagged` are **saiife-vocabulary** triggers with *composed* sources
   (§6.1) — a customer *requesting* a refund is Shopify's `returns/request` topic
   **or** an email the customer sent (the email trigger), and "flagged" is
   derived from an order's **risk assessment** (high-risk / manual-review),
   surfaced on `orders/create` fraud fields rather than a dedicated "flagged"
   webhook. This is a naming/derivation cost, not a capability gap — noted
   honestly in §6.1 so the templates track wires the right underlying topic.
2. **Cloud ingress is mandatory for triggers.** Identical to Linear: the local
   webhook receiver needs a public URL. A tunnel in MVP; a hosted relay is the
   product-fork change (§4.4, §13.1). Read + act work over plain outbound HTTPS
   with no ingress — only *triggers* need it.
3. **Mutations are irreversible money/customer actions.** A refund or a cancel
   is real. This is a *safety* concern, not a feasibility one — and it is exactly
   what the flow's **author-placed gates** exist for (§9). The optional
   deterministic backstop (per-action limits) hardens it further.

### 2.4 Verdict: **GREEN**

The pull → read → act loop is **fully buildable today** on the GA GraphQL Admin
API, with a clean single-token auth for the "for me" fork and standard HMAC
webhooks. It is GREEN rather than YELLOW because — unlike Linear's Developer-
Preview Agents API — every surface the loop needs (order/customer reads,
`refundCreate` / `orderCancel` / `orderUpdate`, the four webhook topics) is
**generally available and stable**. The three constraints in §2.3 are naming
(derived triggers), a known ingress pattern already solved for Linear, and a
safety posture the flow engine's gates already provide. Nothing in the loop is
blocked, preview-gated, or missing.

---

## 3. The core loop → Shopify primitives

saiife's ecom loop is `trigger → read → route → act (gated)`. Each stage maps
to a concrete Shopify primitive and the concrete flow-engine mechanism that runs
it:

| Stage | Shopify primitive | saiife / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified webhook (`orders/create`, `returns/request`, or a risk-derived flag), OR a customer email (the **email** connector's trigger — the loop composes). | `shopify-webhook-server` verifies HMAC → normalizes to a `SeedEvent` → the connector's `subscribe(id, triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context (`flow-engine.ts:147`, `trigger-subscriber.ts`). |
| **read** | GraphQL `order(id:)` / `customer(id:)` / `orders(query:)`. | An `action` node (`getOrder` / `getCustomer` / `searchOrders`) → `registry.invokeAction('shopify', ref, params)` → the connector calls `shopify-admin.ts` → **resolves** the typed result, which the action-runner writes to context under the node id (`action-runner.ts:58-59`). |
| **route** | *(none — pure saiife)* | `selectEdges` evaluates edge conditions over the context the read wrote (`context.ts:88`). Today: `field === equals`; soon: the richer `FlowEdgeCondition` operators (§10) over e.g. `order.total`. **No LLM decides routing** — deterministic value compares. |
| **gate** | *(none — pure saiife)* | A `gate` node the author placed pauses the run as `needs-you` (`flow-engine.ts` gate handling); the human approves in the cockpit. A mutation node sits **downstream of the gate the author drew**. |
| **act** | GraphQL `refundCreate` / `orderCancel` / `orderUpdate` (+ `orderEditBegin/Commit`). | The gated `action` node (`refundOrder` / `cancelOrder` / `updateShippingAddress` / `addOrderNote`) → `invokeAction` → `shopify-admin.ts` mutation. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* Shopify error (`action-runner.ts:60-66`). |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities* (read actions, mutation actions, triggers); the *flow*
decides which run, in what order, behind which gates, under which edge
conditions. This is the whole point of the ecom-worker direction: not a hardcoded
support pipeline, but a worker the user assembles with the authority they choose.

---

## 4. Architecture in saiife

### 4.1 Where it sits

A new **main-process module set** under `src/main/shopify/`, mirroring
`src/main/integrations/` (the hub) and the connector-spec module pattern
(`*-connector` / `*-admin` client / `*-webhook-server` / token store / config).
It is **opt-in**: with no `shopify` config entry (and no stored token) the
descriptor's `status()` returns `needs-config` and the engine refuses any Shopify
node (`action-runner.ts:42`) — saiife's "works with no integration"
guarantee is unchanged.

The connector is, architecturally, **the live implementation behind the
registry's pinned `invokeAction` / `subscribe`**. The merged
`IntegrationRegistry` ships those as stubs (a legible "not wired yet" reject / a
no-op unsubscribe — `integration-registry.ts:64-86`). This connector is the
**first live dispatch**: it provides a `ShopifyConnector` that the registry
delegates to (§4.3). All Shopify API shapes are isolated in `shopify-admin.ts`
(the blast radius for any API-version bump), exactly as Linear isolated its
GraphQL in `linear-client.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/shopify/shopify-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'shopify'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids (the contract the templates track consumes). Mirrors `descriptors/linear.ts`. |
| `src/main/shopify/shopify-connector.ts` | Orchestrator + the live `invokeAction`/`subscribe` impl. Dispatches an action id → an `shopify-admin` call (params templated by the engine); dispatches a trigger id → a webhook-server subscription. Owns the in-memory webhook-id dedup set. The one place the loop's dispatch lives. |
| `src/main/shopify/shopify-admin.ts` | Thin **GraphQL Admin API** client. **All** Shopify request/response shapes (queries, mutations, error envelope) live *only* here. Cost-aware backoff on throttle. Isolated behind a `ShopifyApi` interface so tests inject a `MockShopifyApi` (§12). |
| `src/main/shopify/shopify-webhook-server.ts` | HTTPS receiver. Mirrors `hook-server.ts` (createServer, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`, `responded` guard) **plus** HMAC-SHA256 verification over the **raw** body (`timingSafeEqual(sha256hmac(...))`, exactly the pattern `hook-server.ts` / `operator-grant.ts` use), `X-Shopify-Webhook-Id` dedup, and cloud-ingress handling (§4.4). Emits a normalized `SeedEvent`; never trusts shape. |
| `src/main/shopify/shopify-token-store.ts` | Keychain-backed token access. In MVP this is a **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('shopify', 'adminToken')`) — the connector reuses the existing keychain sidecar, it does not open a second one. Named distinctly so a grep test asserts no IPC/renderer caller (the `revealForConnector` discipline). |
| `src/main/shopify/shopify-config.ts` | Reads the non-secret `shopify` refs from the integrations config block (shop domain, api version, environment, webhook url) — the `integration-config.ts` validate-at-the-boundary pattern. (In practice these are the descriptor's non-secret `configFields`, so most validation is free via the hub; this module holds only Shopify-specific coercion, e.g. shop-domain normalization.) |
| `src/main/shopify/shopify-normalize.ts` | **Pure** mapping: a raw Shopify GraphQL order/customer node → the pinned **context-field shape** (§6.3); and a raw webhook topic payload → a `SeedEvent`. Unit-testable in isolation (mirrors `status-map.ts` / `state-machine.ts` purity). This is where GID→id, money-string→number, and status-enum normalization happen — **once**, so conditions read a stable shape. |
| `src/shared/shopify.ts` | Shared types (`ShopifyOrderContext`, `ShopifyCustomerContext`, the action param shapes, the trigger payload shapes) needed by both main and any renderer palette surface. |

### 4.3 Wiring the live dispatch into the merged registry

The pinned `IntegrationDescriptor` interface (`integrations.ts:21-28`) is
**status-only** — it cannot carry `invoke`/`subscribe` (and a method can't cross
the IPC structured-clone boundary anyway — `integrations.ts:138-146`). So live
dispatch must live in the **registry**, not the descriptor. The additive seam:

- Define a minimal `LiveConnector` interface (`invokeAction(actionId, params):
  Promise<unknown>`, `subscribe(triggerId, handler): () => void`).
- `IntegrationRegistry` gains an optional `connectors: Partial<Record<
  IntegrationId, LiveConnector>>` dep. Its pinned `invokeAction`/`subscribe`
  (today's stubs at lines 64-86) become: *if a connector is registered for `id`,
  delegate to it; else the existing legible "not wired yet" reject / no-op.*
- `src/main/index.ts` constructs the `ShopifyConnector` (given the
  `CredentialStore`, config, and the webhook server) and passes it in the
  `connectors` map. Linear/email/cloud connectors slot into the same map as they
  land — this spec's seam is the general one, Shopify is just its first user.

This keeps the pinned contract **byte-for-byte unchanged** (the registry still
`implements IntegrationRegistryContract`), turns the stub into a dispatcher, and
localizes every Shopify concern under `src/main/shopify/`.

### 4.4 Receiving webhooks (the cloud-ingress problem)

Identical in shape to Linear's §4.4 — Shopify posts from the cloud, the local
receiver binds loopback:

- **MVP ("for me" fork):** a developer tunnel (ngrok / Cloudflare Tunnel, or a
  small always-on relay) forwards to the local `shopify-webhook-server`; the
  webhook subscription's `address` is that tunnel URL, stored as the non-secret
  `webhookUrl` config ref. Whole loop stays on the user's machine (local-first),
  at the cost of a running tunnel. A documented v1 prerequisite.
- **Phase 2 ("product" fork):** a thin hosted relay that HMAC-authenticates then
  forwards over a durable channel (or the desktop long-polls the relay). Flagged
  in §13 — it changes distribution.

Regardless of ingress, the receiver **verifies HMAC-SHA256 over the raw body**
(timing-safe), enforces `MAX_BODY_BYTES`, **dedups on `X-Shopify-Webhook-Id`**,
and responds **200 fast** — the run is started after the response so Shopify's
delivery-timeout expectation is met and a slow flow never causes a redelivery
storm. A bad / oversized / forged / duplicate delivery is dropped (4xx or 200-
dedup) and **never** seeds a run.

### 4.5 Reused saiife surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` this connector satisfies; the `IntegrationStatus` union;
  `ResolvedIntegrationDescriptor` transport.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses (`revealForConnector` is the sole plaintext exit,
  main-process-only).
- `src/main/integrations/integration-registry.ts` — where the live-dispatch seam
  (§4.3) attaches; where `status('shopify')` is derived from config + credential
  presence.
- `src/main/flow/flow-engine.ts` / `node-runners/action-runner.ts` — how an
  action is invoked (`invokeAction`, **reject = failure**) and how its resolved
  value lands in context for conditions.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` starts runs; the
  `coerceEvent` / `matchesFilter` normalization the webhook `SeedEvent` flows
  through.
- `src/main/flow/context.ts` — `resolveField` / `selectEdges`: the dotted-path
  read (`order.total`) and boolean routing the pinned fields are designed for.
- `src/main/hook-server.ts` — the loopback receiver pattern the webhook server
  mirrors (createServer, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`,
  `timingSafeEqual`, `responded` guard) + the HMAC/ingress additions.

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `shopifyDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS` (`descriptors/index.ts`). The registry attaches the
presence-derived `status()` (`connected` | `needs-config` | `error` |
`disabled`) exactly as it does for the other three — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `adminToken` | Shopify Admin API access token | **yes** | yes | string | The custom-app `X-Shopify-Access-Token`. Keychain only. Placeholder `shpat_…`. |
| `webhookSecret` | Webhook signing secret | **yes** | yes | string | Verifies `X-Shopify-Hmac-Sha256`. Keychain only. |
| `shopDomain` | Store domain | no | yes | string | `your-store.myshopify.com`. Non-secret ref. |
| `apiVersion` | Admin API version | no | no | string | e.g. `2025-07`; defaults to a pinned version in `shopify-admin.ts`. |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts Shopify work (same field/validation as Linear's). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay `address` (§4.4). Placeholder `https://<tunnel>/shopify/webhook`. |

`status('shopify')` therefore reports `needs-config` until `adminToken`,
`webhookSecret`, `shopDomain`, and `environment` are all present; `error` if a
stored secret can't be decrypted (the hub's `decryptionError` path); `disabled`
if configured-but-turned-off; `connected` otherwise. The action-runner refuses
any non-`connected` Shopify node before any network call (`action-runner.ts:42`).

---

## 6. Pinned ecom vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `shopify-descriptor.ts` guards the ids; the field shape is guarded by the
> `shopify-normalize.ts` tests.

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'shopify'`:

```ts
export type IntegrationId = 'linear' | 'email' | 'cloud' | 'shopify'
```

This is a **shared-union edit** with three companion touch-points that must move
in lockstep (each is a one-line add): `INTEGRATION_IDS` (the stable order array,
`integrations.ts:58`), the `INTEGRATION_IDS` set in `flow-model.ts:22` (the flow
validator's allow-list), and `DESCRIPTOR_DEFS` (`descriptors/index.ts`). No other
`IntegrationId` consumer needs a change — they iterate the array.

### 6.1 Triggers (webhook-backed)

| trigger id | label | underlying Shopify source | note |
|---|---|---|---|
| `order.created` | New order placed | **`orders/create`** webhook (native, 1:1). | The clean case. |
| `order.refundRequested` | Customer requested a refund | **`returns/request`** webhook (native return-request), **and/or composes with the email trigger** — a customer emailing "I want a refund" fires the **email** connector's trigger, and the flow reads the order by email via `searchOrders`. | *Derived*: two honest sources; the templates track picks per store. |
| `order.flagged` | Order flagged for review | Derived from the order's **risk assessment** (high-risk / manual-review), surfaced on the `orders/create` payload's fraud fields (no dedicated "flagged" topic exists). | *Derived*: the webhook server sets a `flagged: true` payload field when risk is high; the trigger filters on it. |

**Composition with email.** The ecom worker's most common wake-up is a customer
*message*, which is the **email** connector's domain. Shopify triggers cover
order/return *events*; the email trigger covers *inbound customer messages*. A
real support flow often has **both** as trigger candidates (two flows, or one
flow per channel), joined by reading the same order via `searchOrders(email:)`.
This spec pins the Shopify triggers; the templates track wires the composition.

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | Shopify GraphQL | writes to context |
|---|---|---|---|
| `getOrder` | Get an order | `order(id:)` | `ShopifyOrderContext` (§6.3) |
| `getCustomer` | Get a customer | `customer(id:)` | `ShopifyCustomerContext` (§6.3) |
| `searchOrders` | Search orders | `orders(query:)` | `{ orders: ShopifyOrderContext[]; count }` |

**Gated mutation (the author places a gate before these):**

| action id | label | Shopify GraphQL | note |
|---|---|---|---|
| `refundOrder` | Refund an order | `refundCreate` | Amount from params or calculated; optional restock. **Irreversible.** |
| `cancelOrder` | Cancel an order | `orderCancel` | With a reason; optional refund + restock. **Irreversible.** |
| `updateShippingAddress` | Update shipping address | `orderUpdate` (or `orderEditBegin`/`Commit` if structural) | Pre-fulfillment only; the connector surfaces a legible error if already fulfilled. |
| `addOrderNote` | Add an order note | `orderUpdate(note:)` / `note` attribute | The low-risk annotate action; safe to leave un-gated if the author chooses, but still an action node. |

**Failure convention (pinned):** a mutation that fails **rejects** its promise
with the real Shopify error text; a resolved promise (any value) is success and
its value becomes the node's context output (`action-runner.ts:52-66`,
`integrations.ts:33-43`). The connector never resolves a sentinel-failure.

### 6.3 Context-field shape (what an action writes for later conditions)

A read action writes a **normalized, stable** object under its node id
(`shopify-normalize.ts` produces it — GIDs reduced to ids, money as numbers,
statuses as lowercase enums). Downstream edge conditions read it via dotted paths
(`context.ts` `resolveField`), e.g. `{{getOrder.order.total}}` in an action
param, or `field: 'getOrder.order.total'` in an edge condition. **Pinned shape:**

```ts
// src/shared/shopify.ts
export interface ShopifyOrderContext {
  order: {
    id: string            // numeric order id (GID reduced), e.g. "5123456789"
    name: string          // human order name, e.g. "#1001"
    total: number         // total_price as a Number (major units), e.g. 42.5
    currency: string      // ISO 4217, e.g. "USD"
    status: 'open' | 'closed' | 'cancelled'          // order status
    financialStatus:                                   // payment state
      'pending' | 'authorized' | 'paid' | 'partially_paid'
      | 'refunded' | 'partially_refunded' | 'voided'
    fulfillmentStatus:                                 // shipment state
      'unfulfilled' | 'partial' | 'fulfilled' | 'restocked'
    email: string         // contact email on the order
    createdAt: string     // ISO 8601
    flagged: boolean      // risk-derived (§6.1); true = high-risk/manual-review
    lineItemCount: number // convenience for conditions
  }
  customer: {             // the order's customer (may be absent → fields undefined)
    id: string
    email: string
    name: string          // display name (first + last)
  }
}

export interface ShopifyCustomerContext {
  customer: {
    id: string
    email: string
    name: string
    ordersCount: number   // lifetime order count (loyalty conditions)
    totalSpent: number    // lifetime spend as a Number
    currency: string
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts:91`, and soon the typed `FlowEdgeCondition` operators of
§10). Money as a *number* lets `order.total gt 100` work; a raw Shopify money
*string* (`"42.50"`) would compare lexically and silently misroute. Normalizing
once, in one pure module, is the correctness boundary. The templates track and
the conditions track both rely on these exact paths and types.

---

## 7. Data flow — a real ecom loop, node by node

**Scenario the author drew on the canvas:** *"When a customer requests a refund,
if the order is ≤ $50 and paid, auto-refund with restock; otherwise pause for
me."* This is **not** hardcoded — it's the graph below, and the author could
draw it a dozen other ways.

```
[trigger: order.refundRequested]        Shopify returns/request webhook (or email trigger)
        │  payload → context['t'] = { orderId, email, ... }
        ▼
[action: getOrder]                       ref=getOrder, params={ id: "{{t.orderId}}" }
        │  invokeAction('shopify','getOrder',…) → shopify-admin.order() → normalize
        │  writes context['read'] = ShopifyOrderContext
        ▼
[router]                                 explicit branch point
   ├── edge condition: read.order.financialStatus == 'paid'
   │        AND (richer, §10) read.order.total lte 50
   │        ▼
   │   [action: refundOrder]             GATED? author left it un-gated for ≤$50 auto-path
   │        │  invokeAction('shopify','refundOrder',{ id:"{{t.orderId}}", restock:true })
   │        │  refundCreate → resolves { refundId, amount } → context['refund']
   │        ▼
   │   [action: addOrderNote]            note="Auto-refunded via saiife worker"
   │        ▼   (done)
   │
   └── edge condition: (else — total > 50 or not paid)
            ▼
        [gate: "approve refund"]         pauses run as needs-you; human reviews in cockpit
            │  approved ──► [action: refundOrder] ──► [action: addOrderNote] ──► done
            │  rejected ──► run ends 'rejected' (a human "no" is not a failure)
```

Node-by-node against the engine:

1. **Trigger fires.** `shopify-webhook-server` verifies HMAC, dedups, 200s fast,
   normalizes the `returns/request` payload to a `SeedEvent`
   (`{ eventId: webhookId, payload: { orderId, email, ... } }`), hands it to the
   connector's `subscribe` handler → `subscribeTriggers` → `startRun`
   (`flow-engine.ts:147`). Trigger node is immediately `done`; payload is in
   `context['t']`.
2. **`getOrder` reads.** The action-runner templates params
   (`id: "{{t.orderId}}"` → the real id via `context.ts` `applyTemplate`),
   confirms `status('shopify') === 'connected'`, calls `invokeAction`. The
   connector calls `shopify-admin.order(id)`, `shopify-normalize` maps it to
   `ShopifyOrderContext`, the connector **resolves** it → the runner writes
   `context['read']` (`action-runner.ts:58-59`).
3. **Router branches.** `selectEdges` evaluates each out-edge's condition over
   `context['read']` — today `financialStatus === 'paid'`; with §10,
   `total lte 50`. Deterministic, no LLM.
4. **Gated mutation.** On the human-review branch, the `gate` node pauses the run
   `needs-you`; the human approves (or rejects → run ends `rejected` cleanly,
   `flow-engine.ts:306-320`). On approval the `refundOrder` action runs
   `refundCreate`; a Shopify error **rejects** and the run fails with the real
   message (§11). On success the resolved `{ refundId, amount }` is in context.
5. **Annotate + finish.** `addOrderNote` records what happened; the run completes
   `done`.

The same trigger + read + fields support arbitrarily different graphs (VIP
auto-approve, fraud-hold, partial refunds, escalate-to-human-always). The
connector supplies capability + facts; the **author supplies authority**.

---

## 8. Auth & keychain

- **"For me" fork (MVP).** A **custom app in the Shopify admin** issues an **Admin
  API access token**. The user pastes it into the descriptor's masked
  `adminToken` field; it goes straight to the keychain via `CredentialStore.set`
  (`credential-store.ts:61`). Every GraphQL request sends it as
  `X-Shopify-Access-Token` — read at call time via
  `revealForConnector('shopify','adminToken')` (main-process-only, the sole
  plaintext exit; a grep test asserts no IPC/renderer caller —
  `credential-store.ts:94-105`). No OAuth, no refresh: the token is long-lived
  until the user rotates it in the Shopify admin.
- **Webhook secret.** Stored the same way (`webhookSecret`), used only inside
  `shopify-webhook-server` to `timingSafeEqual` the `X-Shopify-Hmac-Sha256`
  header against `hmacSha256(rawBody, secret)`.
- **Honoring the global secret rule.** Neither the token nor the webhook secret
  is **ever** written to `config.json`, `sessions.json`, the transcript, a log, a
  PR body, or any IPC payload. `config.json` holds only **references** (shop
  domain, api version, that an install exists — §5). Token **state** (present /
  decrypt-failing) may be surfaced via `status()`; the **value** never is. This
  is the hub's existing discipline (`integration-config.ts:71-79` drops a secret
  found in config.json with a loud notice) applied to Shopify verbatim.
- **"Product" fork (deferred, §13.1).** A distributable app uses OAuth
  authorization-code to mint per-store tokens (multi-tenant, refreshable). The
  keychain shape already supports per-key storage; the additive change is an
  `shopify-oauth.ts` module and a `stores[]` config array. Same
  `X-Shopify-Access-Token` at call time — only *acquisition* differs.
- **Disconnect.** Clearing the `adminToken` / `webhookSecret` (the hub's
  `clearSecret`) flips `status()` to `needs-config`; the connector stops
  dispatching and the webhook subscription can be deleted from Shopify. No
  in-flight run is force-killed — it simply can't start a new Shopify action, and
  reports why (§11).

---

## 9. Authority & safety

**Primary control — the flow's gates (already enforced).** Every mutation
(`refundOrder`, `cancelOrder`, `updateShippingAddress`, and optionally
`addOrderNote`) is an `action` node. Authority is whatever the author wired: a
`gate` node placed before the mutation pauses the run `needs-you` for human
approval; a conditional edge restricts *when* the mutation is even reached. The
engine already implements this — a gate the author drew is honored, a human "no"
ends the run `rejected` (not a failure), and a mutation with no path to it never
runs (`flow-engine.ts` gate handling + `selectEdges`). **The connector never
auto-mutates outside the graph the author drew.** There is no "connector default
policy" that fires a refund on its own — the connector only does what an action
node invokes.

**Optional deterministic backstop (phased — §14 Phase 3).** Gates are the user's
authored control; a backstop is a *deterministic floor* under them, for the case
where a flow is mis-authored or an LLM-seeded param is wrong. Proposal, in the
spirit of **saiifeguard** (`guard/`, the Rust destructive-command guard) but as an
**ecom policy** rather than a shell tokenizer:

- A small, declarative `shopify.limits` config block (non-secret): e.g.
  `{ refundMaxAmount: 100, cancelRequiresGate: true, allowUnfulfilledAddressEditOnly: true }`.
- Enforced **inside the connector**, before the `shopify-admin` mutation call, as
  a hard reject (the pinned failure convention): a `refundOrder` for $250 with
  `refundMaxAmount: 100` **rejects** with a legible "refund $250 exceeds the
  configured $100 ecom limit — raise `shopify.limits.refundMaxAmount` or route it
  through a human gate." Deterministic, no model in the loop, exactly saiifeguard's
  posture.
- This is **defense in depth**, not the primary control: the author's gate is the
  intended safety mechanism; the limit is a floor that holds even if the gate was
  omitted. Flagged as an open decision (§13.2) because its *default* (present vs
  absent, and at what value) is a product call.

**Never render secrets.** The admin token lives in the keychain; no error message,
log line, or context field ever contains it (§8, §11).

---

## 10. Richer-conditions dependency (owned elsewhere — named, not designed)

The flow engine's edge conditions today are `field === equals` (`context.ts:91`,
`flow-model.ts:71-82`). A **sibling conditions track** is upgrading them to a
typed `FlowEdgeCondition`:

```ts
// OWNED BY THE CONDITIONS TRACK — reproduced here only to state the dependency.
interface FlowEdgeCondition {
  field: string
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'truthy'
  value?: unknown
}
```

The fields this spec pins (§6.3) are **designed to be referenced by those
operators**: `order.total` as a **number** so `gt`/`gte`/`lt`/`lte` are
meaningful; `financialStatus` / `fulfillmentStatus` as lowercase **enums** so
`eq`/`ne` are exact; `flagged` as a **boolean** for `truthy`; `email` /
`customer.name` as strings for `contains`; the `customer` sub-object present-or-
absent for `exists`. **This spec does not design the condition system** — it only
guarantees its field types are the ones those operators expect, and normalizes
(in `shopify-normalize.ts`) so the types are stable at condition-eval time. The
dependency is one-directional: conditions depend on these field types; this
connector does not depend on the operator set landing first (it works under the
current `eq`-only routing, just less expressively).

---

## 11. Error handling

saiife's principle (error-message-style memory; demonstrated in
`credential-store.ts` and `action-runner.ts`): **every failure is human-readable,
actionable, and carries the real underlying exception. No silent catch. No bare
"failed" / "not found".** A mutation signals failure by **rejecting** its promise
with that message; the action-runner prefixes it and surfaces it on the run
(`action-runner.ts:60-66`).

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook HMAC invalid** | signature mismatch (never the body or secret) | Receiver `console.warn` route + reason only; 401; **no run started**. Mirrors `control-api`'s "never log token material". |
| **Webhook duplicate** (`X-Shopify-Webhook-Id` seen) | the webhook id | 200 (Shopify redelivery is expected); dedup-drop; no second run. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | 4xx; dropped; no run. Never spawns on unvalidated shape. |
| **`status('shopify') !== 'connected'`** | the derived reason (missing token / decrypt error / disabled) | The action-runner fails the node *before* any call: "Flow needs Shopify connected — action '<id>' can't run. Connect it in Settings." (`action-runner.ts:42-47`). |
| **Admin token invalid/revoked (HTTP 401)** | Shopify's auth error message | `invokeAction` **rejects**: "Shopify rejected the admin token (401 Unauthorized) — the token was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing scope (403 / GraphQL access-denied)** | Shopify's scope error | Rejects with the verbatim scope requirement: "Shopify refused 'refundCreate': the custom app is missing the `write_orders` scope — add it in the app's config." |
| **Order/customer not found** | the id that missed | Rejects: "Shopify has no order '<id>' (it may be from another store or was deleted)." — actionable, not a bare 404. |
| **Rate-limit / throttle (GraphQL `THROTTLED`)** | the bucket state (`currentlyAvailable`/`restoreRate`) | `shopify-admin` retries with **cost-aware backoff** honoring the returned bucket; only after exhausting retries does it reject with "Shopify throttled the request (bucket empty; retry in ~Ns)". Not swallowed. |
| **Refund/cancel business rejection** (e.g. already refunded, already fulfilled) | the verbatim Shopify `userErrors[]` | Rejects with the field + message: "Shopify refused the refund: order already fully refunded (`userErrors: already_refunded`)." The run fails with the true reason, never a silent no-op. |
| **Backstop limit exceeded** (§9) | the limit + the attempted value | Rejects **before** the call: "refund $250 exceeds the configured $100 ecom limit — raise `shopify.limits.refundMaxAmount` or route it through a human gate." |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "Shopify webhook URL '<url>' is unreachable — no order events will arrive." Never a silent dead trigger. |
| **API version removed** | Shopify's version error | Rejects: "Shopify API version '<v>' is no longer served — bump `apiVersion` in Settings." (all shapes are in `shopify-admin.ts`, so the bump is one file — §4.1). |

The connector **never** catches-and-drops. Where Shopify already returns a
precise `userErrors[]` message, the connector forwards *that* rather than minting
a vaguer one — the action-runner's job is only to prefix it with the node/action.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Shopify store**, matching saiife's existing seams
(pure modules, injected backends, fixture events):

- **`ShopifyApi` interface + `MockShopifyApi` seam.** `shopify-admin.ts` is
  written *against* a `ShopifyApi` interface (`order`, `customer`, `orders`,
  `refundCreate`, `orderCancel`, `orderUpdate`); the real impl wraps the GraphQL
  transport. Tests inject a `MockShopifyApi` returning canned nodes and canned
  `userErrors[]` / throttle envelopes. **No test ever performs a live Shopify
  call**; CI has no Shopify credentials. (Same posture as Linear's mocked GraphQL
  transport and the `SessionManager` `spawnFn` seam.)
- **`shopify-normalize.ts` unit tests** — pure function; assert every raw
  order/customer node → the pinned `ShopifyOrderContext`/`ShopifyCustomerContext`
  shape (§6.3): GID→id reduction, money-string→number, status-enum lowercasing,
  absent-customer → undefined fields, `flagged` derivation. This is the
  correctness boundary the conditions track depends on, so it's guarded hardest.
- **`shopify-webhook-server` unit tests** — feed fake `orders/create` /
  `returns/request` / `orders/edited` bodies with **valid and invalid HMAC**,
  oversized bodies, malformed JSON, and **duplicate `X-Shopify-Webhook-Id`**;
  assert 200/4xx/401 and that only valid+signed+novel events produce a
  `SeedEvent`. Reuses the `hook-server.ts` boundary-test approach.
- **`shopify-connector` dispatch tests** — with a `MockShopifyApi` + a fake
  registry: assert `invokeAction('shopify','getOrder',…)` resolves the normalized
  context; assert a `userErrors[]` response **rejects** with the verbatim message
  (the pinned failure convention); assert the backstop limit rejects before the
  mock is called.
- **Engine integration test (offline)** — wire the real `FlowEngine` + the
  registry with the Shopify connector over a `MockShopifyApi`, drive the §7 loop:
  inject a `returns/request` `SeedEvent` → assert `getOrder` writes context →
  assert the router selects the ≤$50 edge → assert `refundOrder` calls the mock →
  assert the gate branch pauses `needs-you` on the >$50 path. Deterministic via
  the engine's injected `now()` (`flow-engine.ts:34`).
- **Token-store test** — `revealForConnector` round-trip via a fake
  `SecretBackend`; a regression guard asserts **no token value appears** in any
  emitted log/console/error string (the secret rule).
- **Snapshot test on `shopifyDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

No test requires Shopify credentials or a live store; the real Admin API is
exercised only in manual dogfooding against a development store.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **"For me" vs "a product others install."** The biggest fork.
   - *For me* (MVP): one **custom app** in Jonas's own dev store, its admin token
     in his keychain, a dev tunnel for ingress. No OAuth, no app-store listing,
     no multi-tenant relay. Fastest to a dogfoodable ecom worker.
   - *Product*: a **distributable OAuth app** (verification, per-store install,
     `stores[]` config, a hosted webhook relay — §4.4 phase 2, §8). Changes auth
     (OAuth + refresh), ingress (relay), config (multi-store), and testing
     (multi-tenant). Recommendation: build MVP "for me", keep the client/token/
     config shapes multi-store-ready (they already are — §4.3, §8).
2. **The ecom safety backstop — default present or absent, and at what value?**
   §9's per-action limits are proposed as **optional** and off by default (the
   author's gate is the primary control). But a shipped ecom worker arguably
   *should* ship with a conservative default (e.g. `refundMaxAmount` set, cancel
   gate-required) so a mis-authored flow can't fire a large refund. This is a
   product-safety call, not a technical one — flagged for a decision before the
   backstop phase (§14 Phase 3). Whatever the default, it is **deterministic**
   (saiifeguard-style), never model-mediated.
3. **`order.refundRequested` source — `returns/request` vs email composition.**
   Both are honest sources (§6.1). Which the **starter template** wires (and
   whether MVP ships both) is a templates-track decision that depends on how
   stores actually receive refund requests (native returns vs email). Flagged so
   the templates track owns it with eyes open.
4. **Webhook subscription management — manual vs programmatic.** MVP can have the
   user create the webhook subscriptions in the Shopify admin (pointing at their
   tunnel), or the connector can create them via `webhookSubscriptionCreate` on
   connect. Programmatic is nicer UX but adds a scope + a teardown story. Leaning
   manual for the MVP slice, programmatic in phase 2.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One store, one flow, the read + one gated mutation, happy path:**

1. `IntegrationId` gains `'shopify'` (+ the three lockstep touch-points, §6.0);
   `shopifyDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from
   config + keychain presence (free from the hub).
2. `adminToken` + `webhookSecret` + `shopDomain` stored (token/secret →
   keychain); `status('shopify') === 'connected'`.
3. `shopify-admin.ts` behind `ShopifyApi`: `getOrder` (`order(id:)`) live;
   `refundOrder` (`refundCreate`) live. `shopify-normalize` produces
   `ShopifyOrderContext`.
4. The registry live-dispatch seam (§4.3): `invokeAction('shopify',…)` reaches
   the connector; `subscribe('shopify','order.created',…)` reaches the webhook
   server.
5. `shopify-webhook-server` handling **`orders/create`** with HMAC + dedup,
   behind a dev tunnel, emitting a `SeedEvent`.
6. On the canvas: `[order.created] → [getOrder] → [gate] → [refundOrder]` runs
   end-to-end. Errors per §11.

That slice proves the whole loop (a real order event wakes a real flow that reads
the order and, behind a gate, refunds it) and is dogfoodable against a Shopify
development store.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. "For me" fork. `order.created` +
  `getOrder` + `refundOrder` + author gate. Single store, single environment.
- **Phase 2 — full vocabulary:** the rest of §6 — `getCustomer` / `searchOrders`;
  `cancelOrder` / `updateShippingAddress` / `addOrderNote`; the
  `order.refundRequested` (`returns/request`) and `order.flagged` (risk-derived)
  triggers; programmatic webhook-subscription management (§13.4); the email-trigger
  composition wired by the templates track.
- **Phase 3 — deterministic ecom backstop:** the `shopify.limits` policy (§9),
  saiifeguard-style, with the default decided (§13.2). Per-action limits enforced in
  the connector before any mutation.
- **Phase 4 — richer conditions consumption:** once the conditions track lands
  `FlowEdgeCondition` (§10), verify the pinned fields drive `gt`/`lte`/`contains`/
  `truthy`/`exists` end-to-end; ship the "money-threshold auto-refund" template.
- **Phase 5 — product fork:** distributable OAuth app, hosted webhook relay,
  `stores[]` multi-store isolation (§13.1). App-store viability.
- **Phase 6 — expand platforms:** **WooCommerce** next (different auth/ingress —
  validates the connector boundary), then **BigCommerce**. Each a peer under
  `src/main/woocommerce/` / `src/main/bigcommerce/`, reusing the
  `*-connector` / `*-admin` / `*-webhook-server` / `*-normalize` shape. No shared
  cross-platform standard — each is its own connector.

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` contract this connector satisfies; `IntegrationId` (edited,
  §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses; `revealForConnector` (main-only plaintext exit),
  `decryptionError` (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — the live-dispatch seam
  (§4.3) attaches here (turning the `invokeAction`/`subscribe` stubs into a
  connector dispatcher); `deriveStatus` gives Shopify its status for free.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary
  config parsing the `shopify` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `shopify`;
  `descriptors/linear.ts` is the descriptor-as-code template.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs;
  `coerceEvent` / `matchesFilter` the webhook `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`order.total`) + boolean routing over the pinned fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` for deterministic tests.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0);
  the strict graph validator.
- `src/main/hook-server.ts` — the loopback receiver pattern the webhook server
  mirrors (createServer, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`,
  `timingSafeEqual`, `responded`) + the HMAC / cloud-ingress additions.
- `guard/` (saiifeguard) — the deterministic-guard *posture* the optional ecom
  backstop (§9) borrows (a policy floor under the author's gates, no model in the
  loop).
