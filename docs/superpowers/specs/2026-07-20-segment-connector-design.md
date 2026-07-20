# Segment Connector — Design

**Date:** 2026-07-20
**Status:** Design (spec) — not started. Feasibility is **done (YELLOW)** — the
inbound firehose is cloud-only and the binding constraint is the 8 GB-RAM ceiling,
so the connector is buildable but only if it **filters hard** (§2, §7).
**Feature:** A single **`segment` connector** that plugs into the merged
flow-builder (integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. It is the **event SOURCE MULTIPLIER**: **one** Segment
webhook connector lets a flow wake on events from **any** upstream product source
Segment already collects — web (`analytics.js`), iOS / Android SDKs, the server
SDKs (Node / Python / Go / …), and Segment's cloud sources (Stripe billing,
mobile-attribution, other SaaS) — with **zero per-source code**. A single
`track` / `identify` webhook fires the pinned `event.tracked` trigger through the
shared webhook receiver, verified with Segment's **X-Signature SHA1 HMAC**, and
the flow does the localflow judgment behind whatever gates the author drew.

This connector satisfies the **pinned** `IntegrationDescriptor` / `LiveConnector`
/ `registerConnector` contract in `src/shared/integrations.ts` and copies the
module shape of `src/main/shopify/` (descriptor-as-code, `CredentialStore`
keychain, presence-derived `status()`, a mocked transport seam). It reuses the
Shopify / generic-HTTP connector specs
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`,
`docs/superpowers/specs/2026-07-18-webhook-connector-design.md`) as its style and
depth template.

**The one thing this connector does that Shopify's does not, stated up front.**
Shopify's `subscribe(triggerId, handler)` **ignores** the trigger node's config —
its webhook is a low-volume order stream. Segment's webhook is a **firehose**: on
a busy source it can carry thousands of `track` events per minute, and on an 8 GB
Mac every seeded run may spawn an agent/session. So the Segment connector's
central design work is to **filter HARD, twice** — at Segment (destination
filters / a Segment Function, so the firehose never leaves the cloud) and again
**pre-seed inside the connector**, using the trigger node's config via
`subscribe(triggerId, handler, config)` (already carried through
`trigger-subscriber.ts`). The RAM ceiling is not a footnote — it is the load-
bearing constraint that shapes §7.

**A note on ownership.** This spec **owns and pins the Segment vocabulary** (§6:
the `IntegrationId` addition, the one trigger, the two write actions, the
per-node filter `config`, and the context-field shape). It **consumes** the
sibling-owned **parameterized webhook receiver**
`src/main/webhooks/webhook-receiver.ts` verbatim — specifically its `algo: 'sha1'`
HMAC path (the receiver already carries it; Intercom uses the same) — and the
sibling-owned **hosted webhook binding** `src/main/hosted/webhook-bindings.ts`.
Where a sibling owns a shape, this spec **names the dependency and stops**.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user, on the canvas, wake a flow when a
specific, **hard-filtered** Segment event (`event.tracked` — a `track` or
`identify` from ANY upstream source Segment collects) arrives — verified with
Segment's X-Signature SHA1 HMAC through the shared receiver — so that **one
connector reaches every product surface Segment sees**, without the firehose ever
flooding an 8 GB machine.

### In scope (MVP)

- A new **`segment` connector** module set under `src/main/segment/`, exposing a
  static `segmentDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus the **live dispatch** (`LiveConnector`) registered via
  `registry.registerConnector('segment', segmentConnector)`
  (`integration-registry.ts:54`).
- **The trigger — `event.tracked`.** A Segment **Webhook (Actions) destination**
  (or a Segment **Function**) POSTs each event to the local receiver. The shared
  `webhook-receiver` verifies the **X-Signature** header (hex HMAC-**SHA1** over
  the raw body) with the destination's shared secret from the keychain,
  normalizes the verified Segment event to a `SeedEvent`, and hands it to
  `subscribe`.
- **The hard filter (the heart — §7).** The trigger node's `config` carries an
  **event-name match** and optional **property / trait match**; the connector
  applies it **before seeding any run**, so an unmatched firehose event starts
  nothing. This is the RAM-ceiling defense. It is *in addition to* the
  recommended **filter-at-Segment** (destination filters / a Function) so the bulk
  never leaves the cloud.
- **Thin write actions — `track` / `identify` (gated).** `track` emits a Segment
  `track` call and `identify` emits an `identify` call via the **HTTP Tracking
  API** (`https://api.segment.io/v1/{track,identify}`, HTTP Basic with the source
  **write key** as the username). Isolated behind a `SegmentApi` interface (the
  blast radius for any API change), mocked in tests. **Gated** because a write
  into Segment fans back out to every downstream destination — a real,
  amplified side effect (§9).
- **Auth → keychain.** The **shared secret** (verifies X-Signature) and the
  **write key** (authorizes the Tracking API) live in the OS keychain via
  `CredentialStore`; `config.json` holds only non-secret refs (§8). Neither is
  ever rendered.
- **Authority = the flow's gates.** Every write is an `action` node the author
  gates; the connector never emits outside the graph the author drew (§9).
- **Single Segment workspace / source, single localflow environment.**

### Out of scope (MVP) — explicitly deferred

- **A write surface at all — flagged as an open decision (§13.2).** Segment's
  centre of gravity is *ingest*, and the flagship value (§7.4) is trigger-only.
  The `track` / `identify` actions are designed here but may be cut from the MVP
  slice if the write path isn't earning its keep.
- **A generic per-event-type trigger set** (`user.identified`, `page.viewed`,
  `screen.viewed`, `group`). MVP pins **one** trigger — `event.tracked` — that
  covers `track` and `identify`; the config's `type` filter distinguishes them
  (§6.4). Splitting into per-type trigger ids is a fast-follow (§14).
- **A hosted webhook relay.** MVP's ingress is the **user-run dev tunnel** (the
  Shopify/HTTP §4.4 "for me" fork). The hosted relay reuses the sibling-owned
  `segmentWebhookBinding` (§4.4) and is the product-fork change (§14), flagged,
  not built now.
