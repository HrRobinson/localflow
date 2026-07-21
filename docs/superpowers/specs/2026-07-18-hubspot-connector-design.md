# HubSpot Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Feasibility is **DONE** (verdict below is
carried, not re-derived). Design-approval gate for the **CRM / sales worker**
product direction. Anchor connector for "a sales-ops worker assembled on the
drag-drop canvas" and the first **webhook-primary** CRM in the connector family.
**Feature:** A **HubSpot connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. It lets a flow author wire a sales worker on the canvas:
an inbound lead event (a new contact, a deal moving stage, a form submission)
**triggers** a run, the flow **reads** contact / deal / company state through the
HubSpot CRM v3 API, an **agent** node forms a judgment on the enriched facts,
and — behind gates the author places — the flow **acts** (logs an activity,
creates a follow-up task, updates a deal). It does **not** hardcode a sales
pipeline; the authority lives in the flow (conditions on edges, gates where the
author puts them, the agent's judgment surfaced as context), exactly as the flow
engine already enforces.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` / `registerConnector` contract in
`src/shared/integrations.ts` and copies the module shape of the merged Shopify
and WooCommerce connectors (`src/main/shopify/*`, `src/main/woocommerce/*`,
`src/main/integrations/*`): CredentialStore keychain, descriptor-as-code,
presence-derived `status()`, the `LiveConnector` live-dispatch seam. It uses the
merged **Shopify connector spec**
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`) and the
**Linear integration spec**
(`docs/superpowers/specs/2026-07-16-linear-integration-design.md`) as its style
and depth template.

**A note on shared infrastructure.** Unlike Shopify/Woo/Linear — each of which
ships its **own** `*-webhook-server.ts` — this connector is the design driver for
a **shared webhook receiver** (`src/main/webhooks/webhook-receiver.ts`) with a
per-connector `WebhookVerifier` seam. HubSpot's v3 signature is the first one that
does **not** sign the raw body alone (§5), so it is the connector that forces the
receiver to expose a **signed-string composition hook**. Where the shared receiver
is a sibling deliverable, this spec **names the dependency and pins HubSpot's
verifier contract**, and stops (§5.4).

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, a sales
worker that wakes on a HubSpot lead event (new contact / deal stage change / form
submission), reads the relevant contact / deal / company facts through the CRM v3
API, lets an agent node form a judgment on them, routes on that judgment via edge
conditions, and performs gated writes (log activity / create task / update deal /
create contact) — with the private-app token in the OS keychain, **never**
rendered.

### In scope (MVP)

- A new **HubSpot connector** module set under `src/main/hubspot/`, exposing a
  static `hubspotDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus a **live** `LiveConnector` registered with the merged
  registry via `registerConnector('hubspot', …)` (`integration-registry.ts:54`).
- **Auth for the "for me" fork:** a **private-app access token** (the single
  `Authorization: Bearer <token>` header), stored in the keychain via
  `CredentialStore` (the `safeStorage` pattern the hub already set). The
  distributable-app **OAuth** fork is designed-for but deferred (§4, §9).
- A **CRM v3 API client** (`hubspot-api.ts`) — the **sole** place any HubSpot API
  shape lives — implementing the read + write surface behind the pinned actions
  (§3.2), with the **search 4/sec** cap handled by a token-bucket + backoff (§6).
- A contribution to the **shared webhook receiver** (`src/main/webhooks/
  webhook-receiver.ts`): a `HubSpotWebhookVerifier` implementing the **v3
  signature** (`X-HubSpot-Signature-v3` = base64 HMAC-SHA256 over
  `method + uri + body + timestamp`, with a `X-HubSpot-Request-Timestamp` header
  and a **5-minute staleness reject**). This is `signsTimestamp: true` and the
  **first verifier that needs the composed signed string, not just the raw
  body** (§5).
- The **pinned CRM vocabulary** (§3): three webhook-backed triggers, four read
  actions, four gated-write actions, and the **context-field shape** an action
  writes for downstream edge conditions and the agent node.
- **Authority = the flow's gates + the author's graph.** Every write is an
  `action` node the author gates by placing a `gate` node (or a conditional edge)
  before it; the **agent judgment** is an `agent` node whose output feeds an edge
  condition or a gate. The engine already enforces this
  (`flow-engine.ts` gate handling, `node-runners/agent-runner.ts`,
  `node-runners/action-runner.ts`). No write ever runs un-gated by construction
  of the flow the author drew.
- **Single portal, single saiife environment.** Config-as-code `hubspot` block
  in `config.json` (non-secret refs only); private-app token + webhook client
  secret in the keychain.

### Out of scope (MVP) — explicitly deferred

- **Distributable / public-app OAuth install** (multi-portal, marketplace
  listing, scoped install). MVP is the **"for me" fork** — one private app in one
  portal, its token in the keychain (§4, §9.1). *Caveat, flagged loud in §5.5 and
  §9:* HubSpot **webhook subscriptions live on an app + are signed with that app's
  client secret**, so even the "for me" fork registers a (developer-account) app
  for the trigger path — the private-app token alone covers read/write but not
  webhook delivery. Honest constraint, not a capability gap.
- **The full CRM object graph** (tickets, line items, products, quotes,
  custom objects). MVP's object surface is contacts / deals / companies +
  engagements (notes/tasks). Everything else is phase 2+.
- **The legacy v1 / v2 CRM endpoints.** New work is **v3-only** (§2); the client
  is v3 from day one — no legacy path is written.
- **Association writes / complex property-history reads.** MVP reads a flat,
  normalized property set (§3.3) and writes single objects/engagements.
- **Flow templates / the "starter sales worker" graph.** Owned by the templates
  track, which consumes §3 verbatim.
- **A HubSpot-specific deterministic backstop** (per-action limits à la saiifeguard).
  Named as a phased item (§7 note, §10 Phase 3); the author's gate is the MVP
  control.

---

## 2. Feasibility + landscape (DONE — carried, not re-derived)

Feasibility is complete; this section records the verdict the design rests on.
Grounded in the CRM research (`scratchpad/research/E-crm-knowledge.md`) and the
current HubSpot developer docs.

### 2.1 Why HubSpot is the CRM anchor

| Platform | API posture for the wake → read → judge → act loop | Verdict |
|---|---|---|
| **HubSpot** | First-class **CRM v3 REST API** (contacts/deals/companies/engagements), a clean **private-app token** for the "for me" fork, and **real v3 HMAC webhooks** (method+uri+body+timestamp, 5-min replay window) — the **only webhook-primary CRM** in the research, so the trigger path is native push, not polling. Large SMB/mid-market install base → widest dogfood + product reach. | **Chosen.** Best push-trigger story of any CRM; the loop is buildable today. |
| **Salesforce** | Extremely capable API but heavyweight auth (connected app + OAuth, no simple single-token fork), and its event story (Platform Events / CDC / Streaming API) is a different, heavier ingress than plain HMAC webhooks. Enterprise-skewed install base → less SMB dogfood leverage. | Deferred. A good *later* target that validates a heavier auth/ingress boundary. |
| **Pipedrive** | Clean REST + simple webhooks, but a **much smaller install base** and a thinner object model. Technically close, less product leverage per unit of build. | Deferred. Peer connector under the same boundaries. |

**HubSpot-first rationale:** it is the one CRM whose **native webhook signing is a
first-class, documented v3 HMAC** — which is exactly the push-trigger primitive
the flow engine wants — plus the cleanest single-token auth for the "for me" fork
and a modern v3 surface that covers the whole sales loop. Salesforce/Pipedrive
become *peer connectors* under the same `*-connector` / `*-api` / `WebhookVerifier`
boundaries, each its own auth/ingress shape.

### 2.2 The HubSpot CRM v3 API for wake → read → judge → act

- **Go-forward surface is CRM v3.** Reads: `GET /crm/v3/objects/contacts/{id}`,
  `…/deals/{id}`, `…/companies/{id}` (with a `properties` selector); search:
  `POST /crm/v3/objects/{object}/search` (filter groups). Writes:
  `POST /crm/v3/objects/contacts`, `PATCH /crm/v3/objects/deals/{id}`, and
  **engagements** (`POST /crm/v3/objects/notes` / `…/tasks`, or the engagements
  v3 API) for logging activity and creating tasks. All GA.
- **Auth.**
  - **"For me" fork (MVP):** a **private app** created in the portal issues a
    long-lived **access token**, sent as `Authorization: Bearer <token>` on every
    v3 request. Single secret → keychain. No OAuth dance. Scopes granted on the
    private app (`crm.objects.contacts.read/write`, `.deals.read/write`,
    `.companies.read`, plus the schema scopes engagements need).
  - **"Product" fork (deferred):** a **public app** uses **OAuth
    authorization-code** to mint per-portal tokens (refreshable). Same Bearer
    header at call time; the difference is *acquisition* and *multi-tenant* (§4,
    §9.1).
- **Webhooks (push, not poll) — the v3 signature.** HubSpot posts subscription
  events from the cloud. The **`X-HubSpot-Signature-v3`** header is a **base64**
  HMAC-SHA256 computed over the concatenation **`method + requestUri + rawBody +
  timestamp`** using the **app client secret**, with the timestamp carried in
  **`X-HubSpot-Request-Timestamp`**; a request whose timestamp is **older than 5
  minutes** must be **rejected** (replay defense). Relevant subscription types:
  **`contact.creation`**, **`deal.propertyChange`** (filtered on `dealstage`),
  and **form submissions**. *Constraint carried to §5.5:* webhook subscriptions
  are configured on a HubSpot **app** and signed with **that app's client
  secret**, distinct from the private-app token used for read/write.
- **Rate limits — the search cap is the sharp edge.** Standard v3 endpoints are
  generous (per-token burst budgets over a 10-second window). The one hard,
  low ceiling is **Search: 4 requests/second per token** — `searchContacts` must
  be rate-limited client-side (token bucket) or it will 429 under any fan-out
  (§6). Ordinary `getContact`/`getDeal`/`getCompany` reads and the writes stay
  well under budget; the webhook-first trigger path keeps us off polling entirely.

### 2.3 Constraints (why not pure GREEN-with-no-caveats)

1. **Webhooks require an app + client secret, not just the private-app token.**
   The read/write loop runs on the private-app Bearer token alone, but the
   **trigger** path needs a registered app whose **client secret** signs the v3
   HMAC. Honest ingress cost; flagged in §5.5 and §9.1.
2. **Two triggers are *derived*, not native 1:1.** `contact.created` maps cleanly
   to `contact.creation`. But `deal.stageChanged` is a **`deal.propertyChange`**
   subscription filtered to the `dealstage` property (there is no dedicated
   "stage changed" type), and `form.submitted` is HubSpot's **form-submission**
   event (a different subscription surface than object CRUD). Naming/derivation
   cost, noted in §3.1.
3. **Cloud ingress is mandatory for triggers.** Identical to Shopify/Linear:
   the shared receiver needs a public URL (tunnel in MVP, relay in the product
   fork — §5.4). Read + judge + act work over plain outbound HTTPS with no
   ingress — only *triggers* need it.
4. **Search 4/sec.** A real cap, handled deterministically client-side (§6). Not
   a blocker; a throttle discipline the client owns.

### 2.4 Verdict: **GREEN**

The wake → read → judge → act loop is **fully buildable today** on the GA CRM v3
API, with a clean single-token auth for the "for me" fork and real v3 HMAC
webhooks. It is GREEN because every surface the loop needs (contact/deal/company
reads, search, `POST/PATCH` writes + engagements, the three subscription types)
is **generally available and stable**. The four constraints in §2.3 are a known
app-registration cost for the trigger path, a naming derivation, a known ingress
pattern already solved for Shopify, and a documented rate cap with a
deterministic client-side answer. Nothing in the loop is blocked or preview-gated.

---

## 3. Pinned CRM vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `hubspot-descriptor.ts` guards the ids; the field shape is guarded by the
> `hubspot-normalize.ts` tests.

### 3.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'hubspot'`:

```ts
export type IntegrationId =
  'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'hubspot'
```

This is a **shared-union edit** with three companion touch-points that must move
in lockstep (each a one-line add): `INTEGRATION_IDS` (the stable order array,
`integrations.ts:71`), the `INTEGRATION_IDS` allow-list in `flow-model.ts` (the
flow validator), and `DESCRIPTOR_DEFS` (`descriptors/index.ts`). No other
`IntegrationId` consumer needs a change — they iterate the array.

### 3.1 Triggers (webhook-backed)

| trigger id | label | underlying HubSpot source | note |
|---|---|---|---|
| `contact.created` | New contact created | **`contact.creation`** subscription (native, 1:1). | The clean case — a new lead. |
| `deal.stageChanged` | Deal moved to a new stage | **`deal.propertyChange`** subscription **filtered to the `dealstage` property**; the verifier surfaces `propertyName`/`propertyValue` so the trigger fires only on a real stage move. | *Derived*: no dedicated "stage changed" type. |
| `form.submitted` | A form was submitted | HubSpot **form-submission** event (forms subscription surface, distinct from object CRUD). | *Derived*: a different subscription surface; the templates track wires the specific form. |

**Composition with email.** As with the ecom worker, a sales worker's other common
wake-up is a customer *message* — the **email** connector's domain. HubSpot
triggers cover CRM *events*; the email trigger covers *inbound messages*, joined by
reading the contact via `searchContacts(email:)`. This spec pins the HubSpot
triggers; the templates track wires the composition.

### 3.2 Actions

**Read (no gate needed — pure reads write facts for conditions and the agent):**

| action id | label | HubSpot v3 | writes to context |
|---|---|---|---|
| `getContact` | Get a contact | `GET /crm/v3/objects/contacts/{id}` | `HubSpotContactContext` (§3.3) |
| `getDeal` | Get a deal | `GET /crm/v3/objects/deals/{id}` | `HubSpotDealContext` (§3.3) |
| `getCompany` | Get a company | `GET /crm/v3/objects/companies/{id}` | `HubSpotCompanyContext` (§3.3) |
| `searchContacts` | Search contacts | `POST /crm/v3/objects/contacts/search` | `{ contacts: HubSpotContactContext[]; total }` — **rate-capped 4/sec** (§6) |

**Gated write (the author places a gate before these):**

| action id | label | HubSpot v3 | note |
|---|---|---|---|
| `createContact` | Create a contact | `POST /crm/v3/objects/contacts` | Idempotency risk (dup contacts) — the connector surfaces HubSpot's conflict error legibly (§6). |
| `updateDeal` | Update a deal | `PATCH /crm/v3/objects/deals/{id}` | e.g. move stage, set amount/owner. |
| `logActivity` | Log an activity (note) | `POST /crm/v3/objects/notes` (+ association) | The low-risk annotate action; the CRM audit trail of what the worker did. |
| `createTask` | Create a follow-up task | `POST /crm/v3/objects/tasks` (+ association) | The flagship follow-up action (§7). |

**Failure convention (pinned):** a write that fails **rejects** its promise with
the real HubSpot error text; a resolved promise (any value) is success and its
value becomes the node's context output (`action-runner.ts`, the
`LiveConnector`/`IntegrationRegistry` contract, `integrations.ts:33-58`). The
connector never resolves a sentinel-failure.

### 3.3 Context-field shape (what an action writes for later conditions + the agent)

A read action writes a **normalized, stable** object under its node id
(`hubspot-normalize.ts` produces it — HubSpot's `properties` bag flattened, ids as
strings, money/counts as numbers, enums lowercased). Downstream edge conditions
read it via dotted paths (`context.ts` `resolveField`), e.g.
`field: 'getContact.contact.lifecycleStage'`; the **agent** node reads the same
context as its judgment input. **Pinned shape:**

```ts
// src/shared/hubspot.ts
export interface HubSpotContactContext {
  contact: {
    id: string            // HubSpot contact id (vid), as a string
    email: string
    firstName: string
    lastName: string
    name: string          // display name (first + last)
    company: string       // company name property (if set)
    jobTitle: string
    lifecycleStage: string // lowercase, e.g. "lead" | "marketingqualifiedlead" | "customer"
    leadStatus: string     // hs_lead_status, lowercase
    createdAt: string      // ISO 8601
    lastActivityAt: string // ISO 8601 (may be empty)
  }
}

export interface HubSpotDealContext {
  deal: {
    id: string
    name: string          // dealname
    stage: string         // dealstage, lowercase
    pipeline: string
    amount: number        // as a Number (major units), e.g. 4200
    currency: string      // ISO 4217
    ownerId: string
    closeDate: string      // ISO 8601 (may be empty)
    isClosed: boolean
    isWon: boolean
    createdAt: string
  }
}

export interface HubSpotCompanyContext {
  company: {
    id: string
    name: string
    domain: string
    industry: string
    numEmployees: number
    annualRevenue: number  // as a Number
    country: string
  }
}
```

**Why normalized here and not raw:** conditions and the agent must read a
**deterministic, stable** shape. HubSpot returns everything as strings inside a
`properties` bag (`amount: "4200"`, `dealstage: "closedwon"`); normalizing **once**
in one pure module lets `deal.amount gt 1000` compare numerically and
`deal.stage eq "closedwon"` compare exactly, and gives the agent a clean fact set
instead of raw envelope noise. The templates track and the conditions track both
rely on these exact paths and types.

---

## 4. Auth & keychain

- **"For me" fork (MVP).** A **private app in the HubSpot portal** issues an
  **access token**. The user pastes it into the descriptor's masked
  `privateAppToken` field; it goes straight to the keychain via
  `CredentialStore.set` (`credential-store.ts:61`). Every v3 request sends it as
  `Authorization: Bearer <token>` — read at call time via
  `revealForConnector('hubspot','privateAppToken')` (`credential-store.ts:99`,
  main-process-only, the sole plaintext exit; a grep test asserts no IPC/renderer
  caller). No OAuth, no refresh: the token is long-lived until the user rotates it
  in the portal.
- **Webhook client secret.** Stored the same way (`webhookClientSecret`), used
  only inside the `HubSpotWebhookVerifier` to `timingSafeEqual` the
  `X-HubSpot-Signature-v3` header against the locally composed v3 HMAC (§5). This
  is the **app's client secret**, not the private-app token — see §5.5.
- **Honoring the global secret rule.** Neither the token nor the client secret is
  **ever** written to `config.json`, `sessions.json`, the transcript, a log, a PR
  body, or any IPC payload. `config.json` holds only **references** (portal id,
  api base, that an install exists — §8). Token/secret **state** (present /
  decrypt-failing) may be surfaced via `status()`; the **value** never is. This is
  the hub's existing discipline (`integration-config.ts` drops a secret found in
  config.json with a loud notice) applied to HubSpot verbatim.
- **"Product" fork (deferred, §9.1).** A public app uses OAuth
  authorization-code to mint per-portal tokens (multi-tenant, refreshable). The
  keychain shape already supports per-key storage; the additive change is a
  `hubspot-oauth.ts` module and a `portals[]` config array. Same `Authorization:
  Bearer` at call time — only *acquisition* differs. OAuth also **subsumes the
  §5.5 app constraint**: a public app already has a client secret for webhook
  signing, so the product fork unifies the auth story.
- **Disconnect.** Clearing `privateAppToken` / `webhookClientSecret` (the hub's
  `clearSecret`) flips `status()` to `needs-config`; the connector stops
  dispatching and the app's webhook subscriptions can be removed. No in-flight run
  is force-killed — it simply can't start a new HubSpot action, and reports why
  (§6).

---

## 5. Webhook design — the shared receiver + the v3 verifier

### 5.1 Where it sits (the shared receiver)

Unlike Shopify/Woo/Linear — each of which ships its own `*-webhook-server.ts` —
HubSpot is designed against a **shared webhook receiver**,
`src/main/webhooks/webhook-receiver.ts`, that generalizes the loopback-server
skeleton those three duplicated: `createServer`, `applyLoopbackTimeouts`
(`server-timeouts.ts`), a `MAX_BODY_BYTES` cap, the `responded` guard, the mid-body
`'error'` guard, and the **200-fast** hot path (verify + parse → respond → hand off
on a later tick). Per-connector concerns are injected through a **`WebhookVerifier`**
seam. This connector **pins HubSpot's verifier contract and drives the receiver
hook it needs** (§5.4); the shared receiver itself is a sibling deliverable —
named here, not designed in full.

### 5.2 The `WebhookVerifier` seam (HubSpot's contract)

```ts
// The seam the shared receiver exposes; HubSpot's implementation pinned here.
export interface WebhookVerifier {
  /** True ⇒ the receiver must extract the timestamp header and pass it in, and
   *  the verifier enforces a staleness window (HubSpot: 5 minutes). */
  signsTimestamp: boolean
  /** Verify one delivery. Given the FULL signing context (not just the body),
   *  return true iff the signature is valid AND (if signsTimestamp) fresh. */
  verify(input: WebhookSigningInput): boolean
}

