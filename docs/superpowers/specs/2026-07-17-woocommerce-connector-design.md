# WooCommerce Connector — Design

**Date:** 2026-07-17
**Status:** Design (spec) — not started. Design-approval gate for the
WordPress-ecom sibling of the Shopify connector (the ecom-worker direction of
the integration-scope brainstorm; see the memory note *Product integration
directions*).
**Feature:** Assemble an **ecom-worker** on the just-merged flow-builder: a flow
whose worker agent reads a customer message, **pulls order/customer info** from a
WooCommerce store via its REST API, and **acts** (reply / refund / cancel / note)
with exactly the authority the user wires into the flow graph — never more. The
store never mutates unless a flow node says so.

**Deliberate sibling of** `docs/superpowers/specs/2026-07-17-shopify-connector-design.md`
(being written in a parallel worktree). This spec keeps the ecom vocabulary
**aligned** with Shopify's so a single flow template can target either platform;
it flags every place WooCommerce **genuinely diverges** (self-hosted URL, two
secrets, no native refund-request webhook, undocumented rate limits, REST not
GraphQL).

Ground truth for the flow-builder contract this connector satisfies:
`src/shared/integrations.ts` (pinned `IntegrationDescriptor` / `IntegrationRegistry`),
`src/main/integrations/*` (`CredentialStore` keychain + descriptor pattern to
copy), `src/main/flow/*` (how `subscribe` → a run and `invokeAction` → an action
node actually work). Style/depth template: the Linear and email connector specs
(`docs/superpowers/specs/2026-07-16-{linear-integration,email-execution}-design.md`).

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife flow subscribe to a WooCommerce store
event (a new order, or a derived refund-request), **read** the order/customer
behind it via the WC REST API, and **act** on it through gated-mutation actions
(refund / cancel / re-address / note) whose authority is the flow graph — with
the store's API keys held in the OS keychain and **never rendered anywhere**.

### In scope (MVP)

- A new **`woocommerce` integration** satisfying the pinned `IntegrationDescriptor`
  in `src/shared/integrations.ts` (`IntegrationId` gains `'woocommerce'`), authored
  as a descriptor def in `src/main/integrations/descriptors/woocommerce.ts`.
- **Live dispatch** — a connector module set under `src/main/woocommerce/` that
  provides the real `invokeAction`/`subscribe` behavior the registry stubs today
  (`integration-registry.ts` currently rejects `invokeAction` with a legible
  "not wired yet"; the Woo connector is one of the modules that replaces that
  stub for its id).
- **Read actions** (pull): `getOrder`, `getCustomer`, `searchOrders`.
- **Gated-mutation actions** (act, flow-authorized only): `refundOrder`,
  `cancelOrder`, `updateShippingAddress`, `addOrderNote`.
- **Triggers**: `order.created` (native WC webhook) and `order.refundRequested`
  (derived — see §6.1 / §10; WC has no native refund-request event).
- **Context fields** written for the router/condition layer:
  `order.{id,total,currency,status,email}`, `customer.{id,email,name}`.
- **Auth**: WooCommerce REST API **consumer key + consumer secret** (both
  SECRETS → keychain), plus a non-secret **store base URL** config field, over
  **HTTPS only**.
- **Webhook ingress**: a receiver that verifies WooCommerce's
  `X-WC-Webhook-Signature` (base64 HMAC-SHA256) before any event reaches a flow.
- Single store, single saiife environment. Keys in `safeStorage`, **never**
  logged, echoed to IPC, or written to `config.json`.

### Out of scope (MVP) — explicitly deferred

- **The FlowEdgeCondition schema** (`{ field; op; value? }`) — a sibling
  sub-project owns it. This connector only *produces* the `order.*` / `customer.*`
  context fields that feed conditions; it does **not** design conditions (§4.5).
- **Multi-store / multi-environment** fan-out (config shaped to make it additive).
- **`order.updated` firehose** and refund-created reconciliation (phase 2).
- **Product-fork ingress** (hosted webhook relay, guided "Connect a store"
  wizard). MVP is the "for me" fork: keys pasted, a dev tunnel for ingress (§4.4).
- **Non-Woo ecom platforms** — Shopify is the parallel sibling; BigCommerce/Medusa
  later, each its own connector (no shared ecom standard).

---

## 2. Feasibility — the real WooCommerce REST API

Research basis: WooCommerce REST API v3 (GA, stable, documented at
`woocommerce.github.io/woocommerce-rest-api-docs`) running on self-hosted
WordPress + the WooCommerce webhooks subsystem.

### 2.1 Auth (contrast with Shopify)

- **Credential:** a **consumer key** + **consumer secret** generated in
  *WooCommerce ▸ Settings ▸ Advanced ▸ REST API*, each with a read / read-write
  permission. Over **HTTPS** the API accepts them as **HTTP Basic Auth** (key =
  username, secret = password). **Both are secrets → keychain.**
