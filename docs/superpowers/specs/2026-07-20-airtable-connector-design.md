# Airtable Connector — Design

**Date:** 2026-07-20
**Status:** Design (spec) — not started. Feasibility is **DONE** (verdict below is
carried, not re-derived). Design-approval gate for the **structured-data worker**
product direction. Anchor connector for "a worker that operates a structured
tracker assembled on the drag-drop canvas" and the first **poll-primary,
ping-only-webhook** connector in the family.
**Feature:** An **Airtable connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. It lets a flow author wire a structured-data worker on
the canvas: a **new or changed record** in an Airtable table **triggers** a run,
the flow **reads** rows through the Airtable Web API, an **agent** node forms a
judgment on the row facts, and — behind gates the author places — the flow
**acts** by writing cells back (create a row, update a row). It does **not**
hardcode a workflow; the authority lives in the flow (conditions on edges, gates
where the author puts them, the agent's judgment surfaced as context), exactly as
the flow engine already enforces.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` / `registerConnector` contract in
`src/shared/integrations.ts` and copies the module shape of the merged **PostHog**
connector (`src/main/posthog/*`) — the family's other **poll** connector — plus
`src/main/shopify/*` for the descriptor/token/normalize skeleton and
`src/main/integrations/*` for the hub: CredentialStore keychain,
descriptor-as-code, presence-derived `status()`, the `LiveConnector`
live-dispatch seam. It uses the merged **Shopify connector spec**
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`) as its style and
depth template, and the **HubSpot connector spec**
(`docs/superpowers/specs/2026-07-18-hubspot-connector-design.md`) as the sibling
"read → agent judgment → gated write" loop reference.

**The one design point that defines this connector.** Airtable *has* a webhooks
API, but a delivered webhook **notification is a bare PING — it carries no change
payload**, only `{ base, webhook, timestamp }`. The actual changed records are
retrieved by **polling the webhook's `/payloads` endpoint with a persisted
integer cursor**. So Airtable's trigger is **not** a webhook-payload → `SeedEvent`
path like Shopify/Woo/Linear/HubSpot; it is a **reconcile POLL with a persisted
cursor**, modeled directly on the merged **PostHog poller**
(`posthog-poller.ts` + `posthog-cursor-store.ts`) and the **email reconcile**
(`email/provider.ts reconcile(cursor)`): a cadence keyed off the **injected
clock**, a persisted cursor advanced only after handoff, and the trigger **node
config** carrying *what* to poll (base / table / view). The signed ping is, at
most, a **latency optimization** that wakes the poll early — never the source of
truth (§4.5).

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, a
structured-data worker that wakes when a row is created or changed in an Airtable
table, reads the relevant rows through the Airtable Web API, lets an agent node
judge them, routes on that judgment via edge conditions, and performs gated cell
writes (create row / update row) — with the personal access token in the OS
keychain, **never** rendered.

### In scope (MVP)

- A new **Airtable connector** module set under `src/main/airtable/`, exposing a
  static `airtableDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus a **live** `LiveConnector` registered with the merged
  registry via `registerConnector('airtable', …)` (`integration-registry.ts:54`).
- **Auth:** a **Personal Access Token (PAT)** — the single `Authorization: Bearer
  <pat>` header — stored in the keychain via `CredentialStore` (the `safeStorage`
  pattern the hub already set). Scopes granted on the PAT:
  `data.records:read`, `data.records:write`, `schema.bases:read`, and (for the
  ping path, phase 2) `webhook:manage`.
- A **Web API client** (`airtable-api.ts`) — the **sole** place any Airtable API
  shape lives — implementing the read + write surface behind the pinned actions
  (§3.2) **and** the `/payloads` cursor read behind the poll trigger (§4), with
  the **5 requests/second per base** cap handled by a token-bucket + the 30-second
  429-lockout backoff (§9).
- **The reconcile poll trigger** (`airtable-poller.ts` + `airtable-cursor-store.ts`),
  the KEY design (§4): a persisted **integer cursor** per watched base, advanced
  only after the changed records are handed to the engine; a cadence keyed off the
  **injected clock** (`deps.now`, the `flow-engine.now()` seam) so tests advance
  time deterministically with no real waiting; the trigger node **config** (base /
  table / view / change-types) read by the poller when it registers the
  subscription — exactly the PostHog `subscribe(triggerId, config, handler)` shape.
- The **pinned structured-data vocabulary** (§3): two poll-backed triggers, two
  read actions, two gated-write actions, and the **context-field shape** an action
  writes for downstream edge conditions and the agent node.
- **Authority = the flow's gates + the author's graph.** Every write is an
  `action` node the author gates by placing a `gate` node (or a conditional edge)
  before it; the **agent judgment** is an `agent` node whose output feeds an edge
  condition or gate. The engine already enforces this
  (`flow-engine.ts` gate handling, `node-runners/agent-runner.ts`,
  `node-runners/action-runner.ts`). No write ever runs un-gated by construction of
  the flow the author drew.
- **Single account, single saiife environment.** Config-as-code `airtable`
  block in `config.json` (non-secret refs only — base id, table, poll cadence,
  environment); PAT (and, phase 2, the webhook MAC secret) in the keychain.

### Out of scope (MVP) — explicitly deferred

- **The signed-ping latency optimization** (§4.5). MVP is a **pure cadence poll**
  of `/payloads`; the webhook that PINGs to wake the poll early (and the shared
  webhook receiver + `webhook:manage` scope + MAC-secret keychain entry it needs)
  is **phase 2**. This is the single biggest scope cut and it keeps MVP free of
  cloud ingress entirely (§4.5, §11.1).
- **Programmatic webhook creation / refresh.** Airtable webhooks **expire after 7
  days** without a refresh; the create/refresh lifecycle (`webhook:manage`) is
  bound to the phase-2 ping path (§4.5, §11.4).
- **Destructive writes.** No `deleteRecord`, no PUT-style full-record replace. MVP
  writes are additive/partial only: `createRecord` (POST) and `updateRecord`
  (PATCH — partial). Deletes/replace are phase 2+ behind a gate and a backstop.
- **Schema/metadata writes** (create tables, add fields, change field types via the
  Meta API). MVP reads records and writes cell values into an **existing** schema.
- **Batch writes > the happy single-record path.** Airtable accepts ≤10 records per
  write request; MVP writes one record per action node. Batching is phase 2.
- **Flow templates / the "starter tracker worker" graph.** Owned by the templates
  track, which consumes §3 verbatim.
- **An Airtable-specific deterministic backstop** (per-action limits à la saiifeguard).
  Named as a phased item (§7.3, §12 Phase 3); the author's gate is the MVP control.

---

## 2. Feasibility + landscape (DONE — carried, not re-derived)

Feasibility is complete; this section records the verdict the design rests on.
Grounded in the CRM/structured-data research
(`scratchpad/research/E-crm-knowledge.md` — the same corpus the HubSpot spec
carried) and the current **Airtable Web API** developer docs.

### 2.1 Why Airtable is the structured-data anchor

| Platform | API posture for the wake → read → judge → act loop | Verdict |
|---|---|---|
| **Airtable** | First-class **Web API** (list/get/create/update records via `GET`/`POST`/`PATCH /v0/{baseId}/{table}`), a clean **single PAT** for auth, and a **change-data-capture stream** (`/payloads` with a monotonic integer cursor) that captures create **and** update **and** delete for a whole base. Its webhooks only PING (no payload), so the trigger is a **cursor poll** — which is *simpler and more complete* than a per-event webhook because one cursor covers all change types with no dedup. Huge no-code install base of exactly the "structured tracker" users this direction targets. | **Chosen.** Best structured-CDC story; the loop is buildable today. |
| **Notion (databases)** | Capable API (query a database, create/update pages), but **no change stream at all** — the only trigger option is polling `last_edited_time`, which misses deletes and needs a per-row timestamp. Thinner typing (everything is a rich-text/property blob). | Deferred. A good *second* target — its poll-only, no-CDC shape validates the poller boundary further. |
| **Google Sheets** | Ubiquitous, but the API is cell/range-oriented, not record-oriented; "a changed row" has no first-class identity or change feed (Apps Script push notifications are a different, heavier ingress). High variance per sheet layout. | Deferred. Peer connector under the same poll boundaries; weakest typing. |

**Airtable-first rationale:** it is the one structured-data platform whose change
feed is a **first-class, cursor-based CDC stream** (`/payloads`) — which maps
*perfectly* onto the merged PostHog poller's persisted-cursor discipline — plus
the cleanest single-token auth and a genuinely record-oriented, typed model
(fields have types) that gives conditions and the agent a stable fact set.
Notion/Sheets become *peer connectors* under the same `*-connector` / `*-api` /
`*-poller` / `*-cursor-store` boundaries, each its own poll shape.

### 2.2 The Airtable Web API for wake → read → judge → act

- **Go-forward surface is the Web API** (`https://api.airtable.com/v0/`). Reads:
  `GET /v0/{baseId}/{tableIdOrName}` (list, with `filterByFormula`, `view`,
  `pageSize` ≤ 100, `sort`, `fields`, `offset` pagination) and
  `GET /v0/{baseId}/{tableIdOrName}/{recordId}` (one record). Writes:
  `POST /v0/{baseId}/{tableIdOrName}` (create, `{ fields }`) and
  `PATCH /v0/{baseId}/{tableIdOrName}/{recordId}` (partial update, `{ fields }`).
  Every record is `{ id, createdTime, fields: { … } }`. All GA.
- **Auth.** A **Personal Access Token** (`pat…`) sent as `Authorization: Bearer
  <pat>` on every request. Single long-lived secret → keychain. No OAuth dance in
  MVP. (The OAuth "product" fork — a distributable Airtable OAuth integration
  minting per-user tokens — is designed-for and deferred, §5, §11.1.)
- **The trigger — a PING-only webhook backed by a `/payloads` cursor (the crux).**
  A webhook is created on a base (`POST /v0/bases/{baseId}/webhooks` with a
  `notificationUrl` + a `specification` that scopes tables / data types / change
  types) and returns a webhook `id` **and a one-time `macSecretBase64`**. When data
  changes, Airtable POSTs a **bare ping** to `notificationUrl` — body is only
  `{ base: { id }, webhook: { id }, timestamp }`, **no records** — signed with
  `X-Airtable-Content-MAC: hmac-sha256=<hex>` (HMAC-SHA256 over the raw body using
  the base64-decoded MAC secret). To read the *actual* changes you call
  **`GET /v0/bases/{baseId}/webhooks/{webhookId}/payloads?cursor={n}`**, which
  returns `{ payloads: [ { timestamp, changedTablesById: { createdRecordsById,
  changedRecordsById, destroyedRecordIds }, … } ], cursor: <nextInt>, mightHaveMore }`.
  The **cursor is a monotonic integer**; payloads are retained 7 days; the webhook
  **expires after ~7 days** without a refresh (`POST …/webhooks/{id}/refresh`).
  **Consequence for saiife:** the ping cannot seed a run (it has no data), so
  the trigger is a **poll of `/payloads`** — with a persisted cursor and an
  injected clock — exactly the PostHog/email reconcile shape (§4).
- **Rate limits — 5 requests/second per base is the sharp edge.** Exceeding it
  returns **429 with a 30-second lockout** (all requests to that base rejected for
  ~30s). The client owns a per-base token bucket + a 30-second-aware backoff (§9).
  A slow cadence poll + a few reads/writes per run stays far under budget; the cap
  only bites on fan-out (a `listRecords` over many pages, or a batch write).

### 2.3 Constraints (why not pure GREEN-with-no-caveats)

1. **The trigger is a POLL, by construction, not a push.** The ping has no
   payload, so there is a **latency floor** equal to the poll cadence (default
   60s, §4.3). The phase-2 signed ping narrows it but never removes the poll — the
   poll is always the source of truth (§4.5). Honest latency cost, not a gap.
2. **"Updated" needs the CDC stream OR a Last-Modified field.** `record.created`
   is trivially pollable (the `createdTime` on every record). `record.updated` is
   *only* reliably detectable via the `/payloads` change stream (or a user-added
   "Last Modified Time" field). MVP uses the `/payloads` stream for both, so a
   webhook (for the cursor stream) exists even though its **ping** is ignored in
   MVP — see §4.1 for the two poll strategies and which MVP pins.
3. **Webhook 7-day expiry.** The `/payloads` cursor stream lives on a webhook that
   expires without a refresh. MVP's cursor-poll needs the webhook alive → a refresh
   discipline (bound to `webhook:manage`) is a documented v1 prerequisite (§4.4,
   §11.4). The alternative — a `listRecords`-timestamp poll with **no** webhook —
   is the fallback that removes this constraint at the cost of missing updates/deletes
   (§4.1 open decision).
4. **5 req/sec per base + 30s lockout.** A real cap with a punishing penalty,
   handled deterministically client-side (§9). Not a blocker; a throttle discipline
   the client owns — and the poll cadence keeps steady-state well under it.

### 2.4 Verdict: **GREEN**

The wake → read → judge → act loop is **fully buildable today** on the GA Web API,
with a clean single-PAT auth and a first-class cursor-based change stream. It is
GREEN because every surface the loop needs (list/get/create/update records, the
`/payloads` cursor CDC) is **generally available and stable**, and the trigger
maps *directly* onto the already-merged PostHog poller. The four constraints in
§2.3 are an inherent poll-latency floor, a "updated needs the stream" derivation,
a known 7-day-refresh chore, and a documented rate cap with a deterministic
answer. Nothing in the loop is blocked or preview-gated.

---

## 3. Pinned structured-data vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `airtable-descriptor.ts` guards the ids; the field shape is guarded by the
> `airtable-normalize.ts` tests.

### 3.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'airtable'`:

```ts
export type IntegrationId =
  | 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'posthog'
  | 'gitlab' | 'slack' | 'http' | 'stripe' | 'github' | 'sentry' | 'hubspot'
  | 'airtable'
```

This is a **shared-union edit** with three companion touch-points that must move
in lockstep (each a one-line add):

1. `INTEGRATION_IDS` — the stable order array (`src/shared/integrations.ts:99`).
2. the `INTEGRATION_IDS` allow-list **set** in the flow validator
   (`src/main/flow/flow-model.ts:29`).
3. `DESCRIPTOR_DEFS` — the id→def map (`src/main/integrations/descriptors/index.ts:19`),
   plus the `airtableDescriptor` import (the descriptor lives at
   `src/main/airtable/airtable-descriptor.ts`, like `shopify`/`slack`/`stripe`,
   not under `descriptors/`).

No other `IntegrationId` consumer needs a change — they iterate the array.

### 3.1 Triggers (poll-backed — NOT webhook-payload)

| trigger id | label | underlying Airtable source | note |
|---|---|---|---|
| `record.created` | New record created | The `/payloads` CDC stream, `createdRecordsById` — filtered to the config's table (and, if set, `view`). | Also expressible as a `createdTime` `listRecords` poll (§4.1) — the stream is preferred for parity with `record.updated`. |
| `record.updated` | Record changed | The `/payloads` CDC stream, `changedRecordsById` — filtered to the config's table (and optional `view` / watched field ids). | *Requires the CDC stream* (§2.3.2). The changed field set is surfaced on the payload so a template can narrow further. |

**Both triggers are a POLL of `/payloads` with a persisted cursor** (§4). The
trigger node's **config** carries `baseId`, `tableId` (or table name), an optional
`viewId`, and (for `record.updated`) an optional `watchFieldIds` filter — read by
the poller when it registers the subscription, exactly as the PostHog poller reads
`insightId`/`cohortId`/`threshold` (`posthog-connector.ts:117-135`). A
`record.enteredView` variant (a row entering a filtered view) is a natural phase-2
addition off the same stream and is **not** pinned here.

**Composition with email.** As with the ecom/sales workers, a structured-data
worker's other common wake-up is an inbound *message* — the **email** connector's
domain. Airtable triggers cover *row* changes; the email trigger covers *inbound
messages*, joined by reading the row via `listRecords(filterByFormula:)` on an
email/id field. This spec pins the Airtable triggers; the templates track wires the
composition.

### 3.2 Actions

**Read (no gate needed — pure reads write facts for conditions and the agent):**

| action id | label | Airtable Web API | writes to context |
|---|---|---|---|
| `listRecords` | List records | `GET /v0/{baseId}/{table}` (`filterByFormula`, `view`, `pageSize`, `sort`, `fields`) | `{ records: AirtableRecordContext[]; count }` (§3.3) |
| `getRecord` | Get a record | `GET /v0/{baseId}/{table}/{recordId}` | `AirtableRecordContext` (§3.3) |

**Gated write (the author places a gate before these):**

| action id | label | Airtable Web API | note |
|---|---|---|---|
| `createRecord` | Create a record | `POST /v0/{baseId}/{table}` (`{ fields }`, optional `typecast`) | Idempotency risk (dup rows) — the connector surfaces Airtable's error legibly (§9). |
| `updateRecord` | Update a record | `PATCH /v0/{baseId}/{table}/{recordId}` (`{ fields }`, **partial**) | The flagship write — set cell values on an existing row. Partial by design; no PUT/replace in MVP (§1 out-of-scope). |

**Failure convention (pinned):** a write that fails **rejects** its promise with
the real Airtable error text; a resolved promise (any value) is success and its
value becomes the node's context output (`action-runner.ts`, the
`LiveConnector`/`IntegrationRegistry` contract, `integrations.ts:43-86`). The
connector never resolves a sentinel-failure. The dispatch is `async` so a
synchronous validation throw (a missing `recordId`) surfaces as a **rejected**
promise, exactly as `posthog-connector.ts:71` documents.

### 3.3 Context-field shape (what an action writes for later conditions + the agent)

A read action writes a **normalized, stable** object under its node id
(`airtable-normalize.ts` produces it). Airtable's records are typed but
free-form: the connector keeps the raw `fields` bag **and** surfaces a small set
of stable envelope fields, so conditions can read either a known envelope path or
a user field by name. Downstream edge conditions read via dotted paths
(`context.ts` `resolveField`), e.g. `field: 'getRecord.record.fields.Status'`; the
**agent** node reads the same context as its judgment input. **Pinned shape:**

```ts
// src/shared/airtable.ts
export interface AirtableRecordContext {
  record: {
    id: string                        // Airtable record id, e.g. "recABC123"
    createdTime: string               // ISO 8601 (present on every record)
    /**
     * The record's cells, keyed by FIELD NAME, values as Airtable returns them
     * (string | number | boolean | string[] | attachment[] | …). Deliberately
     * NOT re-typed: Airtable fields are user-defined, so the author references
     * `record.fields.<Field Name>` and the condition/agent interprets the value.
     * Normalization here is limited to: omit empty fields → undefined (so
     * `exists` works), and NEVER coerce — a "currency"-typed field is already a
     * `number`, so it compares numerically without a money pass (§7.4).
     */
    fields: Record<string, unknown>
  }
}
```

The poll trigger's `SeedEvent` payload is the same normalized record plus the
change envelope (`{ record: AirtableRecordContext['record'], changeType:
'created' | 'updated', changedFieldNames?: string[], baseId, tableId }`), so a
template can branch on `changeType` or on which fields changed.

**Why keep `fields` raw rather than a fixed schema:** unlike Shopify orders or
HubSpot deals, an Airtable table's columns are **whatever the user defined** —
there is no canonical field set to normalize to. Pinning a fixed shape would be a
lie. Instead the connector pins the **envelope** (`id`, `createdTime`, `fields`,
and the change metadata) and leaves the cells addressable by name. The
normalization guarantee is narrow and honest: **envelope stability + never-coerce
+ empty→undefined**, so `record.fields.Status eq "Done"` and
`record.fields.Score gt 80` and `exists record.fields.Owner` all behave. The
templates track and the conditions track rely on these exact envelope paths.

---

## 4. The KEY design — the `/payloads` cursor poll (ping → poll, not push)

This is the section the connector exists to get right. It is modeled **verbatim in
discipline** on the merged PostHog poller (`posthog-poller.ts`,
`posthog-cursor-store.ts`) and the email reconcile (`email/provider.ts
reconcile(cursor)`), because Airtable's ping-only webhook makes a poll the only
honest ingress.

### 4.1 Two poll strategies — which MVP pins

| Strategy | Mechanism | Captures | Cost |
|---|---|---|---|
| **A — `/payloads` cursor** *(pinned)* | Create a webhook on the base (for the cursor stream), then `GET …/webhooks/{id}/payloads?cursor={n}` on a cadence; advance `n` after handoff. | **create + update + delete**, per change, with a monotonic integer cursor (**no dedup math needed** — the cursor is authoritative). | Needs a webhook (7-day refresh, §4.4) + `webhook:manage`. |
| **B — `listRecords` timestamp poll** *(fallback)* | `GET /v0/{baseId}/{table}?sort=createdTime` (or a "Last Modified" field), cursor = newest `(timestamp, recordId)`. | **create** always; **update** only if a Last-Modified field exists; **never delete**. | No webhook, no `webhook:manage`; simplest. Mirrors PostHog `event.matched` exactly. |

**MVP pins Strategy A** for `record.created` + `record.updated` parity and delete
capture, and because the integer cursor is *simpler* than PostHog's `(ts, uuid)`
boundary dedup — Airtable's cursor is authoritative and monotonic, so there is no
same-timestamp boundary case. **Strategy B is the flagged fallback** (§11.2): if
the 7-day-refresh / `webhook:manage` chore is unwanted, a `createdTime`
`listRecords` poll is a drop-in `record.created`-only trigger that reuses the same
poller/cursor-store with a `(timestamp, recordId)` cursor — literally the PostHog
`event.matched` code path.

### 4.2 The poller (mirrors `posthog-poller.ts`)

`airtable-poller.ts` owns one subscription per `(baseId, tableId, viewId?,
triggerId)`, keyed like `posthog-poller.ts subscriptionKey`. Per subscription:

- **Injected clock.** The cadence is keyed off `deps.now` — the same
  `flow-engine.now()` seam PostHog uses (`posthog-poller.ts:41`) — so tests
  advance time and call `tick()` directly with **no wall-clock `setInterval`** in
  the tested core (§10). Default cadence 60s (`pollSeconds`, §8), configurable.
- **Cursor = the webhook's integer cursor.** Stored in `airtable-cursor-store.ts`
  (§4.3). One cursor per **webhook** (a webhook can watch multiple tables via its
  specification), and the poller **fans a fetched payload batch out** to every
  subscription whose `(tableId, viewId, changeType)` filter matches — so two flows
  watching the same base share one webhook + one cursor and one `/payloads` call.
- **Advance-after-handoff (at-least-once).** The cursor is written **only after**
  the changed records are handed to the subscription handlers (the
  `posthog-poller.ts:270 commitCursor` discipline). A crash mid-poll re-fetches
  from the last durable cursor rather than dropping a change. Because the Airtable
  cursor is monotonic and Airtable de-duplicates payloads by cursor, a re-fetch of
  the same cursor returns the same batch — a small per-subscription `seen` set of
  `changeType:recordId:baseTransactionNumber` (as `posthog-poller.ts Subscription.seen`)
  makes a re-emit after a persist-failure a no-op → honest at-least-once, effective
  exactly-once across a persist retry.
- **Baseline-without-firing on first observation.** On first subscribe the poller
  reads the webhook's **current** cursor and baselines to it **without firing**
  (the `posthog-poller.ts` "baseline WITHOUT firing" rule) — so an existing backlog
  of changes since webhook creation does not flood a run on startup. *Whether a
  tracker should instead replay the backlog is an open decision (§11.3).*
- **Loud degradation, never a silent dead poll.** A failed tick logs loudly and
  does **not** advance the cursor (`posthog-poller.ts:156-165` / §9 "Poll failed")
  — the next tick retries from the same cursor, so a signal is worked late, never
  lost. The one forbidden outcome is a silent dead poll.

### 4.3 The cursor store (mirrors `posthog-cursor-store.ts`)

`airtable-cursor-store.ts` persists each subscription/webhook cursor to a
**non-secret** sidecar (atomic temp-write + rename, as `posthog-cursor-store.ts`
and `credential-store.ts`). The Airtable cursor shape is trivially small:

```ts
export interface AirtableCursor {
  kind: 'payloads'
  webhookId: string
  cursor: number   // the monotonic integer to pass as ?cursor=
}
```

A missing/garbage sidecar is the normal first-run case → start empty, never throw
(`posthog-cursor-store.ts load()`). The sidecar holds **only** the cursor — never
a record, never the PAT, never the MAC secret.

### 4.4 Webhook lifecycle (the cursor stream must stay alive)

Strategy A needs a live webhook for its cursor stream. Airtable webhooks **expire
after ~7 days** without a refresh. The connector therefore:

- **Ensures a webhook exists** for each watched base/specification on connect
  (create-if-absent, `POST /v0/bases/{baseId}/webhooks`), persisting the returned
  `id` (non-secret ref) and the one-time **`macSecretBase64` → keychain** (only
  needed by the phase-2 ping path, §4.5).
- **Refreshes** it on a cadence comfortably under 7 days (`POST …/webhooks/{id}/refresh`),
  keyed off the injected clock like the email `renewWatch` deadline discipline
  (`email/provider.ts WatchHandle.expiresAt`). A refresh failure degrades loudly
  (§9), and the poll keeps working until the webhook actually expires.
- **MVP simplification (flagged, §11.4):** the create/refresh lifecycle can be
  **manual** (the user creates the webhook once and pastes its id) to defer
  `webhook:manage` and the refresh timer, or **programmatic**. Leaning
  programmatic-with-manual-fallback; flagged.

### 4.5 The signed ping — a latency optimization, deferred to phase 2

The Airtable ping IS signed (`X-Airtable-Content-MAC: hmac-sha256=<hex>` over the
raw body with the base64-decoded MAC secret), so when it lands it can be verified
and used to **wake the poll immediately** instead of waiting for the next cadence
tick. This is a **latency optimization only** — the ping has no data, so the poll
of `/payloads` remains the source of truth. When built (phase 2) it slots onto the
**shared webhook receiver** with near-zero new security code:

```ts
// The Airtable ping verifier — a config on the SHARED receiver (webhook-receiver.ts).
startWebhookReceiver<AirtablePing>({
  path: '/airtable/webhook',
  secret: revealForConnector('airtable', 'webhookMacSecret'),  // keychain, main-only
  verifier: {
    scheme: 'hmac',
    header: 'x-airtable-content-mac',
    encoding: 'hex',
    parseHeader: (raw) => {                    // 'hmac-sha256=<hex>' → { signature }
      const m = /^hmac-sha256=(.+)$/.exec(raw)
      return m ? { signature: m[1] } : null
    }
  },
  parse: (rawBody) => parseAirtablePing(rawBody)  // { baseId, webhookId } — NO records
})
```

The parsed ping carries only `{ baseId, webhookId }`; the connector's `onEvent`
handler **kicks the poller** to poll that webhook's `/payloads` now (bringing the
cursor forward), rather than seeding a run. So the shared receiver's
verify→parse→200-fast pipeline is reused, but the delivered "event" is a *wake*,
not a `SeedEvent`. This is why the receiver is **named as reused infra (phase 2)**
but the MVP has **no cloud-ingress dependency at all** (§7.2) — a clean, honest
MVP boundary. The MAC-secret-in-keychain, `webhook:manage` scope, tunnel/relay,
and refresh timer all belong to this phase.

---

## 5. Auth & keychain

- **PAT (MVP).** The user pastes a **Personal Access Token** into the descriptor's
  masked `personalAccessToken` field; it goes straight to the keychain via
  `CredentialStore.set` (`credential-store.ts:61`). Every Web API request sends it
  as `Authorization: Bearer <pat>` — read at call time via
  `revealForConnector('airtable','personalAccessToken')` (`credential-store.ts:99`,
  main-process-only, the sole plaintext exit; a grep test asserts no IPC/renderer
  caller). No OAuth, no refresh: the token is long-lived until the user rotates it
  in the Airtable developer hub. Scopes: `data.records:read`, `data.records:write`,
  `schema.bases:read` (for `listRecords` field selection); `webhook:manage` only
  for the phase-2 ping/refresh path.
- **Webhook MAC secret (phase 2 only).** The one-time `macSecretBase64` Airtable
  returns at webhook creation is stored the same way (`webhookMacSecret`), used
  **only** inside the shared receiver's Airtable verifier to check the ping's
  `X-Airtable-Content-MAC` (§4.5). Not present in MVP.
- **Honoring the global secret rule.** Neither the PAT nor the MAC secret is
  **ever** written to `config.json`, `sessions.json`, the transcript, a log, a PR
  body, or any IPC payload. `config.json` holds only **references** (base id,
  table, webhook id, poll cadence, environment — §8). Secret **state** (present /
  decrypt-failing) may be surfaced via `status()`; the **value** never is. This is
  the hub's existing discipline (`integration-config.ts` drops a secret found in
  config.json with a loud notice) applied to Airtable verbatim. The PAT is used
  **only** to build the Bearer header in `airtable-api.ts` and is never logged or
  returned (`posthog-api.ts:226-236` is the pattern).
- **"Product" fork (deferred, §11.1).** A distributable **Airtable OAuth
  integration** mints per-user tokens (refreshable, per-user scopes). The keychain
  shape already supports per-key storage; the additive change is an
  `airtable-oauth.ts` module and a per-account config array. Same `Authorization:
  Bearer` at call time — only *acquisition* differs.
- **Disconnect.** Clearing `personalAccessToken` (the hub's `clearSecret`) flips
  `status()` to `needs-config`; the connector stops dispatching and the poller
  tears down its subscriptions (`posthog-poller.ts stopAll`). No in-flight run is
  force-killed — it simply can't start a new Airtable action, and reports why (§9).

---

## 6. The flagship loop — structured tracker: read rows → agent judgment → gated updates

**Scenario the author drew on the canvas:** *"When a row is added to the 'Intake'
tracker, read it, let an agent classify it and draft a disposition; if the agent
says it's actionable, set the row's Status to 'Triaged' and write the agent's note
into the Notes cell; otherwise set Status to 'Needs review'."* This is **not**
hardcoded — it's the graph below, and the author could draw it a dozen other ways.

```
[trigger: record.created]               Airtable /payloads poll (cursor), filtered to 'Intake'
        │  payload → context['t'] = { record:{id,fields}, changeType:'created', ... }
        ▼