export interface WebhookSigningInput {
  method: string          // e.g. "POST" — HubSpot v3 signs it
  requestUri: string      // the FULL request URI HubSpot signs (scheme+host+path)
  rawBody: Buffer         // raw bytes, never re-serialized
  signature: string       // X-HubSpot-Signature-v3 (base64)
  timestamp?: string      // X-HubSpot-Request-Timestamp (present when signsTimestamp)
}
```

`HubSpotWebhookVerifier` sets `signsTimestamp: true` and computes:

```
expected = base64( HMAC_SHA256( clientSecret, method + requestUri + rawBody + timestamp ) )
verify   = timingSafeEqual(sha256(expected), sha256(providedSig))
           && (now - Number(timestamp)) <= 5*60_000     // 5-minute replay reject
```

Both sides are re-hashed with sha256 before `timingSafeEqual` (the
`operator-grant.ts` / `hook-server.ts` / `wc-webhook-server.ts` trick) so a length
mismatch never throws and a malformed base64 signature simply fails to match. An
empty client secret is **refused outright** (as Woo/Linear guard the boundary).
The secret and the body are **never logged** — only route + reason.

### 5.3 The v3 URI subtlety (worth pinning)

HubSpot signs the **full request URI it delivered to** — scheme, host, and path,
i.e. the *public tunnel/relay URL*, **not** the loopback URL the receiver actually
binds. Because a tunnel rewrites the host, the receiver cannot reconstruct the
signed URI from `req.url` alone; the **public base URL must be supplied as config**
(the `webhookUrl` ref, §8) and the verifier composes `webhookUrl + req.url` (or the
configured path) as `requestUri`. This is pinned because getting it wrong makes
every signature silently fail verification.

### 5.4 Does the v3 signed string need a shared-receiver hook? — **YES.**

**Yes.** Every existing per-connector receiver (Linear, Woo, and Shopify's spec)
computes its HMAC over the **raw body only** — `verify(rawBody, signature, secret)`.
HubSpot's v3 signature is composed over **`method + requestUri + rawBody +
timestamp`**. A shared receiver whose verifier seam only forwards `rawBody`
**cannot** satisfy HubSpot. Therefore the shared receiver must:

1. Pass a **`WebhookSigningInput` (method + requestUri + rawBody + signature +
   timestamp)** to `verify(...)`, **not** a bare `rawBody` — the signed-string
   **composition** is owned by the verifier, and the receiver's job is only to
   *hand it the ingredients*. This is the hook.
2. Honor **`signsTimestamp: true`** by extracting the `X-HubSpot-Request-Timestamp`
   header and including it in the input (and letting the verifier own the 5-minute
   staleness reject).
3. Supply the **public request URI** (from the `webhookUrl` config ref, §5.3), not
   the loopback `req.url`, so the verifier composes the URI HubSpot actually signed.

Concretely: the receiver's verifier contract is `verify(input:
WebhookSigningInput): boolean`, **not** `verify(rawBody, sig, secret): boolean`.
Linear/Woo verifiers simply ignore `method`/`requestUri`/`timestamp` and hash
`input.rawBody`; HubSpot's uses all of them. This keeps the composition in the
verifier (where the per-connector specificity belongs) and the transport in the
receiver (where it's shared). **This is the one shared-infra change HubSpot forces**
and the sibling webhook track must land it before HubSpot's trigger path works.

### 5.5 The app + client-secret constraint (honest, flagged)

HubSpot **webhook subscriptions are configured on a HubSpot app, and deliveries
are signed with that app's client secret** — which is *not* the private-app access
token used for read/write. So the trigger path (only) requires registering a
(developer-account) app and storing its **client secret** as
`webhookClientSecret`. Read + judge + act need only the private-app token; the
**trigger** needs the app. This is called out as a documented v1 prerequisite and
as **open decision §9.1** (it is the strongest argument for going straight to the
OAuth/public-app fork, which has a client secret for free).

### 5.6 Ingress + hot path

- **MVP ("for me" fork):** a developer tunnel (ngrok / Cloudflare Tunnel, or a
  small always-on relay) forwards to the shared receiver; the app's webhook
  subscription target and the `webhookUrl` config ref are that tunnel URL (§5.3).
  Whole loop stays local, at the cost of a running tunnel. A documented v1
  prerequisite.
- **Phase 2 ("product" fork):** a thin hosted relay that authenticates then
  forwards over a durable channel. Flagged in §10 — it changes distribution.
- **The hot path (shared):** verify (v3 + freshness) → normalize the subscription
  payload to a `SeedEvent` (`hubspot-normalize.ts`) → **respond 200 fast** →
  hand the event to the connector's `subscribe` handler on a later tick
  (`setImmediate`), so HubSpot's delivery-timeout expectation is met and a slow
  flow never causes a redelivery storm. A bad / oversized / forged / **stale**
  delivery is dropped (4xx/401) and **never** seeds a run. HubSpot batches events
  in a single POST (an array) — the normalizer emits one `SeedEvent` per array
  element, each keyed by HubSpot's per-event `eventId` for engine-side dedup.

---

## 6. The flagship loop — inbound lead → enrich → judgment → gated follow-up

**Scenario the author drew on the canvas:** *"When a new contact is created, enrich
it (contact + company), let an agent judge whether it's a qualified lead worth
sales time; if the agent says yes and it's mid-market+, create a follow-up task and
log a note; otherwise just log a note."* This is **not** hardcoded — it's the graph
below, and the author could draw it a dozen other ways.

```
[trigger: contact.created]              HubSpot contact.creation webhook (v3-verified)
        │  payload → context['t'] = { contactId, email, ... }
        ▼
