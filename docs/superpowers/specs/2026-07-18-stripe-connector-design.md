# Stripe Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Feasibility **DONE** (GREEN, §2). The
**highest-synergy** addition to the **ecom worker**: it composes directly with
the merged **Shopify** and **WooCommerce** connectors — an order's *money* lives
in Stripe (charges, refunds, disputes) while its *fulfillment* lives in the store
platform, so an ecom support worker that reasons about payments needs both.
**Feature:** A **Stripe connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. A payment event (a dispute opened, a refund posted, an
invoice payment failed) **triggers** a run; the flow **reads** charge / customer
/ dispute / subscription state through Stripe's API; and — behind gates the author
places — it **acts** on money (refund, respond to a dispute, cancel a
subscription). It does **not** hardcode a payments pipeline; the authority lives
in the flow (conditions on edges, gates where the author puts them), exactly as
the flow engine already enforces and exactly as the Shopify connector does.

This connector satisfies the **pinned** `IntegrationDescriptor` / `LiveConnector`
/ `IntegrationRegistry` contract in `src/shared/integrations.ts` and copies the
module shape of `src/main/shopify/` (descriptor-as-code, admin client behind a
transport seam, keychain token store, pure normalize, a `LiveConnector` wired via
`registerConnector`). It uses the **Shopify connector spec** as its style and
depth template (`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`).

**A note on ownership.** This spec **owns and pins the Stripe vocabulary**
(§6: `IntegrationId` addition, triggers, actions, context-field shape) and is the
**reference consumer + reference implementation** for two *sibling-owned* shared
infra tracks it must not reinvent:

- **The shared webhook receiver** (`src/main/webhooks/webhook-receiver.ts`, a
  `WebhookVerifier` config that generalizes the per-connector receivers Shopify
  and Woo hand-rolled). Stripe is the **reference case for its timestamp scheme**
  (§7): `signsTimestamp: true`. Shopify (raw-body-only HMAC) is the other
  reference. This spec **consumes** the receiver and **specifies the Stripe
  verifier config**; it does not design the receiver's internals.
- **The shared money module** (`src/shared/money.ts` — `Money` +
  `minorToMajor`). Stripe's native **minor-unit integers** MUST be converted to
  the **major-unit `number`** the ecom vocabulary already uses (Shopify's
  `order.total`), or a cross-connector money compare is a silent bug (§6.3, §11).
  This spec **consumes** `minorToMajor`; it does not own the currency-exponent
  table.

Where those tracks own a shape, this spec **names the dependency and stops** —
mirroring how the Shopify spec names the conditions/templates tracks.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user assemble, on the canvas, an ecom
worker that wakes on a Stripe payment event (a dispute, a refund, a failed
invoice), reads the relevant charge / customer / dispute facts through Stripe's
API, **composes them with Shopify/Woo order context**, routes on those facts via
edge conditions, and performs **gated** money mutations (refund / respond-to-
dispute / cancel-subscription) — with a **restricted, least-privilege** API key in
the OS keychain, **never** rendered, and **no money action ever auto-running**.

### In scope (MVP)