- **Divergence from Shopify:** Shopify authenticates with a *single* admin API
  access token (or an OAuth token). WooCommerce needs a **pair**, and — because
  the store is **self-hosted** — the **store base URL is user-supplied** and must
  be a first-class config field. Shopify's endpoint is a known-shape
  `<shop>.myshopify.com`; a WooCommerce store can live at any URL the user runs.
- **HTTPS is mandatory.** Over plain HTTP, WooCommerce falls back to OAuth 1.0a
  one-legged signing; MVP **refuses non-HTTPS** URLs outright rather than shipping
  a signing path that would put keys on the wire in the clear (§8).
- **SSRF surface (flag):** a user-supplied base URL means the connector makes
  outbound requests to an address the *user* chose. A mistyped or hostile URL
  could target loopback / RFC-1918 / link-local (`169.254.169.254` cloud
  metadata). The connector **validates the host before every call** (§5.1).

### 2.2 API surface (supports pull → read → act)

| Need | Endpoint | Notes |
|---|---|---|
| `getOrder` | `GET /wp-json/wc/v3/orders/<id>` | Full order incl `billing.email`, `total`, `currency`, `status`, `line_items`. |
| `searchOrders` | `GET /wc/v3/orders?search=&status=&customer=&after=` | Filter by status/customer/date; paginated. |
| `getCustomer` | `GET /wc/v3/customers/<id>` | Registered customers only — guest orders have **no** customer id (§2.5). |
| `cancelOrder` | `PUT /wc/v3/orders/<id>` `{ "status": "cancelled" }` | No dedicated cancel endpoint; a status transition (unlike Shopify's `orderCancel` with restock semantics). |
| `updateShippingAddress` | `PUT /wc/v3/orders/<id>` `{ "shipping": {…} }` | Same PUT; partial object. |
| `refundOrder` | `POST /wc/v3/orders/<id>/refunds` `{ amount, line_items?, api_refund }` | `api_refund: true` refunds via the payment gateway; `false` records a manual refund only. |
| `addOrderNote` | `POST /wc/v3/orders/<id>/notes` `{ note, customer_note }` | `customer_note: true` emails the customer; `false` is a private staff note. |

Every read + gated mutation the connector needs is a first-class REST call. The
API is **v3 and GA** — no Developer-Preview churn (a key contrast with Linear).

### 2.3 Webhooks (the cloud-ingress + HMAC problem)

- Configured in *WooCommerce ▸ Settings ▸ Advanced ▸ Webhooks* (or via the REST
  webhooks endpoint) with a topic + delivery URL + a **secret**.
- MVP topic: **`order.created`** (also `order.updated`, `customer.created`, etc.).
- Delivery carries headers: `X-WC-Webhook-Topic`, `X-WC-Webhook-Resource`,
  `X-WC-Webhook-Event`, `X-WC-Webhook-ID`, `X-WC-Webhook-Delivery-ID`, and the
  security-critical **`X-WC-Webhook-Signature`**.
- **Signature scheme (verify exactly this):**
  `X-WC-Webhook-Signature = base64( HMAC_SHA256( rawRequestBody, webhookSecret ) )`.
  Verification is a **timing-safe** compare of that header against a locally
  computed `base64(hmac-sha256(rawBody, secret))` — the same shape
  `hook-server.ts` / `operator-grant.ts` already use with `timingSafeEqual`.
  (Shopify's `X-Shopify-Hmac-Sha256` is the same base64-HMAC-SHA256 idea; **the
  header name and the accompanying topic/source headers differ** — isolate both
  in the receiver.)
- On webhook creation WooCommerce sends a **ping** (`webhook_id` only, no
  `X-WC-Webhook-Topic` order body) — the receiver must 200 it without spawning a
  run.
- **Retries:** WooCommerce disables a webhook after repeated delivery failures
  (5 consecutive by default) — the receiver must **200 fast** so a slow flow run
  never trips the disable.

### 2.4 Rate limits / reliability (divergence from Shopify)

- **No documented global rate limit.** The core WC REST API is **unthrottled by
  default** — the opposite of Shopify's documented leaky-bucket (2 req/s, 40
  burst, `Retry-After`). Real limits are **host-imposed and variable** (WP Engine,
  Kinsta, Cloudflare, or shared-hosting caps), surfacing as `429`, `503`, or a
  connection reset with **no guaranteed `Retry-After`**.
- Consequence: the client cannot lean on a documented budget or a `Retry-After`
  header. It ships **capped exponential backoff** on `429`/`5xx`/timeouts, a hard
  request timeout, and treats the store as potentially **slow/flaky** (shared
  hosting). Push-over-poll still holds (webhook-primary), but for a different
  reason than Shopify — variance, not a hard bucket.

### 2.5 Guest checkouts (data-shape divergence)

WooCommerce guest orders have **`customer_id: 0`** (no registered customer). The
stable identity key is **`billing.email`**, not a customer id. So
`context.customer.id` may be **absent** while `context.customer.email` is always
present — `wc-normalize` (§4) maps `billing.email` → `order.email` /
`customer.email` and only sets `customer.id` when non-zero.