[action: getContact]                    ref=getContact, params={ id: "{{t.contactId}}" }
        │  invokeAction('hubspot','getContact',…) → hubspot-api.getContact() → normalize
        │  writes context['lead'] = HubSpotContactContext
        ▼
[action: getCompany]                    enrich: company by the contact's associated company id
        │  writes context['co'] = HubSpotCompanyContext
        ▼
[agent: "qualify this lead"]            an AGENT node — judgment, NOT routing (§6 note)
        │  reads context['lead'] + context['co']; writes context['judge'] =
        │  { qualified: boolean, reason: string, tier: 'smb'|'midmarket'|'enterprise' }
        ▼
[router]                                explicit branch point
   ├── edge condition: judge.qualified == true
   │        AND (richer) co.company.numEmployees gte 200
   │        ▼
   │   [gate: "approve outreach"]        author-placed; pauses run needs-you (optional)
   │        │  approved ▼
   │   [action: createTask]             follow-up task assigned to an owner
   │        │  invokeAction('hubspot','createTask',{ ... }) → resolves { taskId } → context
   │        ▼
   │   [action: logActivity]            note: "Qualified by saiife worker: <reason>"
   │        ▼   (done)
   │
   └── edge condition: (else — not qualified, or too small)
            ▼
        [action: logActivity]           note the disposition; no task; done