[action: getRecord]                     ref=getRecord, params={ recordId: "{{t.record.id}}" }
        │  invokeAction('airtable','getRecord',…) → airtable-api.getRecord() → normalize
        │  writes context['row'] = AirtableRecordContext
        ▼
[agent: "classify + draft disposition"] an AGENT node — judgment, NOT routing (§6 note)
        │  reads context['row']; writes context['judge'] =
        │  { actionable: boolean, note: string, category: string }
        ▼
[router]                                explicit branch point
   ├── edge condition: judge.actionable == true
   │        ▼
   │   [gate: "approve status change"]  author-placed; pauses run needs-you (optional)
   │        │  approved ▼
   │   [action: updateRecord]           params={ recordId:"{{t.record.id}}",
   │        │                                     fields:{ Status:"Triaged", Notes:"{{judge.note}}" } }
   │        │  invokeAction('airtable','updateRecord',…) → PATCH → resolves { record } → context
   │        ▼   (done)
   │
   └── edge condition: (else — not actionable)
            ▼
        [action: updateRecord]          fields:{ Status:"Needs review" }; done
```

Node-by-node against the engine:

1. **Trigger fires (a poll, not a push).** `airtable-poller` polls `/payloads`,
   sees a `createdRecordsById` entry for the 'Intake' table past the persisted
   cursor, normalizes it (`airtable-normalize`) to a `SeedEvent`
   (`{ eventId: changeType+recordId+txnNumber, payload: { record, changeType, … } }`),
   advances the cursor **after** handing it to the subscription handler →
   `trigger-subscriber` → `startRun` (`flow-engine.ts`). Trigger node is
   immediately `done`; payload is in `context['t']`.
2. **Read.** `getRecord` runs as an `action` node; the action-runner templates
   params (`recordId: "{{t.record.id}}"`), confirms `status('airtable') ===
   'connected'`, calls `invokeAction`; the connector calls `airtable-api`,
   `airtable-normalize` maps to `AirtableRecordContext`, the connector **resolves**
   it → the runner writes `context['row']`.
3. **Judgment (agent).** The `agent` node (`node-runners/agent-runner.ts`) reads
   `context['row']` and produces a **structured judgment** into `context['judge']`.
   As in the HubSpot loop: **the agent judges; it does not route.** Routing stays
   deterministic (step 4) over the agent's structured output — an LLM never
   silently decides which edge fires or which write runs.
4. **Route.** `selectEdges` evaluates each out-edge's condition over
   `context['judge']` — `judge.actionable === true`. Deterministic value compares
   (`VALID_CONDITION_OPS`, already merged).
5. **Gated write.** On the actionable branch, an author-placed `gate` may pause the
   run `needs-you`; on approval `updateRecord` PATCHes the row; an Airtable error
   **rejects** and the run fails with the real message (§9). On success the resolved
   `{ record }` is in context.
6. **Finish.** The else branch writes a disposition Status; the run completes `done`.

The same trigger + read + agent judgment support arbitrarily different graphs
(auto-tag by category, route uncertain rows to a human gate, enrich from a second
table via `listRecords`, roll a status forward on each poll). The connector
supplies capability + facts; the **agent supplies judgment; the author supplies
authority.**

---

## 7. Architecture in saiife

A new **main-process module set** under `src/main/airtable/`, mirroring
`src/main/posthog/` (the poll sibling) and `src/main/shopify/` (the descriptor/
token/normalize skeleton). It is **opt-in**: with no `airtable` config entry (and
no stored PAT) the descriptor's `status()` returns `needs-config` and the engine
refuses any Airtable node before any network call (`action-runner.ts`) —
saiife's "works with no integration" guarantee is unchanged. The connector is
the **live implementation behind the registry's pinned `invokeAction` /
`subscribe`**, registered via `registerConnector('airtable', connector)`
(`integration-registry.ts:54`) at startup in `src/main/index.ts`.

### 7.1 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/airtable/airtable-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'airtable'`, config fields, the pinned triggers/actions of §3). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids. Mirrors `descriptors/posthog.ts`. |
| `src/main/airtable/airtable-connector.ts` | Orchestrator + the live `LiveConnector` (`invokeAction`/`subscribe`). Dispatches an action id → an `airtable-api` call (params templated by the engine); dispatches a trigger id → a **poll** subscription with `airtable-poller` (reading the node `config` for base/table/view — the `posthog-connector.ts:117-135` shape). The one place the loop's dispatch lives. |
| `src/main/airtable/airtable-api.ts` | Thin **Web API client**. **All** Airtable request/response shapes (record endpoints, `/payloads` cursor read, webhook create/refresh, error envelope) live *only* here. Owns the **5 req/sec per-base token bucket** + the **30-second 429-lockout** backoff (§9). Isolated behind an `AirtableApi` interface so tests inject a `MockAirtableApi` (§10). Injects an HTTP transport seam + a `reveal` seam for the PAT (`posthog-api.ts` pattern); real HTTP may be deferred behind a `deferredLiveTransport` like PostHog. |
| `src/main/airtable/airtable-poller.ts` | The **reconcile poll backbone** (§4). Per-subscription cadence off the injected clock; `/payloads` cursor advance-after-handoff; baseline-without-firing; loud degradation. Fans a payload batch out to matching subscriptions. Direct analog of `posthog-poller.ts`. |
| `src/main/airtable/airtable-cursor-store.ts` | Persists each webhook's integer cursor to a **non-secret** sidecar (atomic write). Direct analog of `posthog-cursor-store.ts`; simpler cursor shape (§4.3). |
| `src/main/airtable/airtable-token-store.ts` | Keychain-backed PAT access — a **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('airtable', …)`). Named distinctly so a grep test asserts no IPC/renderer caller (the `revealForConnector` discipline). |
| `src/main/airtable/airtable-config.ts` | Reads the non-secret `airtable` refs from the integrations config block (base id, table, view, webhook id, poll cadence, environment) — the `integration-config.ts` validate-at-the-boundary pattern; holds only Airtable-specific coercion (base-id / table-name shape). |
| `src/main/airtable/airtable-normalize.ts` | **Pure** mapping: a raw record (`{ id, createdTime, fields }`) → the pinned `AirtableRecordContext` (envelope stability, empty→undefined, never-coerce — §3.3); and a raw `/payloads` batch → one `SeedEvent` per changed record with its `changeType` + `changedFieldNames`. Unit-testable in isolation (`posthog-normalize.ts` purity). The correctness boundary conditions + agent depend on. |
| `src/main/airtable/airtable-verifier.ts` *(phase 2)* | The ping HMAC config for the **shared receiver** (§4.5): `x-airtable-content-mac`, hex, `hmac-sha256=` prefix strip. Trivial; only the ping-wake path needs it. Not built in MVP. |
| `src/shared/airtable.ts` | Shared types (`AirtableRecordContext`, the action param shapes, the trigger `SeedEvent` payload shape) needed by both main and any renderer palette surface. |

### 7.2 Reused saiife surfaces (and what is deliberately NOT reused)

**Reused:**

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §3.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor`. The
  **optional 3rd `config` arg** on `LiveConnector.subscribe(triggerId, handler,
  config?)` (`integrations.ts:81-85`) is exactly what carries base/table/view to
  the poller — the poll-connector use the seam was designed for.
