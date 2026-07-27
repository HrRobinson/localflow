# Salesforce Connector — Design

**Date:** 2026-07-20
**Status:** Design (spec) — not started. Design-approval gate for the **enterprise
CRM / sales-worker** product direction. Anchor connector for "a sales-ops worker
assembled on the drag-drop canvas that lives against the org's Salesforce."
**Feature:** A **Salesforce connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptorDef` + a live `LiveConnector`. It lets a flow author wire a
CRM worker on the canvas: a **new or changed record** (a Lead, an Opportunity, a
Case) **triggers** a run, the flow **reads** CRM state via SOQL / the REST record
API, routes on those facts via edge conditions, and — behind gates the author
places — **acts** (create a follow-up Task, update a record, or **submit the
record to the org's own Approval Process**). It does **not** hardcode a sales
pipeline; the authority lives in the flow (conditions on edges, gates where the
author puts them), exactly as the flow engine already enforces.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and copies the module shape of `src/main/integrations/` (CredentialStore keychain,
descriptor-as-code, presence-derived `status()`) plus the **poll-connector**
shape proven by PostHog (`src/main/posthog/`). Its trigger backbone is modeled
directly on the **email reconcile poll** (`src/main/email/provider.ts` `reconcile`
+ a persisted cursor) — the same lineage PostHog followed. It reuses the shared
**SSRF guard** (`src/main/net/ssrf-guard.ts`) for the user-supplied instance /
login URLs. It uses the Shopify connector spec
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`) as its style
and depth template.

**A note on ownership.** This spec **owns and pins the CRM vocabulary** (§6:
`IntegrationId` addition, triggers, actions, context-field shape). A sibling
**flow-templates** track consumes that vocabulary verbatim; a sibling
**richer-conditions** track owns the `FlowEdgeCondition` upgrade (§10) the pinned
fields are shaped for. Where those tracks own a shape, this spec **names the
dependency and stops** — it does not design their internals.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, a CRM /
sales worker that wakes when a Salesforce record is created or modified (a SOQL
`LastModifiedDate` reconcile poll), reads the relevant record facts through the
REST API, routes on those facts via edge conditions, and performs gated writes
(create a follow-up Task, update a record, create a record) **or** hands the
human decision to the org's **native Salesforce Approval Process** — with the
connected-app credentials in the OS keychain, **never** rendered.

### In scope (MVP)

