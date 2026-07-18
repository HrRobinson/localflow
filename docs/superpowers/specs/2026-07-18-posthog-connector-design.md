# PostHog Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Feasibility is **DONE** (see the product-
automation research, summarized in §2). Design-approval gate for the
**product-analytics worker** direction: a connector whose triggers are
**product-analytics signals** (a new event matching a filter, a person entering a
cohort, an insight crossing a threshold) that wake a flow. PostHog is chosen first
because it is the **OSS-affine** analytics surface — MIT/open-core, self-hostable
in one binary — which fits localflow's own local-first, open-core identity.
**Feature:** A **PostHog connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. A product signal **triggers** a run (by a **polled read**,
not a webhook — see §7), the flow **reads** analytics state via PostHog's Query /
Insights / Cohorts / Feature-Flags APIs, routes on those facts via edge
conditions, and — behind gates the author places — performs one thin, real
**gated write** (`updateFeatureFlag`, e.g. roll a bad flag back). Authority lives
in the flow the author drew, exactly as the engine enforces.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and copies the live-dispatch module shape of the just-landed Shopify and
WooCommerce connectors (`src/main/{shopify,woocommerce}/`). It uses the Shopify,
WooCommerce, Linear, and **email** connector specs as its style and depth template
(`docs/superpowers/specs/2026-07-17-{shopify,woocommerce}-connector-design.md`,
`2026-07-16-{linear-integration,email-execution}-design.md`).