- `src/main/integrations/integration-registry.ts` — `registerConnector('airtable',
  …)` wires live dispatch (line 54); `subscribe` forwards the node `config` to the
  connector (line 102); `deriveStatus` gives Airtable its status for free.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses; `revealForConnector` (main-only plaintext exit, line 99),
  `decryptionError` (feeds `status()`).
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `airtable` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/index.ts` — `DESCRIPTOR_DEFS` gains
  `airtable`; `descriptors/posthog.ts` is the poll-descriptor template.
- `src/main/posthog/posthog-poller.ts` + `posthog-cursor-store.ts` — the **poll +
  persisted-cursor + injected-clock** pattern this connector copies wholesale
  (§4).
- `src/main/email/provider.ts` — the **reconcile(cursor)** discipline and the
  `WatchHandle.expiresAt` renewal deadline (§4.4) the webhook-refresh timer mirrors.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, how the resolved value lands in context.
- `src/main/flow/node-runners/agent-runner.ts` — the `agent` judgment node (§6).
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; the
  `SeedEvent` shape the poller emits; `coerceEvent` / `matchesFilter`.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`record.fields.Status`) + boolean routing over the pinned
  envelope.
- `src/main/flow/flow-engine.ts` / `flow-model.ts` — run lifecycle, gate handling,
  the injected `now()` (which the poller shares), the `INTEGRATION_IDS` allow-list
  (edited, §3.0), `VALID_CONDITION_OPS`.
- *(phase 2)* `src/main/webhooks/webhook-receiver.ts` + `src/main/server-timeouts.ts`
  — the shared receiver the ping-wake verifier registers with (§4.5). **No MVP
  dependency.**

**Deliberately NOT reused (stated for honesty):**

- `src/main/net/ssrf-guard.ts` — **not used.** Airtable's API host is the fixed
  cloud host `api.airtable.com`; there is no user-supplied base URL to guard. (The
  ping's `notificationUrl` is *our* tunnel/relay, an outbound registration, not an
  SSRF surface.) Unlike Woo/GitLab/PostHog self-host, Airtable has no self-host
  fork, so `checkBaseUrl`/`blockedIpRange` do not apply.
- `src/shared/money.ts` — **not used.** Airtable "currency" fields are already
  plain `number`s in the record `fields` bag; there is no minor-unit envelope to
  convert. If a cross-connector condition ever compares an Airtable number against
  a Stripe `Money`, the author formats it — the connector does not invent a money
  pass over user-defined fields (§3.3 never-coerce).

### 7.3 Authority & safety (note)

**Primary control — the flow's gates + the agent-judges-not-routes discipline.**
Every write (`createRecord`, `updateRecord`) is an `action` node the author gates;
the agent's judgment is **structured context an edge condition or gate reads
deterministically**, never a direct trigger of a write. The engine already
enforces gates (`flow-engine.ts`), a human "no" ends the run `rejected` (not a
failure), and a write with no path to it never runs. **The connector never
auto-writes outside the graph the author drew.** An optional **deterministic
Airtable backstop** (e.g. `airtable.limits`: max writes/run, forbid
`updateRecord` to a named field/table without a gate, a max-rows-touched ceiling)
is a phased item (§12 Phase 3), saiifeguard-style — flagged, not built in MVP.

---

## 8. The connector as an `IntegrationDescriptor`

The static half is an `airtableDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as it does for the
others — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `personalAccessToken` | Airtable personal access token | **yes** | yes | string | The `Authorization: Bearer` PAT. Keychain only. Placeholder `pat…`. |
| `webhookMacSecret` | Webhook MAC secret (phase 2) | **yes** | no | string | Verifies the ping's `X-Airtable-Content-MAC` (§4.5). Keychain only. Absent in MVP. |
| `baseId` | Base id | no | yes | string | `appXXXXXXXXXXXXXX`. Non-secret ref. |
| `tableId` | Table (id or name) | no | yes | string | The watched table; also the default write target. |
| `viewId` | View (optional) | no | no | string | Narrows `record.created`/`updated` and `listRecords` to a view. |
| `webhookId` | Webhook id (Strategy A) | no | no | string | The `/payloads` cursor stream's webhook (manual or connector-managed, §4.4). |
| `pollSeconds` | Poll cadence (seconds) | no | no | number | Default 60 (§4.2). Same field/validation as PostHog's. |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts Airtable work (same field/validation as the others). |