- A new **Salesforce connector** module set under `src/main/salesforce/`,
  exposing a static `salesforceDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus a live `SalesforceConnector` (`LiveConnector`)
  registered via `registry.registerConnector('salesforce', …)`
  (`integration-registry.ts:54`) so the pinned `invokeAction` / `subscribe`
  delegate to real work.
- **Auth: a connected app + a dedicated Integration User**, server-to-server, no
  interactive login. Two forks are designed (§8): **OAuth 2.0 JWT-bearer** (a
  keypair, no stored secret) and **OAuth 2.0 client-credentials** (a run-as
  integration user, a stored consumer secret). Which one MVP pins is a **flagged
  open decision** (§13.1). The credential (JWT private key **or** client secret)
  → the keychain via `CredentialStore`; the minted access token is cached
  in-process and re-minted on expiry, **never** written to disk.
- A **REST API client** (`salesforce-api.ts`) — the **sole** place any Salesforce
  request/response shape lives — implementing SOQL query, the sObject record
  CRUD surface, and the Process-Approvals resource behind the pinned actions
  (§6.2). Isolated behind a `SalesforceApi` interface so tests inject a
  `MockSalesforceApi` (§12).
- The **POLL-primary trigger backbone** (`salesforce-poller.ts` +
  `salesforce-cursor-store.ts`): a SOQL **`LastModifiedDate`** (+ `Id`) reconcile
  poll on the injected `flow-engine.now()` clock, a persisted per-subscription
  cursor, a first-tick baseline-without-firing, a bounded seen-set for
  persist-failure idempotency, and **loud** degradation on a failed poll — the
  PostHog poller's shape verbatim (§7). The flow trigger node's `config` carries
  **what to poll** (the sObject + optional SOQL `WHERE`).
- The **pinned CRM vocabulary** (§6): two poll-backed triggers, two read actions,
  four gated-write actions (incl. the distinctive `submitForApproval`), and the
  **context-field shape** an action writes for downstream edge conditions.
- **Authority = the flow's gates**, plus a **distinctive second gate**: Salesforce
  is (uniquely among saiife's connectors) a system with a **first-class,
  org-configured human-approval workflow**. A worker can **submit a record to its
  Approval Process** and defer the decision to the org's existing approver — the
  `needs-you` concept realized in the system the sales manager already lives in
  (§9). The universal saiife `gate` node still applies to every write.
- **Single org, single saiife environment.** Config-as-code `salesforce` block
  in `config.json` (non-secret refs only: instance/login URL, integration
  username, connected-app client id, sObject defaults, poll cadence, environment);
  the JWT private key / client secret in the keychain.
- **The instance / login URL runs through the shared SSRF guard**
  (`ssrf-guard.ts`) before the first request — the org's My Domain is a
  user-supplied base URL, exactly the self-host case the guard exists for.

### Out of scope (MVP) — explicitly deferred

- **The Pub/Sub API (gRPC) push subscriber.** Salesforce's low-latency ingress is
  Change-Data-Capture / Platform Events over the **Pub/Sub API** (gRPC + Avro +
  a replay-id cursor). It's the **phase-2** upgrade to the poll (§7.5, §13.2): a
  different, heavier ingress (a persistent gRPC stream, Avro schema handling, CDC
  enablement in the org) that the poll does not need. MVP is poll-only, over plain
  outbound HTTPS.
- **Closed-loop approval resume.** MVP's `submitForApproval` is fire-and-forget:
  it submits the record and resolves; the flow continues. Making the flow **wait**
  for the Salesforce approver's decision and branch on approve/reject requires
  observing the `ProcessInstance` outcome — which is *another* reconcile poll plus
  a run-suspend/resume mechanic. Phase 2 (§9, §14). The *submit* is GREEN today;
  *resuming on the decision* is the richer part.
- **Bulk API / large-volume sync.** MVP is the event-driven worker loop (a few
  records per run), not a data-migration path. The Bulk 2.0 API is out.
- **External Client Apps as the auth vehicle.** Salesforce's **Spring '26**
  release positions **External Client Apps** as the successor to **Connected
  Apps** for new integrations (§8, §13.5). MVP builds on a Connected App (still
  fully supported); the auth module is drawn so the External-Client-App migration
  is a config/registration change, not a code rewrite. Flagged.
- **Multi-org fan-out.** The config/token shapes are drawn so an `orgs: [...]`
  array is the additive path, not built now.
- **The richer edge-condition operators** (`gt`/`gte`/`contains`/…). Owned by the
  sibling conditions track (§10); this spec only guarantees its fields are shaped
  to be referenced by them.
- **Flow templates / the "starter sales worker" graph.** Owned by the templates
  track, which consumes §6 verbatim (the flagship of §7 is the reference graph,
  not a hardcoded pipeline).

---

## 2. Feasibility + landscape

### 2.1 Verdict up front: **GREEN**

Grounded in the prior CRM research (research file `E-crm-knowledge.md`, GREEN;
Approval Process API = the native gate) and the current Salesforce platform docs.
The pull → read → act loop is **fully buildable today** on GA REST surfaces:

- **Read** is GA: the SOQL `query` resource and the sObject record resource cover
  every read the loop needs.
- **Act** is GA: the sObject `POST` / `PATCH` resources cover create/update, and
  the **Process Approvals** REST resource covers submitting a record to an
  Approval Process.
- **Auth** is GA and server-to-server: a Connected App with **JWT-bearer** or
  **client-credentials** and a dedicated **Integration User** needs no interactive
  login and no user in the loop.
- **Trigger** has no simple hosted-webhook path (§2.3), so it is **poll-primary** —
  but the poll is a GA, well-understood SOQL reconcile, and saiife already has
  the exact machinery (the email reconcile → the PostHog poller). Nothing in the
  loop is preview-gated or missing.

It is GREEN rather than YELLOW because every surface is generally available and
stable; the one real constraint — no signed HTTP webhook — is a *known ingress
shape saiife has already solved twice* (§2.3), not a capability gap.

### 2.2 The Salesforce API for pull → read → act

| Stage | Salesforce primitive | Posture |
|---|---|---|
| **read (query)** | `GET /services/data/vXX/query?q=<SOQL>` — arbitrary SOQL over any sObject the Integration User can see. | GA. The backbone of both the read actions and the poll. |
| **read (one record)** | `GET /services/data/vXX/sobjects/{Type}/{Id}?fields=…` — one record by id, selected fields. | GA. |
| **act (create)** | `POST /services/data/vXX/sobjects/{Type}` with a field body → new record id. | GA. Covers `createRecord` and `createTask` (Task is just the activity sObject). |
| **act (update)** | `PATCH /services/data/vXX/sobjects/{Type}/{Id}` with a field body → 204. | GA. Covers `updateRecord`. |
| **act (approval)** | `POST /services/data/vXX/process/approvals/` with a `{ requests: [{ actionType: 'Submit', contextId, … }] }` body → submits the record to its **Approval Process**. | GA. The **native human-gate** (§9) — distinctive to Salesforce. |
| **auth** | `POST <loginUrl>/services/oauth2/token` — JWT-bearer assertion **or** client-credentials grant → an access token + the org's instance URL. | GA. Server-to-server, integration user (§8). |

**Rate + volume posture.** Salesforce enforces a **per-org daily API request
allocation** (edition/license-derived) and short-window concurrency limits. The
loop is light (a handful of reads + one write per run), but the **poll** consumes
requests on a cadence, so the cadence is a configurable `pollSeconds` (default
conservative) and a failed/throttled poll **degrades loudly and does not advance
the cursor** (§7, §11) rather than hammering the allocation. This is precisely why
the Pub/Sub push path (§7.5) is the phase-2 efficiency upgrade.

### 2.3 The one real constraint: no simple signed HTTP webhook → POLL-primary

Unlike Shopify (HMAC-signed HTTPS webhooks) or Stripe/Linear, **Salesforce has no
first-class "POST a signed JSON body to your URL on record change" webhook** a
desktop app can host. The platform's push options are:

1. **Outbound Messages** (Workflow/SOAP) — legacy, SOAP-envelope, admin-configured
   per object, no HMAC, brittle.
2. **Apex triggers → callouts** — requires writing/ deploying Apex in the org;
   not a connector-owned, config-only path.
3. **The Pub/Sub API** (gRPC, CDC / Platform Events) — the *modern* push path, but
   a persistent gRPC subscriber with Avro schemas and a replay cursor (§7.5).

None is the clean signed-HTTP-webhook shape. So — exactly as the research
concluded, and exactly as PostHog faced — **the trigger is POLL-primary**: a SOQL
**`LastModifiedDate`** reconcile poll. This is not a downgrade; it is the same
reconcile pattern the **email** connector uses (`provider.ts reconcile(cursor)`)
and the **PostHog** connector productionized (`posthog-poller.ts`). The Pub/Sub
gRPC subscriber is the flagged **phase-2** low-latency alternative (§13.2), not a
prerequisite.

Two secondary constraints, both mild:

- **Cloud-side vs local.** Reads/writes are plain outbound HTTPS — no ingress
  needed. The poll is outbound too. So, unlike the webhook connectors, Salesforce
  needs **no tunnel / relay** for triggers — the poll reaches *out*. This is
  actually a distribution *win* (no cloud-ingress dependency).
- **`LastModifiedDate` granularity + ties.** It is second-granular and two records
  can share a timestamp, so the cursor is a **`(LastModifiedDate, Id)` tuple** and
  the query is `>= boundary` with tuple-dedup — the PostHog event-poll shape
  (§7.2). (`SystemModstamp` is an alternative reconcile field that also moves on
  system updates; flagged in §13.3.)

---

## 3. The core loop → Salesforce primitives

saiife's CRM loop is `trigger → read → route → act (gated)`. Each stage maps to
a concrete Salesforce primitive and the concrete flow-engine mechanism that runs
it:

| Stage | Salesforce primitive | saiife / flow-engine mechanism |
|---|---|---|
| **trigger** | A SOQL reconcile poll finding a new/changed record (`SELECT … FROM <object> WHERE LastModifiedDate >= :cursor …`). No webhook. | `salesforce-poller` ticks on the injected clock, diffs against the persisted `(LastModifiedDate, Id)` cursor, normalizes a new row → a `SeedEvent`, and hands it to the connector's `subscribe(triggerId, handler, config)` handler → the engine `startRun`s the flow with the record in trigger-node context (`trigger-subscriber.ts`, `SeedEvent`). |
| **read** | SOQL `query` / the sObject record `GET`. | An `action` node (`query` / `getRecord`) → `registry.invokeAction('salesforce', ref, params)` → `SalesforceConnector` calls `salesforce-api` → `salesforce-normalize` maps it → the connector **resolves** the typed result, which the action-runner writes to context under the node id (`action-runner.ts`). |
| **route** | *(none — pure saiife)* | `selectEdges` evaluates edge conditions over the context the read wrote (`context.ts`). Deterministic value compares (`field === equals` today; the richer `FlowEdgeCondition` operators soon, §10). **No LLM decides routing.** |
| **gate** | *(none — pure saiife)* **OR** the org's **Approval Process** (§9). | A `gate` node the author placed pauses the run `needs-you`; the human approves in the cockpit. **Distinctively**, a `submitForApproval` action can instead route the decision into Salesforce's own approval queue (§9). A write node sits **downstream of the gate the author drew**. |
| **act** | sObject `POST` (`createRecord` / `createTask`), sObject `PATCH` (`updateRecord`), Process-Approvals `Submit` (`submitForApproval`). | The gated `action` node → `invokeAction` → `salesforce-api` write. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* Salesforce error (`action-runner.ts`). |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities* (read actions, write actions, the approval-submit action,
poll triggers); the *flow* decides which run, in what order, behind which gates,
under which edge conditions. That is the entire point of the CRM-worker direction:
not a hardcoded sales pipeline, but a worker the user assembles with the authority
they choose — including the choice to defer to the org's own approval governance.

---

## 4. Architecture in saiife

### 4.1 Where it sits

A new **main-process module set** under `src/main/salesforce/`, mirroring
`src/main/posthog/` (the reference **poll** connector) and the descriptor/keychain
conventions of `src/main/integrations/`. It is **opt-in**: with no `salesforce`
config entry (and no stored credential) the descriptor's `status()` returns
`needs-config` and the engine refuses any Salesforce node before any network call
— saiife's "works with no integration" guarantee is unchanged
(`integration-registry.ts` `deriveStatus`).

The connector is, architecturally, **a live `LiveConnector` the registry delegates
to**. It is registered once at startup via `registry.registerConnector('salesforce',
connector)` (`integration-registry.ts:54`); thereafter the registry's pinned
`invokeAction`/`subscribe` (`integration-registry.ts:73-103`) delegate to it, and
an unregistered build keeps the legible "no live connector wired" reject / no-op
unsubscribe. All Salesforce API shapes are isolated in `salesforce-api.ts` (the
blast radius for any API-version bump), exactly as PostHog isolated its REST in
`posthog-api.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/salesforce/salesforce-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'salesforce'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids (the contract the templates track consumes). Mirrors `descriptors/posthog.ts`. |
| `src/main/salesforce/salesforce-connector.ts` | The `LiveConnector` orchestrator. `invokeAction(actionId, params)` → the right `salesforce-api` call + `salesforce-normalize` mapping; `subscribe(triggerId, handler, config)` → registers a POLL subscription with `salesforce-poller` and returns an unsubscribe. The one place the loop's dispatch lives. Mirrors `posthog-connector.ts`. |
| `src/main/salesforce/salesforce-api.ts` | Thin **REST** client behind a `SalesforceApi` interface. **All** Salesforce request/response shapes (SOQL query envelope, sObject CRUD, the `process/approvals` body, the error array) live *only* here. Tests inject a `MockSalesforceApi` (§12). |
| `src/main/salesforce/salesforce-auth.ts` | Mints + caches the access token (JWT-bearer **or** client-credentials, §8), tracks its expiry, and re-mints on `INVALID_SESSION_ID`. Reads the keychain credential via the token store; **never** logs or returns token material. The one place the auth fork is decided. |
| `src/main/salesforce/salesforce-poller.ts` | The SOQL **`LastModifiedDate`** reconcile poll backbone. Per subscription: a cadence keyed off the **injected clock** (`deps.now`, the `flow-engine.now()` seam), a `(LastModifiedDate, Id)` tuple cursor, a first-tick **baseline-without-firing**, a bounded `seen` set for persist-failure idempotency, and **loud** degradation that does **not** advance the cursor on failure. Structurally the `posthog-poller.ts` event-poll, retargeted at SOQL. |
| `src/main/salesforce/salesforce-cursor-store.ts` | Keychain-free, sidecar-persisted `(LastModifiedDate, Id)` cursor per subscription key, so a restart resumes without missing or replaying records. Mirrors `posthog-cursor-store.ts`. |
| `src/main/salesforce/salesforce-normalize.ts` | **Pure** mapping: a raw Salesforce record → the pinned `SalesforceRecordContext` (§6.3) — strips the `attributes` envelope, normalizes the **15→18-char Id**, coerces field types (numbers stay numbers so conditions compare numerically), and builds the record's Lightning deep-link URL. Unit-testable in isolation (mirrors `posthog-normalize.ts` / `status-map.ts` purity). The correctness boundary the conditions track depends on. |
| `src/main/salesforce/salesforce-config.ts` | Reads the non-secret `salesforce` refs (instance URL, login URL, integration username, client id, api version, default sObject, poll cadence, environment). **Runs the instance/login URL through `net/ssrf-guard.ts` `checkBaseUrl` before any request** (§4.4). The validate-at-the-boundary pattern. |
| `src/main/salesforce/salesforce-token-store.ts` | Thin wrapper over the hub's `CredentialStore` (`revealForConnector('salesforce', 'privateKey' \| 'clientSecret')`) — reuses the existing keychain sidecar; named distinctly so a grep test asserts no IPC/renderer caller. |
| `src/shared/salesforce.ts` | Shared types (`SalesforceRecordContext`, the trigger-id union `SalesforceTriggerId`, the action param shapes) needed by both main and any renderer palette surface. |