- **Reading historical events / Segment's Profiles (Unify) API.** The connector
  is push-only (webhook in) + emit (Tracking API out); it does not query Segment
  for profile traits or past events. A Profiles read action is later scope.
- **Replay / at-least-once durability of missed events.** If the tunnel is down,
  events are lost at Segment's retry boundary — MVP surfaces the dead-ingress
  loudly (§11) but does not buffer. Durable delivery is the hosted-relay phase.
- **Multi-source / multi-workspace fan-in.** The config/secret shapes are drawn
  so a `sources: [...]` array is the additive path, not built now.

---

## 2. Feasibility + landscape (done — YELLOW)

### 2.1 Why Segment, and why it is a *multiplier* not just another connector

Every other connector in the catalog reaches **one** system: Shopify reaches
Shopify, Stripe reaches Stripe. **Segment reaches everything already piped into
Segment.** A customer-data platform's whole job is to collect `track`/`identify`
events from every source a company runs — the website, the iOS and Android apps,
the backend services, and dozens of cloud SaaS sources — and fan them out to
destinations. If localflow is **a destination**, then one connector inherits the
entire upstream: a `Subscription Downgraded` event fired from Stripe billing, from
an in-app button, or from a mobile screen all arrive through the *same* webhook,
in the *same* shape. **One connector, every product surface.** That is the
strategic case, and it is why Segment is worth a bespoke connector rather than
the generic-HTTP webhook trigger: the value is the *shape guarantee* (the Segment
spec) and the *source multiplication*, not merely "receive a POST".

### 2.2 The Segment surface for the trigger → judge → (emit) loop

Grounded in the current Segment docs (verified 2026-07-20):

- **Inbound (the trigger).** Segment forwards events to an external endpoint via
  the **Webhook (Actions)** destination or a **Segment Function** (a
  destination Function). Each delivery is an HTTPS **POST** whose body is the
  Segment event envelope (`type`, `event`, `userId`/`anonymousId`, `properties`
  or `traits`, `context`, `messageId`, `timestamp`). The Webhook destination signs
  each request with an **`X-Signature`** header: the **hex-encoded HMAC-SHA1** of
  the **raw request body**, keyed by a **shared secret** you configure on the
  destination. Verify **before** parsing (a body-parser that consumes the stream
  first breaks the HMAC — the receiver reads raw bytes). This is **exactly** the
  shared receiver's `scheme:'hmac', algo:'sha1', encoding:'hex'` path — no new
  crypto (§4.2, §8).
- **The firehose.** A destination receives **every event that matches its filters**
  from its connected sources. Unfiltered, that is the full stream — thousands of
  events/min on a real source. This is the YELLOW (§2.3).
- **Filter-at-Segment (the primary volume control).** The Webhook destination
  supports **Destination Filters** (drop / sample events before they leave
  Segment), and a **Function** can `return`-early on anything it shouldn't
  forward. **Filtering hard at Segment means the firehose never reaches the 8 GB
  machine at all** — the single most important design lever (§7.1).
- **Outbound (the optional write).** The **HTTP Tracking API** accepts `track` /
  `identify` (and `page`/`screen`/`group`) via `POST
  https://api.segment.io/v1/{track,identify}`, authenticated with the **source
  write key** as the HTTP **Basic-auth username** (empty password). EU-region
  workspaces post to `https://events.eu1.segmentapis.com/v1/…` (a non-secret
  `dataPlaneUrl` ref, §5). A write into Segment **fans out to every downstream
  destination** — powerful and to be gated (§9).
- **No inbound rate concern on our side beyond volume.** We receive; we don't
  poll. The write side is generous (batched Tracking API), well under any limit
  for the loop's occasional emit.

### 2.3 Constraints (why YELLOW, not GREEN)

1. **Cloud ingress is mandatory** (trigger only). Segment POSTs from the cloud;
   localflow is a Finder-launched Electron app on an 8 GB Mac behind NAT with no
   public HTTPS endpoint. MVP uses a **user-run tunnel** ("for me"); a hosted
   relay is the product fork (§4.4). Identical in shape to Shopify/HTTP §4.4 —
   a known, solved pattern, not a blocker.
2. **The firehose vs the 8 GB RAM ceiling — the binding constraint.** This is
   what makes Segment YELLOW where Shopify is GREEN. Segment's stream is high-
   volume by construction, and on this machine RAM is the scarce resource
   ([Dev machine] memory: qwen2.5:3b + Electron + Claude already sized to fit).
   An unfiltered subscription that seeds a run per event would spawn unbounded
   agents/sessions and OOM the box. **The connector is only viable if it filters
   hard** — at Segment first, and pre-seed in the connector second (§7). This is
   a design constraint the spec must satisfy, not a capability gap.
3. **Is a write surface even needed?** Segment is an *ingest* platform; the
   flagship (§7.4) is trigger-only. The `track`/`identify` write is designed but
   its inclusion in the MVP is an open product call (§13.2) — a genuine "do we
   build this half" question, not a technical unknown.

### 2.4 Verdict: **YELLOW**

The trigger → judge loop is **buildable today** on GA Segment surfaces (Webhook/
Function destination, X-Signature SHA1 HMAC, the HTTP Tracking API), reusing the
shared receiver's existing SHA1 path with **no new crypto and no new ingress
architecture**. It is YELLOW rather than GREEN for one honest reason: the inbound
firehose **must** be filtered hard to fit the 8 GB ceiling (§7), and the ingress
tunnel is a prerequisite (§4.4). Neither blocks; both are addressed. The write
surface is optional and flagged (§13.2).

---

## 3. The core loop → Segment primitives

localflow's loop is `trigger → read → route → act (gated)`. For Segment the
"read" is already in the event envelope (Segment delivers the properties/traits),
so the loop is `trigger (hard-filtered) → route → act (gated, optional)`:

