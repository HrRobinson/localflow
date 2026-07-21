# Zendesk Connector — Design

**Date:** 2026-07-20
**Status:** Design (spec) — not started. Feasibility **DONE** (YELLOW, §2). The
**support-ticket worker** that pairs with the shipped **ecom/Stripe worker**: a
customer support ticket is where an order problem *surfaces*, so the worker that
reads a ticket, pulls the matching order (Shopify) and payment (Stripe), drafts a
grounded reply, and — behind a human gate — sends it, is the customer-facing
completion of the commerce loop.
**Feature:** A **Zendesk connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. A ticket event (a customer replied, a ticket was created
or escalated) **triggers** a run; the flow **reads** ticket / comment / requester
state through Zendesk's REST API; and — behind gates the author places — it
**acts** on the ticket (reply, note, set status, assign). It does **not** hardcode
a support pipeline; the authority lives in the flow (conditions on edges, gates
where the author puts them), exactly as the flow engine already enforces and
exactly as the Shopify and Stripe connectors do.

This connector satisfies the **pinned** `IntegrationDescriptor` / `LiveConnector`
/ `IntegrationRegistry` contract in `src/shared/integrations.ts` and copies the
module shape of `src/main/shopify/` and `src/main/stripe/` (descriptor-as-code,
API client behind a transport seam, keychain token store, pure normalize, a
`LiveConnector` wired via `registerConnector`). It uses the **Shopify connector
spec** as its style and depth template
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`) and the **Stripe
connector spec** (`docs/superpowers/specs/2026-07-18-stripe-connector-design.md`)
as its shared-infra-consumer template.

**A note on ownership.** This spec **owns and pins the support vocabulary**
(§6: `IntegrationId` addition, triggers, actions, context-field shape) and is a
**reference consumer** of two *sibling-owned* patterns it must not reinvent:

- **The shared webhook receiver** (`src/main/webhooks/webhook-receiver.ts`, the
  `WebhookVerifier` config that generalizes the per-connector receivers). Zendesk
  signs **`timestamp + rawBody` with HMAC-SHA256** and carries the timestamp in a
  **separate header** — so it is a second consumer of the **`signsTimestamp: true`**
  path that Stripe is the reference for (§7). This spec **specifies the Zendesk
  verifier config** and **names one small receiver-track extension** Zendesk needs
  (an ISO-8601 timestamp for the replay window — §7.1); it does not design the
  receiver's internals.
- **The email connector's never-auto-send gate**
  (`docs/superpowers/specs/2026-07-16-email-execution-design.md`). A public reply
  to a customer is **customer-facing outbound** — the exact category the email
  spec's **never-auto-send** invariant governs. `replyToTicket(public)` reuses that
  gate **verbatim** and structurally (§9): draft-create and send are distinct
  steps, the drafted reply surfaces as `needs-you`, the human **peeks the exact
  outbound text**, and the send call has **one gated caller**. **The gate is the
  point** — the whole value is drafting-and-proposing autonomously while never
  sending without a click.

Where those tracks own a shape, this spec **names the dependency and stops** —
mirroring how the Stripe spec names the webhook-receiver and money tracks.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, a support
worker that wakes on a Zendesk ticket event, reads the ticket and its conversation
through Zendesk's REST API, **composes them with Shopify order and Stripe payment
context**, drafts a reply, routes on those facts via edge conditions, and performs
**gated** ticket mutations (reply / note / set-status / assign) — with the API
token in the OS keychain, **never** rendered, and **no customer-facing reply ever
auto-sending**.

### In scope (MVP)

- A new **Zendesk connector** module set under `src/main/zendesk/`, exposing a
  static `zendeskDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus a `ZendeskConnector` (`LiveConnector`) wired via
  `integrationRegistry.registerConnector('zendesk', …)` (`index.ts`, exactly the
  Shopify/Stripe pattern — `integration-registry.ts:54`).
- **Auth for the "for me" fork:** an **API token** used as HTTP Basic
  `{agentEmail}/token:{apiToken}` against `https://{subdomain}.zendesk.com/api/v2/`,
  with the token in the keychain via `CredentialStore` (§8). The **distributable**
  fork (Zendesk **OAuth**, `Authorization: Bearer <access_token>`) is designed-for
  but deferred (§8, §13).
- **`subdomain` as a required non-secret config field** (`your-co` in
  `your-co.zendesk.com`) — the per-tenant identity, analogous to Shopify's
  `shopDomain`. Every API call and the webhook origin key off it.
- A **Zendesk REST client** (`zendesk-api.ts`) — the **sole** place any Zendesk
  request/response shape lives — behind a `ZendeskApi` interface so tests inject a
  `MockZendeskApi` (§12), implementing the read + mutation surface behind the
  pinned actions (§6.2).
- **Webhook triggers via the shared receiver** (§7): `zendesk-connector` registers
  a **Zendesk `WebhookVerifier`** with `src/main/webhooks/webhook-receiver.ts` —
  header `X-Zendesk-Webhook-Signature` (base64), a separate
  `X-Zendesk-Webhook-Signature-Timestamp` header, HMAC-SHA256 over
  `timestamp + rawBody`, and a replay window. The connector does **not** hand-roll
  an HTTP server.
- The **pinned support vocabulary** (§6): four webhook-backed triggers, four read
  actions, five **gated-mutation** actions (of which the **public reply** rides the
  never-auto-send gate), and the **context-field shape** an action writes for
  downstream edge conditions.
- **Authority = the flow's gates.** Every mutation is an `action` node the author
  gates by placing a `gate` node (or a conditional edge) before it. A public reply
  to a customer is a **never-auto-send** action — **the gate is the whole point**;
  it never runs un-gated by construction of the flow the author drew (§9).
- **The Zendesk × Shopify × Stripe composition** as a first-class worked example
  (§7.3): a support worker whose reply draft is grounded in **both** the store
  order (Shopify) and the payment/refund state (Stripe), read into flow context and
  sent only behind a human peek→confirm.
- **Single subdomain, single saiife environment.** Config-as-code `zendesk`
  block in `config.json` (non-secret refs only); API token + webhook secret in the
  keychain.

### Out of scope (MVP) — explicitly deferred

- **Zendesk OAuth (the "product" fork).** Multi-subdomain install, per-tenant
  OAuth client registration, `Authorization: Bearer`. MVP is the **"for me" fork**
  — one API token for one subdomain in the keychain (§8, §13.1). The config/token
  shapes are drawn so a `subdomains[]` / per-tenant array is the additive path.
- **Ticket *creation* / macro execution / side-conversations / help-center article
  writes.** MVP's mutation surface is the support-loop five (`replyToTicket`,
  `addInternalNote`, `setStatus`, `assignTicket`, `tagTicket`). Everything else is
  phase 2+.
- **Programmatic webhook + trigger provisioning.** MVP has the user create the
  Zendesk webhook + the firing trigger/automation in Admin Center (pointing at
  their tunnel); creating them via the API on connect is phase 2 (§13.4).
- **Non-Zendesk help desks** (Intercom, Freshdesk, Front, Gorgias, Help Scout). The
  module boundaries are help-desk-shaped so a peer connector can reuse them;
  justified-deferred in §2. Intercom is the designed next target (research track D).

---

## 2. Feasibility + landscape (DONE — YELLOW)