**A note on the key design point.** Unlike the ecom siblings (webhook-primary) and
Linear (webhook-primary), **PostHog's trigger backbone is a POLL/reconcile read,
not a webhook.** The connector models its trigger loop directly on the **email
connector's reconcile poll** (`src/main/email/provider.ts` `reconcile(account,
cursor)` + a persisted opaque cursor + a periodic fallback poll). That is the load-
bearing design decision of this spec (§7). PostHog's realtime **Actions /
Destinations** webhooks are an **optional augment** (YELLOW / cloud-ingress), not
the MVP path (§7.5, §13).

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user assemble, on the canvas, a
product-analytics worker that wakes when a PostHog signal appears — a new event
matching a filter, a person entering a churn-risk cohort, or an insight crossing a
threshold — reads the relevant analytics facts through PostHog's REST/Query API,
routes on them, and behind an author-placed gate performs the one real product
action the loop needs (roll a feature flag back) — with the **personal API key in
the OS keychain, never rendered**, and the user-supplied **host validated by the
shared SSRF guard** before any request.

### In scope (MVP)

- A new **`posthog` integration** satisfying the pinned `IntegrationDescriptor`
  (`src/shared/integrations.ts`; `IntegrationId` gains `'posthog'`), authored as a
  descriptor def in `src/main/integrations/descriptors/posthog.ts` and added to
  `DESCRIPTOR_DEFS` — mirroring `woocommerce.ts` placement exactly.
- **Live dispatch** — a connector module set under `src/main/posthog/` that
  provides the real `invokeAction`/`subscribe` behavior the registry delegates to
  for id `'posthog'` (the `LiveConnector` seam, `registerConnector('posthog', …)`
  in `src/main/index.ts`), exactly as `ShopifyConnector` / `WoocommerceConnector`
  already do.
- **The POLL trigger backbone (§7).** `subscribe(triggerId, handler)` starts a
  **periodic reconcile poll** (injected clock) that queries PostHog for signals
  since a **persisted cursor**, dedups, and fires `handler` once per new signal.
  Modeled on `email/provider.ts` `reconcile` + `MailboxCursor`. This is the
  primary — and in MVP the **only** — trigger ingress.
- **Read actions** (pull, no gate): `queryEvents`, `getInsight`, `getFeatureFlag`,
  `getCohort`.
- **One gated write:** `updateFeatureFlag` — a real product action (change
  rollout %, enable/disable), gated by an author-placed `gate` node. Thin by
  design: the loop's whole point is *reading a signal and, with human approval,
  turning a flag down*.
- **Triggers (polled):** `event.matched`, `cohort.entered`, `insight.threshold`
  (§6.1) — each backed by a poll strategy in §7, not a webhook.
- **Auth:** a **personal API key** (`phx_…`) — **secret → keychain**; a **project
  API key** (`phc_…`) — **non-secret config** (it identifies the project, it is the
  public client key, it is not a secret); and a single **`host`** field
  (cloud-US / cloud-EU / self-host in one field) — **non-secret**, but
  **user-supplied → runs through the shared SSRF guard** on every request.
- **Config-as-code** `posthog` block in `config.json` (non-secret refs only:
  `projectApiKey`, `host`, `environment`, poll cadence); the personal API key lives
  in `safeStorage` via `CredentialStore`, **never** in config.json / a log / IPC /
  the transcript / a PR body.
- **Authority = the flow's gates.** `updateFeatureFlag` runs only because an
  action node was reached behind whatever gate the author drew; the connector never
  mutates on its own (§10).

### Out of scope (MVP) — explicitly deferred

- **PostHog realtime webhooks (Actions / Destinations / CDP).** PostHog *can* push
  on an action match to a webhook destination — the same cloud-ingress shape
  Shopify/Linear/Woo confront. It is a **phase-2 augment** (lower latency for
  `event.matched`), not the backbone. MVP is poll-only; the poll already covers
  every trigger with no public ingress to run (§7.5, §13.2).
- **Writes beyond `updateFeatureFlag`.** No creating insights/cohorts/annotations,
  no capturing events, no dashboard edits. The one real mutation the loop needs is
  the flag roll-back; everything else is read.
- **Multi-project / multi-environment fan-out.** The config/cursor shapes are drawn
  so a `projects: [...]` array is the additive path (§7.2, §14), not built now.
- **Session-recording / experiment / group-analytics surfaces.** Out of the MVP
  read set; addable behind the same `PostHogApi` seam later.
- **The richer edge-condition operators** (`gt`/`gte`/`contains`/…). Owned by the
  sibling flow-conditions track (`src/shared/flows.ts`,
  `docs/superpowers/specs/2026-07-17-flow-conditions-design.md`); this spec only
  guarantees its context fields are typed to be referenced by them (§6.3).

---

## 2. Feasibility + landscape (feasibility DONE — summarized)

Feasibility is complete; this section records the verdict the build assumes.

### 2.1 Why PostHog first — the OSS-affinity argument

| Platform | Trigger posture for signal→read→act | OSS / self-host | Verdict |
|---|---|---|---|
| **PostHog** | Rich **query surface** (HogQL Query API, Insights, Cohorts, Feature Flags) over a stable REST API; **personal API key** auth (scopable read/write); realtime destinations exist but are an augment. No first-class "new event" webhook you'd lean on — but the **query API makes polling trivial and precise**. | **MIT / open-core, self-hostable in one deployment.** Cloud-US, cloud-EU, or a user's own box — all the *same REST API*, differing only by base URL. | **Chosen.** Best OSS fit for localflow's identity; the poll→read→act loop is buildable today. |
| Amplitude / Mixpanel | Capable query + cohort APIs, webhooks/CDP on some tiers. | Closed SaaS. | Deferred. Good *peer* connectors under the same boundary; no OSS story. |
| Segment (as a signal source) | Strong event routing / webhooks. | Closed SaaS; a *pipe*, not an analytics store you query. | Deferred; different shape (push router, not a queryable store). |

**PostHog-first rationale:** it is the analytics surface whose **open-core,
single-`host`, self-hostable** posture matches localflow/OpenClaw's local-first
identity; its **queryable** API makes a precise, low-infrastructure **poll** the
natural trigger backbone (no public ingress required — a real advantage for a
desktop app); and one `host` field covers cloud-US, cloud-EU, and self-host
uniformly, so the connector is deployment-agnostic by construction.

### 2.2 The PostHog API for poll → read → act (verified during feasibility)

- **Auth.** A **personal API key** (`phx_…`) sent as `Authorization: Bearer <key>`
  authenticates the REST/Query API. Personal keys can be **scoped** (per-resource
  read/write) — the MVP recommends a key scoped **read** on query/insights/cohorts/
  feature-flags and **write** only on feature-flags (least privilege for the one
  mutation). The **project API key** (`phc_…`) is the *public* client/ingest key —
  **not a secret** — used only to identify the project; it lives in config.json.
- **Read / query.**
  - **Events:** the **Query API** (`POST /api/projects/:id/query/`, HogQL) returns
    events filtered by properties and — crucially for the poll — by a `timestamp >
    <cursor>` predicate with a stable order. Covers `queryEvents` and the
    `event.matched` poll.
  - **Insights:** `GET /api/projects/:id/insights/:id/` returns a computed insight
    (a trend/number). Covers `getInsight` and the `insight.threshold` poll.
  - **Cohorts:** `GET /api/projects/:id/cohorts/:id/` + the cohort's persons list
    return current membership. Covers `getCohort` and the `cohort.entered` poll
    (diff membership against the last-seen set).
  - **Feature flags:** `GET /api/projects/:id/feature_flags/:id/` reads a flag's
    definition/rollout. Covers `getFeatureFlag`.
- **Act.** `PATCH /api/projects/:id/feature_flags/:id/` updates a flag (`active`,
  `rollout_percentage` / filter groups). Covers the single gated `updateFeatureFlag`.
- **Host.** Cloud is `us.posthog.com` / `eu.posthog.com`; self-host is any URL the
  user runs. **All three speak the same REST API** — the only difference is the base
  URL, which is exactly why one `host` field suffices. Because that field is
  **user-supplied**, a mistyped/hostile value could target loopback / RFC-1918 /
  link-local (`169.254.169.254` metadata) — so every request passes the **shared
  SSRF guard** first (§4.4, §8).
- **Realtime push (the augment).** PostHog **Actions → Destinations** (CDP /
  webhooks) can post on a matched action — the same HMAC/cloud-ingress shape as the
  ecom siblings. Useful later to cut `event.matched` latency, but it needs a public
  URL a desktop app can't cheaply host, so it is **not** the backbone (§7.5).

### 2.3 Verdict

- **Read + POLL trigger + the one gated write: GREEN.** Every read the loop needs
  is a GA REST/Query endpoint; polling with a `timestamp`/membership/insight cursor
  is precise and needs **no ingress**; `updateFeatureFlag` is a documented PATCH.
- **Webhook augment: YELLOW (deferred).** Destinations exist but carry the
  cloud-ingress cost (public URL + HMAC verify) the siblings already priced; not
  needed for MVP because the poll covers all three triggers.

The one honest cost: **poll latency** (a signal is seen at the next poll tick, not
instantly) and **query-cost budget** on busy projects — both bounded by the
cadence knob (§7.3) and addressed by the optional webhook augment for the one
latency-sensitive trigger later.

---

## 3. The core loop → PostHog primitives

localflow's product-analytics loop is `signal → read → route → gate → act`. Each
stage maps to a concrete PostHog primitive and the concrete flow-engine mechanism
that runs it:

| Stage | PostHog primitive | localflow / flow-engine mechanism |
|---|---|---|
| **signal (trigger)** | A **polled read**: new events since a timestamp cursor (`event.matched`), new cohort members since a membership snapshot (`cohort.entered`), or an insight value crossing a threshold (`insight.threshold`). **No webhook in MVP.** | `posthog-poller` runs a cadence timer (injected clock) → queries `posthog-api` since the persisted cursor → normalizes each new signal to a `SeedEvent` → the connector's `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context (`trigger-subscriber.ts` `coerceEvent`/`matchesFilter`, `flow-engine.startRun`). |
| **read** | Query API / Insights / Cohorts / Feature-Flags GET. | An `action` node (`queryEvents`/`getInsight`/`getFeatureFlag`/`getCohort`) → `registry.invokeAction('posthog', ref, params)` → the connector calls `posthog-api` → **resolves** the normalized result, which the action-runner writes to context under the node id (`action-runner.ts`). |
| **route** | *(none — pure localflow)* | `selectEdges` evaluates edge conditions over the context the read wrote (`context.ts`). Today `eq`; soon the typed `FlowEdgeCondition` operators (sibling-owned) over e.g. `insight.value`. **No LLM decides routing** — deterministic value compares. |
| **gate** | *(none — pure localflow)* | A `gate` node the author placed pauses the run `needs-you`; a human approves in the cockpit. The mutation node sits **downstream of the gate the author drew** (`flow-engine.ts` gate handling; a human "no" ends the run `rejected`, not failed). |
| **act** | `PATCH …/feature_flags/:id/`. | The gated `updateFeatureFlag` action node → `invokeAction` → `posthog-api` PATCH. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* PostHog error. |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities* (four reads, one gated write, three polled triggers); the
*flow* decides which run, in what order, behind which gates. That is the whole
point of the product-analytics-worker direction: not a hardcoded incident
pipeline, but a worker the user assembles with the authority they choose.

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/posthog/`, peer of
`src/main/shopify/` and `src/main/woocommerce/`, plus a descriptor def in
`src/main/integrations/descriptors/posthog.ts`. It is **opt-in**: with no `posthog`
config entry (and no stored personal API key) `status('posthog')` returns
`needs-config` and the action-runner refuses any PostHog node before any network
call — localflow's "works with no integration" guarantee is unchanged.

The connector is the **live implementation behind the registry's pinned
`invokeAction` / `subscribe`**, registered via `registerConnector('posthog', …)`
in `src/main/index.ts` exactly as Shopify/WooCommerce are today
(`integration-registry.ts` delegates to the registered `LiveConnector`; an id with
no connector keeps the legible "no live connector wired" reject). All PostHog API
shapes are isolated in `posthog-api.ts` (the blast radius for any API change),
exactly as Woo isolated its REST in `wc-api.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/integrations/descriptors/posthog.ts` | The static `IntegrationDescriptorDef` (`id: 'posthog'`, config fields of §5, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS` (`descriptors/index.ts`). A snapshot test guards the trigger/action ids. Mirrors `descriptors/woocommerce.ts`. |
| `src/main/posthog/posthog-connector.ts` | The `LiveConnector` orchestrator. `invokeAction(actionId, params)` → the right `posthog-api` call (reject-on-failure, `requireId`-style param guards like `WoocommerceConnector`). `subscribe(triggerId, handler)` → **registers a poll subscription with `posthog-poller`** and returns an unsubscribe that stops it. Owns the action-dispatch table; **never auto-mutates** (§10). |
| `src/main/posthog/posthog-poller.ts` | **The POLL/reconcile trigger backbone (§7).** Per active subscription: a cadence timer (injected clock), a **persisted cursor**, the query strategy for its trigger id, **dedup**, and the `handler(SeedEvent)` fan-out. Announces degradation (a failed poll) loudly, never silently stops. Directly modeled on `email/watch-receiver.ts`'s reconcile poll + `email/provider.ts` `reconcile(cursor)`. |
| `src/main/posthog/posthog-cursor-store.ts` | Persists each subscription's cursor (last event timestamp+uuid / cohort membership snapshot / last insight value) to a sidecar so a **restart resumes without missing or re-firing** (the email `mailbox-registry` cursor persistence, §7.4). Non-secret; no analytics payload retained beyond the cursor. |
| `src/main/posthog/posthog-api.ts` | Thin REST/Query client. **All** PostHog request/response shapes live *only* here. Every request URL passes the **shared SSRF guard** (`src/main/net/ssrf-guard.ts`) before dialing (§4.4). Bearer-auth from `revealForConnector`. Isolated behind a `PostHogApi` interface so tests inject a `MockPostHogApi` (§12). |
| `src/main/posthog/posthog-normalize.ts` | **Pure** mapping: a raw PostHog event / insight / cohort / flag → the pinned **context-field shape** (§6.3); and a raw polled signal → a `SeedEvent`. Unit-testable in isolation (mirrors `wc-normalize.ts` / `status-map.ts` purity). Where property→typed-field normalization happens **once** so conditions read a stable shape. |
| `src/main/posthog/posthog-webhook-server.ts` | **DEFERRED augment (§7.5).** The Actions/Destinations HMAC ingress, mirroring `wc-webhook-server.ts`. Not built in MVP; named so the poll-vs-push seam is explicit. |
| `src/shared/posthog.ts` | Shared types (`PostHogEventContext`, `PostHogInsightContext`, `PostHogCohortContext`, `PostHogFeatureFlagContext`, the action param + trigger payload shapes) needed by main and any renderer palette surface. No I/O. |