| Stage | Segment primitive | localflow / flow-engine mechanism |
|---|---|---|
| **trigger** | A Webhook/Function destination POSTs a `track`/`identify` event; **destination filters keep the firehose in the cloud**. | `webhook-receiver` verifies X-Signature (SHA1 HMAC over raw body) → `segment-normalize` maps it to a `SegmentEventContext` → **the connector applies the node's hard filter** → only a match becomes a `SeedEvent` → `subscribe(triggerId, handler, config)` hands it to the engine, which `startRun`s the flow (`trigger-subscriber.ts`). |
| **read** | *(none — the event carries its own `properties`/`traits`)* | The event payload is written to the trigger node's context slot; no follow-up API call needed. Downstream conditions read `event.properties.*` / `event.traits.*` by dotted path (`context.ts`). |
| **route** | *(none — pure localflow)* | `selectEdges` evaluates edge conditions over the event context — e.g. `field: 'trigger.event.name', op: 'eq', value: 'Subscription Downgraded'`. **No LLM decides routing** — deterministic value compares. |
| **gate** | *(none — pure localflow)* | A `gate` node the author placed pauses the run `needs-you`; the human approves in the cockpit before any emit. |
| **act (optional)** | `POST /v1/track` / `POST /v1/identify` (HTTP Tracking API, write-key Basic auth). | The gated `track`/`identify` action → `invokeAction('segment', …)` → `segment-client`. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the real Segment error. An emit **fans out to every downstream destination** — hence gated. |

**The authority is the graph the author drew, not the connector.** The connector
exposes a hard-filtered trigger and (optionally) a gated emit; the *flow* decides
which runs, behind which gates. There is no "connector default policy" — the
connector only seeds a run on a filter match and only emits when an `action` node
invokes it.

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/segment/`, mirroring
`src/main/shopify/` (the connector-spec module pattern:
`*-descriptor` / `*-connector` / `*-client` / `*-webhook-server` / `*-config` /
`*-normalize`). It is **opt-in**: with no `segment` config entry and no stored
secret the descriptor's `status()` reports `needs-config`, `subscribeTriggers`
starts no subscription, and the engine refuses any `segment` node before any
network call (`action-runner.ts`) — localflow's "works with no integration"
guarantee is unchanged.

Architecturally the connector is a **live implementation behind the registry's
pinned `invokeAction` / `subscribe`**, registered via
`registry.registerConnector('segment', segmentConnector)`
(`integration-registry.ts:54`; Shopify/WooCommerce/PostHog are the existing live
connectors, `segment` slots into the same map). **All Segment API shapes are
isolated in `segment-client.ts`** (the write blast radius) and
`segment-normalize.ts` (the inbound-envelope blast radius) — the connector itself
holds no Segment shape and no secret.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/segment/segment-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'segment'`, the config fields of §5, the pinned trigger/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids. Mirrors `shopify-descriptor.ts`. |
| `src/main/segment/segment-connector.ts` | The `LiveConnector` impl + orchestrator. `subscribe('event.tracked', handler, config)` → wires the single webhook sink (lazily, once) and **applies the node's hard filter (§7) before seeding**. `invokeAction('track'\|'identify', params)` → a `segment-client` emit. Holds NO Segment shape, NO secret; every failure REJECTS with the real cause (§11). |
| `src/main/segment/segment-client.ts` | Thin **HTTP Tracking API** client for the write actions. **All** Segment request/response shapes live *only* here. Write-key Basic auth; region-aware base URL (`dataPlaneUrl`). Isolated behind a `SegmentApi` interface so tests inject a `MockSegmentApi` (§12). Only built if the write surface ships (§13.2). |
| `src/main/segment/segment-webhook-server.ts` | A **thin wrapper** over the shared `startWebhookReceiver`, mirroring `shopify-webhook-server.ts`: it supplies the **Segment verifier** (`x-signature`, hex HMAC-**SHA1**) and the vendor `parse` (JSON-object guard → `SegmentWebhookDelivery`). Also exports `segmentWebhookBinding` for the hosted path (§4.4). The HTTP + HMAC + size-cap + 200-fast machinery lives in `webhook-receiver.ts`. |
| `src/main/segment/segment-normalize.ts` | **Pure** mapping: a raw (untrusted) Segment event body → the pinned `SegmentEventContext` (§6.5); and the **filter predicate** `eventMatches(config, ctx)` (§7.2). Unit-testable in isolation (mirrors `shopify-normalize.ts` purity). Never throws — a sparse/garbage body normalizes to safe defaults and fails the filter rather than crashing a run. |
| `src/main/segment/segment-config.ts` | Reads the non-secret `segment` refs (environment, webhook path/url, `dataPlaneUrl`) — the `integration-config.ts` validate-at-the-boundary pattern. Mostly free via the descriptor's non-secret `configFields`; holds only Segment-specific coercion (region-URL normalization). |

**Consumed shared-infra (sibling-owned — named, not designed here):**

| Module | This connector's use |
|---|---|
| `src/main/webhooks/webhook-receiver.ts` | The parameterized receiver. Segment supplies `{ scheme:'hmac', header:'x-signature', algo:'sha1', encoding:'hex' }` and a `parse`; the receiver does createServer + `MAX_BODY_BYTES` (413) + 200-fast + `responded`/error guards + the timing-safe HMAC over the **raw** body **before** parse. **The `algo:'sha1'` path already exists** (Intercom uses it) — no receiver change. |
| `src/main/hosted/webhook-bindings.ts` | `HostedWebhookBinding<SegmentWebhookDelivery>` — the SAME verifier + parse the loopback server uses, plus the keychain secret ref — for the phase-2 hosted relay (§4.4). Exported as `segmentWebhookBinding`, mirroring `shopifyWebhookBinding`. |
| `src/main/integrations/credential-store.ts` | The `safeStorage` keychain; `revealForConnector('segment', 'sharedSecret'\|'writeKey')` is the sole main-process-only plaintext exit. |