### 4.3 Wiring the live dispatch into the registry

The pinned live-dispatch seam already exists in the merged codebase — this
connector is a **new consumer** of it, not a change to it:

- `LiveConnector` (`integrations.ts:73-86`) is the minimal interface
  (`invokeAction(actionId, params)`, `subscribe(triggerId, handler, config?)`).
  `SalesforceConnector` implements it.
- `IntegrationRegistry.registerConnector(id, connector)` (`integration-registry.ts:54`)
  is called once from `src/main/index.ts` with the constructed
  `SalesforceConnector` (given the `SalesforceApi`, the `SalesforcePoller`, and
  the config). Thereafter `invokeAction('salesforce', …)` and
  `subscribe('salesforce', …, config)` (`integration-registry.ts:73-103`) delegate
  to it. The **`config` third argument is load-bearing here** — the registry
  forwards the flow trigger node's config to `connector.subscribe`
  (`integration-registry.ts:102`), and a **POLL connector needs it** to know
  *what* to poll (the sObject + SOQL `WHERE`). Without the forward, the poller's
  `requireConfig` throws every tick and no run is ever seeded.

This keeps the pinned contract **byte-for-byte unchanged** and localizes every
Salesforce concern under `src/main/salesforce/`.

### 4.4 The instance / login URL through the SSRF guard

Salesforce API calls go to the org's **My Domain instance URL**
(`https://<mydomain>.my.salesforce.com`) and auth goes to the **login URL**
(`https://login.salesforce.com`, the sandbox `https://test.salesforce.com`, or a
My Domain login host). Both are **user-supplied base URLs**, so both run through
`net/ssrf-guard.ts` `checkBaseUrl(raw, { label })` before the first request:
https-only, no embedded credentials, and (because a mistyped/hostile value could
target loopback / RFC-1918 / `169.254.169.254` cloud metadata) a private-range IP
literal is refused. A DNS hostname passes the literal check and is re-verified
against its **resolved** IP by `blockedIpRange` at dial time (the DNS-rebinding
hook) when the real transport lands. This is the same guard Woo/GitLab/PostHog use
for self-host URLs — Salesforce is another user-supplied-base-URL connector, so it
gets the protection for free. (Salesforce's own hosts are public, so no
`allowHost` exception is needed; the guard just rejects a fat-fingered internal
address.)

### 4.5 Receiving triggers — a poll, not an ingress