```

Node-by-node against the engine:

1. **Trigger fires.** The shared receiver verifies the v3 signature (method+uri+
   body+timestamp) and freshness, dedups, 200s fast, and `hubspot-normalize` maps
   the `contact.creation` event to a `SeedEvent`
   (`{ eventId, payload: { contactId, email, ... } }`), handed to the connector's
   `subscribe` handler → `trigger-subscriber` → `startRun` (`flow-engine.ts`).
   Trigger node is immediately `done`; payload is in `context['t']`.
2. **Enrich (reads).** `getContact` then `getCompany` run as `action` nodes; the
   action-runner templates params (`id: "{{t.contactId}}"`), confirms
   `status('hubspot') === 'connected'`, calls `invokeAction`; the connector calls
   `hubspot-api`, `hubspot-normalize` maps to the pinned contexts, the connector
   **resolves** them → the runner writes `context['lead']` / `context['co']`.
3. **Judgment (agent).** The `agent` node (`node-runners/agent-runner.ts`) reads
   the enriched context and produces a **structured judgment** into
   `context['judge']`. This is the CRM loop's distinctive stage: **the agent
   judges; it does not route.** Routing stays deterministic (step 4) over the
   agent's structured output — an LLM never silently decides which edge fires or
   which write runs.
4. **Route.** `selectEdges` evaluates each out-edge's condition over
   `context['judge']` + `context['co']` — `judge.qualified === true`, and (richer
   conditions, already merged — `flow-model.ts` `VALID_CONDITION_OPS`)
   `co.company.numEmployees gte 200`. Deterministic value compares.
5. **Gated write.** On the qualified branch, an author-placed `gate` may pause the
   run `needs-you`; on approval `createTask` runs; a HubSpot error **rejects** and
   the run fails with the real message (§6). On success the resolved `{ taskId }`
   is in context.
6. **Annotate + finish.** `logActivity` records the disposition (qualified or not);
   the run completes `done`.

The same trigger + enrich + agent judgment support arbitrarily different graphs
(auto-assign by territory, route hot leads to a human, dedup-before-create,
stage-advance on reply). The connector supplies capability + facts; the **agent
supplies judgment; the author supplies authority.**

---

## 7. Architecture in saiife

A new **main-process module set** under `src/main/hubspot/`, mirroring
`src/main/shopify/` and `src/main/woocommerce/`. It is **opt-in**: with no
`hubspot` config entry (and no stored token) the descriptor's `status()` returns
`needs-config` and the engine refuses any HubSpot node before any network call
(`action-runner.ts`) — saiife's "works with no integration" guarantee is
unchanged. The connector is the **live implementation behind the registry's pinned
`invokeAction` / `subscribe`**, registered via `registerConnector('hubspot',
connector)` (`integration-registry.ts:54`) at startup in `src/main/index.ts`.

### 7.1 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/hubspot/hubspot-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'hubspot'`, config fields, the pinned triggers/actions of §3). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids. Mirrors `descriptors/woocommerce.ts`. |
| `src/main/hubspot/hubspot-connector.ts` | Orchestrator + the live `LiveConnector` (`invokeAction`/`subscribe`). Dispatches an action id → a `hubspot-api` call (params templated by the engine); dispatches a trigger id → a shared-receiver subscription filtered to the HubSpot subscription type. The one place the loop's dispatch lives. |
| `src/main/hubspot/hubspot-api.ts` | Thin **CRM v3 client**. **All** HubSpot request/response shapes (paths, `properties` selectors, search filter groups, error envelope) live *only* here. Owns the **search 4/sec token bucket** + 429 backoff (§6). Isolated behind a `HubSpotApi` interface so tests inject a `MockHubSpotApi` (§8). |
| `src/main/hubspot/hubspot-verifier.ts` | The `HubSpotWebhookVerifier` (§5.2): `signsTimestamp: true`, v3 signed-string composition (`method+uri+body+timestamp`), base64 HMAC, 5-minute staleness reject. Registered with the shared receiver. Pure/unit-testable in isolation. |
| `src/main/hubspot/hubspot-token-store.ts` | Keychain-backed token access — a **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('hubspot', …)`). Named distinctly so a grep test asserts no IPC/renderer caller (the `revealForConnector` discipline). |
| `src/main/hubspot/hubspot-config.ts` | Reads the non-secret `hubspot` refs from the integrations config block (portal id, api base, environment, webhook url) — the `integration-config.ts` validate-at-the-boundary pattern; holds only HubSpot-specific coercion. |
| `src/main/hubspot/hubspot-normalize.ts` | **Pure** mapping: a raw v3 object (`properties` bag) → the pinned **context-field shape** (§3.3); and a raw subscription payload (batched array) → one `SeedEvent` per event. Unit-testable in isolation. This is where string→number, property-flattening, and enum lowercasing happen — **once**, so conditions + the agent read a stable shape. |
| `src/shared/hubspot.ts` | Shared types (`HubSpotContactContext`, `HubSpotDealContext`, `HubSpotCompanyContext`, the action param shapes, the trigger payload shapes) needed by both main and any renderer palette surface. |

### 7.2 Reused saiife surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §3.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/integrations/integration-registry.ts` — `registerConnector('hubspot',
  …)` wires live dispatch (`integration-registry.ts:54`); `deriveStatus` gives
  HubSpot its status for free.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses; `revealForConnector` (main-only plaintext exit, line 99),
  `decryptionError` (feeds `status()`, line 112).
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `hubspot` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `hubspot`;
  `descriptors/woocommerce.ts` is the descriptor-as-code template.