### 4.3 Wiring the live dispatch into the merged registry

Unchanged from the Shopify/HTTP seam — the registry already supports it.
`src/main/index.ts` constructs the `SegmentConnector` (given the `CredentialStore`,
config, and the webhook server) and calls
`registry.registerConnector('segment', segmentConnector)`. The pinned
`invokeAction`/`subscribe` (`integration-registry.ts:73-103`) already delegate to
a registered connector or fall back to the legible "no live connector wired"
reject / no-op unsubscribe. Crucially, the registry's `subscribe` **already
forwards `config`** to the connector (`integration-registry.ts:90-103`,
`trigger-subscriber.ts:60-67`) — the seam the hard filter needs is **already
pinned**; no contract change. **The pinned contract is byte-for-byte unchanged.**

### 4.4 Receiving events (the cloud-ingress problem)

Identical in shape to Shopify/HTTP §4.4 — Segment posts from the cloud, the local
receiver binds loopback:

- **MVP ("for me" fork):** a developer tunnel (ngrok / Cloudflare Tunnel) forwards
  to the local `segment-webhook-server`; the Webhook destination's URL is that
  tunnel URL + the non-secret `webhookPath`. Whole loop stays on the user's
  machine, at the cost of a running tunnel. A documented v1 prerequisite.
- **Phase 2 ("product" fork):** the sibling-owned hosted relay consumes
  `segmentWebhookBinding` (the same verifier + parse + secret ref), authenticates
  the delivery, and forwards over a durable channel. Flagged (§14); it changes
  distribution, not the connector's verification or dispatch.

Regardless of ingress, the receiver **verifies X-Signature over the raw body**
(timing-safe, before parse), enforces `MAX_BODY_BYTES`, and responds **200 fast**
— the filter + run start happen after the response so Segment's delivery-timeout
is met and a slow flow never causes a redelivery storm. A forged / oversized /
malformed / unverified delivery is dropped (4xx/401) and **never** reaches the
filter, let alone seeds a run.

### 4.5 Reused localflow surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `LiveConnector` / `registerConnector` contract; `IntegrationId` (edited, §6.0);
  `IntegrationStatus`; **`subscribe(…, config?)`** (the already-pinned filter seam).
- `src/main/integrations/integration-registry.ts` —
  `registerConnector('segment', …)` (§4.3); `deriveStatus` gives `segment` its
  status for free; the config-forwarding `subscribe`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain;
  `revealForConnector` (main-only plaintext exit); `clear('segment')` teardown.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; `coerceEvent`
  normalizes the `SeedEvent`; **`matchesFilter`** (the generic post-seed filter the
  connector's own pre-seed filter complements, §7.2).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called, the
  **reject = failure** convention, and how a resolved value lands in context.
- `src/main/flow/context.ts` — `resolveField` / `selectEdges`: dotted-path reads
  (`event.properties.plan`) + boolean routing over the pinned fields.
- `src/main/webhooks/webhook-receiver.ts` (sibling-owned) — the parameterized
  receiver + its existing `algo:'sha1'` HMAC path (§4.2).
- `src/main/hosted/webhook-bindings.ts` (sibling-owned) — the hosted binding (§4.4).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `segmentDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected | needs-config | error | disabled`) as it does for the others — no
bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `sharedSecret` | Webhook shared secret | **yes** | yes | string | Verifies `X-Signature` (SHA1 HMAC). Keychain only. Set on the Segment Webhook destination. |
| `writeKey` | Source write key | **yes** | **no** | string | Authorizes the HTTP Tracking API (Basic-auth username). Keychain only. **Only required when a `track`/`identify` action is used** — a trigger-only connector is valid without it (§13.2). Placeholder masked. |
| `environment` | localflow environment (1-9) | no | yes | number | Which env hosts Segment work (same field/validation as Shopify's). |
| `webhookPath` | Ingress webhook path | no | no | string | Default `/segment/webhook`; the path the tunnel/relay forwards to. Non-secret ref. |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay base + path — the destination's delivery URL. Placeholder `https://<tunnel>/segment/webhook`. |
| `dataPlaneUrl` | Tracking API region base | no | no | string | Defaults to `https://api.segment.io`; EU workspaces set `https://events.eu1.segmentapis.com`. Write side only. |

`status('segment')` reports **`needs-config`** until `sharedSecret` and
`environment` are present (note: **not** `writeKey` — a trigger-only connector is
fully usable); **`error`** if a stored secret can't be decrypted (the hub's
`decryptionError` path); **`disabled`** if configured-but-turned-off; **`connected`**
otherwise. The action-runner refuses any non-`connected` `segment` node before any
network call; a `track`/`identify` node whose `writeKey` is missing **rejects at
run time** with a legible message (§11) — the same per-capability-readiness honesty
the HTTP connector uses.

---

## 6. Pinned Segment vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The canvas palette and the flow-templates
> track read these ids and this field shape verbatim. A snapshot test in
> `segment-descriptor.ts` guards the ids; the field/filter shapes are guarded by
> the `segment-normalize.ts` tests.

### 6.0 Shared-union edit (the three lockstep touch-points)

`src/shared/integrations.ts` — `IntegrationId` gains `'segment'`. This is a
shared-union edit with **three** companion touch-points that must move in lockstep
(each a one-line add):

1. `IntegrationId` union **and** the `INTEGRATION_IDS` stable-order array
   (`integrations.ts:11-24`, `:99-113`) — the union member + its array slot.
2. the `INTEGRATION_IDS` set in `flow-model.ts:29` (the flow validator's
   allow-list).
3. `DESCRIPTOR_DEFS` (`descriptors/index.ts`) — import `segmentDescriptor`, add
   the `segment:` key.

No other `IntegrationId` consumer needs a change — they iterate the array.

### 6.1 Trigger (one, webhook-backed)