There is **no webhook receiver** (contrast Shopify's `*-webhook-server`). The
trigger backbone is the poller, which reaches *out*:

- Production wires a real interval to call `poller.tick()`; the tested core takes
  the **injected clock** so tests advance time deterministically with no real
  waiting (§7.1, §12).
- Each active subscription owns a `(LastModifiedDate, Id)` cursor persisted by
  `salesforce-cursor-store`; a restart resumes from it.
- A failed tick **degrades loudly** (a `log` line, never a secret) and **does not
  advance the cursor** — the next tick retries from the same boundary, so a
  Salesforce blip works the signal *late*, never *lost*. The one forbidden outcome
  is a silent dead poll.

Because the poll is outbound HTTPS, Salesforce needs **no tunnel/relay** — a
distribution advantage over the webhook connectors (§2.3).

### 4.6 Reused saiife surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; the
  `IntegrationStatus` union; `IntegrationId` (edited, §6.0);
  `ResolvedIntegrationDescriptor` transport.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses (`revealForConnector` main-only plaintext exit,
  `decryptionError` feeding `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3),
  the `invokeAction`/`subscribe` delegation, and the presence-derived
  `deriveStatus`.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `salesforce` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `salesforce`;
  `descriptors/posthog.ts` is the poll-descriptor template.
- `src/main/net/ssrf-guard.ts` — `checkBaseUrl` / `blockedIpRange` for the
  instance / login URL (§4.4).
- `src/main/posthog/posthog-poller.ts` — the reference poll backbone (injected
  clock, tuple cursor, baseline-without-firing, seen-set, loud degradation) the
  Salesforce poller is modeled on.
- `src/main/email/provider.ts` — the original **reconcile(cursor)** pattern the
  whole poll lineage descends from.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — `SeedEvent`, `coerceEvent`,
  `matchesFilter`: how a poll `SeedEvent` seeds a run.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`record.fields.Amount`) + boolean routing over the pinned
  fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` the poller shares.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0);
  the strict graph validator.

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `salesforceDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS` (`descriptors/index.ts`). The registry attaches the
presence-derived `status()` (`connected` | `needs-config` | `error` | `disabled`)
exactly as for the others — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary). The **auth fork** determines which secret is required — MVP pins one
(§13.1); both are shown:

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `privateKey` | Connected-app JWT private key (PEM) | **yes** | *JWT fork* | string | RSA private key for the JWT-bearer assertion. Keychain only. |
| `clientSecret` | Connected-app consumer secret | **yes** | *client-creds fork* | string | For the client-credentials grant. Keychain only. |
| `clientId` | Connected-app consumer key | no | yes | string | The connected-app / External-Client-App client id. Non-secret ref. |
| `username` | Integration User username | no | *JWT fork* | string | The `sub` of the JWT assertion (the dedicated integration user). |
| `loginUrl` | Login / token host | no | yes | string | `https://login.salesforce.com` (prod) / `https://test.salesforce.com` (sandbox) / My Domain. **SSRF-checked** (§4.4). |
| `instanceUrl` | Org instance URL | no | no | string | `https://<mydomain>.my.salesforce.com`; if omitted, taken from the token response. **SSRF-checked**. |
| `apiVersion` | REST API version | no | no | string | e.g. `v62.0`; defaults to a pinned version in `salesforce-api.ts`. |
| `defaultObject` | Default sObject for triggers | no | no | string | e.g. `Lead`; the trigger node's `config.object` overrides it. |
| `pollSeconds` | Poll cadence (seconds) | no | no | number | Default a conservative cadence (mindful of the daily API allocation, §2.2). |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts Salesforce work (same field/validation as the others). |

`status('salesforce')` reports `needs-config` until the auth-fork secret + `clientId`
+ `loginUrl` + `environment` (and `username` for the JWT fork) are present; `error`
if a stored secret can't be decrypted (the hub's `decryptionError` path); `disabled`
if configured-but-turned-off; `connected` otherwise. The action-runner refuses any
non-`connected` Salesforce node before any network call.

---

## 6. Pinned CRM vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `salesforce-descriptor.ts` guards the ids; the field shape is guarded by the
> `salesforce-normalize.ts` tests.

### 6.0 Shared-union edit + the 3 lockstep touch-points

`src/shared/integrations.ts` — `IntegrationId` gains `'salesforce'`:

```ts
export type IntegrationId =
  | 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'posthog'
  | 'gitlab' | 'slack' | 'http' | 'stripe' | 'github' | 'sentry' | 'hubspot'
  | 'salesforce'
```

This is a **shared-union edit** with **3 companion touch-points that must move in
lockstep** (each a one-line add):

1. `INTEGRATION_IDS` — the stable-order array (`integrations.ts:99`) the tabs /
   `descriptors()` iterate.
2. `INTEGRATION_IDS` — the set in `flow-model.ts:29` (the flow validator's
   allow-list; without it a `salesforce` node fails `parseFlowGraph`).
3. `DESCRIPTOR_DEFS` — the record in `descriptors/index.ts:19` (TypeScript's
   `Record<IntegrationId, …>` makes this a **compile error** until the key is
   added — the type system enforces the lockstep).

No other `IntegrationId` consumer needs a change — they iterate the array.

### 6.1 Triggers (poll-backed — NOT webhooks)

| trigger id | label | backing poll | node `config` |
|---|---|---|---|
| `record.created` | New record created | SOQL poll, `(CreatedDate, Id)` cursor, `WHERE CreatedDate >= :cursor [AND <where>] ORDER BY CreatedDate, Id`. First tick baselines without firing. | `object` (e.g. `Lead`), optional `where`, optional `fields`. |
| `record.updated` | Record created or modified | SOQL **reconcile** poll, **`(LastModifiedDate, Id)`** cursor, `WHERE LastModifiedDate >= :cursor [AND <where>] ORDER BY LastModifiedDate, Id`. The **KEY design point** (§7). | `object`, optional `where`, optional `fields`. |

The flagship "**new Lead**" trigger (§7) is `record.created` with `config.object =
'Lead'`. The two triggers share the **one** poll backbone (`salesforce-poller`),
differing only in the timestamp field they cursor on — exactly PostHog's
per-trigger cursor shape. `object` + `where` in the node config are what the
registry's `subscribe(…, config)` forward (§4.3) carries down to the poller so it
knows *what* to poll.

**Why generic `record.*` and not `lead.created` / `opportunity.won`.** Salesforce
is schemaless-per-org (custom objects, custom fields, org-specific pipelines). A
generic `record.created` / `record.updated` parameterized by `object` + a SOQL
`where` covers *every* org's objects (standard **and** custom) with two ids the
templates track can specialize (`object: 'Lead'`, `where: "Status = 'Open'"`),
rather than a brittle enumerated list that never matches a given org's schema.
This is the honest shape for Salesforce's data model.

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | Salesforce REST | writes to context |
|---|---|---|---|
| `query` | Run a SOQL query | `GET /query?q=<SOQL>` | `{ records: SalesforceRecord[]; count; done }` (§6.3) |
| `getRecord` | Get a record | `GET /sobjects/{object}/{id}` | `SalesforceRecordContext` (§6.3) |

**Gated write (the author places a gate before these — or routes through the
Approval Process, §9):**

| action id | label | Salesforce REST | note |
|---|---|---|---|
| `createRecord` | Create a record | `POST /sobjects/{object}` | Any sObject; params: `object`, `fields`. Returns the new id. |
| `createTask` | Create a follow-up Task | `POST /sobjects/Task` | The canonical CRM worker verb (the flagship's follow-up); a typed specialization of `createRecord` for the `Task` activity object (`Subject`, `WhoId`, `WhatId`, `ActivityDate`, `OwnerId`). |
| `updateRecord` | Update a record | `PATCH /sobjects/{object}/{id}` | Params: `object`, `id`, `fields`. |
| `submitForApproval` | Submit to the org's Approval Process | `POST /process/approvals/` (`actionType: 'Submit'`) | The **distinctive native-gate** action (§9). Params: `recordId`, optional `approverId`, optional `comments`. Hands the human decision to Salesforce's own approval workflow. |

**Failure convention (pinned):** a write that fails **rejects** its promise with
the real Salesforce error text (Salesforce's error array `[{ message, errorCode,
fields }]` is already human-readable — forward `message` verbatim); a resolved
promise (any value) is success and its value becomes the node's context output
(`action-runner.ts`, `integrations.ts:47-56`). The connector never resolves a
sentinel-failure, and `invokeAction` is `async` so a synchronous validation throw
(a missing `id`) surfaces as a **rejected** promise, not an out-of-band throw
(the PostHog connector's `async invokeAction` discipline).

### 6.3 Context-field shape (what an action writes for later conditions)

Salesforce records are **generic** (any sObject, any fields), so — unlike Shopify's
fixed order shape — the normalized context is a **generic record envelope**.
`salesforce-normalize` strips the `attributes` wrapper, normalizes the Id to 18
chars, coerces field types (numbers stay numbers), and adds a deep-link URL.
**Pinned shape:**

```ts
// src/shared/salesforce.ts
export type SalesforceFieldValue = string | number | boolean | null