### 2.6 Verdict: **GREEN** (with named operational caveats)

The full pull → read → act loop is **buildable today** on the GA WooCommerce
REST API: every read and mutation is a documented endpoint, the webhook + HMAC
ingress is the *same solved problem* as Linear/Shopify, and secret storage rides
the merged registry's `CredentialStore`. It is GREEN, not qualified lower,
because none of the caveats block the loop — they shape the client's defensive
posture:

1. **Self-hosted URL trust / SSRF** — mitigated by host validation (§5.1); an
   open decision on *how strict* (§10.2).
2. **Undocumented, host-variable rate limits** — mitigated by backoff + timeout
   (§2.4); no `Retry-After` to trust.
3. **`order.refundRequested` has no native webhook** — derived in-flow, not from
   the store (§6.1, §10.3). The trigger id is kept for Shopify template parity;
   its *ingress* diverges.

---

## 3. The ecom-worker loop → WooCommerce primitives

saiife's ecom-worker loop is `event → read → decide → act`. Each stage maps
to a concrete WC primitive and a concrete flow-builder mechanism:

| Stage | WooCommerce primitive | saiife flow mechanism |
|---|---|---|
| **event** | `order.created` webhook (HMAC-signed), or a customer message the worker classifies as a refund request (`order.refundRequested`, derived). | `wc-webhook-server` verifies + normalizes → the connector's `subscribe(id, triggerId, handler)` fires → `trigger-subscriber.ts` seeds a run, writing the payload to `context['order.created']` (§4.5). |
| **read** | `GET /orders/<id>`, `GET /customers/<id>`, `GET /orders?search=`. | An **action node** `getOrder` / `getCustomer` / `searchOrders` → `registry.invokeAction('woocommerce', ref, params)` → `wc-api` → normalized result written to context under the node id (`action-runner.ts`). |
| **decide** | — | A **gate/router node** reads `order.status` / `order.total` via `FlowEdgeCondition` (sibling-owned) over the context fields this connector produced. The connector designs the **fields**, not the conditions (§4.5). |
| **act** | `POST /orders/<id>/refunds`, `PUT /orders/<id>` (cancel / re-address), `POST /orders/<id>/notes`. | A gated **action node** `refundOrder` / `cancelOrder` / `updateShippingAddress` / `addOrderNote` → `invokeAction` → `wc-api` mutation. The node's **existence in the graph is the authority**; the connector never mutates on its own (§4.6). |

**Failure convention (from the pinned contract):** an action signals failure by
**rejecting** the promise; a resolved promise (any value, incl `undefined`) is
success and its value becomes the node's context output (`action-runner.ts`
lines 51-59). Every Woo mutation therefore **throws the real WC error** on
failure rather than resolving a sentinel (§8).

---

## 4. Architecture in saiife

### 4.1 Where it sits

Two parts, mirroring how Linear splits a *descriptor* (static, in the registry)
from a *connector* (live dispatch, its own module set):

- **Descriptor** — `src/main/integrations/descriptors/woocommerce.ts`: the static
  `IntegrationDescriptorDef` (id, label, `configFields`, `triggers`, `actions`).
  Copies the `linear.ts` descriptor pattern verbatim; a snapshot test guards the
  ids (the vocabulary sub-projects 2/3 depend on).
- **Connector** — a main-process module set under `src/main/woocommerce/` (peer
  of `src/main/linear/`) that supplies the live `invokeAction`/`subscribe`
  behavior the `IntegrationRegistry` delegates to for id `'woocommerce'`. It is
  **opt-in**: absent config, the connector never starts a webhook server and
  never subscribes, and `status()` reports `needs-config` — nothing about
  saiife's "works with no integration" guarantee changes.