| trigger id | label | backing | note |
|---|---|---|---|
| `event.tracked` | A Segment event fired (from any source) | The shared `webhook-receiver` (X-Signature SHA1 HMAC), hard-filtered per node (§7). | Covers `track` **and** `identify`; the node's `config.type` filter distinguishes them (§6.4). One trigger id = the source multiplier: every upstream source fires the same trigger. |

Splitting into per-type ids (`user.identified`, `page.viewed`, …) is a fast-follow
(§14); MVP pins the single `event.tracked` so the flagship (§7.4) works with a
minimal contract.

### 6.2 Actions (two, thin write — optional per §13.2)

| action id | label | Segment call | gate? | writes to context |
|---|---|---|---|---|
| `track` | Emit a track event | `POST /v1/track` (write-key Basic auth) | **yes** — author places a gate | `{ segment: { messageId, type: 'track' } }` |
| `identify` | Emit an identify | `POST /v1/identify` | **yes** — author places a gate | `{ segment: { messageId, type: 'identify' } }` |

**Why gated:** an emit into Segment **fans out to every downstream destination**
connected to the source — a single `track` can trigger email sends, ad-audience
updates, warehouse rows, and other webhooks. It is an amplified, effectively
irreversible side effect, so it is an `action` node the author gates (§9).

**Failure convention (pinned):** an action that fails **rejects** its promise with
the real Segment error text; a resolved promise (any value) is success and its
value becomes the node's context output (`action-runner.ts`,
`integrations.ts:43-56`). The connector never resolves a sentinel-failure and
never swallows a non-2xx.

### 6.3 Shared-union & vocabulary types (`src/shared/segment.ts`)

```ts
export const SEGMENT_TRIGGER_IDS = ['event.tracked'] as const
export type SegmentTriggerId = (typeof SEGMENT_TRIGGER_IDS)[number]

export const SEGMENT_ACTION_IDS = ['track', 'identify'] as const
export type SegmentActionId = (typeof SEGMENT_ACTION_IDS)[number]

/** The Segment event types the trigger recognizes. */
export type SegmentEventType = 'track' | 'identify' | 'page' | 'screen' | 'group'
```

### 6.4 The per-node hard-filter `config` (the RAM-ceiling control — §7)

Carried on the trigger `FlowNode.config`, forwarded to `subscribe` (already pinned,
§4.3), applied **before** a run is seeded:

```ts
// src/shared/segment.ts — a segment `event.tracked` trigger node's config.
export interface SegmentTriggerConfig {
  /** Which Segment event type to accept. Default 'track'. */
  type?: SegmentEventType
  /** REQUIRED for 'track': the exact event name, e.g. "Subscription Downgraded".
   *  A track subscription with no `event` is refused at validation (§7.3) — an
   *  un-named track filter IS the firehose, and the whole point is to not have it. */
  event?: string
  /** Optional exact-match narrowing on properties (track) or traits (identify),
   *  e.g. { plan: 'pro' }. All entries must match (deterministic value compare). */
  match?: Record<string, string | number | boolean>
}
```

### 6.5 Context-field shape (what the trigger writes for later conditions)

The verified, filtered event is normalized (`segment-normalize.ts`) into a stable
object written to the trigger node's context slot. Downstream conditions read it by
dotted path (`context.ts` `resolveField`). **Pinned shape:**

```ts
// src/shared/segment.ts
export interface SegmentEventContext {
  event: {
    type: SegmentEventType     // 'track' | 'identify' | …
    name: string               // the `event` name for track; '' for identify
    userId: string             // '' when only anonymousId is present
    anonymousId: string        // '' when only userId is present
    messageId: string          // Segment's dedup id (also the SeedEvent eventId)
    timestamp: string          // ISO 8601
    /** track: the event's `properties`; identify: '' — see `traits`. */
    properties: Record<string, unknown>
    /** identify: the user's `traits`; track: {} unless present in context. */
    traits: Record<string, unknown>
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and the typed `FlowEdgeCondition` operators owned by the
conditions track). `userId`/`anonymousId` coerced to strings (never `undefined`)
so `exists`/`eq` are stable; `properties`/`traits` preserved as objects so
`event.properties.mrr gt 100` and `event.traits.plan eq 'enterprise'` work.
Normalizing once, in one pure module, is the correctness boundary the templates
and conditions tracks rely on.

---

## 7. The hard-filter design (the heart of the connector)

The 8 GB RAM ceiling (§2.3) makes filtering **the** design problem: an unfiltered
Segment subscription seeds a run per firehose event, and each run may spawn an
agent/session, so an unfiltered stream OOMs the machine. The connector filters in
**two layers**, defence-in-depth, each of which alone dramatically cuts volume.

### 7.1 Layer 1 — filter at Segment (the firehose never leaves the cloud)

The **primary** control, and the strongly recommended setup: configure the
Segment Webhook destination's **Destination Filters** (or an early `return` in a
Segment **Function**) so only the events a flow actually wants are ever forwarded.
Filtering at Segment means the bulk of the firehose is dropped **in Segment's
infrastructure** and never touches the tunnel or the 8 GB box at all. This is not
localflow code — it is a documented connect-time step (§14 onboarding), and it is
where the heaviest reduction happens. The connector's UI/onboarding copy makes it
explicit: *"Add a Destination Filter in Segment for the event(s) this flow needs —
localflow filters again locally, but keeping the firehose in the cloud is what
keeps your machine healthy."*

### 7.2 Layer 2 — pre-seed filter in the connector (the deterministic floor)

Segment filters can be mis-set, and a Function can be bypassed, so the connector
**does not trust** that the inbound stream is already narrow. `subscribe(
'event.tracked', handler, config)` receives the node's `SegmentTriggerConfig`
(§6.4); on each **verified** delivery the connector runs the pure predicate
`eventMatches(config, ctx)` (`segment-normalize.ts`) **before** constructing a
`SeedEvent`:

- `ctx.event.type === (config.type ?? 'track')`, else **drop** (no run).
- for `track`: `ctx.event.name === config.event`, else **drop**.
- every `config.match` entry equals the corresponding `properties`/`traits`
  value, else **drop**.

A drop is silent and cheap — it starts **no run**, spawns **no session**, allocates
**nothing** beyond the parse. Only a full match becomes a `SeedEvent`. This is the
deterministic floor under Layer 1 — the lfguard posture (a deterministic guard, no
model in the loop) applied to event volume. It composes with, and runs *before*,
the engine's generic post-seed `matchesFilter` (`trigger-subscriber.ts:44-50`):
the connector filter keeps a run from *starting*; `matchesFilter` is a second,
generic net the author can add on top.

### 7.3 The one hard rule: a `track` subscription must name its event

An `event.tracked` trigger of `type: 'track'` with **no `event` name** is refused
at flow validation / subscribe time with a legible error — *"a Segment track
trigger must name an event (e.g. 'Subscription Downgraded'); an un-named track
filter is the whole firehose, which will overwhelm this machine."* This is the
single guardrail that makes the RAM ceiling structurally safe: you **cannot**
accidentally author the firehose. (`identify` may omit `event` — its volume is
inherently lower and bounded by distinct users; a `match` on traits is still
encouraged.)

### 7.4 Flagship loop — one connector, every product

**Scenario the author drew:** *"When a `Subscription Downgraded` event fires from
**any** source, wake a retention-risk agent to assess the account and draft a
save-offer — behind my approval before anything is sent."*

```
[trigger: event.tracked]        config = { type:'track', event:'Subscription Downgraded' }
        │  Segment Destination Filter forwards ONLY this event (Layer 1)
        │  webhook-receiver verifies X-Signature (SHA1 HMAC) → normalize
        │  connector eventMatches(config, ctx) === true (Layer 2) → SeedEvent
        │  context['t'] = SegmentEventContext { event:{ name, userId, properties:{ mrr, plan } } }
        ▼