Feasibility is complete (research track D, `scratchpad/research/D-commerce-support.md`);
this section records the verdict, not open questions.

### 2.1 Why Zendesk, and why it pairs with the ecom worker

Zendesk is the widest-install B2B help desk with the cleanest REST surface of the
support vendors. The ecom worker already reads *order* state (Shopify) and *money*
state (Stripe); **the customer's actual question lives in a support ticket**. That
is the pairing: a `ticket.commentAdded` is where "where's my refund?" / "this
arrived broken" actually *arrives*, and answering it well needs the order and the
payment. This connector is therefore the **customer-facing front end** of the
commerce track — it does not open a new domain, it **completes** the loop by giving
the worker a channel to reply on (behind a gate).

### 2.2 The Zendesk API for pull → read → act (verified, research track D)

- **Read.** `GET /tickets/{id}.json`, `GET /tickets/{id}/comments.json` (the
  conversation thread), `GET /search.json?query=` (by requester email / status /
  tag), and `GET /users/{id}.json` (requester context) cover the read surface
  (`getTicket`, `getComments`, `searchTickets`, `getUser`). GA, stable.
- **Act.** Zendesk folds reply + status + assignment into **one** `PUT
  /tickets/{id}.json` (a `comment` object with `public: true|false`, a `status`,
  an `assignee_id`/`group_id`); tags are `PUT /tickets/{id}/tags.json`. The
  connector exposes these as **distinct pinned action ids** mapping to different
  fields on the same underlying call, so the author gates each independently
  (§6.2). All GA.
- **Auth.** **API token** via HTTP Basic `{agentEmail}/token:{apiToken}` — two
  inputs (a non-secret agent email, a secret token) plus the non-secret
  **subdomain**. Long-lived until rotated in Admin Center. The **OAuth** fork
  (distributable) sends `Authorization: Bearer <access_token>`; same REST calls,
  only *acquisition* + *tenancy* differ (§8, §13.1).
- **Webhooks (push, not poll).** A Zendesk webhook (Admin Center → Webhooks, fired
  by a trigger/automation) POSTs JSON with **`X-Zendesk-Webhook-Signature`**
  (base64) and a separate **`X-Zendesk-Webhook-Signature-Timestamp`** header; the
  signature is `Base64(HMAC-SHA256(secret, timestamp + rawBody))`. Verification
  therefore needs the **timestamp** (replay defense) — the **`signsTimestamp: true`**
  case the shared receiver supports, with Stripe as its reference and Zendesk a
  second consumer (§7). Verify over the **raw body before parsing** (a re-serialized
  body breaks it).
- **Rate limits.** Per-minute, plan-tiered (~200/min Team → ~700/min Enterprise;
  High Volume add-on → 2,500/min); `429` with a **`Retry-After`** header, handled
  with backoff in the client (§11). A relevant **sub-limit:** ticket-update
  endpoints are capped at **~30 updates / 10 min / agent** — far above a
  human-gated worker's rate, but a bulk-triage design must respect it (§11).

### 2.3 Why YELLOW (not GREEN)

Everything the loop needs is GA and buildable end-to-end with no blockers. It is
**YELLOW** rather than GREEN for three honest reasons, each a friction not a gap:

1. **Per-tenant onboarding friction.** Connecting requires a **subdomain**, an
   **agent email**, an **API token** the admin mints, and a **webhook + firing
   trigger** the admin configures in Admin Center — the "operator onboarding"
   friction already flagged as a product pain. Real setup surface, not a capability
   gap (§13.1).
2. **The reply-vs-internal-note discipline is load-bearing.** `comment.public:
   true` is a customer-facing reply; `comment.public: false` is an internal note.
   These are **the same underlying `PUT`** distinguished by one boolean. The
   connector must wire them as **distinct gated action ids** so a public reply
   *always* rides the never-auto-send gate and can never be sent as a side effect
   of a status/assign write (§6.2, §9, §13.2).
3. **SaaS-only, no frictionless sandbox.** Unlike Stripe's `test` mode + CLI,
   Zendesk's dev loop is a **trial subdomain**; CI never touches a live subdomain
   (everything is mocked — §12).

Cloud ingress for webhooks is the same known pattern Shopify/Stripe already solved
(a tunnel in MVP, a hosted relay in the product fork).

---

## 3. The core loop → Zendesk primitives

saiife's support loop is `trigger → read → route → draft → gate → act`. Each
stage maps to a concrete Zendesk primitive and the concrete flow-engine mechanism
that runs it:

| Stage | Zendesk primitive | saiife / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified Zendesk webhook (`ticket.created`, `ticket.updated`, `ticket.commentAdded`, `ticket.escalated`), fired by an Admin-Center trigger/automation, delivered to the **shared webhook receiver**. | The receiver verifies the `X-Zendesk-Webhook-Signature` (timestamp scheme, §7) → the connector normalizes the payload to a `SeedEvent` → `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context (`trigger-subscriber.ts`, `flow-engine.ts`). |
| **read** | `GET /tickets/{id}` · `/tickets/{id}/comments` · `/search.json` · `/users/{id}`. | An `action` node (`getTicket` / `getComments` / `searchTickets` / `getUser`) → `registry.invokeAction('zendesk', ref, params)` → the connector calls `zendesk-api.ts` → `zendesk-normalize.ts` maps it → the connector **resolves** it, which the action-runner writes to context under the node id. |
| **route** | *(none — pure saiife)* | `selectEdges` evaluates edge conditions over the context the reads wrote, including **cross-connector** paths (`{{ticket.requesterEmail}}`, `{{order.orders.0.fulfillmentStatus}}`, `{{charge.charge.disputed}}` — §7.3). Deterministic value compares; **no LLM decides routing**. |
| **draft** | *(agent — the reply text)* | The agent, prompted with the ticket thread + composed order/payment context, drafts the reply body — the same drafting posture the email spec uses. The draft is *proposed*, never sent, until the gate. |
| **gate** | *(none — pure saiife)* | A `gate` node the author placed pauses the run `needs-you`; the human **peeks the exact reply** and approves in the cockpit. The public-reply mutation sits **downstream of the gate the author drew** (§9). |
| **act** | `PUT /tickets/{id}` (`comment` public/private, `status`, `assignee`) · `PUT /tickets/{id}/tags`. | The gated `action` node (`replyToTicket` / `addInternalNote` / `setStatus` / `assignTicket` / `tagTicket`) → `invokeAction` → `zendesk-api.ts` mutation. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* Zendesk error. |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities*; the *flow* decides which run, in what order, behind which
gates. A public reply with no gated path to it never sends.

---

## 4. Architecture in saiife

### 4.1 Where it sits

A new **main-process module set** under `src/main/zendesk/`, mirroring
`src/main/stripe/` (the closest sibling in shape) and `src/main/shopify/`. It is
**opt-in**: with no `zendesk` config entry (and no stored token) the descriptor's
`status()` returns `needs-config` and the engine refuses any Zendesk node before
any network call — saiife's "works with no integration" guarantee is unchanged.
The connector is the live implementation behind the registry's pinned
`invokeAction`/`subscribe`, registered via `registerConnector('zendesk', …)`.
**All Zendesk API shapes are isolated in `zendesk-api.ts`** (the blast radius for
any API change), exactly as Stripe isolates REST in `stripe-client.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/zendesk/zendesk-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'zendesk'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids (the contract the templates track consumes). Mirrors `shopify-descriptor.ts`. |
| `src/main/zendesk/zendesk-connector.ts` | The `ZendeskConnector implements LiveConnector`. Maps an action id → a `zendesk-api` call (params templated by the engine); maps a trigger id → a shared-receiver subscription. Holds **NO Zendesk shape and NO secret**: reads normalize through `zendesk-normalize.ts`; mutations resolve the client's small result; every failure **rejects** with the real cause. **Enforces the reply-vs-note split** — `replyToTicket` sets `comment.public: true`, `addInternalNote` sets `comment.public: false`, and the two are separate action ids so each is independently gated (§6.2). Mirrors `stripe-connector.ts`. |
| `src/main/zendesk/zendesk-api.ts` | Thin **Zendesk REST client** behind a `ZendeskApi` interface (`getTicket`, `getComments`, `searchTickets`, `getUser`, `updateTicket`, `setTags`). **All** Zendesk request/response shapes (`RawTicket`, `RawComment`, `RawUser`, the `error` envelope) live *only* here. Sends HTTP Basic `{agentEmail}/token:{apiToken}` (or `Authorization: Bearer` in the OAuth fork), targets `https://{subdomain}.zendesk.com/api/v2/`; backs off on `429` honoring `Retry-After`. Isolated so tests inject a `MockZendeskApi` (§12). |
| `src/main/zendesk/zendesk-normalize.ts` | **Pure** mapping: a raw Zendesk ticket/comment/user → the pinned context-field shape (§6.3), and a raw webhook payload → a `SeedEvent`. Statuses lowercased to exact-match enums; tags as a string array; no money in the core object, so **fewer normalization traps than Stripe**. Unit-testable in isolation (mirrors `stripe-normalize.ts` purity). Never throws — a sparse payload normalizes to safe defaults. |
| `src/main/zendesk/zendesk-token-store.ts` | Keychain-backed access to the API token + webhook secret. A **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('zendesk', 'apiToken')`) — reuses the existing keychain sidecar, does not open a second. Named distinctly so a grep test asserts no IPC/renderer caller. |
| `src/main/zendesk/zendesk-config.ts` | Reads the non-secret `zendesk` refs from the integrations config block (**subdomain**, agent email, environment, webhook url) — the `integration-config.ts` validate-at-the-boundary pattern; holds Zendesk-specific coercion (subdomain normalization: strip a pasted `https://…zendesk.com`). |
| `src/shared/zendesk.ts` | Shared, **already-normalized** types (`ZendeskTicketContext`, `ZendeskCommentContext`, `ZendeskUserContext`, the action-param shapes, the trigger-payload shapes) and the pinned vocabulary id arrays. Imported by main (connector/normalizer) and any renderer palette surface. **No raw Zendesk shape here** — those live only in `zendesk-api.ts`. Mirrors `src/shared/stripe.ts`. |

### 4.3 Consumed shared infra (do NOT reimplement)