### 4.3 Wiring the live dispatch into the registry

Identical seam to Shopify/WooCommerce — no contract change:

- `posthog-connector.ts` implements the pinned `LiveConnector`
  (`invokeAction(actionId, params): Promise<unknown>`, `subscribe(triggerId,
  handler): () => void`).
- `src/main/index.ts` constructs the `PostHogConnector` (given a `PostHogApi`
  bound to the `CredentialStore` reveal + a real HTTP transport, and a
  `PostHogPoller` given the injected clock + cursor store) and calls
  `integrationRegistry.registerConnector('posthog', connector)`.
- Per the current Shopify/Woo pattern, the **live HTTP transport + credential
  reveal binding may ship DEFERRED** (a `deferred…` transport that rejects loudly)
  while the descriptor, normalizer, poller, and mock-tested dispatch land first.

This keeps the pinned `IntegrationRegistry` contract **byte-for-byte unchanged**
and localizes every PostHog concern under `src/main/posthog/`.

### 4.4 The SSRF-guarded host (shared infra)

`host` is user-supplied and the connector makes **outbound** requests to it, so —
exactly as WooCommerce does for its self-hosted `storeUrl` — every request passes a
pure host validator **before** the call. This connector uses the **shared** guard
at **`src/main/net/ssrf-guard.ts`** (the promotion of WooCommerce's `wc-ssrf.ts`
into shared infra, so PostHog and Woo share one audited implementation rather than
each re-deriving RFC-1918/loopback/link-local logic):