[agent: assess retention risk]  reads event.userId + event.properties.mrr, forms a judgment
        ▼
[router]                        edge: field='t.event.properties.mrr', op='gte', value=500  (high-value → escalate)
        ▼
[gate: "approve save-offer"]    pauses run needs-you; human reviews in cockpit
        │  approved ─► [action: track "Save Offer Sent"]  (optional emit back into Segment, §6.2)
        │  rejected ─► run ends 'rejected' cleanly
```

The load-bearing point: that `Subscription Downgraded` event could originate from
**Stripe billing** (a Segment cloud source), an **in-app** downgrade button
(`analytics.js`), or a **mobile** settings screen (the iOS SDK) — all three arrive
through the *same* webhook in the *same* shape and fire the *same* trigger. **One
connector, every product surface.** The retention agent is written once and reacts
to a downgrade wherever it happens. Swap `Subscription Downgraded` for `Trial
Started`, `Cart Abandoned`, `Feature Flag Enabled`, or any of the company's
hundreds of tracked events and the same connector, unchanged, powers a different
worker.

---

## 8. Auth & keychain

- **Shared secret (the trigger).** The Segment Webhook destination signs each
  delivery with `X-Signature = hex(HMAC-SHA1(rawBody, sharedSecret))`. The user
  pastes the destination's shared secret into the descriptor's masked
  `sharedSecret` field; it goes straight to the keychain via `CredentialStore.set`.
  The receiver reads it at verify time via `revealForConnector('segment',
  'sharedSecret')` (main-process-only, the sole plaintext exit) and
  `timingSafeEqual`s the recomputed HMAC against the header. An empty secret is
  refused outright (the shared receiver already rejects an empty-key HMAC as
  forgeable).
- **Write key (the optional emit).** Stored the same way (`writeKey`), used only
  inside `segment-client` as the HTTP **Basic-auth username** on the Tracking API
  request. Read at call time via `revealForConnector('segment', 'writeKey')`.
  Never placed in a URL, a log, or context.
- **Honoring the global secret rule.** Neither secret is **ever** written to
  `config.json`, `sessions.json`, the transcript, a log, a PR body, or any IPC
  payload. `config.json` holds only **references** (environment, webhook path/url,
  data-plane region). Secret **state** (present / decrypt-failing) may be surfaced
  via `status()`; the **value** never is. This is the hub's existing discipline
  applied to Segment verbatim.
- **Disconnect.** Clearing `sharedSecret` (the hub's `clearSecret`) flips
  `status()` to `needs-config`; the connector stops seeding runs and the Webhook
  destination can be deleted in Segment. `clear('segment')` (no field) wipes every
  `segment:*` key via the existing prefix match — the right full teardown.

---

## 9. Authority & safety

**Primary control — the flow's gates (already enforced).** The two write actions
(`track`, `identify`) are `action` nodes; a `gate` node the author places before a
write pauses the run `needs-you`. The engine already implements this — a gate the
author drew is honored, a human "no" ends the run `rejected` (not a failure), and a
write with no path to it never runs. **The connector never emits outside the graph
the author drew.** There is no "connector default policy" that fires a `track` on
its own — the connector only emits when an `action` node invokes it, and it only
seeds a run on a hard-filter match.

**The hard filter is a deterministic floor (§7.2).** Beyond authoring authority,
the pre-seed filter is a resource-safety floor: even a mis-authored flow cannot
spawn unbounded runs, because a track trigger *must* name its event (§7.3) and the
connector drops every non-match before allocating a run. This is the lfguard
posture applied to volume — a deterministic guard, no model in the loop.

**Emit fans out — treat it as amplified.** A `track`/`identify` into Segment
reaches *every* downstream destination. The gate is therefore not optional
politeness; it is the control on an amplified side effect. This is a reason the
write surface is flagged for a deliberate ship decision (§13.2).

**Never render secrets.** The shared secret and write key live in the keychain; no
error message, log line, or context field ever contains either (§8, §11).

---

## 10. Conditions dependency (owned elsewhere — named, not designed)

The pinned context fields (§6.5) are **designed to be referenced** by the typed
`FlowEdgeCondition` operators the sibling conditions track owns
(`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`contains`/`exists`/`truthy`): `event.name` and
`event.type` as strings for `eq`/`ne`; `event.properties.*` / `event.traits.*` as
their native JSON types so a numeric `mrr` drives `gte` and a string `plan` drives
`eq`/`contains`; `userId`/`anonymousId` coerced to strings so `exists` is stable.
**This spec does not design the condition system** — it only guarantees its field
types are the ones those operators expect, normalized once in `segment-normalize.ts`
so the types are stable at condition-eval time. The dependency is one-directional.