export interface SalesforceRecord {
  id: string                 // 18-char Salesforce Id (normalized from 15)
  type: string               // sObject API name, e.g. "Lead"
  fields: Record<string, SalesforceFieldValue>  // the requested fields, JSON-typed
  createdDate: string        // ISO 8601 (from CreatedDate)
  lastModifiedDate: string   // ISO 8601 (from LastModifiedDate) — the reconcile field
  url: string                // Lightning deep-link (non-secret) for the cockpit
}

export interface SalesforceRecordContext {
  record: SalesforceRecord
}
```

`query` writes `{ records: SalesforceRecord[]; count: number; done: boolean }`
(the SOQL result `done`/`nextRecordsUrl` pagination is handled inside
`salesforce-api`; MVP surfaces the first page + `count`, and the field is drawn so
a future "fetch all" is additive).

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and soon the typed `FlowEdgeCondition` operators of §10).
A numeric field (`Amount`, `NumberOfEmployees`) kept as a **number** lets
`record.fields.Amount gt 100000` work; the raw Salesforce JSON already types
numbers, but the `attributes` envelope and the 15/18-char Id ambiguity would
misroute if not normalized — so normalizing once, in one pure module, is the
correctness boundary. The templates track and the conditions track both rely on
these exact paths and types.

---

## 7. Data flow — the flagship CRM loop, node by node

**Scenario the author drew on the canvas:** *"When a new Lead comes in, enrich it,
then — if it's a high-value Lead — create a gated follow-up Task **and** submit the
Lead to the org's Approval Process; otherwise just create the follow-up Task."*
This is **not** hardcoded — it's the graph below, and the author could draw it a
dozen other ways.

```
[trigger: record.created]              SOQL poll: SELECT … FROM Lead WHERE CreatedDate >= :cursor
        │  config = { object: 'Lead' }   ORDER BY CreatedDate, Id   (first tick baselines, no fire)
        │  new row → context['t'] = { record: { id, type:'Lead', fields:{…}, … } }
        ▼
[action: agent enrich]                 an agent node reads t.record, enriches (company size, score)
        │  writes context['enrich'] = { score, segment, … }
        ▼