`status('airtable')` reports `needs-config` until `personalAccessToken`, `baseId`,
`tableId`, and `environment` are present; `error` if a stored secret can't be
decrypted (the hub's `decryptionError` path); `disabled` if
configured-but-turned-off; `connected` otherwise. The action-runner refuses any
non-`connected` Airtable node before any network call.

---

## 9. Error handling

Per the house error-message style (human language, actionable, carries the real
exception; no bare "not found / no connection"). A write signals failure by
**rejecting** its promise with that message; the action-runner prefixes it with
the node/action and surfaces it on the run. This mirrors `posthog-api.ts`'s
`mapClientError` exactly.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **`status('airtable') !== 'connected'`** | the derived reason (missing PAT / decrypt error / disabled) | The action-runner fails the node *before* any call: "Flow needs Airtable connected — action '<id>' can't run. Connect it in Settings." |
| **PAT invalid/revoked (401)** | Airtable's auth error | `invokeAction` **rejects**: "Airtable rejected the personal access token (401) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing scope (403)** | Airtable's scope error | Rejects with the needed scope: "Airtable refused the request (403) — the PAT lacks `data.records:write`; add that scope to the token." |
| **Base/table/record not found (404)** | the base/table/id that missed | Rejects: "Airtable has no record '<id>' in table '<table>' (it may be in another base or was deleted)." — actionable, not a bare 404. |
| **Invalid field / cell value (422)** | Airtable's verbatim `error.message` | Rejects: "Airtable refused the write: unknown field 'Statuss' — check the field name/type (`INVALID_REQUEST_UNKNOWN`)." Forward Airtable's message, don't mint a vaguer one. |
| **Rate limit (429 + 30s lockout)** | the lockout window | `airtable-api` waits the token bucket / honors the 30-second lockout and retries; only after exhausting retries does it reject: "Airtable throttled base '<baseId>' (5 req/sec; 30-second lockout) — the request was retried and gave up." Not swallowed. |
| **Poll failed** (a `/payloads` or `listRecords` tick threw) | the real Airtable/transport error | The poller logs **loudly** and does **NOT** advance the cursor (`posthog-poller.ts:156-165`): "airtable poller: trigger '<id>' poll failed — <reason>. Cursor not advanced; retrying next tick." A signal is worked late, never lost. |
| **Cursor persist failed** | the sidecar write error | Rejects out of the store with the real cause (`posthog-cursor-store.ts persist`): "Couldn't persist the Airtable poll cursor — <reason>. The poll continues in-memory; a restart may re-check from the last saved cursor." The `seen` set prevents a double-seed on the retry (§4.2). |
| **Webhook expired / refresh failed** (phase 2 / Strategy A) | the webhook id + expiry | Loud degradation: "Airtable webhook '<id>' expired or couldn't be refreshed — recreating it; recent changes may be re-fetched from cursor 1." Never a silent dead trigger. |
| **Ping signature invalid** (phase 2) | signature mismatch (never the body or secret) | Shared receiver returns 401, logs route + reason only; **no poll kicked, no run seeded**. |

The connector **never** catches-and-drops. Where Airtable returns a precise
`error.message`, the connector forwards *that* — the action-runner's job is only
to prefix it with the node/action.

---

## 10. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Airtable account**, matching saiife's existing seams
(pure modules, injected backends, an injected clock, fixture events):

- **`AirtableApi` interface + `MockAirtableApi` seam.** `airtable-api.ts` is
  written *against* an `AirtableApi` interface (`listRecords`, `getRecord`,
  `createRecord`, `updateRecord`, `listWebhookPayloads(cursor)`, `createWebhook`,
  `refreshWebhook`); the real impl wraps the HTTP transport + the token bucket.
  Tests inject a `MockAirtableApi` returning canned records, canned `/payloads`
  batches (settable tick-by-tick so a poll test advances state), canned error
  envelopes, and canned **429/lockout** responses. **No test ever performs a live
  Airtable call**; CI has no Airtable credentials. (Same posture as
  `MockPostHogApi` and the `SessionManager` `spawnFn` seam.)
- **`airtable-poller.ts` tests with an injected clock (the KEY tests).** Drive the
  poller's `tick()` with `deps.now` advanced by the test — **no wall-clock wait**:
  assert baseline-without-firing on first observation; assert a later `/payloads`
  batch past the cursor emits one `SeedEvent` per changed record; assert the cursor
  advances **after** handoff; assert a thrown tick logs loudly and **does not**
  advance the cursor; assert a persist-failure + re-tick does **not** double-seed
  (the `seen` set); assert the fan-out sends a batch to two subscriptions on the
  same base. Mirrors the PostHog poller tests.
- **`airtable-cursor-store.ts` tests** — atomic round-trip via a temp file; a
  missing/garbage sidecar → empty (never throw); the sidecar holds only the cursor
  (no record, no secret).
- **`airtable-normalize.ts` unit tests** — pure function; assert a raw record →
  the pinned `AirtableRecordContext` envelope (empty field → undefined,
  never-coerce a currency/number field, `createdTime` preserved) and a raw
  `/payloads` batch → one `SeedEvent` per changed record with the right
  `changeType` + `changedFieldNames`. The correctness boundary conditions + the
  agent depend on — guarded hardest.
- **`airtable-connector` dispatch tests** — with a `MockAirtableApi` + a fake
  registry: assert `invokeAction('airtable','getRecord',…)` resolves the normalized
  context; assert a 422 error envelope **rejects** with the verbatim message (the
  pinned failure convention); assert `subscribe('airtable','record.created',config)`
  registers a poll with the base/table from `config` (and a no-op unsubscribe for an
  unknown trigger id, the opt-in default).
- **Rate-limit test** — drive N `listRecords` calls; assert the token bucket spaces
  them (≤5/sec) and a seeded 429 triggers the 30-second-aware backoff rather than a
  raw throw.
- **Engine integration test (offline)** — wire the real `FlowEngine` + the registry
  with the Airtable connector over a `MockAirtableApi` + a stub `agent-runner`,
  drive the §6 loop: inject a `/payloads` created-record batch → assert `getRecord`
  writes context → assert the agent node writes `judge` → assert the router selects
  the actionable edge → assert `updateRecord` PATCHes the mock → assert the gate
  branch pauses `needs-you`. Deterministic via the engine's injected `now()`.
- **Token-store test** — `revealForConnector` round-trip via a fake `SecretBackend`;
  a regression guard asserts **no PAT value appears** in any emitted
  log/console/error string (the secret rule).
- **Snapshot test on `airtableDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

No test requires Airtable credentials or a live base; the real Web API is exercised
only in manual dogfooding against a personal base.

---

## 11. Open decisions (FLAGGED — not resolved here)

1. **PAT "for me" vs OAuth "product."** The biggest fork.
   - *For me* (MVP): one **PAT** in the user's keychain, one base, a cadence poll
     (no cloud ingress). Fastest to a dogfoodable tracker worker.
   - *Product*: a distributable **Airtable OAuth integration** (per-user install,
     refreshable tokens, an account array, and — if the ping path ships — a hosted
     relay). Recommendation: build MVP "for me", keep the token/config shapes
     multi-account-ready (they already are, §5).
2. **Poll Strategy A (`/payloads` cursor) vs B (`listRecords` timestamp).** A gives
   create+update+delete with a monotonic cursor but needs a 7-day-refreshed webhook
   + `webhook:manage`; B needs no webhook but captures create-only (unless a
   Last-Modified field exists) and no deletes. Recommendation: **A for the pinned
   `record.created`+`record.updated` parity**, with **B as a documented,
   drop-in fallback** for a webhook-free `record.created`-only setup (§4.1). Both
   reuse the same poller/cursor-store.
3. **First-observation: baseline-silent vs replay-backlog.** §4.2 baselines to the
   current cursor **without firing** on first subscribe (the PostHog rule — don't
   flood a run with a startup backlog). But a *tracker* worker's user might
   legitimately want existing rows processed on connect. Whether the default is
   baseline-silent (safe) or replay-backlog (thorough), and whether it's a config
   toggle, is a product call — flagged.
4. **Webhook lifecycle: manual vs programmatic (Strategy A).** MVP can have the user
   create the base's webhook once and paste its id (defers `webhook:manage` + the
   refresh timer), or the connector can create/refresh it programmatically (nicer
   UX, more scope + a teardown story). Leaning programmatic-with-manual-fallback;
   flagged (§4.4).
5. **The agent judgment's structured-output contract.** §6's `context['judge']`
   shape (`{ actionable, note, category }`) is illustrative. Whether the connector
   or the templates track pins a canonical judgment shape (so conditions can rely on
   `judge.actionable`) is an open call shared with the agent-node/templates tracks —
   the same decision the HubSpot spec flagged.
6. **Deterministic Airtable backstop — default present or absent.** Whether a
   shipped tracker worker ships with a conservative default (max writes/run; forbid
   ungated writes to a named "locked" field/table) is a product-safety call for the
   backstop phase (§12 Phase 3). Whatever the default, it is **deterministic**
   (saiifeguard-style), never model-mediated.
7. **`tableId` by id vs name.** Airtable accepts a table id (`tbl…`) or its display
   name in the path; names are friendlier but rename-fragile, ids are stable but
   opaque. MVP accepts either (the config coerces); flagged as a UX/robustness call
   for the templates track.

---

## 12. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One base, one table, the poll trigger + a read + agent judgment + one gated
write, happy path — NO cloud ingress:**

1. `IntegrationId` gains `'airtable'` (+ the three lockstep touch-points, §3.0);
   `airtableDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `personalAccessToken` + `baseId` + `tableId` stored (PAT → keychain);
   `status('airtable') === 'connected'`.
3. `airtable-api.ts` behind `AirtableApi`: `getRecord` (`GET …/{recordId}`),
   `updateRecord` (`PATCH …/{recordId}`), and `listWebhookPayloads(cursor)` live;
   `airtable-normalize` produces `AirtableRecordContext`.
4. `airtable-poller` + `airtable-cursor-store`: a `/payloads` cursor poll of the
   watched base on the injected-clock cadence, baseline-without-firing, advance
   after handoff, emitting a `SeedEvent` per created record (Strategy A) — **or**,
   if the webhook chore is deferred, a `createdTime` `listRecords` poll (Strategy B).
5. `registerConnector('airtable', connector)`: `invokeAction('airtable',…)` reaches
   the connector; `subscribe('airtable','record.created', config)` registers the
   poll with base/table from `config`.
6. On the canvas: `[record.created] → [getRecord] → [agent: classify] → [gate] →
   [updateRecord]` runs end-to-end. Errors per §9.

That slice proves the whole loop (a real row change wakes a real flow that reads
the row, an agent judges it, and behind a gate a cell is written back) and is
dogfoodable against a personal Airtable base — **with no tunnel/relay** (the poll
needs no ingress).

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. PAT fork. `record.created` (poll) +
  `getRecord` + agent judgment + `updateRecord` + author gate. Single base, single
  environment. No cloud ingress.
- **Phase 2 — full vocabulary + the ping wake:** `record.updated` (CDC stream) +
  `listRecords` + `createRecord`; programmatic webhook create/refresh
  (`webhook:manage`, §4.4); the **signed-ping latency optimization** on the shared
  receiver (§4.5) — the first cloud-ingress dependency; the email-trigger
  composition wired by the templates track.
- **Phase 3 — deterministic Airtable backstop:** the `airtable.limits` policy
  (§7.3), saiifeguard-style, with the default decided (§11.6).
- **Phase 4 — richer conditions consumption:** verify the pinned envelope drives
  `gt`/`gte`/`contains`/`truthy`/`exists` over `record.fields.<name>`; ship the
  "triage tracker" template.
- **Phase 5 — product fork:** distributable **Airtable OAuth integration**, hosted
  webhook relay, multi-account isolation (§11.1).
- **Phase 6 — expand structured-data platforms:** **Notion databases** next
  (poll-only, no CDC — validates the poller boundary), then **Google Sheets**. Each
  a peer under `src/main/notion/` / `src/main/sheets/`, reusing the `*-connector` /
  `*-api` / `*-poller` / `*-cursor-store` / `*-normalize` shape. No shared
  cross-platform standard — each is its own connector.

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/integrations.ts` — pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` (incl. the optional 3rd `config` arg on
  `subscribe`, lines 81-85); `IntegrationId` (edited, §3.0); `IntegrationStatus`;
  `ResolvedIntegrationDescriptor`.
- `src/main/integrations/integration-registry.ts` — `registerConnector` (line 54);
  `invokeAction`/`subscribe` delegation (lines 73-102, incl. `config` forwarding);
  `deriveStatus`.
- `src/main/integrations/credential-store.ts` — `safeStorage` keychain;
  `revealForConnector` (line 99, main-only plaintext exit); `decryptionError`.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  (secrets dropped-with-notice).
- `src/main/integrations/descriptors/index.ts` — `DESCRIPTOR_DEFS` gains
  `airtable` (line 19); `descriptors/posthog.ts` the poll-descriptor template.
- `src/main/posthog/posthog-poller.ts` + `posthog-cursor-store.ts` +
  `posthog-connector.ts` — the poll + persisted-cursor + injected-clock + config-
  carrying-subscribe pattern copied wholesale (§4).
- `src/main/email/provider.ts` — the `reconcile(cursor)` + `WatchHandle.expiresAt`
  renewal discipline (§4.4).
- `src/main/flow/node-runners/action-runner.ts` — `invokeAction`, **reject =
  failure**, resolved value → context.
- `src/main/flow/node-runners/agent-runner.ts` — the `agent` judgment node (§6).
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; the
  `SeedEvent` the poller emits.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`.
- `src/main/flow/flow-engine.ts` / `flow-model.ts` — run lifecycle, gate handling,
  the injected `now()` (shared by the poller), the `INTEGRATION_IDS` allow-list
  (edited, §3.0, line 29), `VALID_CONDITION_OPS`.
- *(phase 2)* `src/main/webhooks/webhook-receiver.ts` + `src/main/server-timeouts.ts`
  — the shared receiver the ping-wake verifier registers with (§4.5); **no MVP
  dependency**.
- **Deliberately NOT reused:** `src/main/net/ssrf-guard.ts` (fixed cloud host, no
  self-host, §7.2), `src/shared/money.ts` (user-defined number fields, never-coerce,
  §7.2).
- `guard/` (saiifeguard) — the deterministic-guard posture a future Airtable backstop
  (§12 Phase 3) would borrow.