- `src/main/webhooks/webhook-receiver.ts` — **the shared receiver** HubSpot
  registers its `WebhookVerifier` with (§5); the sibling webhook track owns it,
  HubSpot drives the signed-string hook (§5.4).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, how the resolved value lands in context.
- `src/main/flow/node-runners/agent-runner.ts` — the `agent` node that forms the
  §6 judgment over enriched context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; the
  `coerceEvent` / `matchesFilter` normalization the webhook `SeedEvent` flows
  through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`deal.amount`) + boolean routing over the pinned fields.
- `src/main/flow/flow-engine.ts` / `flow-model.ts` — the run lifecycle, gate
  handling, the `INTEGRATION_IDS` allow-list (edited, §3.0), `VALID_CONDITION_OPS`.
- `src/main/server-timeouts.ts` — `applyLoopbackTimeouts`, reused by the shared
  receiver.
- `guard/` (saiifeguard) — the deterministic-guard *posture* a future HubSpot backstop
  (§10 Phase 3) would borrow.

### 7.3 Authority & safety (note)

**Primary control — the flow's gates + the agent-judges-not-routes discipline.**
Every write (`createContact`, `updateDeal`, `logActivity`, `createTask`) is an
`action` node the author gates; the agent's judgment is **structured context an
edge condition or gate reads deterministically**, never a direct trigger of a
write. The engine already enforces gates (`flow-engine.ts`), a human "no" ends the
run `rejected` (not a failure), and a write with no path to it never runs. **The
connector never auto-writes outside the graph the author drew.** An optional
**deterministic HubSpot backstop** (e.g. `hubspot.limits`: cap tasks/run, forbid
`updateDeal` to `closedwon` without a gate) is a phased item (§10 Phase 3),
saiifeguard-style — flagged, not built in MVP.

