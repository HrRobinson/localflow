# Intercom Connector — Design

**Date:** 2026-07-20
**Status:** Design (spec) — not started. Design-approval gate for the
**product-led support worker** direction (Direction D — commerce support). Anchor
connector for "a support worker assembled on the drag-drop canvas that reads the
customer's commerce state and drafts a reply behind a human gate."
**Branch:** `build/intercom-connector`
**Feature:** An **Intercom connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor` + `LiveConnector`. It lets a flow author wire a support
worker on the canvas: an inbound customer message **triggers** a run, the flow
**reads** the conversation and contact (and composes commerce facts from the
**Shopify**/**Stripe** connectors), **drafts** a reply, and — behind a
human gate the author places — **sends** it. Every mutation is a rejecting
`action`; credentials live in the OS keychain; and the customer-facing **reply is
never auto-sent** (§9), reusing the email layer's never-auto-send discipline.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and copies the module shape of the Stripe/Shopify connectors
(`src/main/stripe/*`, `src/main/shopify/*`): descriptor-as-code, a single API
client that isolates every vendor shape, a **thin** webhook wrapper over the
shared `src/main/webhooks/webhook-receiver.ts`, keychain-only secrets, and
presence-derived `status()`. It uses the Shopify/Stripe connector specs
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`,
`.../2026-07-18-stripe-connector-design.md`) as its style/depth template, and the
**email-execution** spec (`.../2026-07-16-email-execution-design.md`) as the
authority for the **never-auto-send** gate on customer-facing replies.

> **Research note.** The commerce-support feasibility pass
> (`scratchpad/research/D-commerce-support.md` — referenced by the task; not
> committed to this repo) landed Intercom **GREEN**: the **simplest auth** of the
> support-desk field (a single Bearer access token), and a webhook signed with
> **HMAC-SHA1 over the raw body, NO timestamp** — the weakest scheme of the family
> the shared receiver already models, but still verifiable when the header is
> pinned. This spec grounds those two findings in saiife's actual code.

**A note on ownership.** This spec **owns and pins the support vocabulary**
(§6: the `'intercom'` `IntegrationId` addition, triggers, actions, context-field
shape). The **flow-templates** track consumes that vocabulary verbatim; the
**richer-conditions** track owns the `FlowEdgeCondition` upgrade (§10). Where those
tracks own a shape, this spec **names the dependency and stops**.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, a
product-led support worker that wakes when a customer replies in Intercom, reads
the conversation + contact and composes the customer's commerce state (Shopify
order / Stripe charge), **drafts** a reply, and — only after a human approves at a
gate — **sends** it back into the Intercom conversation, with the access token in
the OS keychain and **never** rendered.

### In scope (MVP)

- A new **Intercom connector** module set under `src/main/intercom/`, exposing a
  static `intercomDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus the live `IntercomConnector` (`LiveConnector`) the
  registry delegates `invokeAction`/`subscribe` to.
- **Auth: a single Intercom access token** (`Authorization: Bearer …`) — the
  **simplest auth** of the field. Stored in the keychain via `CredentialStore`.
  Plus the app **client secret** (the webhook HMAC key) as a second keychain
  secret. No OAuth dance in the MVP "for me" fork (§8, §13.1).
- An **Intercom REST client** (`intercom-client.ts`) — the **sole** place any
  Intercom API shape lives — implementing the read + write surface behind the
  pinned actions (§6.2), **region-aware** base URL (US/EU/AU hosting, §8).
- A **thin webhook wrapper** (`intercom-webhook-server.ts`) over the shared
  `startWebhookReceiver`, pinning the Intercom verifier: **HMAC-SHA1, no
  timestamp**, header `X-Hub-Signature` (`sha1=<hex>`), verified over the **raw**
  body before parse. Connector-side dedup on the notification id (§4.4, §7).
- The **pinned support vocabulary** (§6): webhook-backed triggers (flagship
  `conversation.replied`), two read actions, three gated-write actions, and the
  **context-field shape** an action writes for downstream edge conditions.
- **The never-auto-send reply gate (§9).** `replyToConversation` is
  **customer-facing** — a real message to a real customer. It follows the email
  layer's hard invariant: **no reply is sent except downstream of an explicit,
  human-approved gate.** The composed reply text is a **draft** carried in run
  context; the gate's peek shows the exact outbound body; only approval fires the
  send.
- **Single workspace, single saiife environment.** Config-as-code `intercom`
  block in `config.json` (non-secret refs only); token + client secret in the
  keychain.

### Out of scope (MVP) — explicitly deferred

- **Distributable / public OAuth app** (multi-workspace install, app-store
  listing). MVP is the **"for me" fork** — one Intercom app in one workspace, its
  access token in the keychain (§8, §13.1). The token/config shapes are drawn so
  `workspaces: [...]` is the additive path.
- **The Front sibling.** Front occupies the **same connector slot** (a support
  inbox) and — unlike Intercom — has a **native draft object** (create-draft then
  a separate send), which lets it use the email layer's true provider draft/send
  split (§9, §13.5). Designed-for, not built here.
- **Zendesk / Help Scout / Gorgias** and other desks — peer connectors under the
  same `*-connector` / `*-client` / `*-webhook-server` boundary.
- **Rich Intercom surface** beyond the support loop: ticket objects, articles,
  Series/outbound campaigns, custom-attribute writes, assignment routing. MVP's
  write surface is the support-loop three (`replyToConversation`,
  `closeConversation`, `tagConversation`).
- **Programmatic webhook-topic subscription management** (creating the
  subscription via the API on connect). MVP leans manual (§13.4).

---

## 2. Feasibility + landscape

### 2.1 Landscape — why Intercom first

| Desk | Auth for the read→draft→reply loop | Webhook signing | Verdict for MVP |
|---|---|---|---|
| **Intercom** | A **single Bearer access token** (app token or Personal Access Token) — no OAuth dance for the "for me" fork; least-friction of the field. Modern REST (conversations, contacts, reply/close/tag) covers the whole loop. | **HMAC-SHA1** over the raw body, `X-Hub-Signature: sha1=…`, **no timestamp** (weakest of the family, still verifiable — pin the header). | **Chosen.** Best auth-to-effort ratio; the loop is buildable today; maps onto the shared receiver with `algo:'sha1'`. |
| **Front** | OAuth or an API token. **Native draft object** (`POST …/drafts` then a separate send) — the cleanest provider-level never-auto-send split (mirrors Gmail's `drafts.create`/`drafts.send`). | HMAC-SHA256 (`X-Front-Signature`). | Deferred **same-slot sibling** (§13.5). Architecturally the strongest reply-gate (native draft), but heavier auth and a smaller support-desk footprint for the first dogfood. |
| **Zendesk** | OAuth / API token / basic. Capable Tickets API. | HMAC-SHA256 with a timestamp header. | Deferred. A different auth + ingress shape; good third target to validate the connector boundary. |

**Intercom-first rationale:** the **simplest auth** (one Bearer token → keychain),
a modern REST surface that covers read + draft + reply + close + tag, and a webhook
scheme (**SHA1, no timestamp**) that the shared receiver **already models**
(`webhook-receiver.ts` `algo?: 'sha1'`) — so the connector adds **zero**
security-critical HTTP/HMAC code. Front/Zendesk become peer connectors under the
same boundaries; Front specifically upgrades the reply-gate story with its native
draft object (§9, §13.5).

### 2.2 The Intercom API for read → draft → reply

Grounded in the current Intercom developer docs (as summarized by the D-commerce
feasibility pass):

- **Read.** `GET /conversations/{id}` returns the full conversation
  (state, parts/messages, tags, contacts) and `GET /contacts/{id}` returns the
  contact (email, name, role, last-seen). Fully covers **read** (`getConversation`,
  `getContact`). GA.
- **Reply (the customer-facing write).** `POST /conversations/{id}/reply` with a
  `message_type` and `body` posts a reply into the conversation. There is **no
  native draft object** (unlike Front/Gmail) — a reply call **sends**. That single
  fact is what forces saiife's never-auto-send gate to live in the **flow**
  (a draft in run context + an author-placed approval gate), not in a
  provider-level draft/send split (§9).
- **Close / tag (internal writes).** `POST /conversations/{id}/parts` with a
  `close` message type (or the close endpoint) ends the conversation;
  `POST /conversations/{id}/tags` attaches a tag. These are **internal** state
  changes (not customer-facing), so they are gated like any Shopify/Stripe
  mutation — the author's gate, no never-auto-send emphasis.
- **Auth.** A single **access token** sent as `Authorization: Bearer <token>` on
  every request. Long-lived until rotated in the Intercom Developer Hub. Single
  secret → keychain (§8). The "product" fork swaps token *acquisition* for OAuth;
  the header at call time is identical.
- **Region.** Intercom hosts workspaces in **US / EU / AU** regions with distinct
  API base URLs (`api.intercom.io`, `api.eu.intercom.io`, `api.au.intercom.io`).
  The base URL is a **non-secret** config ref (`region`); calling the wrong region
  is a legible error, not a silent 404 (§8, §11).
- **Webhooks (push).** A webhook subscription (a "topic" like
  `conversation.user.replied`, `conversation.user.created`, `conversation.admin.*`)
  POSTs a JSON **notification** carrying a top-level `id`, a `topic`, and a
  `data.item` payload. The delivery is signed **HMAC-SHA1** over the **raw** body
  with the app's **client secret**, in `X-Hub-Signature: sha1=<hex>`. **No
  timestamp** is sent → **no replay window** is possible (§2.3). Same
  **cloud-ingress** problem as every push connector: Intercom posts from the cloud,
  so the local receiver needs a reachable URL (tunnel in MVP, relay in the product
  fork — §4.4).

### 2.3 Constraints (why not GREEN-with-no-caveats)

1. **SHA1 + no timestamp is the weakest scheme in the family.** HMAC-SHA1 is
   cryptographically weaker than SHA256, and — because Intercom sends **no
   timestamp** — there is **no replay defense** at the signature layer: a captured,
   validly-signed delivery could be replayed. This is a *capability of the
   provider*, not a bug we can fix. Mitigation is **defense in depth**:
   (a) the shared receiver still enforces **timing-safe compare + empty-secret
   rejection + verify-over-raw-body-before-parse**; (b) the connector **dedups on
   the notification `id`** (the id is in the body, not a header — so, exactly like
   Stripe's `evt_…` dedup, the seen-set lives connector-side, not in the receiver's
   header-only `dedup` hook, §7.1). A replay of a seen id is dropped.
2. **No native draft object.** A reply call **sends**. saiife cannot lean on a
   provider draft/send split (as email does with Gmail) — the never-auto-send
   boundary must be the **flow's gate** with the draft held in run context (§9).
   Front, the same-slot sibling, *does* have a native draft, which is why it is
   called out as the stronger reply-gate design (§13.5).
3. **Cloud ingress is mandatory for triggers.** Identical to Stripe/Shopify:
   the local receiver binds loopback and needs a public URL (tunnel MVP, relay
   product-fork — §4.4). Read + write work over plain outbound HTTPS with no
   ingress — only *triggers* need it.

### 2.4 Verdict: **GREEN**

The read → draft → reply loop is **fully buildable today**: GA REST endpoints for
every read + write the loop needs, the **simplest auth** in the field (one Bearer
token), and a webhook scheme the **shared receiver already supports**
(`algo:'sha1'`). It is GREEN rather than YELLOW because nothing in the loop is
preview-gated or missing. The three constraints in §2.3 are a known-weak-but-still-
verifiable signature (hardened with connector-side dedup), a "reply sends" API
shape (handled by the flow gate + a context-held draft), and the same ingress
pattern already solved for Stripe/Shopify.

---

## 3. The core loop → Intercom primitives

saiife's support loop is `trigger → read → compose → draft → gate → reply`.
Each stage maps to a concrete Intercom primitive and the concrete flow-engine
mechanism that runs it:

| Stage | Intercom primitive | saiife / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified webhook (`conversation.replied` flagship, `conversation.created`). | `intercom-webhook-server` verifies HMAC-SHA1 → the connector dedups on the notification id → normalizes to a `SeedEvent` → `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context. |
| **read** | `GET /conversations/{id}` / `GET /contacts/{id}`. | An `action` node (`getConversation` / `getContact`) → `invokeAction('intercom', ref, params)` → the connector calls `intercom-client` → **resolves** the normalized result, which the action-runner writes to context under the node id. |
| **compose** | *(cross-connector — pure saiife)* | Other action nodes (`shopify.getOrder`, `stripe.getCharge`, keyed off `{{read.conversation.contactEmail}}`) write commerce facts into the **same** run context — the support worker's whole point: the reply is grounded in the customer's order/charge state. |
| **draft** | *(none — pure saiife)* | The reply text is **composed into run context** (a template/agent node), NOT sent. There is no Intercom draft object; the "draft" is context data until the gate approves it (§9). |
| **gate** | *(none — pure saiife)* | A `gate` node the author placed pauses the run `needs-you`; the human peeks the **exact reply body** and approves. The customer-facing `replyToConversation` node sits **downstream of that gate** (§9). |
| **reply / close / tag** | `POST …/reply` (customer-facing) / close / `POST …/tags`. | The gated `action` node → `invokeAction` → `intercom-client`. **Failure = a rejected promise** carrying the real Intercom error (the pinned convention). |

**The authority is the graph the author drew.** The connector exposes
*capabilities*; the *flow* decides which run, behind which gate, under which edge
conditions. For the **customer-facing reply** specifically, that authority is a
**hard invariant**, not a preference: the reply is never reachable except through
an approved gate (§9).

---

## 4. Architecture in saiife

### 4.1 Where it sits

A new **main-process module set** under `src/main/intercom/`, mirroring
`src/main/stripe/` and `src/main/shopify/` (the closest siblings). It is
**opt-in**: with no `intercom` config entry (and no stored token) the descriptor's
`status()` returns `needs-config` and the engine refuses any Intercom node before
any network call — saiife's "works with no integration" guarantee is unchanged.

The connector is the **live implementation behind the registry's pinned
`invokeAction`/`subscribe`**, delegated via the `LiveConnector` seam
(`integrations.ts:73-86`) exactly as `StripeConnector` does. All Intercom API
shapes are isolated in `intercom-client.ts` (the blast radius for any API-version
bump).

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/intercom/intercom-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'intercom'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids. Mirrors `stripe-descriptor.ts`. |
| `src/main/intercom/intercom-connector.ts` | The `IntercomConnector` (`LiveConnector`): dispatches an action id → an `intercom-client` call; dispatches a trigger id → a webhook subscription. Owns the notification-id dedup set and the customer-facing-action guard (§9). Mirrors `stripe-connector.ts`. |
| `src/main/intercom/intercom-client.ts` | Thin **REST** client. **All** Intercom request/response shapes live *only* here. **Region-aware** base URL. Isolated behind an `IntercomApi` interface so tests inject a `MockIntercomApi` (§12). |
| `src/main/intercom/intercom-webhook-server.ts` | A **thin wrapper** over the shared `startWebhookReceiver`. Pins the Intercom verifier (`INTERCOM_VERIFIER`: `scheme:'hmac', algo:'sha1', header:'x-hub-signature', encoding:'hex', parseHeader` strips `sha1=`) and the vendor `parse` (JSON notification guard → `IntercomWebhookDelivery`). Mirrors `stripe-webhook-server.ts`. |
| `src/main/intercom/intercom-token-store.ts` | Keychain-backed secret access — a thin wrapper over the hub's `CredentialStore` (`revealForConnector('intercom', 'accessToken' | 'clientSecret')`, main-process-only). A grep test asserts no IPC/renderer caller. Mirrors `stripe-token-store.ts`. |
| `src/main/intercom/intercom-config.ts` | Reads the non-secret `intercom` refs (region, environment, webhook url) — the validate-at-the-boundary pattern; holds Intercom-specific coercion (region → base URL). |
| `src/main/intercom/intercom-normalize.ts` | **Pure** mapping: a raw Intercom conversation/contact → the pinned **context-field shape** (§6.3); a raw webhook notification (topic + `data.item`) → a `SeedEvent`. Unit-testable in isolation. Where id/status/last-message-plaintext normalization happens **once**, so conditions read a stable shape. |
| `src/shared/intercom.ts` | Shared vocabulary + types (`IntercomConversationContext`, `IntercomContactContext`, action param shapes, trigger payload shapes, the pinned id arrays). Imported by main and any renderer palette surface. Mirrors `src/shared/stripe.ts`. |

### 4.3 Wiring the live dispatch into the registry

Unchanged seam — the `LiveConnector` interface is already pinned
(`integrations.ts:73-86`) and Stripe/Shopify already prove it. `src/main/index.ts`
constructs the `IntercomConnector` (given the `CredentialStore`, config, and the
webhook server) and passes it in the registry's `connectors` map. The pinned
`IntegrationRegistry` contract is **byte-for-byte unchanged**; Intercom is just its
next user.

### 4.4 Receiving webhooks (the cloud-ingress problem)

Identical in shape to Stripe's — Intercom posts from the cloud, the local receiver
binds loopback:

- **MVP ("for me" fork):** a developer tunnel forwards to the local
  `intercom-webhook-server`; the webhook subscription's URL is that tunnel URL,
  stored as the non-secret `webhookUrl` config ref. A documented v1 prerequisite.
- **Phase 2 ("product" fork):** a thin hosted relay that HMAC-authenticates then
  forwards over a durable channel. Flagged in §13; it changes distribution.

Regardless of ingress, the shared receiver **verifies HMAC-SHA1 over the raw body**
(timing-safe), enforces `MAX_BODY_BYTES`, and responds **200 fast** (run started
after the response, so Intercom's delivery-timeout is met and a slow flow never
causes a redelivery storm). Because Intercom sends **no timestamp**, the
**connector dedups on the notification `id`** (in the body → connector-side, like
Stripe's `evt_…`), so a redelivery *or a replay* of a seen id never seeds a second
run.

### 4.5 Reused saiife surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; the
  `IntegrationStatus` union; `IntegrationId` (edited, §6.0).
- `src/main/webhooks/webhook-receiver.ts` — the **shared** parameterized receiver.
  Intercom is a **config**, not new security-critical code: the receiver already
  ships `algo?: 'sha1'`, the timing-safe re-hash compare, empty-secret rejection,
  verify-before-parse, the 413 cap, and 200-fast. This connector adds a verifier
  object + a vendor `parse`, nothing more.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses; `revealForConnector` (main-only plaintext exit).
- `src/main/integrations/integration-registry.ts` — where `status('intercom')` is
  derived from config + credential presence; where the `LiveConnector` dispatch
  attaches.
- `src/main/flow/*` — `action-runner` (**reject = failure**, resolved value → context),
  `trigger-subscriber` (how `subscribe` seeds runs), `context.ts`
  (`resolveField`/`applyTemplate`/`selectEdges`), `flow-engine.ts` (the run
  lifecycle + **gate handling**: `needs-you`, human-"no"-is-not-a-failure — the
  load-bearing mechanism for §9), `flow-model.ts` (the `INTEGRATION_IDS` allow-list,
  edited §6.0).
- The **email-execution** spec's **draft-approval gate** — the `ApproveButton` +
  `session:peek` reuse that surfaces the outbound reply body for approval (§9).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is `intercomDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected | needs-config | error | disabled`) — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `accessToken` | Intercom access token | **yes** | yes | string | The `Authorization: Bearer` token. Keychain only. Placeholder `dG9r…` / `intercom access token`. |
| `clientSecret` | App client secret (webhook signing) | **yes** | yes | string | The HMAC-SHA1 key for `X-Hub-Signature`. Keychain only. |
| `region` | Intercom region (us \| eu \| au) | no | no | string | Selects the API base URL; defaults `us`. Placeholder `us`. |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts Intercom work (same field/validation as Stripe's). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay URL (§4.4). Placeholder `https://<tunnel>/intercom/webhook`. |

`status('intercom')` reports `needs-config` until `accessToken`, `clientSecret`,
and `environment` are present; `error` if a stored secret can't be decrypted;
`disabled` if configured-but-off; `connected` otherwise. The action-runner refuses
any non-`connected` Intercom node before any network call.

---

## 6. Pinned support vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas palette
> read these ids and this field shape verbatim. A snapshot test in
> `intercom-descriptor.ts` guards the ids; the field shape is guarded by the
> `intercom-normalize.ts` tests.

### 6.0 Shared-union edit (the 3 lockstep touch-points)

`src/shared/integrations.ts` — `IntegrationId` gains `'intercom'`:

```ts
export type IntegrationId = … | 'hubspot' | 'intercom'
```

This is a **shared-union edit** with **three companion touch-points that must move
in lockstep** (each a one-line add):

1. `INTEGRATION_IDS` — the stable order array (`integrations.ts:99`).
2. the `INTEGRATION_IDS` **Set** in `flow-model.ts:29` (the flow validator's
   allow-list).
3. `DESCRIPTOR_DEFS` — the id→def record (`descriptors/index.ts`).

No other `IntegrationId` consumer needs a change — they iterate the array. (The
descriptor lives in `src/main/intercom/intercom-descriptor.ts` and is imported by
`descriptors/index.ts`, as Stripe/Shopify/Slack/GitHub already are.)

### 6.1 Triggers (webhook-backed)

| trigger id | label | underlying Intercom topic | note |
|---|---|---|---|
| `conversation.replied` | Customer replied | **`conversation.user.replied`** | **Flagship.** The most common support wake-up: an existing customer replied. |
| `conversation.created` | New conversation started | **`conversation.user.created`** | A customer opened a new conversation. |

Both are native 1:1 topics (no derivation cost — unlike Shopify's composed
triggers). The webhook notification's `data.item` is the conversation; the
connector normalizes it and seeds the run with `{ conversationId, contactId,
contactEmail, lastMessageBody, … }` so `getConversation`/`getContact` and the
cross-connector commerce reads (`searchOrders(email:)`, `getCharge`) have their
keys immediately.

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | Intercom REST | writes to context |
|---|---|---|---|
| `getConversation` | Get a conversation | `GET /conversations/{id}` | `IntercomConversationContext` (§6.3) |
| `getContact` | Get a contact | `GET /contacts/{id}` | `IntercomContactContext` (§6.3) |

**Gated-write (the author places a gate before these):**

| action id | label | Intercom REST | customer-facing? | note |
|---|---|---|---|---|
| `replyToConversation` | Reply to the customer | `POST /conversations/{id}/reply` | **YES** | **Never-auto-send (§9).** A real outbound message. The body is the context-held draft; only an approved gate reaches this node. |
| `closeConversation` | Close the conversation | close part | no | Internal state; gated like any mutation. |
| `tagConversation` | Tag the conversation | `POST /conversations/{id}/tags` | no | Internal state; low-risk annotate; still an action node. |

The connector pins the customer-facing set so §9's guard and the templates track
both key off it:

```ts
// src/shared/intercom.ts
export const INTERCOM_CUSTOMER_FACING_ACTION_IDS = ['replyToConversation'] as const
```

**Failure convention (pinned):** a write that fails **rejects** its promise with
the real Intercom error text; a resolved promise (any value) is success and its
value becomes the node's context output. The connector never resolves a
sentinel-failure. (Same as `stripe-connector.ts` / `action-runner.ts`.)

### 6.3 Context-field shape (what an action writes for later conditions)

A read action writes a **normalized, stable** object under its node id
(`intercom-normalize.ts` produces it — ids as bare strings, statuses as lowercase
enums, the last message reduced to plaintext). Downstream edge conditions read it
via dotted paths, e.g. `{{getConversation.conversation.contactEmail}}`. **Pinned
shape:**

```ts
// src/shared/intercom.ts
export interface IntercomConversationContext {
  conversation: {
    id: string
    state: 'open' | 'closed' | 'snoozed'
    read: boolean
    priority: 'priority' | 'not_priority'
    title: string                 // conversation subject/title (may be "")
    contactId: string             // the primary customer contact
    contactEmail: string          // the customer's email — the join key to Shopify/Stripe
    lastMessageBody: string       // plaintext of the latest part (HTML stripped)
    lastMessageAuthorType: 'user' | 'admin' | 'bot'  // who spoke last
    tags: string[]                // lowercase tag names
    createdAt: string             // ISO 8601
    updatedAt: string             // ISO 8601
  }
}

export interface IntercomContactContext {
  contact: {
    id: string
    email: string
    name: string
    role: 'user' | 'lead'
    createdAt: string             // ISO 8601
    lastSeenAt: string            // ISO 8601 (may be "")
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares**. `contactEmail` as a lowercase string is the cross-connector **join
key** (it flows into `shopify.searchOrders(email:)` and `stripe.getCustomer`);
`state`/`lastMessageAuthorType` as lowercase **enums** make `eq`/`ne` exact;
`tags` as a string array supports `contains`. Normalizing once, in one pure module,
is the correctness boundary the conditions/templates tracks rely on.

---

## 7. Data flow — the flagship reply loop, node by node

**Scenario the author drew on the canvas:** *"When a customer replies, pull the
conversation + their latest Shopify order, draft a grounded reply, and pause for me
to approve before it sends."* This is **not** hardcoded — it is the graph below.

```
[trigger: conversation.replied]         Intercom conversation.user.replied webhook
        │  payload → context['t'] = { conversationId, contactId, contactEmail, lastMessageBody }
        ▼
[action: getConversation]               ref=getConversation, params={ id: "{{t.conversationId}}" }
        │  invokeAction('intercom','getConversation',…) → intercom-client → normalize
        │  writes context['conv'] = IntercomConversationContext
        ▼
[action: shopify.searchOrders]          params={ email: "{{conv.conversation.contactEmail}}" }
        │  the CROSS-CONNECTOR compose — the customer's commerce state
        │  writes context['orders']
        ▼
[template: compose reply]               builds the DRAFT text into context['draft']
        │  (an agent/template node — NO Intercom call, nothing sent)
        ▼
[gate: "approve reply"]                 pauses run needs-you; peek shows context['draft'] body
        │  approved ──► [action: replyToConversation]  params={ id:"{{t.conversationId}}", body:"{{draft}}" }
        │                    │  POST …/reply → resolves { conversationId, partId } → context['sent']
        │                    ▼  (done)
        │  rejected ──► run ends 'rejected' (a human "no" is not a failure)
        ▼
```

Node-by-node against the engine:

1. **Trigger fires.** `intercom-webhook-server` (shared receiver) verifies HMAC-SHA1,
   the connector dedups on the notification id, 200s fast, normalizes the
   `conversation.user.replied` `data.item` to a `SeedEvent`, hands it to `subscribe`
   → `startRun`. Trigger node is `done`; payload in `context['t']`.
2. **`getConversation` reads.** The action-runner templates `id` from `t`, confirms
   `status('intercom') === 'connected'`, calls `invokeAction`. The connector calls
   `intercom-client.getConversation(id)`, `intercom-normalize` maps it, the
   connector **resolves** it → context `conv`.
3. **Compose.** A `shopify.searchOrders`/`stripe.getCharge` node keyed off
   `conv.conversation.contactEmail` writes the customer's commerce facts; a
   template/agent node composes the **draft reply text** into `context['draft']`.
   **No Intercom write happens yet.**
4. **The gate — the never-auto-send boundary (§9).** The `gate` node pauses the run
   `needs-you`; the human **peeks the exact draft body** and approves (or rejects →
   run ends `rejected` cleanly). On approval the `replyToConversation` action runs
   `POST …/reply`; an Intercom error **rejects** with the real message.
5. **Done.** The resolved `{ conversationId, partId }` is in context; the run
   completes `done`. (An optional downstream `tagConversation`/`closeConversation`
   records/settles the outcome.)

The same trigger + reads support arbitrarily different graphs (VIP fast-path,
auto-tag-and-route, refund-then-reply composing the Stripe connector). The
connector supplies capability + facts; the **author supplies authority** — and for
the customer-facing reply, that authority is enforced as an invariant (§9).

---

## 8. Auth & keychain

- **"For me" fork (MVP).** An **Intercom access token** (app token or Personal
  Access Token from the Developer Hub) is pasted into the descriptor's masked
  `accessToken` field → straight to the keychain via `CredentialStore.set`. Every
  REST request sends `Authorization: Bearer <token>` — read at call time via
  `revealForConnector('intercom','accessToken')` (main-process-only, the sole
  plaintext exit; a grep test asserts no IPC/renderer caller). No OAuth, no refresh.
- **Client secret (webhook signing).** Stored the same way (`clientSecret`), used
  only inside the shared receiver (via `intercom-webhook-server`) to verify
  `X-Hub-Signature` against `hmacSha1(rawBody, clientSecret)`.
- **Region → base URL.** `region` (non-secret) selects `api.intercom.io` (us) /
  `api.eu.intercom.io` (eu) / `api.au.intercom.io` (au) in `intercom-client.ts`.
  A token used against the wrong region fails with a legible error (§11), never a
  silent 404.
- **Honoring the global secret rule.** Neither the token nor the client secret is
  **ever** written to `config.json`, `sessions.json`, the transcript, a log, a PR
  body, or any IPC payload. `config.json` holds only **references** (region,
  environment, that an install exists). Secret **state** (present / decrypt-failing)
  may be surfaced via `status()`; the **value** never is. (The hub's existing
  discipline applied verbatim.)
- **"Product" fork (deferred, §13.1).** A distributable app uses OAuth to mint
  per-workspace tokens (multi-tenant). The keychain shape already supports per-key
  storage; the additive change is an `intercom-oauth.ts` module and a `workspaces[]`
  config array. Same `Authorization: Bearer` at call time — only *acquisition*
  differs.
- **Disconnect.** Clearing `accessToken` / `clientSecret` flips `status()` to
  `needs-config`; the connector stops dispatching and the webhook subscription can
  be deleted in Intercom. No in-flight run is force-killed.

---

## 9. Authority & safety — the never-auto-send reply gate

This is the **load-bearing** section, because a reply is **customer-facing**: an
agent, however it reasons or is prompted, must not be able to send a message to a
real customer without an explicit, recorded human approval. saiife already
solved this for email (`2026-07-16-email-execution-design.md` §5). Intercom adopts
the same invariant, adapted to Intercom's "reply sends" API shape.

**The invariant.** *There is no code path that sends an Intercom reply except one
gated behind an explicit, human-approved event.*

**How it is enforced — three layers:**

1. **The draft is context data, sent only by one action.** There is no Intercom
   draft object, so the composed reply text lives in **run context**
   (`context['draft']`), produced by a template/agent node that makes **zero
   Intercom calls**. The *only* thing that can send it is the `replyToConversation`
   **action** — the single customer-facing verb (§6.2). Composing, reading, and
   triaging never send.

2. **The reply node is reachable only downstream of a gate.** The flow engine's
   `gate` node pauses the run `needs-you`; the human **peeks the exact outbound
   body** (reusing the email layer's `ApproveButton` + `session:peek` — the peek
   payload for a reply node is the `{{draft}}` text that will be posted, so the
   human reads *exactly* what goes out, the "never blind" property) and approves.
   A human "no" ends the run `rejected` — not a failure (`flow-engine.ts` gate
   handling). On the flagship template this gate is **always** placed before
   `replyToConversation`.

3. **A customer-facing-action guard makes "always gated" enforceable, not just
   conventional.** Because the connector alone cannot see the graph, the guarantee
   that a customer-facing action is gated is enforced at **flow-validate** time:
   a graph with a `replyToConversation` node that has **no upstream gate** is a
   validation **error** (keyed off `INTERCOM_CUSTOMER_FACING_ACTION_IDS`, §6.2).
   This is the graph-lint analogue of the email layer's "exactly one send caller"
   test — it moves the invariant from "the template happens to gate it" to "an
   un-gated customer-facing reply cannot be authored." **Whether flow-validate
   hard-errors vs. warns is the key open decision (§13.2).**

**Internal writes are gated, not never-auto-send.** `closeConversation` and
`tagConversation` change *internal* state, not a customer-visible message — they are
gated exactly like a Shopify/Stripe mutation (the author's gate, an optional
`tagConversation` left un-gated if the author chooses). Only `replyToConversation`
carries the never-auto-send emphasis.

**Front sharpens this (same-slot sibling, §13.5).** Front has a **native draft
object**: create-draft (no send) then a separate send call — the true provider-level
draft/send split email uses with Gmail. On Front the invariant can be enforced
**structurally** (a single `sendDraft` caller reachable only from approval), the
strongest form. Intercom can't (its reply sends), so it leans on layers 1–3 above.
This is precisely why Front is called out as the architecturally stronger reply-gate.

**Never render secrets.** The access token / client secret live in the keychain;
no error, log, or context field ever contains them (§8, §11).

---

## 10. Richer-conditions dependency (owned elsewhere — named, not designed)

The sibling **conditions track** is upgrading edge conditions from `field === equals`
to a typed `FlowEdgeCondition` (`op: 'eq'|'ne'|'gt'|…|'contains'|'exists'|'truthy'`).
The fields this spec pins (§6.3) are **designed to be referenced by those
operators**: `state`/`priority`/`lastMessageAuthorType`/`role` as lowercase **enums**
for exact `eq`/`ne`; `contactEmail`/`title`/`name` as strings for `contains`;
`tags` as a string array for `contains`; `read` as a boolean for `truthy`; the
`contact` sub-object present-or-absent for `exists`. **This spec does not design the
condition system** — it only guarantees its field types are the ones those operators
expect, normalized in `intercom-normalize.ts` so they are stable at condition-eval
time. The dependency is one-directional; the connector works under the current
`eq`-only routing, just less expressively.

---

## 11. Error handling

saiife's principle (error-message-style memory; `credential-store.ts`,
`action-runner.ts`): **every failure is human-readable, actionable, and carries the
real underlying exception. No silent catch. No bare "failed"/"not found".** A write
signals failure by **rejecting** with that message; the action-runner prefixes it
with the node/action and surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook HMAC-SHA1 invalid** | signature mismatch (never the body or secret) | Shared receiver: `log` route+reason only; **401**; no run. |
| **Webhook replay / duplicate** (`id` seen) | the notification id | Connector-side dedup drop; no second run. The mitigation for the no-timestamp scheme (§2.3, §7). |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse / unsupported topic | Shared receiver: **413**/**400**; dropped; no run on unvalidated shape. |
| **`status('intercom') !== 'connected'`** | the derived reason (missing token / decrypt error / disabled) | Action-runner fails the node *before* any call: "Flow needs Intercom connected — action '<id>' can't run. Connect it in Settings." |
| **Access token invalid/revoked (401)** | Intercom's auth error | `invokeAction` **rejects**: "Intercom rejected the access token (401) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Wrong region** | the configured region + the 404/host error | Rejects: "Intercom returned no such resource — check the `region` (us/eu/au); this workspace may be hosted in a different region." Not a bare 404. |
| **Missing scope / permission (403)** | Intercom's permission error | Rejects with the verbatim requirement: "Intercom refused '<action>': the app is missing the required permission — grant it in the Developer Hub." |
| **Conversation/contact not found (404)** | the id that missed | Rejects: "Intercom has no conversation '<id>' (it may be closed, merged, or from another workspace)." |
| **Rate limit (429)** | Intercom's `Retry-After` | `intercom-client` backs off honoring `Retry-After`; only after exhausting retries rejects with "Intercom rate-limited the request — retry in ~Ns." Not swallowed. |
| **Reply/close/tag business rejection** | the verbatim Intercom error | Rejects with the field + message: "Intercom refused the reply: the conversation is closed — reopen it or drop the reply." Never a silent no-op. |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "Intercom webhook URL '<url>' is unreachable — no conversation events will arrive." Never a silent dead trigger. |