---

## 11. Error handling

localflow's principle (error-message-style memory; `credential-store.ts`,
`action-runner.ts`): **every failure is human-readable, actionable, and carries
the real underlying cause. No silent catch. No bare "failed" / "not found".** An
action signals failure by **rejecting**; the action-runner prefixes it with the
node/action and surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook X-Signature invalid** | signature mismatch (never the body or secret) | Receiver `console.warn` **route + reason only**; 401; **no run started**. Mirrors the Shopify/Linear receiver discipline. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | Receiver 4xx; dropped; **no run**. Never seeds on unvalidated shape. |
| **Event filtered out (§7)** | *(expected, not an error)* | Silent drop; no run, no log spam. This is the RAM-ceiling control working as designed. |
| **`status('segment') !== 'connected'`** | the derived reason (missing shared secret / decrypt error / disabled) | The action-runner fails a `segment` node *before* any call: "Flow needs Segment connected — connect it in Settings." |
| **Write attempted with no `writeKey`** | the missing keychain key | `invokeAction` **rejects**: "This Segment track/identify action needs a source write key — none is stored. Add it in Settings, or remove the emit." (per-capability readiness, §5). |
| **Write key rejected (HTTP 401)** | Segment's auth error | Rejects: "Segment rejected the write key (401) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Tracking API 4xx (bad payload)** | Segment's error body (bounded, secret-scrubbed) | Rejects: "Segment refused the track call — `<reason>` (check the event name / properties)." Never a silent no-op. |
| **Tracking API 5xx / transport error** | the status or Node error code (`ENOTFOUND`/`ETIMEDOUT`) via `{ cause }` | Rejects: "Couldn't reach the Segment Tracking API (`<code>`) — check connectivity and `dataPlaneUrl`." |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "Segment webhook URL '<url>' is unreachable — no events will arrive." Never a silent dead trigger. Note: events are **lost** at Segment's retry boundary while down (§1 out-of-scope: no replay in MVP). |
| **Un-named track filter** (§7.3) | the offending trigger node | Refused at validate/subscribe: "A Segment track trigger must name an event — an un-named track filter is the whole firehose." Never subscribes the firehose. |

The connector **never** catches-and-drops a *failure* (a filtered-out event is not
a failure), and **never renders a secret** — no error, log, or context field ever
contains the shared secret, the write key, or the raw signed body.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Segment workspace**, matching localflow's seams (pure
modules, injected transport, fixture deliveries):

- **`segment-normalize.ts` unit tests (the correctness + filter boundary — guarded
  hardest).** Pure functions: assert a raw `track`/`identify` body →
  `SegmentEventContext` (type, name, userId/anonymousId coercion,
  properties/traits preserved, sparse/garbage → safe defaults); and assert
  `eventMatches(config, ctx)` for the full matrix — type mismatch drops, name
  mismatch drops, `match` mismatch drops, exact match passes, an un-named track
  config is refused.
- **`segment-webhook-server` unit tests** — feed fixture Segment bodies with
  **valid and invalid X-Signature** (hex HMAC-SHA1), oversized bodies, and
  malformed JSON; assert 200 / 4xx / 401 and that only a valid+signed delivery
  produces a `SegmentWebhookDelivery`. Reuses the shared receiver's boundary-test
  approach; a dedicated test asserts the SHA1 verifier is wired
  (`algo:'sha1', encoding:'hex'`).
- **A signature test (pinned by the task).** A focused test that computes
  `hex(HMAC-SHA1(body, secret))`, sets it as `X-Signature`, and asserts the shared
  `verifyWebhookSignature` accepts it and rejects a one-byte-mutated body and an
  empty secret — the security invariant, isolated.
- **`MockSegment` seam.** `segment-client.ts` is written *against* a `SegmentApi`
  interface (`track`, `identify`); tests inject a **`MockSegment`** returning
  canned success / 401 / 4xx / transport-throw. **No test performs a live Segment
  call**; CI has no Segment credentials. (Same posture as `MockShopifyApi`.)
- **`segment-connector` dispatch + filter tests** — with a `MockSegment` + a fake
  registry: assert a matching delivery seeds exactly one `SeedEvent` and a
  non-matching delivery seeds **none** (the RAM-ceiling guarantee); assert
  `invokeAction('segment','track',…)` resolves the `messageId`, and a 401
  **rejects** with the verbatim message; assert a write with no `writeKey` rejects
  before the mock is called.
- **Engine integration test (offline)** — wire the real `FlowEngine` + registry +
  the Segment connector over a `MockSegment`, drive §7.4: inject a
  `Subscription Downgraded` delivery → assert the trigger seeds a run and writes
  `event.properties` to context → assert the router selects the high-`mrr` edge →
  assert the gate pauses `needs-you`; inject a non-matching event → assert **no run
  starts**. Deterministic via the engine's injected `now()`.
- **Token-store / secret-rule test** — `revealForConnector` round-trip via a fake
  `SecretBackend`; a regression guard asserts **no shared-secret or write-key value
  appears** in any emitted log/console/error string.
- **Snapshot test on `segmentDescriptor`** — pins the `event.tracked` trigger id
  and the `track`/`identify` action ids the palette + templates track consume.