---

## 8. The connector as an `IntegrationDescriptor`

The static half is a `hubspotDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as it does for the
others — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `privateAppToken` | HubSpot private-app token | **yes** | yes | string | The `Authorization: Bearer` token. Keychain only. Placeholder `pat-na1-…`. |
| `webhookClientSecret` | Webhook app client secret | **yes** | yes | string | Signs `X-HubSpot-Signature-v3`. The **app's** client secret, not the token (§5.5). Keychain only. |
| `portalId` | HubSpot portal (hub) id | no | no | string | Non-secret ref; disambiguates the account. |
| `apiBase` | CRM API base | no | no | string | Defaults to a pinned base in `hubspot-api.ts`. |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts HubSpot work (same field/validation as the others). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay public URL (§5.3, §5.6). Placeholder `https://<tunnel>/hubspot/webhook`. Required for the trigger path; the verifier composes the signed URI from it. |

`status('hubspot')` reports `needs-config` until `privateAppToken`,
`webhookClientSecret`, and `environment` are present; `error` if a stored secret
can't be decrypted (the hub's `decryptionError` path); `disabled` if
configured-but-turned-off; `connected` otherwise. The action-runner refuses any
non-`connected` HubSpot node before any network call.

---

## 9. Open decisions (FLAGGED — not resolved here)