The connector **never** catches-and-drops. Where Intercom returns a precise message,
the connector forwards *that* rather than minting a vaguer one — the action-runner
only prefixes it with the node/action.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

- **`IntercomApi` interface + `MockIntercomApi` seam.** `intercom-client.ts` is
  written *against* an `IntercomApi` interface (`getConversation`, `getContact`,
  `replyToConversation`, `closeConversation`, `tagConversation`); tests inject a
  `MockIntercomApi` returning canned resources and canned error envelopes. **No test
  performs a live Intercom call**; CI has no Intercom credentials. (Same posture as
  `MockStripeApi` / the `SessionManager` `spawnFn` seam.)
- **`intercom-normalize.ts` unit tests** — pure function; assert every raw
  conversation/contact → the pinned `IntercomConversationContext`/`ContactContext`
  shape (§6.3): id-as-string, HTML→plaintext last message, status-enum lowercasing,
  lowercase tags, absent-contact → empty fields, `lastMessageAuthorType` derivation.
  The correctness boundary the conditions/templates tracks depend on — guarded
  hardest.
- **Webhook verifier tests** — reuse the shared `webhook-receiver` matrix; add the
  **HMAC-SHA1** accept/reject case and the `sha1=`-prefix `parseHeader` (valid /
  forged / missing-prefix / empty-secret → 401). Assert the secret/body are never
  logged. (The shared `verifyWebhookSignature` already has the SHA1 branch — this
  pins Intercom's config against it.)
- **`intercom-connector` dispatch tests** — with a `MockIntercomApi`: assert
  `invokeAction('intercom','getConversation',…)` resolves the normalized context;
  assert a business-error response **rejects** with the verbatim message (the pinned
  failure convention); assert **notification-id dedup** drops a replayed delivery
  and seeds exactly one run.
- **The never-auto-send tests (load-bearing).**
  1. *Draft never sends:* drive trigger→read→compose through the mock; assert
     `mock.replies` stays empty until the gate approves — composing/reading never
     increments it.
  2. *Gate → exactly one reply:* on approval, assert `replyToConversation` is
     called once with the approved `{{draft}}` body.
  3. *Un-gated reply is unauthorable:* assert `flow-validate` **rejects** a graph
     with a `replyToConversation` node lacking an upstream gate (keyed off
     `INTERCOM_CUSTOMER_FACING_ACTION_IDS`).
- **Engine integration test (offline)** — real `FlowEngine` + registry with the
  Intercom connector over a `MockIntercomApi`, drive the §7 loop: inject a
  `conversation.replied` `SeedEvent` → assert `getConversation` writes context →
  assert the gate pauses `needs-you` → assert approval fires exactly one reply.
  Deterministic via the engine's injected `now()`.
- **Token-store test** — `revealForConnector` round-trip via a fake `SecretBackend`;
  a regression guard asserts **no token/secret value** appears in any emitted
  log/error string.
- **Snapshot test on `intercomDescriptor`** — pins the trigger/action ids.

No test requires Intercom credentials or a live workspace; the real API is exercised
only in manual dogfooding against a development workspace.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **"For me" vs "a product others install."** The biggest fork. *For me* (MVP):
   one Intercom app in Jonas's own workspace, its access token in his keychain, a
   dev tunnel for ingress — no OAuth, no listing. *Product*: a distributable OAuth
   app (per-workspace install, `workspaces[]` config, a hosted relay). Changes auth
   (OAuth), ingress (relay), config (multi-workspace). Recommendation: build MVP
   "for me", keep the client/token/config shapes multi-workspace-ready (they already
   are — §4.3, §8).
2. **The customer-facing-action guard — flow-validate hard-error vs. warn.** §9's
   guarantee that `replyToConversation` is always downstream of a gate is enforced
   at flow-validate. A **hard error** (un-gated customer-facing reply is
   unauthorable) is the strongest never-auto-send posture; a **warn** is more
   permissive but weaker. This interacts with whether the conditions/gate model
   should grow a first-class "customer-facing" node flag. **Recommend hard-error**
   for a customer-facing send; flagged because it touches the shared flow-validate
   surface owned partly by the engine track.
3. **No-timestamp replay window.** Intercom's SHA1 scheme has **no replay defense**
   at the signature layer (§2.3). The connector-side notification-id dedup is the
   mitigation, but its seen-set is unbounded in a long-lived process (same open
   question as Stripe's `evt` dedup and Shopify's `webhook-id` dedup —
   connector-shared-infra spec O-2). Whether to bound it (LRU/TTL) or generalize a
   shared dedup store is a cross-connector decision, not owned here.
4. **Webhook subscription management — manual vs programmatic.** MVP can have the
   user create the topic subscription in the Developer Hub (pointing at the tunnel),
   or the connector can create it via the API on connect. Programmatic is nicer UX
   but adds a scope + a teardown story. Leaning **manual** for the MVP slice.
5. **Front as the same-slot sibling.** Front occupies the same connector slot and
   has a **native draft object** → the structurally strongest reply-gate (email-style
   single `sendDraft` caller). Whether the second support connector is Front (upgrade
   the reply-gate, moderate auth) or Zendesk (broader market, heavier) is a
   product/sequencing call. The `*-connector`/`*-client`/`*-webhook-server` boundary
   is drawn so either drops in as a peer.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One workspace, one flow, read + the gated customer-facing reply, happy path:**

1. `IntegrationId` gains `'intercom'` (+ the 3 lockstep touch-points, §6.0);
   `intercomDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from
   config + keychain presence (free from the hub).
2. `accessToken` + `clientSecret` stored (→ keychain); `status('intercom') ===
   'connected'`.
3. `intercom-client.ts` behind `IntercomApi`: `getConversation` +
   `replyToConversation` live; `intercom-normalize` produces
   `IntercomConversationContext`.
4. `intercom-webhook-server` (thin over the shared receiver) handling
   **`conversation.user.replied`** with **HMAC-SHA1** + connector-side id dedup,
   behind a dev tunnel, emitting a `SeedEvent`.
5. Flow-validate customer-facing-action guard (§9 layer 3) live for
   `replyToConversation`.
6. On the canvas: `[conversation.replied] → [getConversation] → [compose draft] →
   [gate] → [replyToConversation]` runs end-to-end. Errors per §11.

That slice proves the whole loop (a real reply wakes a real flow that reads the
conversation and, behind a human gate, sends a grounded reply) and is dogfoodable
against an Intercom development workspace.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. "For me" fork. `conversation.replied` +
  `getConversation` + `replyToConversation` + the gate + the flow-validate guard.
- **Phase 2 — full vocabulary:** `getContact`; `closeConversation` /
  `tagConversation`; the `conversation.created` trigger; the cross-connector compose
  (`shopify.searchOrders(email:)` / `stripe.getCharge`) wired by the templates track
  into the grounded-support-reply starter template.
- **Phase 3 — richer conditions consumption:** once `FlowEdgeCondition` lands (§10),
  verify the pinned fields drive `eq`/`contains`/`truthy`/`exists` end-to-end
  (route VIP vs. standard, tag-based triage).
- **Phase 4 — Front (same-slot sibling):** implement the support-inbox peer with the
  **native draft object** → the structural single-send-caller reply-gate (§9, §13.5).
- **Phase 5 — product fork:** distributable OAuth app, hosted webhook relay,
  `workspaces[]` multi-workspace isolation (§13.1).
- **Phase 6 — expand desks:** Zendesk / Help Scout, each a peer under the same
  boundary, each its own auth/ingress shape.

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `INTEGRATION_IDS`.
- `src/main/webhooks/webhook-receiver.ts` — the **shared** parameterized receiver;
  Intercom is a verifier config (`algo:'sha1'`, already supported) + a vendor
  `parse`, **zero new security-critical code**.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the token
  store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError`
  (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — the `LiveConnector` dispatch
  attaches here; `deriveStatus` gives Intercom its status for free.
- `src/main/integrations/descriptors/index.ts` — `DESCRIPTOR_DEFS` gains `intercom`;
  `stripe-descriptor.ts` / `shopify-descriptor.ts` are the descriptor-as-code
  templates.
- `src/main/stripe/*` — the closest sibling connector: `stripe-connector.ts`
  (`LiveConnector` shape, connector-side body-id dedup, rejecting mutations),
  `stripe-webhook-server.ts` (thin wrapper pattern), `stripe-token-store.ts`,
  `src/shared/stripe.ts` (vocabulary + context-shape module).
- `src/main/flow/action-runner.ts` — the **reject = failure** convention, resolved
  value → context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`.
- `src/main/flow/flow-engine.ts` — the run lifecycle + **gate handling**
  (`needs-you`, human-"no"-is-not-a-failure) — the mechanism §9 stands on.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0).
- `docs/superpowers/specs/2026-07-16-email-execution-design.md` — the never-auto-send
  gate (§5 there) this spec adopts for the customer-facing reply (§9); the
  `ApproveButton` + `session:peek` draft-approval reuse.
</content>
</invoke>