- A new **Stripe connector** module set under `src/main/stripe/`, exposing a
  static `stripeDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus a `StripeConnector` (`LiveConnector`) wired via
  `integrationRegistry.registerConnector('stripe', …)` (`index.ts`, exactly the
  Shopify/Woo pattern — `integration-registry.ts:54`).
- **Auth for the "for me" fork:** a **restricted API key** (`rk_live_…` /
  `rk_test_…`) scoped to **least privilege** — read charges/customers/disputes/
  subscriptions, write refunds/dispute-responses/subscription-cancels, nothing
  else — stored in the keychain via `CredentialStore` (§8). The **distributable**
  fork (Stripe **Connect** / OAuth, `Stripe-Account` header) is designed-for but
  deferred (§8, §13).
- A **Stripe API client** (`stripe-client.ts`) — the **sole** place any Stripe
  request/response shape lives — behind a `StripeApi` interface so tests inject a
  `MockStripeApi` (§12), implementing the read + mutation surface behind the
  pinned actions (§6.2).
- **Webhook triggers via the shared receiver** (§7): `stripe-connector` registers
  a **Stripe `WebhookVerifier`** with `src/main/webhooks/webhook-receiver.ts`.
  Stripe is the **reference for the receiver's timestamp scheme** — header
  `Stripe-Signature` (`t=<ts>,v1=<hex-hmac-sha256>`), HMAC-SHA256 over
  `"<t>.<rawBody>"`, and a **replay-tolerance window**. The connector does **not**
  hand-roll an HTTP server.
- **Money normalized to major units.** Every amount Stripe returns (minor-unit
  integer) is converted **once**, in `stripe-normalize.ts`, via
  `minorToMajor(minor, currency)` from `src/shared/money.ts`, so a Stripe amount
  and a Shopify `order.total` are **the same unit** and compare correctly (§6.3).
- The **pinned Stripe vocabulary** (§6): three webhook-backed triggers, four read
  actions, three **gated-mutation** actions, and the **context-field shape** an
  action writes for downstream edge conditions — amounts as major-unit `number`
  with an **explicit `currency`**.
- **Authority = the flow's gates.** Every mutation is an `action` node the author
  gates by placing a `gate` node (or a conditional edge) before it. A refund, a
  dispute response, and a cancellation are money actions — **the gate is the whole
  point** and none of them ever runs un-gated by construction of the flow the
  author drew (§9). Plus an **optional deterministic backstop** (per-action
  limits, e.g. `refundMaxAmount`) as a phased item (§9, §13).
- **The Stripe × Shopify composition** as a first-class worked example (§7.3): a
  worker whose edge conditions read **both** `{{shopify.order.*}}` and
  `{{stripe.charge.*}}`, taking order context from Shopify and issuing a gated
  refund through Stripe.
- **Single account, single localflow environment.** Config-as-code `stripe` block
  in `config.json` (non-secret refs only); restricted key + webhook secret in the
  keychain.

### Out of scope (MVP) — explicitly deferred

- **Stripe Connect / OAuth (the "product" fork).** Multi-account, per-connected-
  account `Stripe-Account` headers, platform onboarding. MVP is the **"for me"
  fork** — one restricted key for one account in the keychain (§8, §13.1). The
  config/key shapes are drawn so an `accounts[]` array is the additive path.
- **Payment creation / capture / payout / balance writes.** MVP's mutation surface
  is the support-loop three (`createRefund`, `respondToDispute`,
  `cancelSubscription`). Everything else is phase 2+.
- **The deterministic ecom backstop's *default*.** The `stripe.limits` policy is
  designed (§9) but whether it ships on-by-default, and at what value, is an open
  product-safety decision (§13.2).
- **Full dispute-evidence authoring UX.** MVP `respondToDispute` submits a
  structured evidence object the flow supplies / a human fills at the gate; a rich
  evidence-builder UI is later.
- **Non-Stripe PSPs** (PayPal, Adyen, Braintree). The module boundaries are
  processor-shaped so a peer connector can reuse them; justified-deferred in §2.

---

## 2. Feasibility + landscape (DONE — GREEN)

Feasibility is complete; this section records the verdict, not open questions.

### 2.1 Why Stripe, and why it composes

Stripe is the dominant hosted card processor and the money layer behind a large
share of Shopify/Woo merchants. The ecom worker already reads *order* state from
the store platform; **the money truth — was it captured, refunded, disputed —
lives in Stripe**. That is the synergy: `{{shopify.order.financialStatus}}` tells
you Shopify's *view*; `{{stripe.charge.disputed}}` / `{{stripe.dispute.reason}}`
tell you the *processor's* view, and a real support decision (accept a chargeback
vs fight it, refund vs not) needs both. This connector is therefore the
**highest-leverage** addition: it doesn't open a new domain, it **completes** the
ecom one.

### 2.2 The Stripe API for pull → read → act (verified 2026-07-18)

- **Read.** `GET /v1/charges/:id`, `/v1/customers/:id`, `/v1/disputes/:id`,
  `/v1/subscriptions/:id` cover the read surface (`getCharge`, `getCustomer`,
  `getDispute`, `getSubscription`). GA, stable.
- **Act.** `POST /v1/refunds` (create a refund on a charge / payment intent),
  `POST /v1/disputes/:id` (submit evidence / accept), `DELETE
  /v1/subscriptions/:id` (cancel). All GA. Refunds and dispute submissions accept
  an **`Idempotency-Key`** header — used (§11) so a run-retry never double-acts.
- **Auth.** **Restricted API keys** (`rk_…`) carry **per-resource permissions**
  (Charges: Read, Refunds: Write, …). This is the crux of §8: we never store a
  full-access secret key (`sk_…`) — a restricted key scoped to exactly the loop's
  resources is the keychain posture. Sent as `Authorization: Bearer rk_…`.
- **Webhooks (push, not poll).** Stripe posts events from the cloud with a
  **`Stripe-Signature`** header: `t=<unix-ts>,v1=<hex HMAC-SHA256>`, where the
  signed payload is **`"<t>.<rawBody>"`** and the key is the endpoint's signing
  secret (`whsec_…`). Verification therefore needs the **timestamp** (Stripe's
  own guidance: reject deliveries whose `t` is outside a tolerance window to
  defeat replay). This is precisely the **`signsTimestamp: true`** case the shared
  receiver must support — and Stripe is its reference implementation (§7).
- **Amounts are minor-unit integers.** `amount: 5000` is **$50.00** for USD, but
  **¥5000** for JPY (zero-decimal) and **5.000 BHD** for BHD (three-decimal). This
  is the money-convention requirement: convert to major units on the way in (§6.3,
  §11) so amounts compose with Shopify's major-unit numbers.
- **Rate limits.** Standard live-mode limits are generous for the loop (a few
  reads + one mutation per run); `429` returns `Retry-After` and is handled with
  backoff in the client (§11). Push-over-poll keeps us far under budget.

### 2.3 Verdict: **GREEN**

Every surface the loop needs — the four reads, `createRefund` /
`respondToDispute` / `cancelSubscription`, the three webhook events, restricted-
key auth, signed webhooks — is **generally available and stable**. The only
non-trivial engineering is (a) the **timestamp signature scheme** (owned by the
shared receiver; this spec is its reference) and (b) the **minor→major money
conversion** (owned by `src/shared/money.ts`; this spec consumes it). Neither is a
blocker. Cloud ingress for webhooks is the same known pattern Shopify already
solved (a tunnel in MVP, a relay in the product fork).

---

## 3. The core loop → Stripe primitives

localflow's ecom loop is `trigger → read → route → act (gated)`. Each stage maps
to a concrete Stripe primitive and the concrete flow-engine mechanism that runs
it:

| Stage | Stripe primitive | localflow / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified Stripe event (`charge.dispute.created`, `charge.refunded`, `invoice.payment_failed`) delivered to the **shared webhook receiver**. | The receiver verifies the `Stripe-Signature` (timestamp scheme, §7) → the connector normalizes the event to a `SeedEvent` → `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context (`trigger-subscriber.ts`, `flow-engine.ts`). |
| **read** | `GET /v1/charges/:id` · `/customers/:id` · `/disputes/:id` · `/subscriptions/:id`. | An `action` node (`getCharge` / `getCustomer` / `getDispute` / `getSubscription`) → `registry.invokeAction('stripe', ref, params)` → the connector calls `stripe-client.ts` → `stripe-normalize.ts` maps it (minor→major) → the connector **resolves** it, which the action-runner writes to context under the node id. |
| **route** | *(none — pure localflow)* | `selectEdges` evaluates edge conditions over the context the reads wrote, including **cross-connector** paths (`{{stripe.charge.amount}}`, `{{shopify.order.total}}` — §7.3). Deterministic value compares; **no LLM decides routing**. |
| **gate** | *(none — pure localflow)* | A `gate` node the author placed pauses the run `needs-you`; the human approves in the cockpit. Every money mutation sits **downstream of the gate the author drew** (§9). |
| **act** | `POST /v1/refunds` · `POST /v1/disputes/:id` · `DELETE /v1/subscriptions/:id` (each with an `Idempotency-Key`). | The gated `action` node (`createRefund` / `respondToDispute` / `cancelSubscription`) → `invokeAction` → `stripe-client.ts` mutation. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* Stripe error (`error.type`/`error.code`/`error.message`). |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities*; the *flow* decides which run, in what order, behind which
gates. A money mutation with no gated path to it never runs.

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/stripe/`, mirroring
`src/main/shopify/` (the closest sibling) and `src/main/integrations/` (the hub).
It is **opt-in**: with no `stripe` config entry (and no stored key) the
descriptor's `status()` returns `needs-config` and the engine refuses any Stripe
node before any network call — localflow's "works with no integration" guarantee
is unchanged. The connector is the live implementation behind the registry's
pinned `invokeAction`/`subscribe`, registered via `registerConnector('stripe',
…)`. **All Stripe API shapes are isolated in `stripe-client.ts`** (the blast
radius for any API-version bump), exactly as Shopify isolates GraphQL in
`shopify-admin.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/stripe/stripe-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'stripe'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids (the contract the templates track consumes). Mirrors `shopify-descriptor.ts`. |
| `src/main/stripe/stripe-connector.ts` | The `StripeConnector implements LiveConnector`. Maps an action id → a `stripe-client` call (params templated by the engine); maps a trigger id → a shared-receiver subscription. Holds **NO Stripe shape and NO secret**: reads normalize through `stripe-normalize.ts`; mutations resolve the client's small result; every failure **rejects** with the real cause. The one place the loop's dispatch lives. Mirrors `shopify-connector.ts`. |
| `src/main/stripe/stripe-client.ts` | Thin **Stripe REST client** behind a `StripeApi` interface (`getCharge`, `getCustomer`, `getDispute`, `getSubscription`, `createRefund`, `respondToDispute`, `cancelSubscription`). **All** Stripe request/response shapes (`RawCharge`, `RawDispute`, the `error` envelope) live *only* here. Sends `Authorization: Bearer <restrictedKey>`, `Stripe-Version`, and an **`Idempotency-Key`** on mutations; backs off on `429`. Isolated so tests inject a `MockStripeApi` (§12). |
| `src/main/stripe/stripe-normalize.ts` | **Pure** mapping: a raw Stripe object → the pinned context-field shape (§6.3), and a raw webhook event → a `SeedEvent`. This is where **`minorToMajor`** is applied, `currency` is normalized (§6.3), Unix timestamps become ISO 8601, and Stripe ids stay bare strings. Unit-testable in isolation (mirrors `shopify-normalize.ts` purity). Never throws — a sparse event normalizes to safe defaults. |
| `src/main/stripe/stripe-token-store.ts` | Keychain-backed access to the restricted key + webhook secret. A **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('stripe', 'restrictedKey')`) — reuses the existing keychain sidecar, does not open a second. Named distinctly so a grep test asserts no IPC/renderer caller. |
| `src/main/stripe/stripe-config.ts` | Reads the non-secret `stripe` refs from the integrations config block (account id, api version, environment, webhook url, mode) — the `integration-config.ts` validate-at-the-boundary pattern. |
| `src/shared/stripe.ts` | Shared, **already-normalized** types (`StripeChargeContext`, `StripeCustomerContext`, `StripeDisputeContext`, `StripeSubscriptionContext`, the action-param shapes, the trigger-payload shapes) and the pinned vocabulary id arrays. Imported by main (connector/normalizer) and any renderer palette surface. **No raw Stripe shape here** — those live only in `stripe-client.ts`. Mirrors `src/shared/shopify.ts`. |

### 4.3 Consumed shared infra (do NOT reimplement)

| Shared module | What this connector uses | Ownership |
|---|---|---|
| `src/main/webhooks/webhook-receiver.ts` (`WebhookVerifier`) | The connector registers a **Stripe verifier** (§7) and an `onEvent` sink; the receiver owns the HTTP server, `MAX_BODY_BYTES`, `responded` guard, 200-fast, raw-body capture, timing-safe compare, and dedup. Stripe is the **reference `signsTimestamp: true` case**. | Webhook-receiver track. This spec **specifies the Stripe verifier config**; it does not design the receiver. |
| `src/shared/money.ts` (`Money`, `minorToMajor`) | `stripe-normalize.ts` calls `minorToMajor(amount, currency)` on every Stripe amount so context amounts are major-unit `number`s that compose with Shopify (§6.3). | Money track. This spec **consumes** the conversion; it does not own the currency-exponent table. |
| `src/shared/integrations.ts` | The pinned `IntegrationDescriptor` / `LiveConnector` / `IntegrationRegistry` this connector satisfies; `IntegrationId` (edited, §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor` transport. | Integrations Hub (pinned — verbatim). |
| `src/main/integrations/credential-store.ts` | The `safeStorage` keychain the token store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError` (feeds `status()`). | Integrations Hub. |
| `src/main/integrations/integration-registry.ts` | `registerConnector('stripe', …)` (line 54) wires the live dispatch; `deriveStatus('stripe')` gives Stripe its status for free. | Integrations Hub. |
| `src/main/flow/node-runners/action-runner.ts` | How `invokeAction` is called, the **reject = failure** convention, and how the resolved value lands in context for conditions. | Flow engine. |
| `src/main/flow/trigger-subscriber.ts`, `context.ts`, `flow-engine.ts`, `flow-model.ts` | How `subscribe` seeds runs; dotted-path reads + boolean routing; the run lifecycle + gate handling; the `INTEGRATION_IDS` allow-list (edited, §6.0). | Flow engine. |
| `guard/` (lfguard) | The deterministic-guard *posture* the optional Stripe backstop (§9) borrows — a policy floor under the author's gates, no model in the loop. | lfguard. |

### 4.4 Wiring the live dispatch (verbatim, the Shopify pattern)

`src/main/index.ts` constructs the `StripeConnector` (given a `StripeApi` built on
the real HTTP transport + the `CredentialStore` reveal, and the shared webhook
receiver) and registers it — the exact call shape already used for Shopify/Woo
(`index.ts:249`, `:269`):

```ts
integrationRegistry.registerConnector(
  'stripe',
  new StripeConnector({ api: new StripeApiClient({ transport, reveal }), webhook })
)
```

Nothing in the pinned `IntegrationRegistry` contract changes — `registerConnector`
+ the `connectors` map already exist. Stripe is simply a new entry, and (like the
Shopify/Woo foundation slices) the MVP may register with a **deferred transport**
that rejects loudly until the real HTTP + reveal binding lands, so the descriptor,
normalizer, and mock-tested dispatch ship first.

### 4.5 Receiving webhooks (cloud ingress)

Identical in shape to Shopify's — Stripe posts from the cloud, the shared receiver
binds loopback:

- **MVP ("for me" fork):** a developer tunnel forwards to the shared receiver; the
  Stripe webhook endpoint's URL is that tunnel, stored as the non-secret
  `webhookUrl` config ref. A documented v1 prerequisite.
- **Phase 2 ("product" fork):** a hosted relay that authenticates then forwards.
  Flagged in §13 — it changes distribution.

Regardless of ingress, verification (raw-body + timestamp, timing-safe, replay
window), size caps, dedup, and 200-fast are the **shared receiver's** job (§7).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `stripeDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as it does for the
others — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `restrictedKey` | Stripe restricted API key | **yes** | yes | string | `rk_live_…` / `rk_test_…`. Least-privilege (§8). Keychain only. Placeholder `rk_live_…`. |
| `webhookSecret` | Webhook signing secret | **yes** | yes | string | `whsec_…`. Verifies `Stripe-Signature` (§7). Keychain only. |
| `accountId` | Stripe account id | no | no | string | `acct_…`. Non-secret ref (display / future Connect). |
| `apiVersion` | Stripe API version | no | no | string | e.g. `2025-06-30`; defaults to a pinned version in `stripe-client.ts`. |
| `environment` | localflow environment (1-9) | no | yes | number | Which env hosts Stripe work (same field/validation as Shopify's). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay endpoint (§4.5). Placeholder `https://<tunnel>/stripe/webhook`. |
| `mode` | Stripe mode | no | no | string | `test` \| `live`; if omitted, derived from the key prefix (`rk_test_`/`rk_live_`). Guards against a live key firing against a test flow and vice-versa. |

`status('stripe')` reports `needs-config` until `restrictedKey`, `webhookSecret`,
and `environment` are all present; `error` if a stored secret can't be decrypted
(the hub's `decryptionError` path); `disabled` if configured-but-off; `connected`
otherwise. The action-runner refuses any non-`connected` Stripe node **before**
any network call.

---

## 6. Pinned Stripe vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `stripe-descriptor.ts` guards the ids; the field shape is guarded by the
> `stripe-normalize.ts` tests.

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'stripe'`:

```ts
export type IntegrationId =
  'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'stripe'
```

This is a **shared-union edit** with three companion touch-points that must move
in lockstep (each is a one-line add): `INTEGRATION_IDS` (the stable order array,
`integrations.ts:71`), the `INTEGRATION_IDS` allow-list in `flow-model.ts` (the
flow validator), and `DESCRIPTOR_DEFS` (`descriptors/index.ts`). No other
`IntegrationId` consumer needs a change — they iterate the array.

### 6.1 Triggers (webhook-backed, via the shared receiver)

| trigger id | label | underlying Stripe event | note |
|---|---|---|---|
| `charge.dispute.created` | Dispute (chargeback) opened | `charge.dispute.created` (native, 1:1). | The anchor trigger — a chargeback is the highest-stakes payment event a worker reacts to. |
| `charge.refunded` | Charge refunded | `charge.refunded` (native, 1:1). Fires when a charge is fully or partially refunded (including refunds issued outside localflow). | Lets a flow reconcile a Stripe refund back to the store order (composition, §7.3). |
| `invoice.payment_failed` | Invoice payment failed | `invoice.payment_failed` (native, 1:1). | Subscription/dunning path — wake a worker on a failed renewal to dun, pause, or gate a cancel. |

All three are **native 1:1 Stripe events** — no derivation cost (unlike Shopify's
`order.flagged`). The shared receiver delivers the verified event; the connector's
`stripe-normalize.ts` maps `event.type` → the trigger id(s) and the event's
`data.object` → the trigger payload (§6.3).

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | Stripe API | writes to context |
|---|---|---|---|
| `getCharge` | Get a charge | `GET /v1/charges/:id` | `StripeChargeContext` (§6.3) |
| `getCustomer` | Get a customer | `GET /v1/customers/:id` | `StripeCustomerContext` (§6.3) |
| `getDispute` | Get a dispute | `GET /v1/disputes/:id` | `StripeDisputeContext` (§6.3) |
| `getSubscription` | Get a subscription | `GET /v1/subscriptions/:id` | `StripeSubscriptionContext` (§6.3) |

**Gated mutation (the author places a gate before these — money actions):**

| action id | label | Stripe API | note |
|---|---|---|---|
| `createRefund` | Refund a charge | `POST /v1/refunds` | Amount from params (major units → converted to minor for Stripe) or full; optional `reason`. **Irreversible.** Sent with an `Idempotency-Key`. |
| `respondToDispute` | Respond to a dispute | `POST /v1/disputes/:id` | Submit structured `evidence` to contest, **or** `{ close: true }` to accept the chargeback. **Irreversible / time-bound** (Stripe's evidence deadline). |
| `cancelSubscription` | Cancel a subscription | `DELETE /v1/subscriptions/:id` | Optional `invoiceNow` / `prorate`. **Money-affecting** (stops billing / may refund). |

**Failure convention (pinned):** a mutation that fails **rejects** its promise with
the real Stripe error (`error.type` / `error.code` / `error.message`); a resolved
promise (any value) is success and its value becomes the node's context output
(`integrations.ts:33-43`, `action-runner.ts`). The connector never resolves a
sentinel-failure.

**None of the three mutations ever auto-runs.** They exist only as `action`
nodes reachable behind a gate/edge the author drew (§9). This is stricter than
Shopify's `addOrderNote` (a low-risk annotate that may be left un-gated): **all
three Stripe mutations move money or contest money**, so the connector treats them
uniformly as gated money actions.

### 6.3 Context-field shape (amounts as major-unit `number` + explicit `currency`)

A read (or a trigger) writes a **normalized, stable** object. **Every amount is a
major-unit `number`** produced by `minorToMajor(minorAmount, currency)`
(`src/shared/money.ts`), and **`currency` is always carried explicitly** (ISO
4217). Currency is **normalized to uppercase** so it compares equal to Shopify's
`order.currency` (`"USD"`) — Stripe's wire form is lowercase (`"usd"`). Unix
timestamps become ISO 8601. **Pinned shape:**

```ts
// src/shared/stripe.ts
export interface StripeChargeContext {
  charge: {
    id: string                 // "ch_…"
    amount: number             // MAJOR units, e.g. 50 (from minor 5000 USD), 5000 (¥5000)
    currency: string           // ISO 4217, UPPERCASE, e.g. "USD" (matches Shopify)
    amountRefunded: number     // MAJOR units — already refunded
    status: 'succeeded' | 'pending' | 'failed'
    paid: boolean
    refunded: boolean          // fully refunded
    disputed: boolean          // a dispute exists on this charge
    customerId: string         // "cus_…" (may be "")
    email: string              // receipt/billing email (may be "")
    paymentIntentId: string    // "pi_…" (may be "")
    createdAt: string          // ISO 8601 (from Stripe unix `created`)
  }
}

export interface StripeDisputeContext {
  dispute: {
    id: string                 // "dp_…"
    chargeId: string           // "ch_…" the dispute is against
    amount: number             // MAJOR units — disputed amount
    currency: string           // ISO 4217, UPPERCASE
    reason: string             // Stripe reason, e.g. "fraudulent", "product_not_received"
    status:                    // dispute lifecycle
      'warning_needs_response' | 'needs_response' | 'under_review'
      | 'won' | 'lost' | 'charge_refunded'
    evidenceDueBy: string      // ISO 8601 — the response deadline (empty if none)
  }
}

export interface StripeCustomerContext {
  customer: {
    id: string                 // "cus_…"
    email: string
    name: string
    currency: string           // default currency, UPPERCASE (may be "")
    delinquent: boolean        // has an unpaid invoice
  }
}

export interface StripeSubscriptionContext {
  subscription: {
    id: string                 // "sub_…"
    customerId: string         // "cus_…"
    status:                    // subscription lifecycle
      'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'trialing' | 'paused'
    amount: number             // MAJOR units — recurring amount
    currency: string           // ISO 4217, UPPERCASE
    currentPeriodEnd: string   // ISO 8601
    cancelAtPeriodEnd: boolean
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and the typed `FlowEdgeCondition` operators the sibling
conditions track owns). A **minor-unit integer** (`5000`) compared against a
Shopify **major-unit number** (`50.0`) is a **silent, 100×-wrong money bug** — and
a lowercase Stripe `"usd"` compared against Shopify's `"USD"` silently never
matches. Normalizing **once**, in one pure module, using the shared `minorToMajor`
and an explicit uppercase `currency`, is the correctness boundary that makes the
composition (§7.3) safe. The trigger payloads (§7.1) are normalized the same way,
so a `{{trigger.amount}}` is already major-unit.

---

## 7. Webhook design — the shared receiver + the Stripe timestamp verifier

### 7.1 The Stripe `WebhookVerifier` (Stripe is the reference `signsTimestamp` case)

The connector does **not** run its own HTTP server. It registers a **Stripe
`WebhookVerifier`** with `src/main/webhooks/webhook-receiver.ts`. Stripe's scheme
is the receiver's reference **timestamp** case; Shopify's raw-body-only HMAC is the
other. The Stripe verifier config (this spec's contribution to the shared track):

```ts
// consumed from src/main/webhooks/webhook-receiver.ts — this spec SPECIFIES the
// Stripe verifier, it does not design the receiver.
const stripeVerifier: WebhookVerifier = {
  id: 'stripe',
  path: '/stripe/webhook',
  header: 'Stripe-Signature',        // "t=<unixTs>,v1=<hex hmac-sha256>[,v1=<...>]"
  signsTimestamp: true,              // ← the reference case: timestamp is IN the signature
  algorithm: 'sha256',
  encoding: 'hex',                   // Stripe uses hex; Shopify uses base64
  // signed payload = `${t}.${rawBody}` (timestamp, ".", then the exact raw bytes)
  buildSignedPayload: (t, rawBody) => `${t}.${rawBody}`,
  toleranceSeconds: 300,             // reject deliveries whose `t` is >5min skewed (replay defense)
  secret: /* revealForConnector('stripe','webhookSecret') — never rendered */,
}
```

The receiver, given this config, must: capture the **raw body** (verify before
parsing), parse the `t` and **all** `v1` values from the header, compute
`HMAC-SHA256(secret, "<t>.<rawBody>")` as hex, `timingSafeEqual` it against each
`v1`, **and reject when `|now - t| > toleranceSeconds`** (the replay window —
unique to the `signsTimestamp` path; Shopify has no timestamp so this check is
skipped for it). Stripe supports **key rotation** by sending multiple `v1`s and
allowing two active signing secrets — the receiver accepts a match against any
configured secret. Dedup is on Stripe's **event `id`** (`evt_…`), read from the
parsed body, so an at-least-once redelivery never seeds a second run.

### 7.2 From verified event → `SeedEvent`

The receiver hands the connector a verified, deduped delivery (topic =
`event.type`, payload = `event.data.object`). `stripe-normalize.ts` maps it:
`event.type` → trigger id(s) via a small table (`charge.dispute.created` →
`['charge.dispute.created']`, etc.), and the `data.object` → a normalized trigger
payload (amounts **already major-unit**, currency uppercase):

```ts
export interface StripeDisputePayload {   // charge.dispute.created
  disputeId: string; chargeId: string; amount: number; currency: string
  reason: string; evidenceDueBy: string; eventId: string; type: string
}
export interface StripeRefundPayload {    // charge.refunded
  chargeId: string; amountRefunded: number; currency: string
  email?: string; eventId: string; type: string
}
export interface StripeInvoiceFailedPayload {  // invoice.payment_failed
  invoiceId: string; subscriptionId: string; customerId: string
  amountDue: number; currency: string; eventId: string; type: string
}
```

A malformed/unsupported event normalizes to `null` → **no run is seeded** (never
trust an unauthenticated or unexpected shape).

### 7.3 The Stripe × Shopify composition (the worked example)

**Scenario the author drew on the canvas:** *"When a Stripe dispute is opened, pull
the Stripe charge and the matching Shopify order; if the order was ≤ $50, in the
same currency, and already fulfilled, pause for me to **accept & refund** through
Stripe; otherwise pause for me to **contest** the dispute."* The order facts come
from **Shopify**; the money action goes through **Stripe**; **both mutations are
gated**; the edge conditions read **both** `{{shopify.order.*}}` and
`{{stripe.charge.*}}`.

```
[trigger: stripe · charge.dispute.created]      shared receiver verifies Stripe-Signature (§7.1)
        │  payload → context['t'] = { disputeId, chargeId, amount /*MAJOR*/, currency:"USD", reason }
        ▼
[action: stripe · getCharge]                     params={ id: "{{t.chargeId}}" }
        │  → stripe-client.charge() → normalize (minorToMajor, currency→UPPER)
        │  writes context['charge'] = StripeChargeContext  (charge.amount MAJOR, charge.email)
        ▼
[action: shopify · searchOrders]                 params={ email: "{{charge.charge.email}}" }
        │  → the MERGED Shopify connector → context['order'] = { orders:[ShopifyOrderContext], count }
        │  (order.total is ALSO major-unit — same unit as charge.amount by construction, §6.3)
        ▼
[router]                                          cross-connector edge conditions
   ├── edge: {{charge.charge.currency}} == {{order.orders.0.currency}}       (USD == USD)
   │         AND {{order.orders.0.total}} lte 50                             (Shopify order ≤ $50)
   │         AND {{order.orders.0.fulfillmentStatus}} == 'fulfilled'
   │        ▼
   │   [gate: "accept & refund this dispute?"]    GATED — money action (§9)
   │        │  approved ▼
   │   [action: stripe · createRefund]            params={ id:"{{t.chargeId}}", reason:"fraudulent" }
   │        │  → POST /v1/refunds (Idempotency-Key) → context['refund'] = { refundId, amount, currency }
   │        ▼   (done)
   │
   └── edge: (else — larger, cross-currency, or unfulfilled → worth contesting)
            ▼
        [gate: "contest this dispute?"]           GATED — money action (§9)
            │  approved ──► [action: stripe · respondToDispute]  { id:"{{t.disputeId}}", evidence:{…} }
            │  rejected ──► run ends 'rejected' (a human "no" is not a failure)
```

**Why this is the highest-synergy connector, concretely.** The condition
`{{order.orders.0.total}} lte 50` and the compare
`{{charge.charge.currency}} == {{order.orders.0.currency}}` **only work because
both connectors emit major-unit amounts and uppercase currencies** (§6.3). Without
the shared `minorToMajor` conversion, `charge.amount` would be `5000` and
`order.total` would be `50.0` — the `lte 50` edge would misroute every USD dispute,
and a `stripe.refund.amount` vs `shopify.order.total` reconciliation would be
100× off. The money convention is not a nicety; it is what makes the composition
correct. Order *context* from Shopify, money *action* through Stripe, **both
gated** — that is the ecom worker completing itself.

---

## 8. Auth & keychain — restricted keys, least privilege

**The keychain posture is the design's centerpiece.** We do **not** store a Stripe
**secret key** (`sk_…`, full account access). We store a **restricted API key**
(`rk_…`) scoped to **exactly** the loop's resources — least privilege — so that a
leaked or misused key can, at most, do what the connector's actions already do
behind gates, and nothing else (no payouts, no key creation, no balance access).

- **Restricted key scope (documented for the user creating it in the Stripe
  dashboard):**

  | Stripe resource | Permission | Why |
  |---|---|---|
  | Charges | **Read** | `getCharge`, and reading a charge for a dispute/refund. |
  | Customers | **Read** | `getCustomer`. |
  | Disputes | **Write** | `getDispute` (read) + `respondToDispute` (write). |
  | Refunds | **Write** | `createRefund`. |
  | Subscriptions | **Write** | `getSubscription` (read) + `cancelSubscription` (write). |
  | Invoices | **Read** | resolve `invoice.payment_failed` context. |
  | *Everything else* (Payouts, Balance, API keys, Payment Links, …) | **None** | not in the loop; least privilege. |

- **"For me" fork (MVP).** The user creates that restricted key in their Stripe
  dashboard, pastes it into the descriptor's masked `restrictedKey` field; it goes
  straight to the keychain via `CredentialStore.set`. Every request sends
  `Authorization: Bearer <restrictedKey>` — read at call time via
  `revealForConnector('stripe','restrictedKey')` (main-process-only, the sole
  plaintext exit; a grep test asserts no IPC/renderer caller). No OAuth, no
  refresh.
- **Webhook secret.** `whsec_…` stored the same way, used only inside the shared
  receiver's Stripe verifier to `timingSafeEqual` the `v1` signature (§7).
- **Honoring the global secret rule.** Neither the restricted key nor the webhook
  secret is **ever** written to `config.json`, `sessions.json`, the transcript, a
  log, a PR body, or any IPC payload. `config.json` holds only **references**
  (account id, api version, that an install exists — §5). Key **state** (present /
  decrypt-failing) may be surfaced via `status()`; the **value** never is.
- **"Product" fork (deferred, §13.1).** A distributable app uses **Stripe
  Connect** (OAuth) and sends a `Stripe-Account: acct_…` header per connected
  account (multi-tenant). The keychain shape already supports per-key storage; the
  additive change is a `stripe-connect.ts` module and an `accounts[]` config array.
  Same `Authorization` header shape at call time — only *acquisition* and
  *tenancy* differ.
- **Disconnect.** Clearing `restrictedKey` / `webhookSecret` flips `status()` to
  `needs-config`; the connector stops dispatching. No in-flight run is force-
  killed — it simply can't start a new Stripe action, and reports why (§11).

---

## 9. Authority & safety — the gate is the whole point

**Primary control — the flow's gates (already enforced).** Every mutation
(`createRefund`, `respondToDispute`, `cancelSubscription`) is an `action` node.
Authority is whatever the author wired: a `gate` node before the mutation pauses
the run `needs-you`; a conditional edge restricts *when* the mutation is even
reached. The engine already enforces this — a gate the author drew is honored, a
human "no" ends the run `rejected` (not a failure), a mutation with no path to it
never runs. **The connector never auto-mutates outside the graph the author
drew.** Because **all three Stripe mutations move or contest money**, the
connector treats them **uniformly as gated money actions** — there is no
"low-risk, may-be-un-gated" Stripe mutation (unlike Shopify's `addOrderNote`). The
gate is not a suggestion for these actions; it is the entire safety model.

**Optional deterministic backstop (phased — §13.2).** A *deterministic floor*
under the author's gates, in the spirit of **lfguard** (`guard/`) but as an **ecom
money policy** rather than a shell tokenizer:

- A small declarative `stripe.limits` config block (non-secret): e.g.
  `{ refundMaxAmount: 100, refundMaxCurrency: "USD", cancelRequiresGate: true,
  disputeAutoAcceptMax: 25 }`.
- Enforced **inside the connector**, **before** the `stripe-client` call, as a hard
  reject (the pinned failure convention): a `createRefund` for $250 major with
  `refundMaxAmount: 100` **rejects** with a legible "refund $250 exceeds the
  configured $100 Stripe limit — raise `stripe.limits.refundMaxAmount` or route it
  through a human gate." Deterministic, no model in the loop. The limit is compared
  in **major units** (the amount the author sees), consistent with §6.3.
- **Defense in depth**, not the primary control. Flagged as an open decision
  (§13.2) because its *default* (present vs absent, at what value) is a product
  call.

**Never render secrets.** The restricted key lives in the keychain; no error
message, log line, or context field ever contains it (§8, §11).

---

## 10. Cross-connector conditions (owned elsewhere — named, not designed)

The composition (§7.3) routes on **cross-connector** edge conditions —
`{{stripe.charge.*}}` **and** `{{shopify.order.*}}` in the same router. Two
dependencies, both **already satisfied by construction**, neither designed here:

1. **The condition operator set** (`gt`/`gte`/`lt`/`lte`/`eq`/`contains`/…) is
   owned by the **sibling conditions track** (the Shopify spec's §10). This spec's
   pinned fields (§6.3) are **shaped to be referenced by those operators**:
   `charge.amount` / `order.total` as **numbers** (so `lte 50` is numeric),
   `currency` as **uppercase strings** (so `==` is exact and cross-connector),
   `disputed` / `paid` as **booleans** (`truthy`), `status` as **lowercase enums**
   (`eq`/`ne`).
2. **Cross-connector context.** The engine's `context.ts` already namespaces each
   node's output under its node id, and `resolveField` reads any dotted path —
   there is nothing Stripe-specific to add for a router to read both a Stripe node
   and a Shopify node in one condition. This spec only **guarantees its field
   types line up with Shopify's** (major-unit number + uppercase currency), which
   is the §6.3 correctness boundary.

The dependency is one-directional: conditions depend on these field types; this
connector does not depend on the operator set landing first (it works under
`eq`-only routing, just less expressively).

---

## 11. Error handling

localflow's principle (error-message-style memory; demonstrated in
`credential-store.ts` and `action-runner.ts`): **every failure is human-readable,
actionable, and carries the real underlying exception. No silent catch. No bare
"failed" / "not found".** A mutation signals failure by **rejecting** its promise
with that message; the action-runner prefixes it with the node/action and surfaces
it on the run. Stripe's errors are well-structured (`error.type`, `error.code`,
`error.message`, `error.param`) — the connector forwards **those**, never a vaguer
minted string.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook signature invalid** | signature mismatch (never the body or secret) | Shared receiver: route + reason only; 400; **no run started**. |
| **Webhook timestamp outside tolerance** (replay) | the skew vs `toleranceSeconds` | Shared receiver: rejected as a possible replay; 400; **no run**. Unique to the Stripe `signsTimestamp` path (§7.1). |
| **Webhook duplicate** (`evt_…` seen) | the event id | 200 (Stripe redelivery is expected); dedup-drop; no second run. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | 4xx; dropped; no run. Never seeds on unvalidated shape. |
| **`status('stripe') !== 'connected'`** | the derived reason (missing key / decrypt error / disabled) | action-runner fails the node *before* any call: "Flow needs Stripe connected — action '<id>' can't run. Connect it in Settings." |
| **Restricted key invalid/revoked (HTTP 401)** | Stripe's `authentication_error` message | Rejects: "Stripe rejected the API key (401) — the restricted key was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Key lacks the required permission (HTTP 403)** | Stripe's `permission_error` message | Rejects with the exact missing scope: "Your Stripe restricted key can't write refunds — grant **Refunds: Write** to this key in the Stripe dashboard." (The least-privilege posture surfaces as an *actionable* error, not an opaque 403.) |
| **Resource not found (HTTP 404)** | the id that missed | Rejects: "Stripe has no charge '<id>' (wrong id, or it belongs to another account/mode)." — actionable, not a bare 404. |
| **Test/live mode mismatch** | the key mode vs the id prefix / `mode` config | Rejects: "This is a **live** key but '<id>' is a test-mode object (or vice-versa) — check `stripe.mode` / the object id." Prevents a test flow from firing live refunds. |
| **Rate limit (HTTP 429)** | `Retry-After` | `stripe-client` retries with backoff honoring `Retry-After`; only after exhausting retries does it reject with "Stripe throttled the request (retry in ~Ns)". Not swallowed. |
| **Refund business rejection** (already refunded, amount > charge, charge not captured) | Stripe's `error.code` (e.g. `charge_already_refunded`) | Rejects with the verbatim code + message: "Stripe refused the refund: charge already fully refunded (`charge_already_refunded`)." Never a silent no-op. |
| **Dispute already closed / past deadline** | Stripe's dispute error | Rejects: "Stripe won't accept evidence — dispute '<id>' is already '<status>' (the response deadline passed)." |
| **Idempotency replay conflict** | Stripe's `idempotency_error` | Rejects legibly; the connector's `Idempotency-Key` is derived from run + node id, so a *retry* is safe (returns the original result) while a *conflicting* reuse is reported, never double-charging. |
| **Backstop limit exceeded** (§9) | the limit + the attempted value (major units) | Rejects **before** the call: "refund $250 exceeds the configured $100 Stripe limit — raise `stripe.limits.refundMaxAmount` or route it through a human gate." |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "Stripe webhook URL '<url>' is unreachable — no payment events will arrive." Never a silent dead trigger. |
| **API version removed** | Stripe's version error | Rejects: "Stripe API version '<v>' is no longer served — bump `apiVersion` in Settings." (all shapes are in `stripe-client.ts`, so the bump is one file.) |

The connector **never** catches-and-drops. Where Stripe already returns a precise
`error.code`, the connector forwards *that*.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Stripe account**, matching localflow's existing seams
(pure modules, injected backends, fixture events). **No test ever performs a live
Stripe call**; CI has no Stripe credentials.

- **`StripeApi` interface + `MockStripeApi` seam.** `stripe-client.ts` is written
  *against* a `StripeApi` interface (`getCharge`, `getCustomer`, `getDispute`,
  `getSubscription`, `createRefund`, `respondToDispute`, `cancelSubscription`); the
  real impl wraps the HTTP transport. Tests inject a `MockStripeApi` returning
  **canned Stripe test-mode fixtures** (real `ch_…` / `dp_…` / `evt_…` shapes
  copied from Stripe's test mode) and canned `error` / `429` envelopes. Same
  posture as Shopify's `MockShopifyApi` and the `SessionManager` `spawnFn` seam.
- **`stripe-normalize.ts` unit tests (the correctness boundary, guarded hardest).**
  Pure function; assert every raw Stripe object → the pinned context shape (§6.3):
  **`minorToMajor` conversion for USD (`5000`→`50`), JPY (`5000`→`5000`,
  zero-decimal), and BHD (`5000`→`5.0`, three-decimal)**; currency lowercased
  wire → **uppercase**; unix `created` → ISO 8601; absent customer/email → empty
  strings; every trigger event → its normalized payload. This is where the
  money-convention bug would live, so it is tested exhaustively per currency class.
- **Stripe `WebhookVerifier` tests (via the shared receiver's test harness).** Feed
  fixture bodies with **valid and invalid `v1` signatures**, a **timestamp inside
  and outside `toleranceSeconds`** (replay), a **rotated second signing secret**, a
  **duplicate `evt_…`**, oversized bodies, and malformed JSON; assert 200/4xx and
  that only valid+signed+in-window+novel events produce a `SeedEvent`. Stripe is
  the reference `signsTimestamp` case, so the timestamp/replay path is asserted
  here.
- **`stripe-connector` dispatch tests** — with a `MockStripeApi` + a fake registry:
  assert `invokeAction('stripe','getCharge',…)` resolves the normalized context;
  assert an `error` response **rejects** with the verbatim Stripe message (the
  pinned failure convention); assert the backstop limit (§9) rejects **before** the
  mock is called; assert `createRefund` sends a stable `Idempotency-Key`.
- **Composition integration test (offline)** — wire the real `FlowEngine` + the
  registry with **both** the Stripe connector (over `MockStripeApi`) **and** the
  Shopify connector (over `MockShopifyApi`), drive the §7.3 loop: inject a
  `charge.dispute.created` `SeedEvent` → assert `getCharge` writes a **major-unit**
  `charge.amount` → assert Shopify `searchOrders` writes `order.total` in the
  **same unit** → assert the cross-connector edge (`currency ==`, `total lte 50`)
  selects the accept-&-refund branch → assert the gate pauses `needs-you` → on
  approval assert `createRefund` calls the Stripe mock. This is the test that
  proves the money convention makes the composition correct. Deterministic via the
  engine's injected `now()`.
- **Token-store test** — `revealForConnector` round-trip via a fake
  `SecretBackend`; a regression guard asserts **no key value appears** in any
  emitted log/console/error string (the secret rule).
- **Snapshot test on `stripeDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **"For me" restricted key vs the "product" Stripe Connect fork.** The biggest
   fork.
   - *For me* (MVP): one **restricted key** (`rk_…`) for Jonas's own account, in
     his keychain, least-privilege scoped (§8), a dev tunnel for ingress. Fastest
     to a dogfoodable payments worker.
   - *Product*: a **Stripe Connect** platform app — OAuth onboarding, per-connected-
     account `Stripe-Account` headers, `accounts[]` config, a hosted webhook relay
     (§4.5 phase 2). Changes auth (Connect OAuth), tenancy (multi-account), config,
     and testing. Recommendation: build MVP "for me", keep the key/config shapes
     multi-account-ready (they already are — `accounts[]` is additive).
2. **The deterministic money backstop — default present or absent, and at what
   value?** §9's per-action limits are proposed as **optional** and off by default
   (the author's gate is the primary control). But a shipped payments worker
   arguably *should* ship with a conservative default (e.g. `refundMaxAmount` set,
   `cancelRequiresGate: true`) so a mis-authored flow can't fire a large refund or
   accept a large chargeback. This is a product-safety call, not a technical one —
   flagged for a decision before the backstop phase. Whatever the default, it is
   **deterministic** (lfguard-style), never model-mediated.
3. **Trust the event's embedded object vs re-fetch via `getCharge`.** A
   `charge.dispute.created` event embeds the charge/dispute snapshot; re-fetching
   via `getCharge`/`getDispute` guarantees freshness (a dispute status can change
   between emission and processing) at the cost of an extra call. Leaning
   **re-fetch for the action path, embedded-snapshot for the trigger payload** —
   flagged so the templates track wires it consistently.
4. **Webhook endpoint management — manual vs programmatic.** MVP can have the user
   create the Stripe webhook endpoint in the dashboard (pointing at their tunnel),
   or the connector can create it via the API on connect (adds a scope + a teardown
   story). Leaning **manual for the MVP slice**, programmatic in phase 2 — same
   call as Shopify's §13.4.
5. **`currency` normalization ownership.** This spec pins **uppercase** currency in
   Stripe context (§6.3) to match Shopify. If the money track later canonicalizes
   currency casing inside `Money`, this spec defers to it; until then, the
   uppercasing lives in `stripe-normalize.ts`. Flagged so the two tracks don't
   double-normalize.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One account, one flow, the read + one gated money mutation, happy path:**

1. `IntegrationId` gains `'stripe'` (+ the three lockstep touch-points, §6.0);
   `stripeDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `restrictedKey` + `webhookSecret` stored (→ keychain); `status('stripe') ===
   'connected'`.
3. `stripe-client.ts` behind `StripeApi`: `getCharge` (`GET /v1/charges/:id`) live;
   `createRefund` (`POST /v1/refunds`, with `Idempotency-Key`) live.
   `stripe-normalize` produces `StripeChargeContext` via `minorToMajor` (major-unit
   amount, uppercase currency).
4. `registerConnector('stripe', new StripeConnector(…))` (§4.4) — `invokeAction`
   reaches the connector.
5. The shared receiver's **Stripe `WebhookVerifier`** (§7.1) handling
   `charge.dispute.created` with the timestamp scheme + replay window + `evt_…`
   dedup, behind a dev tunnel, emitting a `SeedEvent`.
6. On the canvas: `[charge.dispute.created] → [getCharge] → [gate] →
   [createRefund]` runs end-to-end. Errors per §11.

That slice proves the whole loop (a real dispute event wakes a real flow that reads
the charge and, behind a gate, refunds it) and is dogfoodable against Stripe **test
mode**.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. "For me" restricted key.
  `charge.dispute.created` + `getCharge` + `createRefund` + author gate. Single
  account, single environment.
- **Phase 2 — full vocabulary:** the rest of §6 — `getCustomer` / `getDispute` /
  `getSubscription`; `respondToDispute` / `cancelSubscription`; the `charge.refunded`
  and `invoice.payment_failed` triggers; programmatic webhook-endpoint management.
- **Phase 3 — the Stripe × Shopify composition (§7.3):** ship the cross-connector
  "dispute → Shopify order context → gated refund" template (owned/wired by the
  templates track, consuming §6 verbatim). This is the connector's headline value.
- **Phase 4 — deterministic money backstop:** the `stripe.limits` policy (§9),
  lfguard-style, with the default decided (§13.2). Per-action limits enforced in
  the connector before any mutation.
- **Phase 5 — product fork:** Stripe Connect (OAuth), per-account `Stripe-Account`
  headers, a hosted webhook relay, `accounts[]` multi-account isolation (§13.1).
- **Phase 6 — expand PSPs:** a peer connector (PayPal / Adyen) under
  `src/main/<psp>/`, reusing the `*-connector` / `*-client` / `*-normalize` shape,
  the shared receiver (its own `WebhookVerifier`), and the shared `Money`
  convention. No shared cross-PSP standard — each is its own connector, each
  emitting the same major-unit amounts so all compose with the store connectors.

---

## Appendix — reused localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `LiveConnector` / `IntegrationRegistry` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/webhooks/webhook-receiver.ts` — the **shared** receiver + `WebhookVerifier`
  the Stripe verifier (§7.1) plugs into; Stripe is its reference `signsTimestamp`
  case. **Consumed, not reimplemented.**
- `src/shared/money.ts` — `Money` + `minorToMajor`; the minor→major conversion
  `stripe-normalize.ts` applies to every amount (§6.3). **Consumed, not
  reimplemented.**
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses; `revealForConnector` (main-only plaintext exit),
  `decryptionError` (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector('stripe', …)`
  (line 54) wires the live dispatch; `deriveStatus` gives Stripe its status.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `stripe` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `stripe`;
  `shopify-descriptor.ts` is the descriptor-as-code template.
- `src/main/shopify/*` — the closest sibling and module-shape template
  (`shopify-connector.ts` → `stripe-connector.ts`, `shopify-admin.ts` →
  `stripe-client.ts`, `shopify-normalize.ts` → `stripe-normalize.ts`); the merged
  Shopify connector this one **composes with** (§7.3).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called, the
  **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs;
  `coerceEvent` / `matchesFilter` the webhook `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`charge.amount`, `order.total`) + cross-connector boolean
  routing.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` for deterministic tests.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0).
- `src/main/index.ts` — constructs + `registerConnector`s the `StripeConnector`
  (§4.4), the Shopify/Woo pattern verbatim (`index.ts:249`, `:269`).
- `guard/` (lfguard) — the deterministic-guard posture the optional money backstop
  (§9) borrows (a policy floor under the author's gates, no model in the loop).
</content>
</invoke>