1. **Private-app "for me" vs public-app OAuth product — and the webhook client
   secret.** The biggest fork, sharpened for HubSpot by §5.5.
   - *For me* (MVP): one **private app** (token in the keychain) **plus** a
     developer-account **app whose client secret** signs webhooks. Two artifacts,
     one portal, a dev tunnel for ingress. Fastest to a dogfoodable sales worker.
   - *Product*: a **public OAuth app** (marketplace, per-portal install,
     `portals[]` config, hosted relay). A public app has a client secret *for
     free*, so it **unifies** the auth + webhook-signing story (§4). Recommendation:
     build MVP "for me", keep the client/token/config shapes multi-portal-ready
     (they already are). The §5.5 friction is an argument for prioritizing the
     OAuth fork sooner than Shopify's.
2. **Which objects + events ship in MVP.** Contacts / deals / companies + notes /
   tasks is the proposed surface. Do we ship all **three triggers** in the MVP
   slice, or only `contact.created` (cleanest) with `deal.stageChanged` /
   `form.submitted` in phase 2? (The walking skeleton takes `contact.created`
   only — §10.) Tickets, line items, custom objects are explicitly phase 2+.
3. **`deal.stageChanged` filtering — connector-side or template-side.** The
   `deal.propertyChange` subscription fires on *any* deal property change; filtering
   to `dealstage` can be done in the verifier/normalizer (emit a `SeedEvent` only
   when `propertyName === 'dealstage'`) or left to a flow edge condition. Leaning
   connector-side (cheaper, no wasted runs); flagged for the templates track.
4. **The agent judgment's structured-output contract.** §6's `context['judge']`
   shape (`{ qualified, reason, tier }`) is illustrative. Whether the connector or
   the templates track pins a canonical judgment shape (so conditions can rely on
   `judge.qualified`) is an open call shared with the agent-node/templates tracks.
5. **Deterministic HubSpot backstop — default present or absent.** As with
   Shopify's ecom backstop, whether a shipped sales worker ships with a
   conservative default (cap tasks/run; forbid ungated `updateDeal` to a
   closed-won stage) is a product-safety call for the backstop phase (§10 Phase 3).
   Whatever the default, it is **deterministic** (saiifeguard-style), never
   model-mediated.
6. **Webhook subscription management — manual vs programmatic.** MVP can have the
   user create the app's subscriptions in HubSpot (pointing at their tunnel), or
   the connector can manage them via the webhooks API on connect. Programmatic is
   nicer UX but adds scope + teardown. Leaning manual for the MVP slice.

---

## 10. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live HubSpot portal**, matching saiife's existing seams
(pure modules, injected backends, fixture events):

- **`HubSpotApi` interface + `MockHubSpotApi` seam.** `hubspot-api.ts` is written
  *against* a `HubSpotApi` interface (`getContact`, `getDeal`, `getCompany`,
  `searchContacts`, `createContact`, `updateDeal`, `createNote`, `createTask`);
  the real impl wraps the v3 HTTP transport. Tests inject a `MockHubSpotApi`
  returning canned objects, canned error envelopes, and canned **429/throttle**
  responses. **No test ever performs a live HubSpot call**; CI has no HubSpot
  credentials. (Same posture as Shopify's `MockShopifyApi` and the
  `SessionManager` `spawnFn` seam.)
- **`hubspot-normalize.ts` unit tests** — pure function; assert every raw v3
  object (`properties` bag) → the pinned `HubSpot{Contact,Deal,Company}Context`
  (§3.3): string→number (`amount`), property-flattening, enum lowercasing
  (`dealstage`, `lifecyclestage`), absent-property → empty/zero, and the batched
  subscription array → one `SeedEvent` per event. The correctness boundary the
  conditions + agent tracks depend on — guarded hardest.
- **`hubspot-verifier.ts` unit tests** — feed `WebhookSigningInput`s with **valid
  and invalid v3 signatures**, a **stale timestamp** (> 5 min → reject), a fresh
  one, an empty client secret (reject), and a wrong `requestUri` (§5.3 → reject);
  assert the composed signed string is exactly `method+uri+body+timestamp` and
  base64. This is where the §5.4 hook is proven.
- **Shared-receiver integration test (HubSpot verifier registered)** — feed fake
  `contact.creation` / `deal.propertyChange` / form-submission POSTs with valid
  and invalid v3 signatures, oversized bodies, malformed JSON, and stale
  timestamps; assert 200/4xx/401 and that only valid+signed+fresh events produce a
  `SeedEvent`. Proves the receiver passes the **full signing input** (not bare
  rawBody) to the verifier.