- **HTTPS only** for cloud; reject embedded credentials (`https://user:pass@host`).
- **Block private/loopback/link-local targets** by literal and by **resolved IP**
  (`127/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. the
  `169.254.169.254` metadata endpoint, `fc00::/7`, `fe80::/10`) — the exact ranges
  `wc-ssrf.ts` already enforces (`checkStoreUrl` + `blockedIpRange`).
- **Pin the validated IP** so a DNS-rebinding flip between validate and connect
  can't redirect to a private IP (validate the IP actually dialed).
- **Self-host caveat (open decision §13.3):** a self-hosted PostHog on a LAN/
  `localhost` is a *legitimate* target that the strict guard would block. So — unlike
  Woo, where a private store is always suspect — PostHog needs an explicit
  `allowInsecureLocalHost` opt-in (default off) for a self-host-on-LAN dogfood.
  The guard stays hard-block by default; the opt-in is the reviewed escape hatch.

### 4.5 Reused localflow surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / **`LiveConnector`** / `IntegrationDescriptorDef` this
  connector satisfies; `IntegrationId` + `INTEGRATION_IDS` (edited, §6.0);
  `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain; the
  personal API key is read main-process-only via
  `revealForConnector('posthog','personalApiKey')` (the sole plaintext exit,
  grep-asserted to have no IPC/renderer caller); `decryptionError` feeds `status()`.
- `src/main/integrations/integration-registry.ts` — `registerConnector` +
  `invokeAction`/`subscribe` delegation; `deriveStatus` gives PostHog its status
  for free from config + credential presence.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary parsing
  of the non-secret `posthog` block (secrets dropped-with-notice).
- `src/main/net/ssrf-guard.ts` — the shared host guard (§4.4), promoted from
  `wc-ssrf.ts`.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, and how the resolved value lands in context;
  the not-`connected` refusal before any call.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs;
  `coerceEvent` / `matchesFilter` the polled `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`insight.value`) + boolean routing over the pinned fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling, and the
  **injected `now()`** (`deps.now ?? Date.now`) — the same injected-clock seam the
  poller reuses for deterministic cursor tests (§7, §12).
- `src/main/email/provider.ts` + `watch-receiver.ts` + `mailbox-registry.ts` — the
  **reconcile-poll + persisted-cursor + degradation-announced** pattern §7 is
  modeled on.
- `src/main/{shopify,woocommerce}/*-connector.ts` — the `LiveConnector`
  dispatch-table + `requireId` param-guard + reject-on-failure style copied.

---

## 5. The connector as an `IntegrationDescriptor`

The static half is `posthogDescriptor: IntegrationDescriptorDef` in
`descriptors/posthog.ts`, added to `DESCRIPTOR_DEFS`. The registry attaches the
presence-derived `status()` (`connected` | `needs-config` | `error` | `disabled`)
exactly as it does for the others — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `personalApiKey` | PostHog personal API key | **yes** | yes | string | `Authorization: Bearer`. Keychain only. Placeholder `phx_…`. Recommend a **scoped** key: read on query/insights/cohorts/feature-flags, write only on feature-flags. |
| `projectApiKey` | Project API key | no | yes | string | `phc_…` — the **public** project key. Identifies the project; **not a secret**. Non-secret ref in config.json. |
| `host` | PostHog host | no | yes | string | Cloud-US `https://us.posthog.com`, cloud-EU `https://eu.posthog.com`, or a self-host URL. **User-supplied → SSRF-guarded** (§4.4). Placeholder `https://us.posthog.com`. |
| `pollSeconds` | Poll cadence (seconds) | no | no | number | Trigger poll interval; defaults to a pinned value in `posthog-poller.ts` (§7.3). |
| `environment` | localflow environment (1-9) | no | yes | number | Which env hosts PostHog work (same field/validation as the other connectors). |

`status('posthog')` reports `needs-config` until `personalApiKey`, `projectApiKey`,
`host`, and `environment` are all present; `error` if the stored key can't be
decrypted (the hub's `decryptionError` path) or `host` fails the SSRF guard;
`disabled` if configured-but-turned-off; `connected` otherwise. The action-runner
refuses any non-`connected` PostHog node before any network call.

> **Project id note.** PostHog's REST paths are `/api/projects/:id/…`. The numeric
> project id is **resolved once** from the `projectApiKey` (via `GET
> /api/projects/@current`) and cached in the cursor sidecar — it is not a separate
> user-entered field, keeping the pinned config surface to the three the research
> named (personal key + project key + host).

---

## 6. Pinned vocabulary (verbatim — the palette / templates track consumes this)

> **This section is the contract.** The canvas palette and any templates track read
> these ids and this field shape verbatim. A snapshot test in `descriptors/posthog.ts`
> guards the ids; the field shape is guarded by the `posthog-normalize.ts` tests.

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'posthog'`:

```ts
export type IntegrationId =
  'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'posthog'
```

This is a **shared-union edit** with three companion touch-points that must move in
lockstep (each a one-line add): `INTEGRATION_IDS` (the stable order array,
`integrations.ts`), the `INTEGRATION_IDS` set in `flow-model.ts` (the flow
validator's allow-list), and `DESCRIPTOR_DEFS` (`descriptors/index.ts`). No other
`IntegrationId` consumer needs a change — they iterate the array.

### 6.1 Triggers (POLLED — not webhooks; see §7 for each poll strategy)

| trigger id | label | polled source | poll strategy (§7) |
|---|---|---|---|
| `event.matched` | New event matched a filter | Query API events since a **timestamp+uuid** cursor, filtered by the trigger node's event name / property filter. | §7.2a — timestamp cursor + uuid tie-break dedup. |
| `cohort.entered` | Person entered a cohort | The cohort's current membership vs the **last-seen membership snapshot**. | §7.2b — set-diff dedup (fire once per newly-present person). |
| `insight.threshold` | Insight crossed a threshold | The insight's computed value vs the trigger node's configured threshold + the **last value** (edge-cross, not level). | §7.2c — fire on the *crossing*, not every poll above the line. |

Each trigger node carries the trigger-specific config (the event name/filter, the
cohort id, or the insight id + threshold + direction) via the flow node's
`config`, which the poller reads when it registers the subscription.

### 6.2 Actions

**Read (no gate — pure reads write facts for conditions):**

| action id | label | PostHog endpoint | writes to context |
|---|---|---|---|
| `queryEvents` | Query events | `POST /query/` (HogQL) | `{ events: PostHogEventContext[]; count }` |
| `getInsight` | Get an insight | `GET /insights/:id/` | `PostHogInsightContext` (§6.3) |
| `getFeatureFlag` | Get a feature flag | `GET /feature_flags/:id/` | `PostHogFeatureFlagContext` (§6.3) |
| `getCohort` | Get a cohort | `GET /cohorts/:id/` | `PostHogCohortContext` (§6.3) |

**Gated write (the author places a gate before this):**

| action id | label | PostHog endpoint | note |
|---|---|---|---|
| `updateFeatureFlag` | Update a feature flag | `PATCH /feature_flags/:id/` | Change `active` and/or `rollout_percentage` / filter groups. The **real product action** — e.g. roll a bad flag back to 0% or disable it. Gated. |

**Failure convention (pinned):** an action that fails **rejects** its promise with
the real PostHog error text; a resolved promise (any value, incl. `undefined`) is
success and its value becomes the node's context output (`action-runner.ts`,
`integrations.ts` `LiveConnector` doc). The connector never resolves a
sentinel-failure — mirroring `WoocommerceConnector`'s `async` dispatch so even a
synchronous param-validation throw surfaces as a **rejected** promise.

### 6.3 Context-field shape (what an action / trigger writes for later conditions)

Reads and triggers write a **normalized, stable** object under the node id
(`posthog-normalize.ts` produces it — numbers as numbers, timestamps as ISO
strings, booleans as booleans). Downstream edge conditions read via dotted paths
(`context.ts` `resolveField`), e.g. `{{getInsight.insight.value}}` or `field:
'getInsight.insight.value'`. **Pinned shape:**

```ts
// src/shared/posthog.ts
export interface PostHogEventContext {
  event: {
    id: string           // event uuid
    name: string         // event name, e.g. "$feature_flag_error"
    distinctId: string   // the person key
    timestamp: string    // ISO 8601
    properties: Record<string, unknown>  // raw event properties (for templating)
  }
}

export interface PostHogInsightContext {
  insight: {
    id: string
    name: string
    value: number        // the computed aggregate (trend total / number) — a NUMBER
                         // so `value gt <threshold>` compares numerically
    unit?: string        // e.g. "%", "errors" (display only)
    computedAt: string   // ISO 8601
  }
}

export interface PostHogCohortContext {
  cohort: {
    id: string
    name: string
    count: number        // current membership size
    // On a `cohort.entered` trigger, the entering person is on the SeedEvent:
    enteredDistinctId?: string
  }
}

export interface PostHogFeatureFlagContext {
  flag: {
    id: string
    key: string          // the flag key, e.g. "new-checkout"
    active: boolean
    rolloutPercentage: number | null  // top-level rollout, when simple
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and soon the typed `FlowEdgeCondition` operators). An
insight `value` as a *number* lets `insight.value gt 5` work; `active` as a
*boolean* drives `truthy`; `count` as a number drives `gt`. Normalizing once, in
one pure module, is the correctness boundary — the same discipline
`wc-normalize.ts` and `shopify-normalize.ts` set.

---

## 7. The POLL trigger design (the key design point)

**The trigger backbone is a poll/reconcile read, not a webhook.** This is the
central design decision and mirrors the **email connector's reconcile poll**
(`email/provider.ts` `reconcile(account, cursor): Promise<EmailMessage[]>`, an
opaque persisted `MailboxCursor`, and `watch-receiver.ts`'s periodic
defense-in-depth poll that "catches anything the push missed … the cursor is
persisted so a restart resumes without missing or re-processing mail"). PostHog has
no reliable first-class "new event" webhook to lean on, and a desktop app can't
cheaply host public ingress — so for PostHog the poll is not a *fallback*, it is
the **primary** path.

### 7.1 Subscription lifecycle

- `connector.subscribe(triggerId, handler)` → the connector reads the flow trigger
  node's `config` (event filter / cohort id / insight id+threshold) and registers a
  **poll subscription** with `posthog-poller`: `{ triggerId, config, handler,
  cursor }`. It returns an unsubscribe that **stops the timer and removes the
  subscription** (the pinned `subscribe(): () => void` signature — the same shape
  `WoocommerceConnector.subscribe` returns).
- The poller keys the cadence timer off the **injected clock** (`deps.now`, the same
  seam `flow-engine.now()` uses) so tests advance time deterministically with no
  real waiting (§12). No wall-clock `setInterval` in the tested core.

### 7.2 Per-trigger poll + dedup strategy

**a) `event.matched` — timestamp+uuid cursor.** Each tick runs the Query API for
events matching the node filter **with `timestamp > cursor.ts` ordered ascending**.
The cursor is `{ ts, lastUuid }`. Dedup: events at exactly `cursor.ts` are
included by the `>=`-with-uuid-filter and any whose uuid ≤ `lastUuid` (already
seen) are dropped — so an event on the boundary tick is never re-fired and never
skipped. New events fire `handler({ eventId: event.id, payload })` **once each**,
oldest first; the cursor advances to the newest `(ts, uuid)`.

**b) `cohort.entered` — membership set-diff.** Each tick reads the cohort's current
member set; the cursor is the **last-seen member snapshot** (a set of distinct ids,
or a hash + page cursor for large cohorts — §13.4). Fire `handler` once per
`current − lastSeen` (newly entered), carrying `enteredDistinctId`. Members that
leave and re-enter fire again (a real re-entry); members already present never
re-fire. The snapshot advances to `current`.

**c) `insight.threshold` — edge-cross, not level.** Each tick reads the insight
value; the cursor is the **last value**. Fire `handler` only when the value
**crosses** the configured threshold in the configured direction (e.g. `lastValue
< threshold && value >= threshold`) — not on every poll while it sits above the
line, so a sustained error rate wakes one run, not one per tick. The cursor advances
to `value`.

**The dedup rule, stated once:** a signal fires a run **exactly once**; the cursor
is advanced **only after** the handler has been handed the SeedEvent, so a crash
mid-poll re-processes rather than drops (at-least-once at the poll boundary,
de-duplicated by `eventId` downstream via `trigger-subscriber.coerceEvent`'s
`eventId` idempotency — the same idempotency key the Woo/Shopify webhook path uses).

### 7.3 Cadence

- A single `pollSeconds` cadence (default **60s**, an open decision §13.1) drives
  all subscriptions; the poller batches due subscriptions per tick. 60s is a
  deliberate latency/query-cost trade: precise enough for churn-cohort / insight-
  threshold / flag-error signals (which are minute-scale, not sub-second), cheap on
  the Query API budget.
- The latency-sensitive case (`event.matched` needing near-real-time) is exactly
  what the **optional webhook augment** (§7.5) addresses later — for MVP the cadence
  knob is the only control, and it is honest about the trade.

### 7.4 Cursor persistence (restart-safe)

`posthog-cursor-store.ts` persists each subscription's cursor to a non-secret
sidecar (the email `mailbox-registry` cursor discipline). On restart, a
re-subscribed trigger **resumes from its stored cursor** — no missed signals (the
poll picks up everything since the cursor) and no re-fired signals (the cursor and
`eventId` dedup prevent replay). The sidecar holds **only the cursor** (timestamps,
uuids, membership snapshot, last insight value) — **no analytics payload** is
retained, and **no secret** ever touches it.

### 7.5 The webhook augment (deferred — YELLOW / ingress)

PostHog **Actions → Destinations** (CDP webhooks) can push on a matched action —
the same HMAC + cloud-ingress shape `wc-webhook-server.ts` / the Linear/Shopify
specs already solve. When built (`posthog-webhook-server.ts`, phase 2), it would
**augment** `event.matched` with lower latency: a verified push seeds the same
`SeedEvent` the poll would have produced, and the poll stays on as the
defense-in-depth reconcile (exactly the email "push + reconcile" duality). It is
**out of MVP** because (a) it needs a public URL a desktop app can't cheaply host,
and (b) the poll already covers all three triggers. Flagged §13.2.

---

## 8. Auth & keychain

- **Personal API key (secret).** The user pastes it into the descriptor's masked
  `personalApiKey` field; it goes straight to the keychain via `CredentialStore`.
  Every REST/Query request sends it as `Authorization: Bearer <key>`, read at call
  time via `revealForConnector('posthog','personalApiKey')` (main-process-only, the
  sole plaintext exit; a grep test asserts no IPC/renderer caller). Recommend a
  **scoped** key (read on query/insights/cohorts/feature-flags; write only on
  feature-flags) so a leaked-or-misused key can't exceed the loop's needs.
- **Project API key (non-secret).** `phc_…` is the *public* project key; it
  identifies the project and is **not** a secret. It lives in `config.json` as a
  non-secret ref (the registry's secret/non-secret write split refuses to store it
  as a secret and vice-versa). The numeric project id is resolved once from it (§5).
- **Host (non-secret but guarded).** `host` is a non-secret ref, but user-supplied,
  so it is validated by the shared SSRF guard on every request (§4.4). A `host` that
  fails the guard flips `status()` to `error` with the guard's legible reason.
- **Honoring the global secret rule.** The personal API key is **never** written to
  `config.json`, `sessions.json`, the transcript, a log, a PR body, or any IPC
  payload. `config.json` holds only references (project key, host, cadence, env).
  Key **state** (present / decrypt-failing) may be surfaced via `status()`; the
  **value** never is — the hub's existing discipline
  (`integration-config.ts` drops a secret found in config.json with a loud notice)
  applied verbatim.
- **Disconnect.** Clearing `personalApiKey` (the hub's `clearSecret`) flips
  `status()` to `needs-config`; the connector stops dispatching and the poller
  **tears down every timer + subscription** (no orphaned polling, no leaked key).
  No in-flight run is force-killed — it simply can't start a new PostHog action and
  reports why (§11).

---

## 9. Product-signal data flow — the flagship loop, node by node

**Scenario the author drew on the canvas:** *"When error-tracking shows the
`new-checkout` flag's error-rate insight cross 2%, or a person enters the
`churn-risk` cohort, wake a worker: it judges severity from the numbers, and if
it's bad, pause for me — on approval, roll the flag back to 0%."* This is **not**
hardcoded — it's the graph below, and the author could draw it a dozen other ways.

```
[trigger: insight.threshold]           posthog-poller: insight.value crosses 2% (edge-cross, §7.2c)
   (or [trigger: cohort.entered]        churn-risk cohort gains a member, §7.2b)
        │  SeedEvent payload → context['t'] = { insightId, value, ... }
        ▼
[action: getInsight]                    ref=getInsight, params={ id: "{{t.insightId}}" }
        │  invokeAction('posthog','getInsight',…) → posthog-api → normalize
        │  writes context['read'] = PostHogInsightContext
        ▼
[action: getFeatureFlag]                read the current flag rollout for context
        │  writes context['flag'] = PostHogFeatureFlagContext
        ▼
[router]                                deterministic branch on the numbers
   ├── edge: read.insight.value gte 5   (severe — richer op, sibling-owned §6.3)
   │        ▼
   │   [gate: "approve rollback"]       pauses run needs-you; human reviews in cockpit
   │        │  approved ─► [action: updateFeatureFlag]  params={ id:"{{flag.flag.id}}",
   │        │                            active:false }  → PATCH → resolves → context['act']
   │        │  rejected ─► run ends 'rejected' (a human "no" is not a failure)
   │        ▼   (done)
   └── edge: (else — 2% ≤ value < 5%, elevated but not severe)
            ▼
        [action: queryEvents]           gather the erroring events for the worker to summarize
            ▼   (worker annotates / notifies; no mutation) (done)
```

Node-by-node against the engine:

1. **Trigger fires (poll).** `posthog-poller` sees the insight cross 2% on a tick
   (edge-cross dedup, §7.2c), normalizes to a `SeedEvent` (`{ eventId, payload:
   { insightId, value, ... } }`), advances the cursor **after** handing it off, and
   the connector's `subscribe` handler → `trigger-subscriber` → `startRun`. Trigger
   node is `done`; payload in `context['t']`.
2. **Reads.** `getInsight` then `getFeatureFlag` — the action-runner templates
   params, confirms `status('posthog') === 'connected'`, calls `invokeAction`; the
   connector calls `posthog-api`, `posthog-normalize` maps the result, the connector
   **resolves** it → the runner writes context.
3. **Router branches.** `selectEdges` evaluates each out-edge over `context['read']`
   — `insight.value gte 5` (severe) vs else. Deterministic, no LLM.
4. **Gated mutation.** On the severe branch the `gate` node pauses `needs-you`; the
   human approves (or rejects → run ends `rejected` cleanly). On approval
   `updateFeatureFlag` PATCHes the flag to `active:false`; a PostHog error
   **rejects** with the real message (§11). On success the resolved value is in
   `context['act']`.
5. **Finish.** The run completes `done`; the flag is rolled back only because a
   human approved the gate the author drew.

The same three triggers + reads support arbitrarily different graphs (auto-page-on-
severe, notify-only, gather-and-summarize, VIP-cohort-escalate). The connector
supplies capability + facts; the **author supplies authority**.

---

## 10. Authority & safety

**Primary control — the flow's gates (already enforced).** The one mutation
(`updateFeatureFlag`) is an `action` node. Authority is whatever the author wired: a
`gate` node before it pauses the run `needs-you` for human approval; a conditional
edge restricts *when* it is reached. The engine already implements this — a gate the
author drew is honored, a human "no" ends the run `rejected` (not a failure), and a
mutation with no path to it never runs. **The connector never auto-mutates outside
the graph the author drew** — delivering a polled trigger makes **zero** PostHog
writes (it is a read), exactly the `WoocommerceConnector.deliver` posture ("makes NO
store calls").

**Rolling a flag is a real production lever.** Turning a feature flag off changes
what every user sees — this is a *safety* posture, not a feasibility concern, and it
is exactly what the author-placed gate exists for. A **deterministic backstop**
(lfguard-style, in the spirit of `guard/`) — e.g. a `posthog.limits` block that
requires a gate for `updateFeatureFlag`, or forbids disabling flags matching a
protected key pattern — is a **phased item** (§14) and an open decision (§13.5),
defense-in-depth under the author's gate, never model-mediated.

**Never render secrets.** The personal API key lives in the keychain; no error
message, log line, cursor sidecar, or context field ever contains it (§8, §11).

---

## 11. Error handling

localflow's principle (error-message-style memory; demonstrated in
`credential-store.ts`, `action-runner.ts`, `wc-api.ts`): **every failure is
human-readable, actionable, and carries the real underlying exception. No silent
catch. No bare "failed" / "not found".** A mutation/read signals failure by
**rejecting** its promise; the action-runner prefixes it and surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **`status('posthog') !== 'connected'`** | the derived reason (missing key / decrypt error / bad host / disabled) | The action-runner fails the node *before* any call: "Flow needs PostHog connected — action '<id>' can't run. Connect it in Settings." |
| **Host blocked by SSRF guard** | the guard's range label | Refused **before** any request: "PostHog host '<host>' resolves to a private/loopback address (<range>) — refusing to call it. Set a public host, or enable `allowInsecureLocalHost` for a self-host on your LAN." (§4.4) |
| **Personal API key invalid/revoked (401)** | PostHog's auth error | `invokeAction` **rejects**: "PostHog rejected the personal API key (401) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing key scope (403)** | PostHog's scope error | Rejects verbatim: "PostHog refused 'updateFeatureFlag': the personal API key lacks *write* scope on feature flags — regenerate a scoped key with that permission." |
| **Insight / cohort / flag not found (404)** | the id that missed | Rejects: "PostHog has no insight '<id>' in this project (it may be in another project or was deleted)." — actionable, not a bare 404. |
| **Query error (bad HogQL / property)** | PostHog's query error body | Rejects with the verbatim query error so the author can fix the filter — never a vaguer mint. |
| **Rate limit / throttle (429)** | any `Retry-After` / the code | `posthog-api` retries with **capped exponential backoff** (honoring `Retry-After` when present); only after exhausting retries does it reject with "PostHog throttled the request — backed off and gave up after <n> tries." Not swallowed. |
| **Poll failed (a tick errored)** | the underlying transport/query error | The poller **announces degradation loudly** (a legible notice) and **does not advance the cursor** — the next tick retries from the same cursor, so a signal is worked late, **never lost**. A silent dead poll is the one thing forbidden (the email "reconcile is the safety net, and the degradation is announced, not silent" rule). |
| **Flag-update business rejection** | PostHog's error body | Rejects with the field + message: the run fails with the true reason, never a silent no-op. |
| **Host unreachable / self-host down** | the connection errno | Rejects: "PostHog host '<host>' is unreachable (<errno>) — check the host in Settings." Never a silent dead trigger. |
| **Stored key won't decrypt** | keychain/`safeStorage` change | `status()` → `error` via `decryptionError`: "Stored PostHog key can't be decrypted — re-enter it in the Integrations tab." |

The connector **never** catches-and-drops. Where PostHog returns a precise error
body, the connector forwards *that* rather than minting a vaguer one — the
action-runner's job is only to prefix it with the node/action.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live PostHog project**, matching localflow's existing seams
(pure modules, injected backends, an injected clock, fixture signals):

- **`PostHogApi` interface + `MockPostHogApi` seam.** `posthog-api.ts` is written
  *against* a `PostHogApi` interface (`queryEvents`, `getInsight`, `getFeatureFlag`,
  `getCohort`, `updateFeatureFlag`); the real impl wraps the HTTP transport + the
  SSRF guard. Tests inject a `MockPostHogApi` returning canned events/insights/
  cohorts/flags and canned error bodies. **No test ever performs a live PostHog
  call**; CI has no PostHog credentials (the exact `MockWcApi` posture).
- **Injected clock for the poll cursor (the load-bearing test).** `posthog-poller`
  takes its clock as `deps.now` (the `flow-engine.now()` seam). Tests advance the
  clock tick-by-tick over a `MockPostHogApi` and assert:
  - `event.matched`: an event on the **boundary tick** fires **once** (not skipped,
    not re-fired); the cursor advances to the newest `(ts, uuid)`.
  - `cohort.entered`: only `current − lastSeen` fire; an already-present member
    never re-fires; a leave-then-re-enter fires again.
  - `insight.threshold`: fires only on the **crossing**, not on every tick above
    the line.
  - **Restart-resume:** rehydrate the poller from a persisted cursor and assert no
    missed and no re-fired signals across the "restart".
  - **Degradation:** a failing tick emits a legible notice and **does not advance
    the cursor**; the next tick recovers the signal.
- **`posthog-normalize.ts` unit tests** — pure function; assert every raw event/
  insight/cohort/flag → the pinned context shape (§6.3): number/boolean/ISO
  normalization, absent-field handling. The correctness boundary the conditions
  track depends on — guarded hardest.
- **`posthog-connector` dispatch tests** — with a `MockPostHogApi`: assert each
  action id → the right call and the normalized resolve; assert a PostHog error
  body **rejects** with the verbatim message (the pinned failure convention); assert
  a missing-id param **rejects** (the `requireId` guard) rather than throwing sync.
- **SSRF-guard tests** — reuse the shared `ssrf-guard.ts` suite; assert `posthog-api`
  refuses a loopback/RFC-1918/link-local host **before** any request, and that the
  `allowInsecureLocalHost` opt-in flips a LAN self-host from blocked to allowed.
- **Secret-never-logged regression** — a grep/string test asserting the personal API
  key value appears in **no** emitted log/console/error/IPC string and **not** in the
  cursor sidecar (the secret rule + the "cursor holds no secret" invariant).
- **Snapshot test on `posthogDescriptor`** — pins the trigger/action ids the palette
  consumes; a change is a deliberate, reviewed contract edit.
- **Engine integration test (offline)** — wire the real `FlowEngine` + registry +
  `PostHogConnector` over a `MockPostHogApi` and an injected clock; drive the §9
  flagship loop: advance the clock so the insight crosses the threshold → assert
  `getInsight`/`getFeatureFlag` write context → assert the router selects the severe
  edge → assert the gate pauses `needs-you` → on approve assert `updateFeatureFlag`
  PATCHes the mock. Deterministic via the injected clock (no real waiting).

No test requires PostHog credentials or a live project; the real API is exercised
only in manual dogfooding against a self-hosted or cloud dev project.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **Poll cadence.** Default `pollSeconds` = 60s balances latency vs Query-API cost.
   Is 60s right for the churn/flag-error use cases, or should it be per-trigger
   (a fast cadence for `insight.threshold`, a slow one for `cohort.entered`)?
   Leaning one global knob for MVP; per-trigger cadence is the additive follow-up.
2. **Webhook augment — if/when.** Build `posthog-webhook-server.ts` (Actions/
   Destinations HMAC ingress) to cut `event.matched` latency, accepting the
   cloud-ingress cost (public URL + HMAC verify) the siblings priced? Or stay
   poll-only? Recommendation: poll-only MVP; add the augment only if a real
   latency-sensitive flow demands it — the poll covers correctness either way (§7.5).
3. **Self-host SSRF strictness.** A self-hosted PostHog on `localhost`/LAN is a
   *legitimate* target the strict guard blocks. MVP hard-blocks by default with an
   explicit `allowInsecureLocalHost` opt-in (§4.4). Decide the opt-in's exact shape
   (per-connector flag vs a global dev setting) before a self-host dogfood.
4. **Which signals ship in the MVP slice.** All three triggers (`event.matched`,
   `cohort.entered`, `insight.threshold`), or a walking-skeleton subset? The three
   share one poller but differ in cursor shape (timestamp vs set-diff vs edge-cross).
   Recommendation: ship `insight.threshold` first (simplest cursor: a single last
   value; and it drives the flagship flag-rollback loop), then `cohort.entered`, then
   `event.matched` (§14).
5. **`updateFeatureFlag` backstop.** Ship a deterministic `posthog.limits` policy
   (gate-required for flag writes; a protected-key denylist) on by default, or leave
   authority entirely to the author's gate? Product-safety call, flagged for the
   backstop phase; whatever the default, it is **deterministic** (lfguard-style),
   never model-mediated (§10, §14 Phase 3).
6. **Large-cohort membership snapshots.** `cohort.entered` set-diff is cheap for
   small cohorts; a 100k-member cohort needs a paged snapshot / hashed diff rather
   than an in-memory set. Deferred; the cursor store is shaped so the snapshot
   representation is swappable (§7.2b).

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One project, one trigger, the reads + the one gated write, happy path:**

1. `IntegrationId` gains `'posthog'` (+ the three lockstep touch-points, §6.0);
   `posthogDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `personalApiKey` → keychain; `projectApiKey` + `host` + `environment` → config;
   `host` validated by the shared SSRF guard; `status('posthog') === 'connected'`.
3. `posthog-api.ts` behind `PostHogApi`: `getInsight` + `getFeatureFlag` +
   `updateFeatureFlag` live (over the deferred/real transport per the current
   Shopify/Woo pattern). `posthog-normalize` produces the typed contexts.
4. The registry live-dispatch: `registerConnector('posthog', …)`;
   `invokeAction('posthog',…)` reaches the connector.
5. `posthog-poller` + `posthog-cursor-store`: the **`insight.threshold`** trigger
   (simplest cursor — a single last value; edge-cross dedup; injected clock; cursor
   persisted; degradation announced) → `subscribe('posthog','insight.threshold',…)`
   seeds a run.
6. On the canvas: `[insight.threshold] → [getInsight] → [gate] → [updateFeatureFlag]`
   runs end-to-end. Errors per §11.

That slice proves the whole loop — a real product signal (an insight crossing a
threshold, seen by the poll) wakes a real flow that reads the numbers and, behind a
gate, rolls a flag back — and is dogfoodable against a self-hosted or cloud dev
project.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. `insight.threshold` + `getInsight` +
  `getFeatureFlag` + `updateFeatureFlag` behind an author gate. Single project,
  single environment, poll-only.
- **Phase 2 — full vocabulary:** the rest of §6 — `queryEvents` / `getCohort`; the
  `event.matched` (timestamp cursor) and `cohort.entered` (set-diff) triggers with
  their poll strategies; the scoped-key least-privilege guidance surfaced in the UI.
- **Phase 3 — deterministic backstop:** the `posthog.limits` policy (§10), lfguard-
  style, with the default decided (§13.5). Gate-required / protected-key enforcement
  in the connector before any flag write.
- **Phase 4 — richer conditions consumption:** once the conditions track lands
  `FlowEdgeCondition`, verify the pinned fields drive `gt`/`gte`/`lt`/`truthy`/
  `exists` end-to-end; ship a "flag error-rate auto-rollback" template.
- **Phase 5 — the webhook augment (§7.5):** `posthog-webhook-server.ts` (Actions/
  Destinations HMAC ingress) as a low-latency augment for `event.matched`, poll
  retained as the reconcile safety net. Changes distribution (public ingress).
- **Phase 6 — expand analytics platforms:** Amplitude / Mixpanel as sibling
  connectors under `src/main/{amplitude,mixpanel}/`, reusing the
  `*-connector` / `*-api` / `*-poller` / `*-normalize` shape and the shared SSRF
  guard. Each its own connector (no shared cross-platform standard) — the same way
  Shopify and WooCommerce stay siblings rather than one abstraction.

---

## Appendix — reused / satisfied localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / **`LiveConnector`** / `IntegrationDescriptorDef` this
  connector satisfies; `IntegrationId` + `INTEGRATION_IDS` (edited, §6.0);
  `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  personal API key rides; `revealForConnector` (main-only plaintext exit);
  `decryptionError` powers `status()`.
- `src/main/integrations/integration-registry.ts` — `registerConnector` + the
  `invokeAction`/`subscribe` delegation seam; `deriveStatus` gives PostHog its
  status for free.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `posthog` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `posthog`;
  `descriptors/woocommerce.ts` is the descriptor-as-code template.
- `src/main/net/ssrf-guard.ts` — the **shared** host guard (promoted from
  `wc-ssrf.ts`) the user-supplied `host` passes on every request (§4.4).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called, the
  **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs;
  `coerceEvent` (the `eventId` idempotency the poll dedup rides) / `matchesFilter`.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`insight.value`) + boolean routing over the pinned fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling, and the
  **injected `now()`** the poller reuses for deterministic cursor tests.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0).
- `src/main/email/provider.ts` / `watch-receiver.ts` / `mailbox-registry.ts` — the
  **reconcile-poll + persisted-cursor + degradation-announced** pattern §7 is
  modeled on (`reconcile(cursor)`, opaque `MailboxCursor`, "restart resumes without
  missing or re-processing").
- `src/main/{shopify,woocommerce}/*-connector.ts`, `wc-api.ts`, `wc-normalize.ts`,
  `wc-ssrf.ts` — the `LiveConnector` dispatch-table + `requireId` guard + reject-on-
  failure + isolated-API-client + pure-normalize + SSRF-guard patterns copied.
- `guard/` (lfguard) — the deterministic-guard *posture* the optional flag-write
  backstop (§10, §13.5) borrows (a policy floor under the author's gate, no model in
  the loop).