Registration extends `INTEGRATION_IDS` and `IntegrationId` in
`src/shared/integrations.ts` (`… | 'woocommerce'`) and adds the descriptor to
`DESCRIPTOR_DEFS` (`src/main/integrations/descriptors/index.ts`). Live dispatch
is wired where `index.ts` builds the registry.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/integrations/descriptors/woocommerce.ts` | Static descriptor def. `configFields` (storeUrl [non-secret], consumerKey/consumerSecret/webhookSecret [secret], environment), the two triggers, the seven actions. Snapshot-guarded vocabulary. |
| `src/main/woocommerce/woocommerce-connector.ts` | Orchestrator. Implements live `invokeAction`(actionId → `wc-api` call) and `subscribe`(triggerId → the webhook stream). Owns the action-dispatch table. **Never auto-mutates** — it only runs the mutation a flow action node explicitly requested. |
| `src/main/woocommerce/wc-api.ts` | Thin REST client for `wc/v3`. **ALL WooCommerce JSON shapes (order, customer, refund) live only here** — the blast radius. Basic-auth over HTTPS with keys from `CredentialStore.revealForConnector`. Methods: `getOrder`/`searchOrders`/`getCustomer`/`createRefund`/`updateOrder`/`createOrderNote`. HTTP transport injected as a seam → `MockWcApi` (§9). |
| `src/main/woocommerce/wc-webhook-server.ts` | HTTP receiver mirroring `hook-server.ts` (`createServer`, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`, `responded` guard) **plus** WC HMAC verify (`X-WC-Webhook-Signature`, base64 HMAC-SHA256, timing-safe), ping handling, and cloud ingress (§4.4). 200s fast; hands verified events to the connector. |
| `src/main/woocommerce/wc-normalize.ts` | Pure map: raw WC order/customer JSON → the pinned context fields (`order.{id,total,currency,status,email}`, `customer.{id,email,name}`). Handles guest orders (§2.5). Unit-testable in isolation (mirrors `status-map.ts`'s purity). |
| `src/main/woocommerce/wc-ssrf.ts` | Pure host guard: validate a store base URL (https-only, block loopback/RFC-1918/link-local, reject embedded credentials). Called by `wc-api` before every request (§5.1). |
| `src/shared/woocommerce.ts` | Shared types (`WcTriggerPayload`, the normalized order/customer view) needed by main and any renderer surface. No I/O. |

**Note — no separate key store.** Unlike the pre-registry Linear module set
(which had its own `linear-token-store.ts`), the Woo connector rides the
**merged registry's `CredentialStore`** (`src/main/integrations/credential-store.ts`).
Secrets are fetched main-process-only via `revealForConnector('woocommerce', key)`
— the sole plaintext exit, grep-asserted to have no IPC/renderer caller. This is
exactly the reuse the `CredentialStore` header comment anticipated ("sets the
pattern the connector token-stores will adopt").

**Note — no separate config module.** Non-secret refs (storeUrl, environment)
are ordinary non-secret `configFields`, so they flow through the registry's
`integration-config.ts` write-back and validation — no bespoke `wc-config.ts`.

### 4.3 The descriptor (config surface)

```ts
// src/main/integrations/descriptors/woocommerce.ts  (shape — not final code)
export const woocommerceDescriptor: IntegrationDescriptorDef = {
  id: 'woocommerce',
  label: 'WooCommerce',
  configFields: [
    { key: 'storeUrl', label: 'Store URL (https://…)', secret: false, required: true,  type: 'string',
      placeholder: 'https://shop.example.com' },
    { key: 'consumerKey',    label: 'Consumer key (ck_…)',    secret: true, required: true, type: 'string' },
    { key: 'consumerSecret', label: 'Consumer secret (cs_…)', secret: true, required: true, type: 'string' },
    { key: 'webhookSecret',  label: 'Webhook signing secret', secret: true, required: true, type: 'string' },
    { key: 'environment', label: 'saiife environment (1-9)', secret: false, required: true, type: 'number' }
  ],
  triggers: [
    { id: 'order.created',         label: 'New order placed' },
    { id: 'order.refundRequested', label: 'Customer requested a refund' } // derived — §6.1/§10.3
  ],
  actions: [
    { id: 'getOrder',              label: 'Get an order' },
    { id: 'getCustomer',           label: 'Get a customer' },
    { id: 'searchOrders',          label: 'Search orders' },
    { id: 'refundOrder',           label: 'Refund an order' },           // gated mutation
    { id: 'cancelOrder',           label: 'Cancel an order' },           // gated mutation
    { id: 'updateShippingAddress', label: 'Update shipping address' },   // gated mutation
    { id: 'addOrderNote',          label: 'Add an order note' }          // gated mutation
  ]
}
```

`status()` derives from `CredentialStore` presence + config exactly as
`integration-registry.ts` `deriveStatus` already does: missing required field →
`needs-config`; undecryptable stored key → `error`; configured-but-disabled →
`disabled`; else `connected`. No connector-specific status logic.

### 4.4 Receiving webhooks (cloud ingress — same as Linear/Shopify)

`hook-server.ts` binds `127.0.0.1` because its sender is a local subprocess.
**WooCommerce webhooks originate from the store (cloud or a remote host)**, so
the receiver needs a reachable URL:

- **MVP ("for me"):** a dev tunnel (ngrok / Cloudflare Tunnel) forwards to the
  local `wc-webhook-server`; the tunnel URL is registered as the webhook delivery
  URL in WooCommerce. Documented as a v1 prerequisite (same posture as Linear
  §4.4 and the OpenClaw operator skill).
- **Phase 2 ("product"):** a thin hosted relay that HMAC-authenticates then
  forwards over a durable channel. Flagged in §10.1 — changes the distribution
  story.

Regardless of ingress, the receiver **verifies the WC HMAC**, enforces
`MAX_BODY_BYTES`, 200s the **ping**, and responds **fast** so WC never disables
the webhook for slow delivery; the run is seeded *after* the response.

### 4.5 How a trigger becomes a run (grounding in `src/main/flow`)

The connector's `subscribe('woocommerce', 'order.created', handler)` is what
`trigger-subscriber.ts` calls for any flow whose trigger node names
`integration: 'woocommerce', ref: 'order.created'`. When the webhook fires:

1. `wc-webhook-server` verifies + parses → hands the connector a normalized event.
2. The connector invokes the stored `handler(event)`.
3. `trigger-subscriber.coerceEvent` normalizes it to `{ eventId, payload }`
   (`eventId` = `X-WC-Webhook-Delivery-ID` for idempotency).
4. `matchesFilter` applies the trigger node's optional `config.filter`.
5. `flow-engine` seeds `context['order.created'] = payload`, where `payload`
   carries the `order.*` / `customer.*` fields from `wc-normalize`.

Downstream, a **router/gate node** reads those fields through the sibling-owned
`FlowEdgeCondition { field; op; value? }` (e.g. `field: 'order.created.order.total',
op: '>', value: 100`). **This connector supplies the fields; it does not design
conditions** — that dependency is owned elsewhere (task constraint).

### 4.6 Authority & safety posture

Identical to the Shopify sibling and to saiife's operator posture:

- **Mutations are gated by the flow, never by the connector.** `refundOrder` /
  `cancelOrder` / `updateShippingAddress` / `addOrderNote` only ever run because
  an **action node exists in the graph** and the run reached it. The connector
  exposes them; it never fires one on its own, and it never "auto-refunds".
- A gate node (human `needs-you` approval, or a condition) can sit *before* a
  mutation node so a refund waits on explicit authorization — but that wiring is
  the flow author's, using primitives this connector does not own.
- **Read/write key separation** is honored: a read-only consumer key surfaces a
  legible `403` on any mutation (§8), nudging the user to a read-write key only
  when they actually wire a mutation.
- **NEVER render the consumer key/secret** — not to a log, IPC payload, console
  row, transcript, or PR body. Only `revealForConnector` (main-only) touches
  plaintext; the client sends it as a Basic-auth header and nowhere else.

### 4.7 Textual data-flow diagram

```
                      WOOCOMMERCE STORE (self-hosted WordPress)
        order.created  ──X-WC-Webhook-Signature: base64(hmac-sha256(body, secret))──┐
                                                                                     ▼
┌──────────────────────────── saiife main process ───────────────────────────────┐
│  wc-webhook-server ──verify HMAC, size, ping──► woocommerce-connector.handler       │
│      (200 fast)                                       │                              │
│                                                       │ coerceEvent → SeedEvent      │
│                                                       ▼                              │
│  trigger-subscriber ──matchesFilter──► flow-engine seeds context['order.created']   │
│                                            (order.{id,total,currency,status,email})  │
│                                                       │                              │
│   worker/agent node reads customer message ──► action node: getOrder ──────────────►│
│                                          invokeAction('woocommerce','getOrder',{id}) │
│                                                       │                              │
│   woocommerce-connector ─► wc-api ─(wc-ssrf guard)─► GET /wc/v3/orders/<id> ─► store │
│                                                       │  wc-normalize → context      │
│                                                       ▼                              │
│   gate/router node ── FlowEdgeCondition over order.status/order.total (sibling-owned)│
│                                                       │ (authorized)                 │
│                                                       ▼                              │
│   action node: refundOrder ─► invokeAction ─► wc-api ─► POST /orders/<id>/refunds    │
│        (mutation runs ONLY because the graph reached this node — never auto)         │
│                                                       │ throws real WC error on fail │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Auth & keychain

- **Credentials:** `consumerKey`, `consumerSecret`, `webhookSecret` are **secret**
  `configFields` → stored via `CredentialStore` (`safeStorage`-encrypted sidecar).
  `storeUrl` and `environment` are **non-secret** → `config.json` (references
  only). The registry already enforces the secret/non-secret split
  (`setSecret` refuses a non-secret field and vice-versa; `integration-registry.ts`
  lines 149-193).
- **Retrieval:** `wc-api` obtains the key/secret at call time via
  `creds.revealForConnector('woocommerce', 'consumerKey' | 'consumerSecret')` and
  the receiver via `revealForConnector('woocommerce', 'webhookSecret')` — the
  **main-process-only** plaintext exit. They are used to build a Basic-auth header
  / verify an HMAC and are **never** returned, logged, or IPC'd.
- **State, not value** (global CLAUDE.md rule verbatim): `status()` proves
  presence (`creds.has`) and decryptability (`creds.decryptionError`) — never the
  bytes. `SetSecretResult` returns status only.
- **Disconnect:** `clearSecret('woocommerce')` wipes the keychain entries;
  disabling the config entry stops the connector (`status()` → `disabled`), tears
  down the webhook server, and unsubscribes. No orphaned state renders the keys.

### 5.1 Store-URL SSRF guard (`wc-ssrf.ts`) — the self-hosted risk

Because `storeUrl` is user-supplied and the connector makes **outbound** requests
to it, every call passes through a pure validator **before the request**:

- **HTTPS only** — reject `http://` (would send keys in cleartext; §2.1).
- **Reject embedded credentials** (`https://user:pass@host`).
- **Block private/loopback/link-local targets** by resolved IP: `127.0.0.0/8`,
  `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl the
  `169.254.169.254` metadata endpoint), `fc00::/7`.
- Pin the validated host so a **DNS-rebinding** flip between validate and connect
  can't redirect the request to a private IP (validate the IP actually dialed).
- **Open decision (§10.2):** whether a localhost/RFC-1918 store is *hard-blocked*
  or allowed behind an explicit `allowInsecureLocalStore` opt-in for a dev store
  on the same LAN.

---

## 6. Triggers, reads & gated mutations

All WC shapes isolated in `wc-api.ts` / `wc-webhook-server.ts`.

### 6.1 Triggers (inbound)

- **`order.created`** — native WC webhook. Registered (once, at connect) pointing
  at the ingress URL; verified by HMAC; normalized to `order.*` / `customer.*`;
  seeds a run.
- **`order.refundRequested`** — **DIVERGENCE: WooCommerce has no native
  refund-request event.** Refunds in Woo are *admin-initiated*; there is no
  customer-facing "request refund" object or webhook (Shopify surfaces refund
  intent natively). The trigger **id is kept for Shopify template parity**, but
  its **ingress differs**: in MVP it is **derived in-flow** — the worker agent
  reads the inbound customer message and a router node classifies it as a refund
  request — not emitted by the store. (Phase-2 alternatives in §10.3: an
  `order.updated`-derived signal, or an order-note convention.) The connector
  documents this so a flow author does not expect a store-sourced firehose.

### 6.2 Reads

- `getOrder(orderId)` → `GET /orders/<id>`.
- `getCustomer(customerId)` → `GET /customers/<id>` (guest orders have no id;
  callers key on `order.email` instead — §2.5).
- `searchOrders({ search?, status?, customer?, after? })` → `GET /orders?…`
  (paginated; the client caps page size and total pages defensively).

### 6.3 Gated mutations (act — flow-authorized only)

- `refundOrder({ orderId, amount?, lineItems?, viaGateway })` →
  `POST /orders/<id>/refunds` (`api_refund` = `viaGateway`; default **false** —
  record-only — unless the flow explicitly opts into a gateway refund).
- `cancelOrder({ orderId })` → `PUT /orders/<id>` `{ status: 'cancelled' }`.
- `updateShippingAddress({ orderId, shipping })` → `PUT /orders/<id>`
  `{ shipping }`.
- `addOrderNote({ orderId, note, customerNote })` → `POST /orders/<id>/notes`
  (`customer_note` gates whether the customer is emailed).

Each **rejects** the `invokeAction` promise on failure, forwarding the verbatim
WC error (§3, §8). None runs unless a flow action node invoked it (§4.6).

---

## 7. Pinned vocabulary — aligned with Shopify, divergences flagged

| Axis | id | Shopify parity |
|---|---|---|
| **IntegrationId** | `'woocommerce'` | Shopify pins `'shopify'`; both extend `IntegrationId` + `INTEGRATION_IDS`. |
| **Trigger** | `order.created` | **MATCH** — same id, same semantics (native webhook both sides). |
| **Trigger** | `order.refundRequested` | **id MATCH / ingress DIVERGES** — Shopify native; Woo derived in-flow (§6.1). |
| **Read action** | `getOrder`, `getCustomer`, `searchOrders` | **MATCH** — identical ids + semantics. |
| **Mutation** | `refundOrder`, `cancelOrder`, `updateShippingAddress`, `addOrderNote` | **MATCH** ids; mechanics differ under the hood (WC PUT-status cancel + refunds endpoint vs Shopify GraphQL `orderCancel`/`refundCreate`). |
| **Context** | `order.{id,total,currency,status,email}` | **MATCH** — same field paths. WC `status` enum (`processing`/`on-hold`/`completed`/`refunded`/`cancelled`/…) differs from Shopify's `financial_status`/`fulfillment_status`; the *field name* is aligned, the *value set* is platform-specific. |
| **Context** | `customer.{id,email,name}` | **MATCH** field paths; `customer.id` may be **absent** for WC guest orders (§2.5) — `email` is the stable key. |

**Net:** a flow template targets either platform by id; the connector's job is to
make WooCommerce's REST reality *present the same context surface*. Divergences
are confined to **ingress** (`order.refundRequested`), **value sets**
(`order.status`), and **guest-order** `customer.id` nullability — none of which
change the ids a template pins.

---

## 8. Error handling

saiife's rule (error-message-style memory; demonstrated across
`session-manager.ts` / `control-api.ts`): **every failure is human-readable,
actionable, and carries the real underlying exception. No silent catch, no bare
"failed", never a 404-vibe.** An action `invokeAction` **rejects** with these
messages; `action-runner.ts` wraps them as
`Flow action '<id>' on WooCommerce failed: <detail>`.

| Failure | Real cause | Surface (message carries the real exception) |
|---|---|---|
| Store unreachable | DNS failure / connection refused / timeout | "WooCommerce store `<host>` is unreachable (`<errno>`) — check the Store URL in Settings." |
| Non-HTTPS store URL | `http://` given | "Store URL must be `https://` — plain HTTP would send the API keys in the clear. Fix it in Settings." (refused before any call) |
| SSRF-blocked host | URL resolves to loopback/private/link-local | "Store URL `<host>` resolves to a private/loopback address (`<ip>`) — refusing to call it." (refused before any call; §5.1) |
| 401 Unauthorized | bad/rotated consumer key or secret | "WooCommerce rejected the API keys (401) — regenerate a key in WooCommerce ▸ Settings ▸ Advanced ▸ REST API and re-enter both parts." |
| 403 Forbidden | read-only key used for a mutation | "The stored WooCommerce key is read-only — `refundOrder` needs a Read/Write key. Regenerate it and re-enter." |
| 404 Not Found | order/customer id absent | "Order `<id>` isn't in this store (404) — it may be trashed or from another store." |
| 400 on refund | amount exceeds refundable / gateway refused | Forward WC's verbatim body message (e.g. "Invalid refund amount"), not a generic "failed". |
| 429 / 5xx | host throttle or overloaded shared hosting | "The store returned `<code>` — backing off and retrying (no rate-limit header to honor)." Capped exponential backoff (§2.4); not swallowed. |
| Webhook signature invalid | forged/mistyped `webhookSecret` | Receiver 401s, `console.warn` **route + reason only** — never the body or the secret (mirrors control-api's token discipline). No run seeded. |
| Webhook oversized / malformed | body > `MAX_BODY_BYTES` / bad JSON | 4xx + dropped; never parsed onward. |
| Stored key won't decrypt | keychain/`safeStorage` change | `status()` → `error` via `creds.decryptionError`; "Stored WooCommerce credential can't be decrypted — re-enter it in the Integrations tab." |
| Secure storage unavailable | `safeStorage.isEncryptionAvailable()` false | `CredentialStore.set` throws the existing legible message; the integration stays disabled. |

The connector **never** catches-and-drops; where WC returns a real message it
forwards **that**, never a vaguer mint.

---

## 9. Testing strategy (offline — no live store)

Testable **without a live WooCommerce store**, matching saiife's seams
(injected transports, pure functions, fixture events):

- **`MockWcApi` seam** — `wc-api` takes its HTTP transport as a constructor dep
  (as `operator-guard.ts` injects its `GuardRunner`, and `CredentialStore` its
  `SecretBackend`). Tests inject a mock that returns canned WC JSON / status
  codes. **No test makes a live call.**
- **`wc-normalize` unit tests** — pure map from raw WC order/customer JSON to
  `order.*` / `customer.*`. Fixtures include a **guest order** (`customer_id: 0`,
  no `customer.id`, `email` from `billing.email`) and each `status` value.
- **`wc-webhook-server` unit tests** — feed fake `order.created` bodies with
  **valid and invalid** `X-WC-Webhook-Signature` (base64 HMAC-SHA256), oversized
  bodies, malformed JSON, and a **ping**; assert 2xx/4xx and that **only valid,
  signed events** reach the connector. Reuses the `hook-server.ts`
  boundary-test approach + `timingSafeEqual`.
- **`wc-api` tests against the mock transport** — assert the exact endpoint,
  method, and Basic-auth header for each action, and that `401`/`403`/`404`/`429`
  drive the §8 messages / backoff. Assert a mutation is a `POST`/`PUT` to the
  right path with the right body.
- **`wc-ssrf` unit tests** — private/loopback/link-local hosts refused; https
  enforced; embedded credentials rejected; a public host allowed.
- **`woocommerce-connector` tests** — the `invokeAction` dispatch table (each id →
  the right `wc-api` call) and `subscribe` fan-out (a webhook event → the handler
  → a `SeedEvent`); assert **no mutation fires without an action-node invocation**
  (authority regression).
- **Secret-never-logged regression** — a grep/string test asserting no
  consumer key/secret value ever appears in any emitted console/log/IPC string
  (mirrors the Linear token-store regression guard).

No test requires store credentials or network; the live API is exercised only in
manual dogfooding.

---

## 10. Open decisions (FLAGGED — not resolved here)

1. **"For me" vs "a product others install."** MVP is the *for-me* fork: keys
   pasted into the Integrations tab, a dev tunnel for ingress, keys in Jonas's
   keychain, one store. The *product* fork wants a guided **"Connect a store"**
   wizard (the operator-onboarding-friction memory asks for exactly this
   one-click flow), a hosted webhook relay, and multi-store config — changing
   ingress, config shape, and support surface. Recommendation: build for-me, keep
   the client/config shapes multi-store-ready.
2. **Self-hosted URL trust (SSRF strictness).** Hard-block **all** private/
   loopback targets (safest, but breaks a `localhost`/LAN dev store), or allow an
   explicit `allowInsecureLocalStore` opt-in for development? MVP leans
   hard-block; the opt-in is the flagged escape hatch. Decide before a dev-store
   dogfood.
3. **`order.refundRequested` ingress.** WC has no native refund-request webhook
   (§6.1). MVP derives it **in-flow** from the customer message (worker + router
   classify it). Alternatives: an `order.updated`-diff signal, or an order-note
   convention, or a small WP plugin that emits a custom webhook topic. Which
   becomes the "real" trigger source is unresolved — the id stays stable either
   way.
4. **Refund authority granularity.** Is a `refundOrder` node sufficient on its
   own, or must a refund **always** sit behind a `needs-you` gate / an
   saiifeguard-style check (the destructive-command posture)? The connector supports
   either; the *default template* posture is an open product call. (`api_refund`
   defaulting to record-only is the conservative MVP hedge.)
5. **`order.updated` firehose.** Adding it as a trigger would catch refunds,
   status changes, and edits — but it is noisy and needs dedup by
   `X-WC-Webhook-Delivery-ID`. Deferred; decide if/when phase 2 needs it.

---

## 11. MVP slice + phased roadmap

### Smallest first shippable slice (walking skeleton)

**One store, the happy path, one low-risk mutation first:**

1. `woocommerce` descriptor + `IntegrationId`/`INTEGRATION_IDS` extension;
   `storeUrl` + `consumerKey`/`consumerSecret`/`webhookSecret` stored (keychain +
   config), `status()` deriving correctly.
2. `wc-api` (read) with `MockWcApi` seam + `wc-ssrf` guard: `getOrder`,
   `getCustomer`, `searchOrders` wired through `invokeAction`.
3. `wc-webhook-server` behind a dev tunnel handling `order.created` (HMAC verify +
   ping) → `subscribe` → a seeded run with `order.*` / `customer.*` context.
4. `addOrderNote` as the **first gated mutation** (lowest risk), then `refundOrder`
   behind a flow gate.
5. `wc-normalize` + the full §9 offline test suite.

That slice proves the ecom-worker loop end-to-end and is dogfoodable: a real
order fires the webhook, a flow reads it, a worker drafts a reply, and a gated
node posts an order note / issues a refund only when the graph authorizes it.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. For-me fork, single store/env,
  `order.created` + read actions + `addOrderNote`/`refundOrder`.
- **Phase 2 — full act surface + derived refund trigger:** `cancelOrder`,
  `updateShippingAddress`; `order.refundRequested` derived-ingress finalized
  (§10.3); `order.updated` if warranted; a `needs-you` gate template for refunds
  (§10.4).
- **Phase 3 — product fork:** the "Connect a store" guided wizard, a hosted
  webhook relay, multi-store config (additive per the §5 shapes).
- **Phase 4 — ecom breadth:** BigCommerce / Medusa as sibling connectors reusing
  the `*-connector` / `*-api` / `*-webhook-server` / `*-normalize` module
  boundaries — each its own connector (no shared ecom standard), the same way
  Shopify and WooCommerce stay siblings rather than one abstraction.

---

## Appendix — reused / satisfied saiife surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` this connector satisfies; `IntegrationId` +
  `INTEGRATION_IDS` extended with `'woocommerce'`.
- `src/main/integrations/credential-store.ts` — keychain (`safeStorage`) store;
  `revealForConnector` (main-only plaintext exit) is how the client/receiver get
  the key/secret; `decryptionError` powers `status()`.
- `src/main/integrations/integration-registry.ts` — `deriveStatus` (presence →
  `connected`/`needs-config`/`error`/`disabled`), the secret/non-secret write
  split; the descriptor plugs into `DESCRIPTOR_DEFS`.
- `src/main/integrations/descriptors/linear.ts` — the descriptor-def pattern the
  Woo descriptor copies.
- `src/main/flow/trigger-subscriber.ts` — `subscribe`/`coerceEvent`/`matchesFilter`:
  how a Woo webhook becomes a seeded run.
- `src/main/flow/node-runners/action-runner.ts` — the `invokeAction` runner +
  the **reject-to-fail** convention every Woo action honors; the not-connected
  guard.
- `src/main/flow/context.ts` — `resolveField`/`applyTemplate`: how `order.*`
  context fields are read by templates and (sibling-owned) conditions.
- `src/main/hook-server.ts` — the loopback HTTP-receiver pattern
  (`applyLoopbackTimeouts`, `MAX_BODY_BYTES`, `responded`, `timingSafeEqual`)
  the `wc-webhook-server` mirrors + cloud ingress + WC HMAC.
- `docs/superpowers/specs/2026-07-16-linear-integration-design.md` — the
  webhook+HMAC / keychain / error-table / offline-testing template.
- `docs/superpowers/specs/2026-07-17-shopify-connector-design.md` — the sibling
  whose vocabulary this spec deliberately mirrors.