[router]                               explicit branch point
   ├── edge: enrich.score >= 80  (richer, §10)
   │        ▼
   │   [gate: "approve high-value follow-up"]     saiife gate → needs-you (cockpit)
   │        │  approved ▼
   │   [action: createTask]        Subject="Call new high-value lead", WhoId="{{t.record.id}}"
   │        │  invokeAction('salesforce','createTask',{ fields:{ Subject, WhoId, ActivityDate } })
   │        ▼
   │   [action: submitForApproval]  route the Lead into the ORG's Approval Process (§9)
   │        │  invokeAction('salesforce','submitForApproval',{ recordId:"{{t.record.id}}", comments })
   │        ▼   (done — the org's approver now owns the decision, in Salesforce)
   │
   └── edge: (else — score < 80)
            ▼
        [action: createTask]        Subject="Follow up with lead", WhoId="{{t.record.id}}"
            ▼   (done)
```

Node-by-node against the engine:

1. **Trigger fires.** `salesforce-poller` ticks on the injected clock, runs the
   `record.created` SOQL for `Lead`, diffs against the `(CreatedDate, Id)` cursor.
   The **first tick baselines** the backlog **without firing** (an org with 10k
   existing Leads must not flood 10k runs on connect); only genuinely-new Leads on
   later ticks fire. A new row is normalized to a `SeedEvent` (`{ eventId:
   record.id, payload: { record } }`) and handed to the connector's `subscribe`
   handler → the engine `startRun`s the flow. The trigger node is immediately
   `done`; the record is in `context['t']`.
2. **Agent enriches.** An `agent` node reasons over `t.record` and writes
   `context['enrich']` (score/segment). *(Enrichment is a saiife agent node,
   not a Salesforce call — the connector supplies the record; the flow supplies
   the reasoning.)*
3. **Router branches.** `selectEdges` evaluates each out-edge over `context` —
   `enrich.score >= 80` (deterministic, no LLM). §10's operators make `>=`
   first-class; today an `eq` on a bucketed segment does the same.
4. **Gated write.** On the high-value branch, the `gate` node pauses the run
   `needs-you`; the human approves (or rejects → run ends `rejected` cleanly — a
   human "no" is not a failure). On approval, `createTask` runs; a Salesforce error
   **rejects** with the real message (§11). Then `submitForApproval` hands the
   *Lead's own* approval to the org's Approval Process (§9) — the sales manager
   approves in Salesforce, where they already work.
5. **Else branch.** A low-value Lead just gets a follow-up Task; the run completes
   `done`.

The same trigger + read + fields support arbitrarily different graphs (round-robin
assignment, SLA escalation, opportunity-stage automation, case triage). The
connector supplies capability + facts; the **author supplies authority**.

### 7.1 The poll cadence + the injected clock

Per active subscription the poller keeps a `nextDueAt` computed from the injected
`now()` and `pollSeconds`; production wires a real interval that calls
`poller.tick()`, and `tick()` polls every *due* subscription once. Tests advance
the injected clock and call `tick()` directly — **no wall-clock waiting, fully
deterministic** (the `flow-engine.now()` seam, §12). One failing subscription does
not stop the others.

### 7.2 The `(LastModifiedDate, Id)` reconcile cursor (the key mechanic)

`LastModifiedDate` is second-granular and two records can share a timestamp, so
the cursor is a **tuple** `(lastModifiedDate, id)` and the SOQL is `>= boundary`
(inclusive) with **tuple-dedup**: any row `<= (cursor.ts, cursor.id)` is dropped
(the inclusive query re-returns the boundary row, which must not re-fire), and the
cursor advances to the newest handed-off tuple **after** the handoff — so a crash
mid-poll re-processes rather than drops (at-least-once). A bounded per-subscription
`seen` set makes a persist-that-throws-after-emit effectively exactly-once, and is
cleared on every durable commit so a genuine later re-modification of the same
record still fires. This is `posthog-poller.ts`'s event-poll logic verbatim,
retargeted from PostHog's `(timestamp, uuid)` to Salesforce's `(LastModifiedDate,
Id)`.

### 7.3 Baseline-without-firing on first sight

On the first tick of a fresh subscription (cursor undefined), the poller
**baselines** the newest `(ts, id)` **without firing** — an already-populated org
must not wake a run for every pre-existing record. Only records modified *after*
the baseline fire on later ticks. Identical to `pollEvents`/`pollCohort`/
`pollInsight`'s first-observation rule.

### 7.4 Loud degradation, never a silent dead poll

A failed tick (auth expired, `REQUEST_LIMIT_EXCEEDED`, a network blip) is
**logged loudly** (never a secret) and the **cursor is not advanced** — the next
tick retries from the same boundary, so the signal is worked late, never lost
(§11). The single forbidden outcome is a silently stopped poll.

### 7.5 Pub/Sub API (gRPC) — the phase-2 push alternative (flagged)

Salesforce's low-latency ingress is **Change-Data-Capture / Platform Events over
the Pub/Sub API** (gRPC, Avro-encoded events, a **replay-id** cursor). It would
replace the poll's cadence with real-time push. It is **phase 2** (§13.2) because
it is a materially heavier ingress: a persistent gRPC subscriber with keepalives,
Avro schema fetch/decode, and CDC enablement in the org — none of which the poll
needs. Crucially, its **replay-id cursor maps onto the same `salesforce-cursor-store`
abstraction**, so the poll → Pub/Sub migration is an ingress swap behind the same
cursor + `SeedEvent` seam, not a connector rewrite. The poll ships first; Pub/Sub
is the efficiency upgrade for high-volume orgs.

---

## 8. Auth & keychain

**A connected app + a dedicated Integration User**, server-to-server, no
interactive login. Two forks are fully designed; **which MVP pins is flagged**
(§13.1):

- **JWT-bearer fork.** A connected app configured with a **certificate** (the
  public key) and "admin pre-authorized" for the Integration User. `salesforce-auth`
  builds a signed JWT assertion (`iss = clientId`, `sub = username`, `aud =
  loginUrl`), POSTs it to `/services/oauth2/token`, and receives an access token +
  instance URL. **The secret stored in the keychain is the RSA private key**
  (`privateKey`); there is **no client secret and no refresh token** — the token
  is short-lived and simply re-minted from the assertion on expiry. Most
  established server-to-server shape; the trade is keypair/cert management.
- **Client-credentials fork.** A connected app with "Enable Client Credentials
  Flow" and a designated **run-as** Integration User. `salesforce-auth` POSTs
  `grant_type=client_credentials` with `client_id` + `client_secret` to the token
  endpoint. **The secret stored in the keychain is the consumer secret**
  (`clientSecret`). Simpler (no keypair), and Salesforce now recommends it for
  server-to-server with a run-as user; the trade is a long-lived shared secret.

In both forks: the minted access token is **cached in-process** with its expiry;
on a `401 INVALID_SESSION_ID` mid-call, `salesforce-auth` **re-mints once and
retries** before rejecting. The token is **never** written to `config.json`,
`sessions.json`, a log, the transcript, or any IPC payload — read at call time,
held in memory, and used only as the `Authorization: Bearer` header inside
`salesforce-api`.

- **The keychain credential** (`privateKey` **or** `clientSecret`) is stored via
  `CredentialStore.set` and revealed only through
  `revealForConnector('salesforce', …)` (main-process-only, the sole plaintext
  exit; a grep test asserts no IPC/renderer caller). `config.json` holds only
  **references** (client id, login/instance URL, integration username, api
  version) — the hub's discipline (a secret found in config.json is dropped with a
  loud notice) applied verbatim.
- **Honoring the global secret rule.** Neither the stored credential nor the minted
  token is **ever** rendered into anything durable. Credential/token **state**
  (present / decrypt-failing / expired) may be surfaced via `status()` and legible
  errors; the **value** never is.
- **The dedicated Integration User.** Both forks run as a **dedicated integration
  user** (its own profile / permission sets scoping exactly the objects and
  fields the worker touches). This is the natural place to enforce least-privilege
  — the connector can only read/write what that user can, and a scope error (§11)
  points the admin at that user's permissions. (Salesforce's **Integration User
  license** is the intended vehicle where available.)
- **Spring '26 External Client Apps (flagged, §13.5).** Salesforce is steering new
  integrations to **External Client Apps**, the successor to Connected Apps.
  MVP builds on a Connected App (still fully supported); `salesforce-auth` and the
  descriptor's `clientId`/secret fields are drawn so moving to an External Client
  App is a **registration + config** change (same JWT/client-credentials grant at
  the token endpoint), not a code rewrite.
- **Disconnect.** Clearing the keychain credential flips `status()` to
  `needs-config`; the connector stops dispatching and the poller is torn down
  (`stopAll`). No in-flight run is force-killed — it simply can't start a new
  Salesforce action, and reports why (§11).

---

## 9. Authority & safety — and the Approval-Process-as-gate fit

**Primary control — the flow's gates (already enforced).** Every write
(`createRecord`, `createTask`, `updateRecord`, `submitForApproval`) is an `action`
node. Authority is whatever the author wired: a `gate` node before the write pauses
the run `needs-you` for cockpit approval; a conditional edge restricts *when* the
write is even reached. The engine already implements this — a gate the author drew
is honored, a human "no" ends the run `rejected` (not a failure), and a write with
no path to it never runs. **The connector never auto-writes outside the graph the
author drew.**

**The distinctive fit — Salesforce's native Approval Process as a `needs-you`
gate.** Salesforce is **one of the very few systems saiife integrates that ships
a first-class, org-configured human-approval workflow**: an **Approval Process**
routes a record to a defined approver (a sales manager) who approves or rejects in
the Salesforce UI / mobile / email-approval, with the org's own escalation and
audit. The `submitForApproval` action (`process/approvals/` `Submit`) lets a
saiife worker **hand the human decision to that native workflow** instead of —
or in addition to — saiife's own `gate` node. This maps the `needs-you` concept
onto the approval surface the sales org **already lives in**, with the org's
existing governance, rather than asking approvers to move into the saiife
cockpit. No other current connector (Shopify, PostHog, Stripe, …) has a native
approval concept to defer to — for those, the gate is *always* saiife's. For
Salesforce it can be the **org's own**. That is the distinctive design.

Two levels of that fit, honestly scoped:

1. **Submit (MVP — GREEN today).** `submitForApproval` is a single REST call: it
   enters the record into its Approval Process and resolves. The saiife run
   continues; the record is now "pending approval" in Salesforce, owned by the org
   approver. Combine with a saiife `gate` before it (a saiife check first,
   then route to the org) or use it standalone (delegate the whole decision to the
   org). Either way it is **one gated action node**, the pinned convention.
2. **Resume on the decision (phase 2 — flagged).** To make the flow *wait* for the
   Salesforce approver and branch on approve/reject, the connector must observe the
   `ProcessInstance` outcome — which is **another reconcile poll** (poll the
   approval status / `ProcessInstanceWorkitem` by target record) plus a
   run-suspend/resume. That turns the native approval into a full `needs-you`
   equivalent that resumes the saiife run. Deferred because it is a second poll
   + a suspend/resume mechanic; the *submit* alone is already a distinctive,
   shippable fit.

**Optional deterministic backstop (phased — §14).** In the spirit of **saiifeguard**
(the Rust destructive-command guard) but as a **CRM policy**: a small declarative
`salesforce.limits` config (non-secret), e.g. `{ createAllowedObjects: ['Task',
'Lead'], updateRequiresGate: true, maxRecordsPerRun: 50 }`, enforced **inside the
connector before the write** as a hard reject (the pinned failure convention).
Defense-in-depth — a deterministic floor under the author's gates for a
mis-authored flow or a wrong LLM-seeded param, no model in the loop, exactly
saiifeguard's posture. Its default (present/absent, values) is a product call (§13.4).

**Never render secrets.** The JWT private key / client secret / access token live
only in the keychain / process memory; no error, log, or context field ever
contains them (§8, §11).

---

## 10. Richer-conditions dependency (owned elsewhere — named, not designed)

The flow engine's edge conditions are moving from `field === equals` to a typed
`FlowEdgeCondition` (`op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' |
'exists' | 'truthy'`), owned by the **conditions track**. The fields this spec
pins (§6.3) are **designed to be referenced by those operators**: numeric fields
(`record.fields.Amount`, `record.fields.NumberOfEmployees`) as **numbers** so
`gt`/`gte`/`lt`/`lte` are meaningful; picklist/status fields as strings for
`eq`/`ne`/`contains`; a possibly-absent field for `exists`; a boolean field
(`record.fields.IsConverted`) for `truthy`. **This spec does not design the
condition system** — it only guarantees its field types are stable at
condition-eval time (normalized once in `salesforce-normalize.ts`). The dependency
is one-directional: the connector works under the current `eq`-only routing, just
less expressively.

---

## 11. Error handling

saiife's principle (the error-message-style memory; demonstrated in
`credential-store.ts` and `action-runner.ts`): **every failure is human-readable,
actionable, and carries the real underlying exception. No silent catch. No bare
"failed" / "not found".** A write signals failure by **rejecting** with that
message; the action-runner prefixes it with the node/action and surfaces it on the
run. Salesforce's own error array `[{ message, errorCode, fields }]` is already
human-readable — the connector forwards `message` verbatim rather than minting a
vaguer one.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Instance / login URL blocked (SSRF)** | `ssrf-guard`'s reason (private/loopback/metadata) | Rejected at the config boundary, before any request: "Salesforce login URL '<host>' is a private/loopback address — fix it in Settings." (§4.4). |
| **JWT / client-creds rejected** (`400 invalid_grant` / `invalid_client`) | Salesforce's OAuth error (e.g. "user hasn't approved this consumer", "invalid client credentials") | `salesforce-auth` **rejects**: the verbatim OAuth error + "re-check the connected app + Integration User authorization in Settings." The key/secret value is never included. |
| **Token expired mid-call** (`401 INVALID_SESSION_ID`) | — | `salesforce-auth` re-mints **once** and retries; only if the re-mint fails does it reject with the auth error. Not surfaced on the happy path. |
| **`status('salesforce') !== 'connected'`** | the derived reason (missing credential / decrypt error / disabled) | The action-runner fails the node *before* any call: "Flow needs Salesforce connected — action '<id>' can't run. Connect it in Settings." |
| **Malformed SOQL** (`400 MALFORMED_QUERY`) | Salesforce's parse error + position | Rejects verbatim: "Salesforce rejected the SOQL: unexpected token 'FROMM' at line 1 — fix the query." |
| **Object/field not accessible** (`INSUFFICIENT_ACCESS` / not-api-accessible / FLS) | Salesforce's permission error | Rejects with the requirement pointed at the **Integration User**: "The Integration User can't read `Lead.AnnualRevenue` — grant field-level access on its profile/permission set." |
| **Record not found** (`404 NOT_FOUND`) | the id that missed | Rejects: "Salesforce has no <object> '<id>' (it may be in another org or was deleted)." — not a bare 404. |
| **Required field missing on create** (`REQUIRED_FIELD_MISSING`) | the field name from SF | Rejects: "Salesforce refused the create: `Task.Subject` is required — add it to the action's fields." |
| **Validation rule / trigger rejection** (`FIELD_CUSTOM_VALIDATION_EXCEPTION`) | the verbatim validation message | Rejects with SF's own message (already human-authored by the org's admin) — the run fails with the true reason, never a silent no-op. |
| **Approval submit rejected** (no active process for the object / `ALREADY_IN_PROCESS`) | Salesforce's process error | Rejects: "Salesforce couldn't submit <id> for approval: it's already in an approval process (`ALREADY_IN_PROCESS`)." / "no active Approval Process is defined for <object>." |
| **API daily limit exceeded** (`REQUEST_LIMIT_EXCEEDED`) | the limit state | An **action** rejects with the limit; the **poller** logs it loudly and **does not advance the cursor** (§7.4) — no cursor loss, retries next cadence. |
| **Poll tick failed** (any of the above during a poll) | the real reason | Loud `log`, cursor **not** advanced; next tick retries from the same boundary (§7.4). Never a silent dead poll. |
| **Backstop limit exceeded** (§9) | the limit + attempted value | Rejects **before** the call: "createRecord on 'Account' is not in the configured `salesforce.limits.createAllowedObjects` — add it or route through a gate." |
| **API version removed** | Salesforce's version error | Rejects: "Salesforce API version '<v>' is no longer served — bump `apiVersion` in Settings." (all shapes are in `salesforce-api.ts`, so the bump is one file). |

The connector **never** catches-and-drops. Where Salesforce returns a precise
`errorCode`/`message`, the connector forwards *that*; the action-runner's job is
only to prefix it with the node/action.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Salesforce org**, matching saiife's existing seams
(pure modules, injected backends, injected clock, fixture events):

- **`SalesforceApi` interface + `MockSalesforceApi` seam.** `salesforce-api.ts` is
  written *against* a `SalesforceApi` interface (`query`, `getRecord`,
  `createRecord`, `updateRecord`, `submitForApproval`); the real impl wraps the
  REST transport + `salesforce-auth`. Tests inject a `MockSalesforceApi` returning
  canned records and canned Salesforce error arrays / throttle envelopes. **No test
  ever performs a live Salesforce call**; CI has no Salesforce credentials. (Same
  posture as PostHog's `MockPostHogApi` and the `SessionManager` `spawnFn` seam.)
- **`salesforce-poller` tests with the injected clock** — feed a `MockSalesforceApi`
  returning a growing record set; **advance the injected `now()`** and call `tick()`
  directly (no real waiting). Assert: the **first tick baselines without firing**;
  a later-modified record fires **once**; the `(LastModifiedDate, Id)` boundary row
  does **not** re-fire; a `MockSalesforceApi` that throws leaves the cursor
  **un-advanced** and logs loudly; a persist-that-throws-after-emit does **not**
  double-seed (the seen-set). The reconcile correctness lives here.
- **`salesforce-normalize` unit tests** — pure function; assert every raw record →
  the pinned `SalesforceRecordContext` (§6.3): `attributes` stripped, **15→18-char
  Id** normalization, number fields stay numbers, the Lightning URL built, absent
  fields handled. The correctness boundary the conditions track depends on — guarded
  hardest.
- **`salesforce-connector` dispatch tests** — with a `MockSalesforceApi`: assert
  `invokeAction('salesforce','getRecord',…)` resolves the normalized context; assert
  a Salesforce error array **rejects** with the verbatim `message` (the pinned
  failure convention); assert `submitForApproval` posts a `Submit` request and
  resolves; assert a missing-`id` param **rejects** (async), not throws; assert the
  backstop limit rejects before the mock is called.
- **`salesforce-auth` tests** — with a fake token endpoint + a fake `SecretBackend`:
  assert JWT-bearer and client-credentials each mint + cache a token; assert a
  `401 INVALID_SESSION_ID` triggers exactly **one** re-mint + retry; a regression
  guard asserts **no key/secret/token value appears** in any emitted
  log/console/error string (the secret rule).
- **Engine integration test (offline)** — wire the real `FlowEngine` + the registry
  with the Salesforce connector over a `MockSalesforceApi`, drive the §7 flagship:
  a poll `SeedEvent` for a new Lead → assert the read/enrich writes context → assert
  the router selects the high-value edge → assert the gate pauses `needs-you` →
  assert on approval `createTask` + `submitForApproval` hit the mock. Deterministic
  via the engine's injected `now()`.
- **Snapshot test on `salesforceDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

No test requires Salesforce credentials or a live org; the real REST API is
exercised only in manual dogfooding against a Developer Edition / sandbox org.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **JWT-bearer vs client-credentials for MVP.** Both are designed (§8). JWT-bearer
   stores **no shared secret** (a keypair, re-minted assertions) but needs
   certificate management + the connected app's admin-pre-authorization of the
   Integration User. Client-credentials is **simpler to stand up** (no keypair, a
   consumer secret in the keychain, a run-as user) and is Salesforce's current
   recommendation for server-to-server. **Recommendation:** pin **client-credentials
   for the walking skeleton** (fastest to a dogfoodable worker, one secret in the
   keychain), keep JWT-bearer designed-for behind the same `salesforce-auth` seam.
   Flagged because it changes which secret field is required (§5) and the
   connected-app setup the user does.
2. **Poll vs Pub/Sub API (gRPC) for the trigger.** MVP is **poll-primary** (§7) —
   GA, no gRPC dependency, no CDC enablement, no org config beyond the Integration
   User's read access, and it reuses the email/PostHog machinery. **Pub/Sub API**
   (CDC/Platform Events over gRPC, replay-id cursor) is the **phase-2** low-latency
   upgrade (§7.5) behind the same cursor + `SeedEvent` seam. Flagged: if
   near-real-time is a hard product requirement for the first sales-worker demo,
   Pub/Sub moves up — but it is a materially heavier ingress.
3. **Reconcile field: `LastModifiedDate` vs `SystemModstamp`.** `LastModifiedDate`
   is the classic reconcile field (moves on user + API edits); `SystemModstamp`
   also moves on **system** updates (e.g. rollups, some automations), catching
   changes `LastModifiedDate` misses but firing on noise. MVP pins
   `LastModifiedDate` (matches the research + the intuitive "someone changed this
   record"); flagged so a store that needs system-driven changes can switch the
   `record.updated` cursor field.
4. **The CRM safety backstop — default present or absent, and at what values?** §9's
   `salesforce.limits` is proposed **optional, off by default** (the author's gate
   is the primary control). But a shipped sales worker arguably *should* default to
   a conservative floor (e.g. `updateRequiresGate: true`, an object allow-list) so a
   mis-authored flow can't mass-update Accounts. A product-safety call, not a
   technical one — flagged before the backstop phase. Whatever the default, it is
   **deterministic** (saiifeguard-style), never model-mediated.
5. **Connected App vs External Client App (Spring '26).** Salesforce positions
   **External Client Apps** as the go-forward vehicle (§8). MVP builds on a Connected
   App (still supported); the auth module is drawn so the migration is a
   registration/config change. Flagged: if the org's admin prefers to provision an
   External Client App from day one, that is supported at the same token endpoint —
   only the app-registration surface differs.
6. **Closed-loop approval resume (§9.2).** Whether MVP ships only fire-and-forget
   `submitForApproval` or also the phase-2 wait-and-branch-on-decision (a second
   poll + run suspend/resume). Leaning fire-and-forget for MVP; flagged so the
   templates track wires the starter approval flow with eyes open.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One org, one flow, the read + one gated write, happy path:**

1. `IntegrationId` gains `'salesforce'` (+ the 3 lockstep touch-points, §6.0);
   `salesforceDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from
   config + keychain presence (free from the hub).
2. `salesforce-auth` (the pinned fork, §13.1) mints + caches a token against a fake
   endpoint in tests, real endpoint in dogfood; the keychain holds the credential.
   `status('salesforce') === 'connected'`.
3. `salesforce-api` behind `SalesforceApi`: `query` + `getRecord` reads live;
   `createTask` write live. `salesforce-normalize` produces `SalesforceRecordContext`.
4. `SalesforceConnector` registered via `registerConnector('salesforce', …)`;
   `invokeAction('salesforce',…)` reaches it; `subscribe('salesforce','record.created',
   handler, { object:'Lead' })` reaches the poller.
5. `salesforce-poller` running the `record.created` SOQL for `Lead` on the injected
   clock, `(CreatedDate, Id)` cursor, baseline-without-firing, loud degradation,
   emitting a `SeedEvent`.
6. On the canvas: `[record.created:Lead] → [getRecord] → [gate] → [createTask]` runs
   end-to-end against a Developer-Edition org. Errors per §11.

That slice proves the whole loop (a real new Lead wakes a real flow that reads it
and, behind a gate, files a follow-up Task) and is dogfoodable.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton above. Single org, single environment.
  `record.created` + `query`/`getRecord` + `createTask` + author gate.
- **Phase 2 — full vocabulary + the native gate:** `record.updated` (the
  `LastModifiedDate` reconcile); `createRecord` / `updateRecord`; **`submitForApproval`**
  (fire-and-forget, the distinctive native-gate fit, §9.1); the email/agent
  enrichment composition wired by the templates track.
- **Phase 3 — closed-loop approval + deterministic backstop:** the phase-2
  approval *resume* (poll `ProcessInstance`, suspend/resume the run, §9.2); the
  `salesforce.limits` policy (§9) with the default decided (§13.4).
- **Phase 4 — richer conditions consumption:** once the conditions track lands
  `FlowEdgeCondition` (§10), verify the pinned fields drive `gt`/`lte`/`contains`/
  `truthy`/`exists` end-to-end; ship the "high-value-lead" template.
- **Phase 5 — Pub/Sub API push:** the gRPC CDC/Platform-Events subscriber (§7.5)
  behind the same cursor + `SeedEvent` seam, as the low-latency alternative to the
  poll for high-volume orgs.
- **Phase 6 — External Client App + multi-org:** migrate auth to an External Client
  App (§13.5); an `orgs[]` config array for multi-org isolation. Enterprise
  distribution viability.

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` contract this connector satisfies;
  `IntegrationId` (edited, §6.0); `INTEGRATION_IDS`; `IntegrationStatus`;
  `ResolvedIntegrationDescriptor`.
- `src/main/integrations/integration-registry.ts` — `registerConnector` (`:54`),
  the `invokeAction`/`subscribe` delegation (`:73-103`, incl. the **config forward**
  a poll connector needs), `deriveStatus`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the token
  store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError`
  (feeds `status()`).
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `salesforce`;
  `descriptors/posthog.ts` is the poll-descriptor template.
- `src/main/net/ssrf-guard.ts` — `checkBaseUrl` / `blockedIpRange` for the
  instance / login URL (§4.4).
- `src/main/posthog/posthog-poller.ts` + `posthog-cursor-store.ts` — the reference
  poll backbone (injected clock, `(ts, id)` cursor, baseline-without-firing,
  seen-set, loud degradation) the Salesforce poller mirrors.
- `src/main/email/provider.ts` — the original `reconcile(cursor)` + `MailboxCursor`
  the poll lineage descends from.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called, the
  **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — `SeedEvent` / `coerceEvent` / `matchesFilter`:
  how a poll `SeedEvent` seeds a run.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`record.fields.Amount`) + boolean routing over the pinned fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` the poller shares.
- `src/main/flow/flow-model.ts` — the `INTEGRATION_IDS` allow-list (edited, §6.0);
  the strict graph validator.
- `guard/` (saiifeguard) — the deterministic-guard *posture* the optional CRM backstop
  (§9) borrows (a policy floor under the author's gates, no model in the loop).
</content>
</invoke>