- **`hubspot-connector` dispatch tests** — with a `MockHubSpotApi` + a fake
  registry: assert `invokeAction('hubspot','getContact',…)` resolves the
  normalized context; assert a HubSpot error envelope **rejects** with the verbatim
  message (the pinned failure convention); assert `searchContacts` respects the
  **4/sec** token bucket (drive N calls, assert spacing / that the (N+1)th is
  delayed rather than 429'd).
- **Engine integration test (offline)** — wire the real `FlowEngine` + the registry
  with the HubSpot connector over a `MockHubSpotApi` + a stub `agent-runner`, drive
  the §6 loop: inject a `contact.creation` `SeedEvent` → assert `getContact` /
  `getCompany` write context → assert the agent node writes `judge` → assert the
  router selects the qualified edge → assert `createTask` calls the mock → assert
  the gate branch pauses `needs-you`. Deterministic via the engine's injected
  `now()`.
- **Token-store test** — `revealForConnector` round-trip via a fake
  `SecretBackend`; a regression guard asserts **no token/secret value appears** in
  any emitted log/console/error string (the secret rule).
- **Snapshot test on `hubspotDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

No test requires HubSpot credentials or a live portal; the real v3 API is exercised
only in manual dogfooding against a developer test account.

---

## 11. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One portal, one flow, the read + agent judgment + one gated write, happy path:**

1. `IntegrationId` gains `'hubspot'` (+ the three lockstep touch-points, §3.0);
   `hubspotDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `privateAppToken` + `webhookClientSecret` stored (→ keychain);
   `status('hubspot') === 'connected'`.
3. `hubspot-api.ts` behind `HubSpotApi`: `getContact` (`GET …/contacts/{id}`) and
   `createTask` (`POST …/tasks`) live. `hubspot-normalize` produces
   `HubSpotContactContext`.
4. `registerConnector('hubspot', connector)`: `invokeAction('hubspot',…)` reaches
   the connector; `subscribe('hubspot','contact.created',…)` reaches the shared
   receiver.
5. `HubSpotWebhookVerifier` (§5.2) registered with the **shared receiver**,
   verifying **`contact.creation`** v3-signed + timestamp-fresh deliveries behind a
   dev tunnel, emitting a `SeedEvent`. **Requires the §5.4 receiver hook to land.**
6. On the canvas: `[contact.created] → [getContact] → [agent: qualify] → [gate] →
   [createTask]` runs end-to-end. Errors per §6.

That slice proves the whole loop (a real lead event wakes a real flow that reads
the contact, an agent judges it, and behind a gate a follow-up task is created) and
is dogfoodable against a HubSpot developer test account.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. "For me" fork. `contact.created` +
  `getContact` + agent judgment + `createTask` + author gate. Single portal, single
  environment. Lands (or depends on) the §5.4 shared-receiver hook.
- **Phase 2 — full vocabulary:** the rest of §3 — `getDeal` / `getCompany` /
  `searchContacts` (with the 4/sec bucket); `createContact` / `updateDeal` /
  `logActivity`; the `deal.stageChanged` (`deal.propertyChange`+filter) and
  `form.submitted` triggers; programmatic webhook-subscription management (§9.6);
  the email-trigger composition wired by the templates track.
- **Phase 3 — deterministic HubSpot backstop:** the `hubspot.limits` policy (§7.3),
  saiifeguard-style, with the default decided (§9.5).
- **Phase 4 — richer conditions consumption:** verify the pinned fields drive
  `gt`/`gte`/`contains`/`truthy`/`exists` end-to-end over `deal.amount`,
  `company.numEmployees`, `lifecycleStage`; ship the "qualify + assign" template.
- **Phase 5 — product fork:** distributable **public OAuth app**, hosted webhook
  relay, `portals[]` multi-portal isolation (§9.1) — which also **retires the §5.5
  app/client-secret friction**. Marketplace viability.
- **Phase 6 — expand CRMs:** **Salesforce** (heavier auth/ingress — validates the
  boundary), then **Pipedrive**. Each a peer under `src/main/salesforce/` /
  `src/main/pipedrive/`, reusing the `*-connector` / `*-api` / `WebhookVerifier` /
  `*-normalize` shape. No shared cross-platform standard — each is its own
  connector.

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/integrations.ts` — pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector`; `IntegrationId` (edited, §3.0);
  `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/integrations/integration-registry.ts` — `registerConnector` (line 54,
  the live-dispatch seam); `invokeAction`/`subscribe` delegation (lines 73-96);
  `deriveStatus`.
- `src/main/integrations/credential-store.ts` — `safeStorage` keychain;
  `revealForConnector` (line 99, main-only plaintext exit); `decryptionError`
  (line 112).
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `hubspot`;
  `descriptors/woocommerce.ts` the descriptor-as-code template.
- `src/main/webhooks/webhook-receiver.ts` — the shared receiver + `WebhookVerifier`
  seam HubSpot registers with and drives the §5.4 signed-string hook for.
- `src/main/server-timeouts.ts` — `applyLoopbackTimeouts` (reused by the receiver).
- `src/main/flow/node-runners/action-runner.ts` — `invokeAction`, **reject =
  failure**, resolved value → context.
- `src/main/flow/node-runners/agent-runner.ts` — the `agent` judgment node (§6).
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs;
  `coerceEvent` / `matchesFilter`.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`.
- `src/main/flow/flow-engine.ts` / `flow-model.ts` — run lifecycle, gate handling,
  the `INTEGRATION_IDS` allow-list (edited, §3.0), `VALID_CONDITION_OPS`.
- `src/main/shopify/*`, `src/main/woocommerce/*` — the merged sibling connectors
  whose `*-connector` / `*-api` / `*-normalize` / descriptor / token-store shape
  this connector copies.
- `guard/` (saiifeguard) — the deterministic-guard posture a future HubSpot backstop
  (§10 Phase 3) would borrow.