| Shared module | What this connector uses | Ownership |
|---|---|---|
| `src/main/webhooks/webhook-receiver.ts` (`WebhookVerifier`) | The connector registers a **Zendesk verifier** (§7) and an `onEvent` sink; the receiver owns the HTTP server, `MAX_BODY_BYTES`, `responded` guard, 200-fast, raw-body capture, timing-safe compare, and dedup. Zendesk is a **second `signsTimestamp: true` consumer** (Stripe is the reference). | Webhook-receiver track. This spec **specifies the Zendesk verifier config** and **names one extension** (ISO-8601 timestamp for the replay window — §7.1); it does not design the receiver. |
| `docs/superpowers/specs/2026-07-16-email-execution-design.md` (never-auto-send) | The **structural draft→gate→send pattern** for `replyToTicket(public)` (§9): distinct draft/send steps, single gated send caller, peek shows the exact outbound text via `ApproveButton` peek→confirm. | Email connector. This spec **reuses** the gate; it does not redefine the approval primitive. |
| `src/shared/integrations.ts` | The pinned `IntegrationDescriptor` / `LiveConnector` / `IntegrationRegistry` this connector satisfies; `IntegrationId` (edited, §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor` transport. | Integrations Hub (pinned — verbatim). |
| `src/main/integrations/credential-store.ts` | The `safeStorage` keychain the token store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError` (feeds `status()`). | Integrations Hub. |
| `src/main/integrations/integration-registry.ts` | `registerConnector('zendesk', …)` (line 54) wires the live dispatch; `deriveStatus('zendesk')` gives Zendesk its status for free. | Integrations Hub. |
| `src/main/integrations/integration-config.ts` | Validate-at-the-boundary config parsing the `zendesk` block reuses (secrets dropped-with-notice). | Integrations Hub. |
| `src/main/flow/node-runners/action-runner.ts` | How `invokeAction` is called, the **reject = failure** convention, and how the resolved value lands in context for conditions. | Flow engine. |
| `src/main/flow/trigger-subscriber.ts`, `context.ts`, `flow-engine.ts`, `flow-model.ts` | How `subscribe` seeds runs; dotted-path reads + boolean routing; the run lifecycle + gate handling (`needs-you`, human-"no"-is-not-a-failure); the `INTEGRATION_IDS` allow-list (edited, §6.0). | Flow engine. |
| `src/renderer/src/components/ApproveButton.tsx` + `src/main/peek.ts` | The peek→confirm gate UI reused for the reply gate — peek returns the **draft reply body** the human reads before confirming send (§9). | Email/agent-pane surface. |

### 4.4 Wiring the live dispatch (verbatim, the Stripe pattern)

`src/main/index.ts` constructs the `ZendeskConnector` (given a `ZendeskApi` built
on the real HTTP transport + the `CredentialStore` reveal, and the shared webhook
receiver) and registers it — the exact call shape already used for
Shopify/Stripe/Slack (`index.ts:292`+ `registerConnector` sites):

```ts
integrationRegistry.registerConnector(
  'zendesk',
  new ZendeskConnector({ api: new ZendeskRestApi({ transport, reveal }), webhook })
)
```

Nothing in the pinned `IntegrationRegistry` contract changes —
`registerConnector` + the `connectors` map already exist. Zendesk is simply a new
entry, and (like the Shopify/Stripe foundation slices) the MVP may register with a
**deferred transport** that rejects loudly until the real HTTP + reveal binding
lands, so the descriptor, normalizer, and mock-tested dispatch ship first.

### 4.5 Receiving webhooks (cloud ingress)

Identical in shape to Stripe's — Zendesk posts from the cloud, the shared receiver
binds loopback:

- **MVP ("for me" fork):** a developer tunnel forwards to the shared receiver; the
  Zendesk webhook endpoint's URL is that tunnel, stored as the non-secret
  `webhookUrl` config ref. A documented v1 prerequisite.
- **Phase 2 ("product" fork):** a hosted relay that authenticates then forwards.
  Flagged in §13 — it changes distribution.

Regardless of ingress, verification (raw-body + timestamp, timing-safe, replay
window), size caps, dedup, and 200-fast are the **shared receiver's** job (§7).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `zendeskDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as it does for the
others — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `apiToken` | Zendesk API token | **yes** | yes | string | Used as HTTP Basic `{agentEmail}/token:{apiToken}` (§8). Keychain only. |
| `webhookSecret` | Webhook signing secret | **yes** | yes | string | Verifies `X-Zendesk-Webhook-Signature` (§7). From the webhook's "Show Signing Secret". Keychain only. |
| `subdomain` | Zendesk subdomain | no | yes | string | `your-co` in `your-co.zendesk.com`. Non-secret ref; every call + the webhook origin key off it. Placeholder `your-co`. |
| `agentEmail` | Agent email | no | yes | string | The email half of the Basic-auth pair; the identity replies are attributed to. Non-secret. |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts Zendesk work (same field/validation as Stripe's). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay endpoint (§4.5). Placeholder `https://<tunnel>/zendesk/webhook`. |

`status('zendesk')` reports `needs-config` until `apiToken`, `webhookSecret`,
`subdomain`, `agentEmail`, and `environment` are all present; `error` if a stored
secret can't be decrypted (the hub's `decryptionError` path); `disabled` if
configured-but-off; `connected` otherwise. The action-runner refuses any
non-`connected` Zendesk node **before** any network call.

---

## 6. Pinned support vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `zendesk-descriptor.ts` guards the ids; the field shape is guarded by the
> `zendesk-normalize.ts` tests.

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'zendesk'`:

```ts
export type IntegrationId =
  | 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'posthog'
  | 'gitlab' | 'slack' | 'http' | 'stripe' | 'github' | 'sentry' | 'hubspot'
  | 'zendesk'
```

This is a **shared-union edit** with **three** companion touch-points that must
move in **lockstep** (each is a one-line add): the `INTEGRATION_IDS` stable-order
array (`integrations.ts:99`), the `INTEGRATION_IDS` allow-list set in
`flow-model.ts:29` (the flow validator), and `DESCRIPTOR_DEFS`
(`descriptors/index.ts:19`). No other `IntegrationId` consumer needs a change —
they iterate the array.

### 6.1 Triggers (webhook-backed, via the shared receiver)

| trigger id | label | underlying Zendesk source | note |
|---|---|---|---|
| `ticket.commentAdded` | Customer replied on a ticket | An Admin-Center trigger firing the webhook on a new **public** comment by the requester. | **The flagship trigger** (§7.3) — a customer reply is the most common support wake-up. |
| `ticket.created` | New ticket created | A trigger firing on ticket creation. | The clean "new inbound" case. |
| `ticket.updated` | Ticket updated | A trigger firing on ticket update (status/priority/assignee change). | Broad; templates narrow with edge conditions. |
| `ticket.escalated` | Ticket escalated | A trigger/automation firing on an escalation (SLA breach, priority raise, tag). | Wake a worker on the tickets that matter most. |

All four are wired via a Zendesk **trigger or automation** the admin configures to
POST the connector's webhook (§13.4 — manual in MVP). The shared receiver delivers
the verified payload; `zendesk-normalize.ts` maps it to a trigger id + the trigger
payload (§6.3).

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | Zendesk API | writes to context |
|---|---|---|---|
| `getTicket` | Get a ticket | `GET /tickets/{id}.json` | `ZendeskTicketContext` (§6.3) |
| `getComments` | Get the ticket conversation | `GET /tickets/{id}/comments.json` | `{ comments: ZendeskCommentContext[]; count }` |
| `searchTickets` | Search tickets | `GET /search.json?query=` | `{ tickets: ZendeskTicketContext[]; count }` |
| `getUser` | Get the requester | `GET /users/{id}.json` | `ZendeskUserContext` (§6.3) |

**Gated mutation (the author places a gate before these):**

| action id | label | Zendesk API | gate note |
|---|---|---|---|
| `replyToTicket` | Public reply to the customer | `PUT /tickets/{id}.json` — `comment.body` + **`comment.public: true`** | **Customer-facing → the never-auto-send gate (§9).** Draft as `needs-you`, human peeks the exact reply, confirm sends. The connector hard-sets `public: true` for this id. |
| `addInternalNote` | Add an internal note | `PUT /tickets/{id}.json` — `comment.body` + **`comment.public: false`** | Internal-only (the analog of Shopify's `addOrderNote`) — may be left un-gated if the author chooses, but still an action node. The connector hard-sets `public: false`. |
| `setStatus` | Set ticket status | `PUT /tickets/{id}.json` — `status: open\|pending\|solved\|closed` | State change; gate `solved`/`closed`. |
| `assignTicket` | Assign the ticket | `PUT /tickets/{id}.json` — `assignee_id`/`group_id` | Routing; low-risk. |
| `tagTicket` | Tag the ticket | `PUT /tickets/{id}/tags.json` | Low-risk annotate. |

**The reply/note split is structural, not conventional.** Zendesk folds reply +
status + assign into **one** `PUT`; the connector exposes them as **distinct action
ids** that each set only their own fields on that call. `replyToTicket` is the
**only** id that emits `comment.public: true`, and it is the **only** id routed
through the never-auto-send gate (§9). A `setStatus` or `assignTicket` call can
**never** carry a public comment as a side effect — so a customer-facing reply is
reachable *only* through the gated `replyToTicket` node the author drew.

**Failure convention (pinned):** a mutation that fails **rejects** its promise with
the real Zendesk error (`error`/`description`/`details`); a resolved promise (any
value) is success and its value becomes the node's context output
(`integrations.ts:47-56`, `action-runner.ts`). The connector never resolves a
sentinel-failure.

### 6.3 Context-field shape (what an action writes for later conditions)

A read (or a trigger) writes a **normalized, stable** object under its node id.
Statuses are lowercased to exact-match enums (like Shopify), tags are a string
array, timestamps are ISO 8601, ids are bare numbers-as-strings. **No money lives
in the core Zendesk object** — order totals and payment amounts come from the
composed Shopify/Stripe reads (§7.3), which already carry the pinned major-unit
`number` + uppercase `currency` convention. **Pinned shape:**

```ts
// src/shared/zendesk.ts
export interface ZendeskTicketContext {
  ticket: {
    id: string                 // numeric ticket id, e.g. "35436"
    subject: string
    status: 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed'
    priority: 'low' | 'normal' | 'high' | 'urgent' | ''  // '' when unset
    requesterEmail: string     // the customer's email — the JOIN key to Shopify/Stripe
    requesterId: string
    assigneeId: string         // '' when unassigned
    groupId: string            // '' when ungrouped
    tags: string[]
    satisfactionScore: 'offered' | 'good' | 'bad' | 'unoffered'
    createdAt: string          // ISO 8601
    updatedAt: string          // ISO 8601
  }
}

export interface ZendeskCommentContext {
  comment: {
    id: string
    body: string               // plain-text body
    public: boolean            // true = customer-facing, false = internal note
    authorId: string
    authorRole: 'end-user' | 'agent' | 'system'  // who wrote it
    createdAt: string          // ISO 8601
  }
}

export interface ZendeskUserContext {
  user: {
    id: string
    email: string
    name: string
    role: 'end-user' | 'agent' | 'admin'
    organizationId: string     // '' when none
    createdAt: string          // ISO 8601
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and the typed `FlowEdgeCondition` operators the sibling
conditions track owns). `status`/`priority` as **lowercase enums** so `eq`/`ne` are
exact; `tags` as a **string array** so `contains` works; `public` as a **boolean**
for `truthy`; `requesterEmail` as a **string** so `contains` and — critically — the
**cross-connector join** to `{{order.orders.0.email}}` / `{{charge.charge.email}}`
compare equal (§7.3). Normalizing **once**, in one pure module, is the correctness
boundary. The trigger payloads (§7.1) are normalized the same way.

---

## 7. Webhook design — the shared receiver + the Zendesk timestamp verifier

### 7.1 The Zendesk `WebhookVerifier` (a second `signsTimestamp` consumer)

The connector does **not** run its own HTTP server. It registers a **Zendesk
`WebhookVerifier`** with `src/main/webhooks/webhook-receiver.ts`. Zendesk's scheme
is the receiver's `signsTimestamp` path (Stripe is the reference; Zendesk is a
second consumer). Zendesk differs from Stripe in two pinned details: the timestamp
is in a **separate header** (Stripe embeds it in the signature header as `t=`), and
the base string is a **bare concatenation** `timestamp + rawBody` (Stripe uses
`timestamp + "." + rawBody`). The Zendesk verifier config (this spec's contribution
to the shared track):

```ts
// consumed from src/main/webhooks/webhook-receiver.ts — this spec SPECIFIES the
// Zendesk verifier, it does not design the receiver.
const zendeskVerifier: WebhookVerifier = {
  scheme: 'hmac',
  algo: 'sha256',
  header: 'x-zendesk-webhook-signature',            // base64 signature
  encoding: 'base64',                                // Zendesk uses base64 (Stripe: hex)
  signsTimestamp: true,                              // ← the replay-window path
  timestampHeader: 'x-zendesk-webhook-signature-timestamp',  // SEPARATE header (not embedded)
  // signed base string = `${timestamp}${rawBody}` (NO separator — differs from Stripe's `${t}.${body}`)
  baseString: ({ timestamp, rawBody }) => `${timestamp}${rawBody}`,
  toleranceSec: 300,                                 // reject deliveries whose timestamp is >5min skewed
}
// secret: revealForConnector('zendesk','webhookSecret') — supplied to the receiver, never rendered
```

The receiver, given this config, must: capture the **raw body** (verify before
parsing), read the timestamp from `timestampHeader`, compose
`HMAC-SHA256(secret, timestamp + rawBody)` as base64, `timingSafeEqual` it against
`X-Zendesk-Webhook-Signature`, **and reject when the timestamp is outside
`toleranceSec`** (the replay window). Dedup is on the ticket-event id / delivery id
carried in the payload so an at-least-once redelivery never seeds a second run.

> **Named receiver-track dependency (one small extension).** The current
> `signsTimestamp` replay-window math does `Number(resolved)` and treats the value
> as epoch seconds/milliseconds (`timestampUnit`). **Zendesk's timestamp is
> ISO-8601** (e.g. `2026-07-20T14:31:08Z`), which `Number(...)` renders `NaN` →
> rejected. Zendesk therefore needs the receiver to support an **ISO-8601 timestamp
> unit** for the *replay-window comparison only* (the RAW timestamp string is still
> what gets signed, via `baseString`). This is a **~one-line `timestampUnit:
> 'iso8601'` (or a `parseTimestamp` hook) addition owned by the webhook-receiver
> track** — named here, not designed here. Until it lands, the Zendesk verifier can
> ship with the replay-window check disabled (signature-only) as a documented
> interim, since the HMAC over `timestamp + body` still binds the timestamp; the
> replay *window* is the only part that needs the parse.

### 7.2 From verified delivery → `SeedEvent`

The receiver hands the connector a verified, deduped delivery.
`zendesk-normalize.ts` maps it: the Zendesk event type → the trigger id via a small
table, and the payload → a normalized trigger payload (statuses lowercased, tags as
an array):

```ts
export interface ZendeskTicketEventPayload {   // ticket.created / .updated / .escalated
  ticketId: string; subject: string; status: string; priority: string
  requesterEmail: string; tags: string[]; eventId: string; type: string
}
export interface ZendeskCommentEventPayload {  // ticket.commentAdded
  ticketId: string; commentId: string; body: string; public: boolean
  authorRole: string; requesterEmail: string; eventId: string; type: string
}
```

A malformed/unsupported delivery normalizes to `null` → **no run is seeded** (never
trust an unauthenticated or unexpected shape).

### 7.3 The Zendesk × Shopify × Stripe composition (the flagship worked example)

**Scenario the author drew on the canvas:** *"When a customer replies on a ticket,
pull the ticket thread, find their Shopify order and Stripe payment by email, draft
a reply grounded in that context, and pause for me to approve the exact reply. On
approve, post the public reply and mark the ticket solved."* The order facts come
from **Shopify**, the payment facts from **Stripe**, the reply channel is
**Zendesk**; **the public reply is gated** (never-auto-send); the edge conditions
read across **all three** connectors.

```
[trigger: zendesk · ticket.commentAdded]        shared receiver verifies X-Zendesk-Webhook-Signature (§7.1)
        │  payload → context['t'] = { ticketId, requesterEmail, body, public:true }
        ▼
[action: zendesk · getTicket]                    params={ id: "{{t.ticketId}}" }
        │  + [action: zendesk · getComments]      → context['ticket'], context['thread']
        ▼
[action: shopify · searchOrders]                 params={ email: "{{t.requesterEmail}}" }   ◄── COMPOSE
        │  → the MERGED Shopify connector → context['order'] = { orders:[ShopifyOrderContext], count }
        ▼
[action: stripe · searchCharges]                 params={ email: "{{t.requesterEmail}}" }    ◄── COMPOSE
        │  → the MERGED Stripe connector → context['charge'] = { charges:[StripeChargeContext], count }
        ▼
[agent drafts the reply]                         grounded in {{thread}}, {{order}}, {{charge}}
        ▼
[router]                                          cross-connector edge conditions
   ├── edge: {{order.orders.0.fulfillmentStatus}} == 'fulfilled'
   │         AND {{charge.charges.0.disputed}} == false
   │        ▼
   │   [gate: "approve this public reply?"]       GATED — never-auto-send (§9)
   │        │  peek shows the EXACT reply body the customer will see
   │        │  approved ▼
   │   [action: zendesk · replyToTicket]          params={ id:"{{t.ticketId}}", body:"{{draft}}" }  (public:true)
   │        ▼
   │   [action: zendesk · setStatus]              params={ id:"{{t.ticketId}}", status:"solved" }
   │        ▼   (done)
   │
   └── edge: (else — unfulfilled, disputed, or refund warranted)
            ▼
        [gate: "approve reply?"] ──► replyToTicket(public) ──► setStatus(pending)
            │  (a refund, if warranted, forks to a SEPARATELY-gated Shopify refundOrder /
            │   Stripe createRefund — money and reply are approved independently)
            │  rejected ──► run ends 'rejected' (a human "no" is not a failure)
```

**Why this is the support worker completing the commerce loop, concretely.** The
join `searchOrders(email:{{t.requesterEmail}})` and
`searchCharges(email:{{t.requesterEmail}})` **only work because
`ticket.requesterEmail`, `order.email`, and `charge.email` are all normalized
strings** (§6.3) — the email is the cross-connector key. The reply is drafted from
real order + payment facts, and it is **sent only behind the human peek→confirm**
that the email spec's gate provides. If a refund is warranted, it rides its **own**
gate on a Shopify/Stripe money node — **money and reputation are approved
separately**. Ticket context + order context + payment context, one reply, every
customer-facing action gated: that is the ecom/support worker whole.

---

## 8. Auth & keychain — API token (Basic) or OAuth (Bearer)

- **"For me" fork (MVP).** The admin mints an **API token** in Admin Center; the
  user pastes it (plus the non-secret `agentEmail` and `subdomain`) into the
  descriptor. The token goes straight to the keychain via `CredentialStore.set`.
  Every request sends HTTP Basic `Authorization: Basic base64("{agentEmail}/token:{apiToken}")`
  — the token read at call time via `revealForConnector('zendesk','apiToken')`
  (main-process-only, the sole plaintext exit; a grep test asserts no IPC/renderer
  caller). No OAuth, no refresh: the token is long-lived until rotated in Admin
  Center.
- **Webhook secret.** Stored the same way (`webhookSecret`), used only inside the
  shared receiver's Zendesk verifier to `timingSafeEqual` the
  `X-Zendesk-Webhook-Signature` (§7).
- **Honoring the global secret rule.** Neither the API token nor the webhook secret
  is **ever** written to `config.json`, `sessions.json`, the transcript, a log, a
  PR body, or any IPC payload. `config.json` holds only **references** (subdomain,
  agent email, that an install exists — §5). Token **state** (present /
  decrypt-failing) may be surfaced via `status()`; the **value** never is. The
  `agentEmail` is **not** secret (it is half of a Basic pair whose secret half is
  the token) — it may appear in config, but the token half never does.
- **"Product" fork (deferred, §13.1).** A distributable app uses **Zendesk OAuth**
  — the per-subdomain admin authorizes saiife's OAuth client, minting a
  per-tenant `access_token` sent as `Authorization: Bearer <token>`. The keychain
  shape already supports per-key storage; the additive change is a
  `zendesk-oauth.ts` module and a per-subdomain config array. Same REST calls at
  call time — only *acquisition* and *tenancy* differ.
- **Disconnect.** Clearing `apiToken` / `webhookSecret` flips `status()` to
  `needs-config`; the connector stops dispatching. No in-flight run is
  force-killed — it simply can't start a new Zendesk action, and reports why (§11).

---

## 9. Authority & safety — the reply gate is the whole point

**Primary control — the flow's gates (already enforced).** Every mutation
(`replyToTicket`, `addInternalNote`, `setStatus`, `assignTicket`, `tagTicket`) is
an `action` node. Authority is whatever the author wired: a `gate` node before the
mutation pauses the run `needs-you`; a conditional edge restricts *when* the
mutation is even reached. The engine already enforces this — a gate the author drew
is honored, a human "no" ends the run `rejected` (not a failure), a mutation with
no path to it never runs. **The connector never auto-mutates outside the graph the
author drew.**

**`replyToTicket(public)` reuses the email never-auto-send gate — verbatim and
structurally.** A public reply is **customer-facing outbound**, the exact category
the email spec's invariant governs. This is not enforced by policy or prompt; it is
**structural**, reusing the email spec's four guarantees (§5 of the email spec):

1. **Distinct draft/send steps.** The agent *drafts* the reply body (into flow
   context / the pane) — it never posts. Posting the public comment is a **separate**
   `zendesk-api.updateTicket({ comment: { public: true } })` call reached only from
   the gated `replyToTicket` node. There is no combined "draft-and-post" verb wired.
2. **A single gated send caller.** The public-reply post is invoked from exactly one
   place — the gated `replyToTicket` dispatch, reachable only after the
   `needs-you → approved` transition (the `ApproveButton` "Send ⏎" confirm). A grep
   test asserts one non-test caller of the public-reply path.
3. **The agent surface is read+draft only.** The agent can call the read actions and
   draft text; it has **no** affordance that posts a public comment. The post lives
   on the *human* side of the peek/Approve gate.
4. **Peek shows the exact outbound text.** For a reply-gate pane, the peek payload is
   the **draft reply body the customer will see** (not pty tail) — the human reads
   *exactly* what goes out, then confirms. The "never blind" property `ApproveButton`
   already guarantees, applied to the ticket reply.

**The reply/note discipline (§6.2) hardens this.** Because `replyToTicket` is the
only action id that emits `comment.public: true`, and `setStatus`/`assignTicket`
carry no comment, a customer-facing reply **cannot** be smuggled through a
status/assign write. `addInternalNote` (always `public: false`) may be left
un-gated by the author (an internal note is not customer-facing), but it can never
become a public reply.

**Optional deterministic backstop (phased — §13.2).** A *deterministic floor* under
the author's gates, in the spirit of **saiifeguard** (`guard/`) but as a **support
policy**: e.g. `{ publicReplyRequiresGate: true, autoSolveMax: 0 }` enforced inside
the connector before the `zendesk-api` call — a `replyToTicket(public)` reached
without a recorded approval **rejects** legibly. **Defense in depth**, not the
primary control; its *default* is a product-safety call flagged in §13.2.

**Never render secrets.** The API token lives in the keychain; no error message,
log line, or context field ever contains it (§8, §11).

---

## 10. Cross-connector conditions (owned elsewhere — named, not designed)

The composition (§7.3) routes on **cross-connector** edge conditions —
`{{ticket.*}}`, `{{order.orders.0.*}}`, and `{{charge.charges.0.*}}` in the same
router. Two dependencies, both **already satisfied by construction**, neither
designed here:

1. **The condition operator set** (`eq`/`ne`/`contains`/`truthy`/`exists`/…) is
   owned by the **sibling conditions track** (the Shopify spec's §10). This spec's
   pinned fields (§6.3) are **shaped to be referenced by those operators**:
   `status`/`priority` as **lowercase enums** (`eq`/`ne`), `tags` as a **string
   array** (`contains`), `public` as a **boolean** (`truthy`), `requesterEmail` /
   `subject` as **strings** (`contains`, and the cross-connector `eq` join).
2. **Cross-connector context.** The engine's `context.ts` already namespaces each
   node's output under its node id, and `resolveField` reads any dotted path — there
   is nothing Zendesk-specific to add for a router to read a Zendesk node, a Shopify
   node, and a Stripe node in one condition. This spec only **guarantees its
   `requesterEmail` lines up with Shopify's `order.email` and Stripe's
   `charge.email`** (all normalized strings), which is the §6.3 join boundary.

The dependency is one-directional: conditions depend on these field types; this
connector does not depend on the operator set landing first (it works under
`eq`-only routing, just less expressively).

---

## 11. Error handling

saiife's principle (error-message-style memory; demonstrated in
`credential-store.ts` and `action-runner.ts`): **every failure is human-readable,
actionable, and carries the real underlying exception. No silent catch. No bare
"failed" / "not found".** A mutation signals failure by **rejecting** its promise
with that message; the action-runner prefixes it with the node/action and surfaces
it on the run. Zendesk returns structured errors (`error`, `description`, `details`
with per-field messages) — the connector forwards **those**, never a vaguer minted
string.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook signature invalid** | signature mismatch (never the body or secret) | Shared receiver: route + reason only; 401; **no run started**. |
| **Webhook timestamp outside tolerance** (replay) | the skew vs `toleranceSec` | Shared receiver: rejected as a possible replay; 401; **no run**. The `signsTimestamp` path (§7.1) — gated on the ISO-8601 extension landing. |
| **Webhook duplicate** (delivery/event id seen) | the id | 200 (Zendesk redelivery is expected); dedup-drop; no second run. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | 4xx; dropped; no run. Never seeds on unvalidated shape. |
| **`status('zendesk') !== 'connected'`** | the derived reason (missing token / decrypt error / disabled) | action-runner fails the node *before* any call: "Flow needs Zendesk connected — action '<id>' can't run. Connect it in Settings." |
| **API token / auth invalid (HTTP 401)** | Zendesk's auth error | Rejects: "Zendesk rejected the credentials (401) — check the agent email, API token, and that token access is enabled in Admin Center; re-enter them in Settings." Value never included. |
| **Insufficient permission / not an agent (HTTP 403)** | Zendesk's permission error | Rejects with the actionable cause: "Zendesk refused '<action>' — the token's user lacks agent permission for this ticket/group." |
| **Wrong subdomain / host not found** | the resolved host that failed | Rejects: "Zendesk subdomain '<subdomain>' didn't resolve — check the `subdomain` field (it's the '<x>' in '<x>.zendesk.com')." — not a bare DNS error. |
| **Ticket / user not found (HTTP 404)** | the id that missed | Rejects: "Zendesk has no ticket '<id>' (wrong id, or it's on another subdomain)." — actionable, not a bare 404. |
| **Rate limit (HTTP 429)** | `Retry-After` | `zendesk-api` retries with backoff honoring `Retry-After`; only after exhausting retries does it reject with "Zendesk throttled the request (retry in ~Ns)". Not swallowed. |
| **Update sub-limit** (~30 updates / 10 min / agent) | the 429 + sub-limit hint | Rejects legibly pointing at the per-agent ticket-update cap — so a bulk-triage flow gets a real cause, not an opaque throttle. |
| **Reply/update business rejection** (closed ticket, invalid status transition, validation) | the verbatim Zendesk `details` field messages | Rejects with the field + message: "Zendesk refused the update: cannot reply to a closed ticket (`details: status`)." Never a silent no-op. |
| **Public reply reached without approval** (§9 backstop) | the missing approval record | Rejects **before** the call: "a public reply must be approved at a gate — route `replyToTicket` through a human gate." |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "Zendesk webhook URL '<url>' is unreachable — no ticket events will arrive." Never a silent dead trigger. |

The connector **never** catches-and-drops. Where Zendesk already returns a precise
`details` message, the connector forwards *that*.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Zendesk subdomain**, matching saiife's existing seams
(pure modules, injected backends, fixture events). **No test ever performs a live
Zendesk call**; CI has no Zendesk credentials.

- **`ZendeskApi` interface + `MockZendeskApi` seam.** `zendesk-api.ts` is written
  *against* a `ZendeskApi` interface (`getTicket`, `getComments`, `searchTickets`,
  `getUser`, `updateTicket`, `setTags`); the real impl wraps the HTTP transport.
  Tests inject a `MockZendeskApi` returning **canned ticket/comment/user fixtures**
  (real `/tickets/{id}.json` shapes) and canned `error` / `429` envelopes. Same
  posture as `MockShopifyApi` / `MockStripeApi` and the `SessionManager` `spawnFn`
  seam.
- **`zendesk-normalize.ts` unit tests (the correctness boundary).** Pure function;
  assert every raw ticket/comment/user → the pinned context shape (§6.3): status /
  priority lowercased to the exact enums; tags → string array; `public` boolean
  preserved; absent assignee/group/priority → `''`; author role mapped; timestamps
  → ISO 8601; every trigger payload → its normalized shape. The join field
  (`requesterEmail`) is asserted to match the Shopify/Stripe email shape.
- **Zendesk `WebhookVerifier` tests (via the shared receiver's harness).** Feed
  fixture bodies with **valid and invalid signatures**, a **timestamp inside and
  outside `toleranceSec`** (replay — once the ISO-8601 extension lands), a
  **duplicate delivery id**, oversized bodies, and malformed JSON; assert 200/4xx
  and that only valid+signed+in-window+novel deliveries produce a `SeedEvent`.
  Asserts the `timestamp + rawBody` (no-separator) base string and base64 encoding.
- **`zendesk-connector` dispatch tests** — with a `MockZendeskApi` + a fake
  registry: assert `invokeAction('zendesk','getTicket',…)` resolves the normalized
  context; assert an `error` response **rejects** with the verbatim Zendesk message;
  assert `replyToTicket` sends `comment.public: true` and `addInternalNote` sends
  `comment.public: false` (the reply/note split); assert `setStatus`/`assignTicket`
  carry **no comment**.
- **The reply never-auto-send invariant is tested explicitly** (load-bearing, from
  the email spec's §10): (a) a static/grep test asserting exactly one non-test
  caller of the public-reply post path; (b) drive a full trigger→read→draft cycle
  through the mock and assert **no public comment is posted** until the approval
  event fires; (c) on the confirm event, assert the public reply posts once with the
  approved body and an approval record was written first.
- **Composition integration test (offline)** — wire the real `FlowEngine` + the
  registry with the Zendesk connector (over `MockZendeskApi`), the Shopify connector
  (over `MockShopifyApi`), and the Stripe connector (over `MockStripeApi`); drive the
  §7.3 loop: inject a `ticket.commentAdded` `SeedEvent` → assert `getTicket` writes
  context → assert Shopify `searchOrders` and Stripe `searchCharges` join on
  `requesterEmail` → assert the cross-connector edge selects the reply branch →
  assert the gate pauses `needs-you` → on approval assert `replyToTicket(public)` +
  `setStatus(solved)` fire. Deterministic via the engine's injected `now()`.
- **Token-store test** — `revealForConnector` round-trip via a fake `SecretBackend`;
  a regression guard asserts **no token value** appears in any emitted
  log/console/error string (the secret rule), including the Basic-auth header build.
- **Snapshot test on `zendeskDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **"For me" API token vs the "product" OAuth fork — and the subdomain
   per-tenant onboarding.** The biggest fork, and the source of the YELLOW verdict.
   - *For me* (MVP): one **API token** for Jonas's own subdomain, in his keychain,
     with the subdomain + agent email as config, a dev tunnel + a hand-configured
     Admin-Center webhook/trigger for ingress. Fastest to a dogfoodable support
     worker — but it is **~5 manual setup steps across Admin Center** (mint token,
     create webhook, copy signing secret, create firing trigger, wire the tunnel
     URL), the "operator onboarding friction" already flagged as a product pain. A
     guided "Connect Zendesk" wizard is the natural mitigation.
   - *Product*: a **distributable OAuth app** — per-subdomain admin authorizes
     saiife's OAuth client, a per-tenant token array, a hosted webhook relay
     (§4.5 phase 2). Changes auth (OAuth), tenancy (multi-subdomain), config, and
     onboarding. Recommendation: build MVP "for me", keep the token/config shapes
     multi-subdomain-ready (a per-tenant array is additive), and invest the
     onboarding polish in a wizard either way.
2. **Public-reply vs internal-note discipline — how strict, and what's the backstop
   default?** §6.2/§9 pin `replyToTicket(public)` as the only public-comment id and
   route it through the never-auto-send gate; `addInternalNote` may be left un-gated.
   Open: does the connector ship the deterministic backstop
   (`publicReplyRequiresGate: true`) **on by default** so a mis-authored flow can't
   post a public reply un-gated? Leaning **yes** (a customer-facing reply is
   higher-stakes than an internal note, and the gate is the product's whole promise)
   — but it's a product-safety call flagged for a decision before the backstop
   phase. Whatever the default, it is **deterministic** (saiifeguard-style), never
   model-mediated.
3. **`ticket.commentAdded` scope — requester replies only, or any comment?** The
   flagship trigger should fire on a **customer** reply, not on an agent's own
   comment (which would loop the worker on its own reply). The Admin-Center trigger
   condition (`comment is public` + `current user is (end user)`) filters this, but
   which condition the **starter template** wires is a templates-track decision that
   depends on how the store runs its Zendesk. Flagged so the templates track owns it
   with eyes open (mirrors Shopify's `order.refundRequested` source decision).
4. **Webhook + trigger management — manual vs programmatic.** MVP has the user
   create the Zendesk webhook + firing trigger in Admin Center (pointing at their
   tunnel). The connector *could* create them via the Webhooks + Triggers APIs on
   connect (nicer UX) — but that adds admin scopes + a teardown story. Leaning
   **manual for the MVP slice**, programmatic in phase 2 — same call as Stripe's
   §13.4 / Shopify's §13.4.
5. **The receiver's ISO-8601 timestamp extension (§7.1).** Zendesk's replay-window
   check needs the shared receiver to parse an **ISO-8601** timestamp (the current
   `signsTimestamp` path assumes numeric epoch). This is a **receiver-track**
   one-liner (`timestampUnit: 'iso8601'` or a `parseTimestamp` hook). Flagged as a
   named dependency; until it lands, the Zendesk verifier ships signature-only
   (HMAC still binds the timestamp; only the *window* is deferred).

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One subdomain, one flow, the read + one gated reply, happy path:**

1. `IntegrationId` gains `'zendesk'` (+ the three lockstep touch-points, §6.0);
   `zendeskDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `apiToken` + `webhookSecret` + `subdomain` + `agentEmail` stored (token/secret →
   keychain); `status('zendesk') === 'connected'`.
3. `zendesk-api.ts` behind `ZendeskApi`: `getTicket` (`GET /tickets/{id}.json`)
   live; `getComments` live; `replyToTicket` (`PUT /tickets/{id}.json`,
   `comment.public: true`) live. `zendesk-normalize` produces `ZendeskTicketContext`.
4. `registerConnector('zendesk', new ZendeskConnector(…))` (§4.4) — `invokeAction`
   reaches the connector.
5. The shared receiver's **Zendesk `WebhookVerifier`** (§7.1) handling
   `ticket.commentAdded` with the timestamp scheme (signature-only until the
   ISO-8601 extension lands) + delivery-id dedup, behind a dev tunnel, emitting a
   `SeedEvent`.
6. On the canvas: `[ticket.commentAdded] → [getTicket] → [getComments] → [agent
   drafts] → [gate: approve reply] → [replyToTicket(public)]` runs end-to-end.
   Errors per §11.

That slice proves the whole loop (a real customer reply wakes a real flow that
reads the ticket and, behind a gate, posts an approved public reply) and is
dogfoodable against a Zendesk trial subdomain.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. "For me" API token.
  `ticket.commentAdded` + `getTicket` + `getComments` + gated `replyToTicket` +
  author gate. Single subdomain, single environment.
- **Phase 2 — full vocabulary:** the rest of §6 — `searchTickets` / `getUser`;
  `addInternalNote` / `setStatus` / `assignTicket` / `tagTicket`; the
  `ticket.created` / `ticket.updated` / `ticket.escalated` triggers; programmatic
  webhook + trigger provisioning (§13.4); the ISO-8601 replay-window extension
  (§13.5) wired.
- **Phase 3 — the Zendesk × Shopify × Stripe composition (§7.3):** ship the
  cross-connector "ticket reply → order + payment context → gated public reply +
  solve" template (owned/wired by the templates track, consuming §6 verbatim). This
  is the connector's headline value and the ecom/support worker completing itself.
- **Phase 4 — deterministic support backstop:** the support-policy floor (§9),
  saiifeguard-style, with the `publicReplyRequiresGate` default decided (§13.2).
- **Phase 5 — product fork:** distributable Zendesk OAuth app, per-subdomain token
  isolation, a hosted webhook relay, and the guided "Connect Zendesk" onboarding
  wizard (§13.1).
- **Phase 6 — expand help desks:** **Intercom** next (research track D — access-token
  auth, HMAC-**SHA1** timestamp-less webhook, `/reply` + `/parts` endpoint
  multiplexing), then **Front** / Freshdesk / Gorgias. Each a peer under
  `src/main/<vendor>/`, reusing the `*-connector` / `*-api` / `*-normalize` shape,
  the shared receiver (its own `WebhookVerifier` — Intercom is the SHA-1,
  timestamp-optional parameterization), and the **same never-auto-send reply gate**.
  No shared cross-vendor standard — each is its own connector, each routing its
  customer-facing reply through the one gate.

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `LiveConnector` / `IntegrationRegistry` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/webhooks/webhook-receiver.ts` — the **shared** receiver + `WebhookVerifier`
  the Zendesk verifier (§7.1) plugs into; a second `signsTimestamp` consumer after
  Stripe. **Consumed, not reimplemented**; names the ISO-8601 extension (§13.5).
- `docs/superpowers/specs/2026-07-16-email-execution-design.md` — the **never-auto-send**
  gate `replyToTicket(public)` reuses verbatim (§9): distinct draft/send, single
  gated caller, peek shows the exact reply.
- `src/renderer/src/components/ApproveButton.tsx` + `src/main/peek.ts` — the
  peek→confirm gate UI; the reply-gate pane resolves peek to the draft reply body.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the token
  store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError`
  (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector('zendesk', …)`
  (line 54) wires the live dispatch; `deriveStatus` gives Zendesk its status.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `zendesk` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `zendesk`;
  `shopify-descriptor.ts` / `stripe-descriptor.ts` are the descriptor-as-code
  templates.
- `src/main/shopify/*` and `src/main/stripe/*` — the module-shape templates
  (`stripe-connector.ts` → `zendesk-connector.ts`, `stripe-client.ts` →
  `zendesk-api.ts`, `stripe-normalize.ts` → `zendesk-normalize.ts`); the merged
  Shopify + Stripe connectors this one **composes with** (§7.3).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called, the
  **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; the
  `coerceEvent` / `matchesFilter` normalization the webhook `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`ticket.requesterEmail`, `order.orders.0.total`) + cross-connector
  boolean routing.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` for deterministic tests.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0).
- `src/main/index.ts` — constructs + `registerConnector`s the `ZendeskConnector`
  (§4.4), the Shopify/Stripe pattern verbatim.
- `guard/` (saiifeguard) — the deterministic-guard posture the optional support backstop
  (§9) borrows (a policy floor under the author's gates, no model in the loop).