No test requires Segment credentials or a live workspace; the real surfaces are
exercised only in manual dogfooding.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **The firehose / volume filter — where and how hard.** §7 filters in two
   layers (Segment-side filters + a connector pre-seed filter). Open questions
   for the RAM ceiling: (a) should the connector additionally enforce a **local
   rate cap** (e.g. drop / coalesce past N seeded runs per minute) as a last-ditch
   floor if a mis-configured Segment filter still lets a flood through? (b) should
   `match` support ranges/contains (not just exact) at the pre-seed layer, or is
   exact-match enough and richer narrowing left to edge conditions post-seed?
   **Recommendation:** ship exact-match §7.2 + the un-named-track refusal (§7.3)
   for MVP; add a local rate cap in phase 2 once real volume is observed. This is
   the connector's defining risk, so it is flagged first.
2. **Is a write surface even needed?** Segment is an ingest platform; the flagship
   (§7.4) is trigger-only, and a `track`/`identify` emit fans out to every
   downstream destination (a big, amplified side effect). Options: (a) ship
   trigger-only for MVP, add the write later if dogfooding wants it; (b) ship the
   gated write from day one for the "emit a `Save Offer Sent` back into Segment"
   loop. **Recommendation:** ship **trigger-only** MVP (leave the `track`/`identify`
   design in place but unbuilt), decide the write after the trigger earns its keep.
   The `writeKey` field is already optional (§5) so this costs nothing to defer.
3. **One trigger vs per-type triggers.** MVP pins a single `event.tracked` covering
   `track` + `identify` via `config.type`. Open: whether the palette should later
   expose distinct `user.identified` / `page.viewed` / `screen.viewed` trigger ids
   for discoverability. **Recommendation:** keep one id for MVP (minimal contract,
   the source multiplier works), add per-type ids as sugar (§14) if authors find
   the single id unclear.
4. **Webhook vs Function ingress.** Segment offers both a Webhook (Actions)
   destination and a destination Function to forward events. Both sign / can be
   made to sign compatibly; the Function gives finer server-side filtering (Layer
   1). **Recommendation:** document the **Webhook destination + Destination
   Filters** as the default onboarding path (simplest), note the Function as the
   power-user Layer-1 option. A docs/onboarding call, not a code fork.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton") — trigger-only

**One source, one hard-filtered trigger, no write, happy path:**

1. `IntegrationId` gains `'segment'` (+ the three lockstep touch-points, §6.0);
   `segmentDescriptor` added to `DESCRIPTOR_DEFS`; `status('segment')` derives from
   config + keychain presence (free from the hub).
2. `sharedSecret` + `environment` stored (secret → keychain);
   `status('segment') === 'connected'`.
3. `segment-webhook-server.ts` — the thin wrapper over `startWebhookReceiver` with
   the SHA1 verifier (`x-signature`, hex HMAC-SHA1), behind a dev tunnel, emitting
   a `SegmentWebhookDelivery`.
4. `segment-normalize.ts` — raw event → `SegmentEventContext` + the pure
   `eventMatches` filter (§7.2); the un-named-track refusal (§7.3).
5. `registry.registerConnector('segment', segmentConnector)` (§4.3):
   `subscribe('segment','event.tracked', handler, config)` reaches the connector,
   which filters hard and seeds only matches.
6. On the canvas: `[event.tracked (Subscription Downgraded)] → [agent] → [gate]`
   runs end-to-end (§7.4). Errors per §11. Onboarding copy tells the user to add a
   Segment **Destination Filter** for the event (Layer 1).

That slice proves the multiplier (a real event from any upstream source wakes a
real flow) and the RAM-ceiling defense (a non-matching firehose seeds nothing),
and is dogfoodable against a Segment workspace + a dev source.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton — trigger-only, `event.tracked`, the
  two-layer hard filter, X-Signature SHA1 verification, offline tests. Dev tunnel
  ingress.
- **Phase 2 — volume hardening:** a local rate cap / coalesce floor (§13.1) once
  real volume is observed; richer `match` if needed. The load-bearing follow-up
  for the 8 GB ceiling.
- **Phase 3 — the write surface (if §13.2 says yes):** `track` / `identify` via
  `segment-client` (`SegmentApi` + `MockSegment`), write-key Basic auth, region
  `dataPlaneUrl`, gated per §9. Ships the "emit back into Segment" loop.
- **Phase 4 — per-type triggers + Profiles read (sugar):** distinct
  `user.identified` / `page.viewed` ids (§13.3); an optional Profiles/Unify read
  action for trait enrichment.
- **Phase 5 — product fork:** the hosted webhook relay consuming
  `segmentWebhookBinding` (§4.4) — durable delivery, no user tunnel. Changes
  distribution, not the connector's verification or dispatch.

---

## Appendix — reused localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `LiveConnector` / `registerConnector` contract; `IntegrationId` (edited, §6.0);
  `IntegrationStatus`; the already-pinned `subscribe(…, config?)` filter seam.
- `src/main/integrations/integration-registry.ts` —
  `registerConnector('segment', …)` (§4.3); `deriveStatus` gives `segment` its
  status; the config-forwarding `subscribe` (`:90-103`).
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain;
  `revealForConnector('segment', …)` (main-only plaintext exit); `clear('segment')`
  teardown via prefix match.
- `src/main/integrations/descriptors/index.ts` — `DESCRIPTOR_DEFS` gains `segment`.
- `src/main/flow/trigger-subscriber.ts` — `subscribe` seeds runs; `coerceEvent`;
  `matchesFilter` (the generic post-seed net the connector's pre-seed filter
  complements, §7.2).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called, the
  **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/context.ts` — `resolveField` / `selectEdges`: dotted-path reads
  (`event.properties.mrr`) + boolean routing over the pinned fields.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0).
- **`src/main/webhooks/webhook-receiver.ts`** (sibling-owned) — the parameterized
  receiver; its existing `algo:'sha1'` HMAC path is the X-Signature verifier (§4.2).
- **`src/main/hosted/webhook-bindings.ts`** (sibling-owned) — the hosted binding
  the phase-5 relay consumes (§4.4).
- `guard/` (lfguard) — the deterministic-guard *posture* the two-layer hard filter
  borrows (a resource floor under the author's authoring, no model in the loop).
