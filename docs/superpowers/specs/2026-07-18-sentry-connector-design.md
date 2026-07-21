# Sentry Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Design-approval gate for the **dev /
incident worker** product direction. Anchor **sensor** connector for "an
error → fix-PR → resolve worker assembled on the drag-drop canvas."
**Feature:** A **Sentry connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. It makes saiife **wake on a production error**: a new
Sentry issue (or a triggered alert) **triggers** a run, the flow **reads** the
issue and its latest event — including the **stack-trace `file:line` / culprit**
context a fix worker needs — and, behind gates the author places, **acts**
(assign / resolve / ignore / comment). It is the **SENSOR**; the sibling
**GitHub connector** is the **ACTUATOR** that authors the fix PR. The two
**compose in one worker through flow context** (§7) — neither calls the other.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and copies the module shape of `src/main/shopify/` (CredentialStore keychain,
descriptor-as-code, presence-derived `status()`, `*-connector` / `*-api` client /
`*-normalize` / token store / config). It reuses the **Shopify connector spec**
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`) and the
**Linear integration spec** (`2026-07-16-linear-integration-design.md`) as its
style and depth template.

**A note on ownership.** This spec **owns and pins the dev/incident vocabulary**
(§6: the `IntegrationId` addition, triggers, actions, and the stack-trace/culprit
**context-field shape** a fix worker consumes). It **depends on but does not
design** three neighbours: the sibling **GitHub connector** (the actuator — §7),
the shared **webhook receiver** (`src/main/webhooks/webhook-receiver.ts` +
`WebhookVerifier`), and the shared **SSRF guard** (`src/main/net/ssrf-guard.ts`).
Where a neighbour owns a shape, this spec **names the dependency and stops**.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, an
incident worker that wakes on a new Sentry error, reads the issue's latest event
to pull the **failing `file:line` + culprit + in-app stack frames**, hands that
context to a downstream **GitHub node that opens a fix PR**, and — when the PR
merges — **resolves the Sentry issue** — with the Sentry auth token in the OS
keychain, **never** rendered.

### In scope (MVP)

- A new **Sentry connector** module set under `src/main/sentry/`, exposing a
  static `sentryDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus the **live dispatch** (`invokeAction` / `subscribe`)
  behind the registry's pinned `LiveConnector` seam (`integration-registry.ts`
  lines 73-96) — Sentry is the next live connector after Shopify/WooCommerce.
- **Auth for the "for me" fork:** a Sentry **internal integration**, which issues
  **both** an API auth token (bearer, for REST calls) **and** a webhook **Client
  Secret** (signs `Sentry-Hook-Signature`), and lets you register the webhook URL
  + select webhook resources in one place. Both secrets → keychain via
  `CredentialStore`. The distributable **public-integration OAuth** fork is
  designed-for but deferred (§8, §13).
- A **REST client** (`sentry-api.ts`) — the **sole** place any Sentry API shape
  lives — implementing the read + mutation surface behind the pinned actions
  (§6.2), routed through the shared **SSRF guard** on a self-host `baseUrl`.
- **Trigger ingress via the shared webhook receiver**
  (`src/main/webhooks/webhook-receiver.ts`) with a Sentry **`WebhookVerifier`**:
  **HMAC-SHA256 hex** over the **raw** body against the keychain Client Secret,
  header `Sentry-Hook-Signature`; `Sentry-Hook-Resource` routing; `Request-ID`
  dedup (§4.4). It normalizes a verified event into a `SeedEvent` for the engine.
- The **pinned dev/incident vocabulary** (§6): three triggers, three read
  actions (with the stack-trace context a fix worker consumes), four gated
  mutation actions, and the **context-field shape** those reads write.
- **Authority = the flow's gates.** Every mutation (`resolveIssue`,
  `assignIssue`, `ignoreIssue`, `commentIssue`) is an `action` node the author
  gates. The engine already enforces this — no mutation runs un-gated by
  construction of the graph the author drew (§9).
- **Single org / single project, single saiife environment.** Config-as-code
  `sentry` block in `config.json` (non-secret refs only); token + Client Secret
  in the keychain.
- **Offline `MockSentryApi` seam** so the whole connector is testable with **no
  live Sentry** (§12).

### Out of scope (MVP) — explicitly deferred

- **Public-integration OAuth install** (multi-org, marketplace listing,
  verification). MVP is the **"for me" fork** — one internal integration in one
  org, its token + Client Secret in the keychain (§8, §13.1).
- **Multi-org / multi-project fan-out.** The config/token shapes are drawn so a
  `projects: [...]` array is the additive path (§7, §14), not built now.
- **Metric alerts** (`metric_alert` resource), **cron/uptime** monitors, and
  **release/deploy** webhooks. MVP handles the `issue` resource + the issue-alert
  `event_alert` resource only (§6.1); the rest are phase 2+.
- **Writing Sentry code-mappings / stack-trace-linking config.** The connector
  *reads* stack frames; it does not manage Sentry's own source-map or repo
  linking. (That linking, if present, only improves frame quality — §6.3.)
- **The GitHub connector itself.** The actuator that authors the fix PR is a
  **sibling connector** (`src/main/github/`), owned elsewhere. This spec pins the
  **context shape** the GitHub node reads and the **compose** (§7) — it does not
  design GitHub's internals.
- **The shared webhook receiver + SSRF guard internals.** This spec **consumes**
  `webhook-receiver.ts` (with a Sentry `WebhookVerifier`) and `ssrf-guard.ts`;
  their extraction/ownership is a shared-infra track (§4.4, §5, §10). If they are
  not yet extracted at build time, Sentry mirrors the per-connector pattern of
  `shopify-webhook-server.ts` / `woocommerce/wc-ssrf.ts` verbatim and the
  extraction is a later refactor — the Sentry-facing contract is identical.

---

## 2. Feasibility + landscape

### 2.1 Landscape — why Sentry as the error sensor

| Tool | API posture for wake → read stack → resolve | Verdict for MVP |
|---|---|---|
| **Sentry** | First-class **REST API** (issues, events, assignment, resolve/ignore, comments), a clean **internal-integration** token + **Client Secret** for the "for me" fork, **HMAC-signed webhooks** (`issue`, `event_alert`) that carry the issue and — on alerts — the **triggering event with its full stack trace**, and **self-host parity** (same API on a customer's own Sentry). The dominant error-monitoring install base, so the dogfood + product surface is widest. | **Chosen.** Best sensor-to-effort ratio; the loop is buildable today, and the event payload already carries the `file:line` a fix worker needs. |
| **Rollbar / Bugsnag** | Capable REST + webhooks, but smaller install base and thinner stack-frame/`inApp` fidelity in the webhook payload. | Deferred. Peer sensors under the same `*-connector` boundary if warranted. |
| **Raw log/APM (Datadog etc.)** | Powerful but an *incident* signal, not a per-error *stack-trace* signal — no clean "one issue → one culprit frame" to hand a fix worker. | Deferred; a different (ops) worker shape (see the cloud/DevOps direction). |

**Sentry-first rationale:** it is the purpose-built **error sensor** — every
error is already deduped into an *issue* with a *culprit* and a *latest event*
whose stack trace names the failing `file:line`. That is exactly, and uniquely,
the input a "write the fix PR" worker needs. It pairs naturally with GitHub as
the actuator (§7), and its webhooks map onto the **same cloud-ingress + HMAC
pattern** the Shopify/Linear specs already solved.

### 2.2 The Sentry API for wake → read → act (verified 2026-07-18)

Grounded in the current Sentry developer docs
(`docs.sentry.io/api`, `docs.sentry.io/organization/integrations/integration-platform`):

- **Read — issue.** `GET /api/0/organizations/{org}/issues/{issue_id}/` returns
  issue metadata: `id`, `shortId`, `title`, **`culprit`**, `level`, `status`,
  `substatus`, `permalink`, `count`, `userCount`, `firstSeen`, `lastSeen`,
  `project`, `platform`. Covers `getIssue`.
- **Read — event (the stack trace).** `GET /api/0/issues/{issue_id}/events/latest/`
  (or a specific `.../events/{event_id}/`) returns the event whose `entries`
  include an `exception` entry: `entries[type=exception].data.values[].stacktrace.frames[]`,
  each frame carrying **`filename`**, **`absPath`**, **`lineNo`**, `colNo`,
  **`function`**, `module`, **`inApp`**, and `context` (source lines). Plus the
  event-level `culprit` and `message`. **This is the load-bearing read** — it is
  where the `file:line` a fix worker edits comes from. Covers `getEvent`.
- **Read — search.** `GET /api/0/organizations/{org}/issues/?query=...` with
  Sentry's issue-search syntax (`is:unresolved level:error ...`). Covers
  `searchIssues`.
- **Act.**
  - `resolveIssue` → `PUT` issues with `{ status: 'resolved' }`, optionally
    `statusDetails: { inCommit } | { inRelease } | { inNextRelease }` to
    **resolve-in-the-fixing-commit/release** (the flagship close — §7). Scope
    `event:write`. **Known quirk (isolated in the client, §4.2):** the org-level
    `PUT /api/0/issues/{id}/` endpoint may *ignore* `statusDetails` and resolve
    only in the current release; the **project-scoped** endpoint
    `PUT /api/0/projects/{org}/{project}/issues/?id={id}` honors `inCommit`/`inRelease`.
    The client uses the project-scoped form when `statusDetails` is present.
  - `assignIssue` → `PUT` issues with `{ assignedTo: 'user:<id>' | 'team:<id>' }`.
  - `ignoreIssue` → `PUT` issues with `{ status: 'ignored' }` (archive), optional
    `statusDetails.ignoreDuration` / `ignoreCount`.
  - `commentIssue` → `POST /api/0/issues/{issue_id}/comments/` `{ text }`.
- **Webhooks (push, not poll).** The Integration Platform posts HTTPS webhooks
  signed with **HMAC-SHA256, hex-encoded, in `Sentry-Hook-Signature`, keyed by
  the integration's Client Secret** over the **raw** body (verified against the
  docs — §4.4). Companion headers: **`Sentry-Hook-Resource`** (`issue` |
  `event_alert` | …), **`Sentry-Hook-Timestamp`**, and **`Request-ID`** (a unique
  delivery id → the dedup key). The **`issue`** resource fires actions
  `created`, `resolved`, `assigned`, `archived`, **`unresolved`** (regression is
  **not** a distinct action — it is `substatus: 'regressed'` on an `unresolved`
  event; §2.3). The **`event_alert`** resource fires when an **issue-alert rule**
  triggers and carries the **triggering event including its stack trace** — so
  for the alert path the `file:line` context arrives **free on the webhook**, no
  separate `getEvent` needed (the Shopify "`promptContext` on the webhook"
  analogue).
- **Self-host.** Self-hosted Sentry serves the **same API** at a customer's own
  origin. The connector takes a non-secret **`baseUrl`** (default
  `https://sentry.io`) and routes every outbound call through the shared **SSRF
  guard** (§5) — a self-host URL is user-supplied and must not be allowed to
  target loopback / RFC-1918 / cloud-metadata.
- **Rate limits.** Sentry's REST API is generous for this loop (a couple of small
  reads + one resolve per incident). Push-over-poll (webhooks) keeps us far under
  budget; the client backs off on `429` honoring `Retry-After` (§11).

### 2.3 Constraints (why not pure GREEN-with-no-caveats)

1. **`issue.regressed` is *derived*, not a native action.** The `issue` webhook
   fires `created | resolved | assigned | archived | unresolved`. A **regression**
   (a previously-resolved issue reoccurring) is signalled by
   **`substatus === 'regressed'`** on an **`unresolved`** event — not by its own
   action. So the pinned `issue.regressed` trigger is **derived**: the verifier
   accepts an `unresolved` `issue` event and the connector filters
   `payload.data.issue.substatus === 'regressed'` before seeding the run (§6.1).
   A naming/derivation cost, noted honestly, exactly like Shopify's `order.flagged`.
2. **Cloud ingress is mandatory for triggers.** Identical to Shopify/Linear: the
   local receiver needs a public URL (a tunnel in MVP, a hosted relay in the
   product fork — §4.4). Read + act work over plain **outbound HTTPS** with no
   ingress; only *triggers* need it.
3. **Mutations change incident state.** Resolving/ignoring an issue is a real
   triage action (it can silence a still-broken error). This is a *safety*
   concern, not a feasibility one — and it is exactly what the flow's
   **author-placed gates** exist for (§9). `resolveIssue` in particular should
   normally sit downstream of a **merged-PR signal**, not fire on read.

### 2.4 Verdict: **GREEN**

The wake → read-stack → act loop is **fully buildable today** on Sentry's GA REST
API, with a clean internal-integration token + Client Secret for the "for me"
fork and standard HMAC webhooks. It is GREEN because every surface the loop needs
— issue + latest-event reads (with `inApp` stack frames and `culprit`),
`assignedTo`/`status` mutations, issue comments, the `issue` and `event_alert`
webhook resources — is **generally available and stable**, and self-host uses the
**same** API. The three constraints in §2.3 are a naming/derivation (regressed),
a known ingress pattern already solved, and a safety posture the flow engine's
gates already provide. Nothing in the loop is blocked or preview-gated.

---

## 3. The core loop → Sentry primitives

saiife's incident loop is `trigger → read (stack) → route → act (gated)`, and
its flagship shape **composes with GitHub** (§7). Each stage maps to a concrete
Sentry primitive and the flow-engine mechanism that runs it:

| Stage | Sentry primitive | saiife / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified webhook: `issue` action `created`, `issue` action `unresolved` + `substatus:'regressed'`, or an `event_alert` (issue-alert rule fired, event + stack trace inline). | The shared `webhook-receiver` runs the Sentry `WebhookVerifier` (HMAC-SHA256 hex) → the connector normalizes to a `SeedEvent` → `subscribe(id, triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context. |
| **read** | REST `issues/{id}/` (issue) and `issues/{id}/events/latest/` (the stack trace). | An `action` node (`getIssue` / `getEvent` / `searchIssues`) → `registry.invokeAction('sentry', ref, params)` → the connector calls `sentry-api.ts` → **resolves** the normalized result, which the action-runner writes to context under the node id. |
| **route** | *(none — pure saiife)* | `selectEdges` evaluates edge conditions over the context the read wrote — e.g. `getEvent.topInAppFrame.filename contains 'checkout'`, `getIssue.issue.level eq 'error'`. Deterministic, no LLM. |
| **gate** | *(none — pure saiife)* | A `gate` node the author placed pauses the run as `needs-you`; the human approves in the cockpit. A mutation node sits **downstream of the gate the author drew**. |
| **act** | REST `PUT issues` (`resolve`/`ignore`/`assign`), `POST issues/{id}/comments/`. | The gated `action` node (`resolveIssue` / `assignIssue` / `ignoreIssue` / `commentIssue`) → `invokeAction` → `sentry-api.ts`. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* Sentry error. |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities* (read actions, mutation actions, triggers); the *flow*
decides which run, in what order, behind which gates. Sentry supplies the
**sensing + the fix context + the close**; the author supplies the authority.

---

## 4. Architecture in saiife

### 4.1 Where it sits

A new **main-process module set** under `src/main/sentry/`, mirroring
`src/main/shopify/` and the connector-spec module pattern (`*-connector` /
`*-api` client / `*-normalize` / token store / config). It is **opt-in**: with no
`sentry` config entry (and no stored token) the descriptor's `status()` returns
`needs-config` and the engine refuses any Sentry node — saiife's "works with
no integration" guarantee is unchanged.

The connector is, architecturally, **a live implementation behind the registry's
pinned `invokeAction` / `subscribe`** (`integration-registry.ts:73-96`). Those
delegate to a registered `LiveConnector`; an id with no connector keeps the
legible "no live connector wired" reject / no-op unsubscribe. Sentry provides a
`SentryConnector` that the registry delegates to (§4.3). All Sentry API shapes
are isolated in `sentry-api.ts` (the API blast radius), exactly as Shopify
isolated its GraphQL in `shopify-admin.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/sentry/sentry-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'sentry'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids (the contract downstream tracks consume). Mirrors `shopify-descriptor.ts`. |
| `src/main/sentry/sentry-connector.ts` | Orchestrator + the live `invokeAction`/`subscribe` impl. Dispatches an action id → a `sentry-api` call (params templated by the engine); dispatches a trigger id → a webhook subscription; applies the `substatus:'regressed'` filter for the derived `issue.regressed` trigger. The one place the loop's dispatch lives. Holds NO Sentry shape and NO secret. |
| `src/main/sentry/sentry-api.ts` | Thin **REST client**. **All** Sentry request/response shapes (issue, event/stacktrace, mutation bodies, error envelope) live *only* here. Sends the bearer token; routes the base URL through the shared **SSRF guard** (§5); backs off on `429`; encapsulates the resolve-in-commit endpoint quirk (§2.2). Isolated behind a `SentryApi` interface so tests inject a `MockSentryApi` (§12). |
| `src/main/sentry/sentry-normalize.ts` | **Pure** mapping: a raw issue/event node → the pinned **context-field shape** (§6.3), incl. flattening `entries[exception].data.values[].stacktrace.frames[]` → `frames[]` and picking `topInAppFrame`; and a raw webhook payload (per `Sentry-Hook-Resource`) → a `SeedEvent`. Unit-testable in isolation (mirrors `shopify-normalize.ts` purity). Where `file:line`, `inApp` selection, and culprit normalization happen — **once** — so conditions and the GitHub node read a stable shape. |
| `src/main/sentry/sentry-token-store.ts` | Keychain-backed secret access — a **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('sentry','authToken')` / `('sentry','webhookSecret')`). Reuses the existing keychain sidecar; named distinctly so a grep test asserts no IPC/renderer caller. |
| `src/main/sentry/sentry-config.ts` | Reads the non-secret `sentry` refs (org slug, project slug, `baseUrl`, environment, webhook url) — the `integration-config.ts` validate-at-the-boundary pattern. Holds Sentry-specific coercion (slug normalization, `baseUrl` default `https://sentry.io`). |
| `src/main/sentry/sentry-verifier.ts` | The Sentry **`WebhookVerifier`** implementation passed to the shared receiver (§4.4): HMAC-SHA256 **hex** over the raw body vs the keychain Client Secret (`Sentry-Hook-Signature`), plus `Sentry-Hook-Resource` extraction and `Request-ID` for dedup. Pure over `(rawBody, headers, secret)`; timing-safe. |
| `src/shared/sentry.ts` | Shared types (`SentryIssueContext`, `SentryEventContext`, `SentryStackFrame`, the trigger payload, the action-param shapes, the pinned id tuples) needed by both main and any renderer palette surface. **No raw Sentry shape here** — those stay in `sentry-api.ts`. |

### 4.3 Wiring the live dispatch into the merged registry

The seam is already merged (Shopify/WooCommerce use it). Sentry:

- Implements the pinned `LiveConnector` (`invokeAction(actionId, params):
  Promise<unknown>`, `subscribe(triggerId, handler): () => void` — `integrations.ts:55-58`).
- `src/main/index.ts` constructs the `SentryConnector` (given the
  `CredentialStore`-backed token store, config, the shared webhook receiver with
  the Sentry verifier, and a `SentryApi`) and registers it:
  `registry.registerConnector('sentry', sentryConnector)`.
- The registry's pinned `invokeAction('sentry', …)` / `subscribe('sentry', …)`
  then delegate to it; no other id is touched.

This keeps the pinned contract byte-for-byte unchanged and localizes every Sentry
concern under `src/main/sentry/`.

### 4.4 Receiving webhooks (shared receiver + Sentry verifier)

Ingress uses the shared **`src/main/webhooks/webhook-receiver.ts`** — the
generalization of the per-connector `hook-server.ts` / `shopify-webhook-server.ts`
pattern (`createServer`, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`, `responded`
guard, verify-**before**-parse, 200-fast then deliver on a later tick, dedup,
route+reason logging that never prints the body or secret). Sentry supplies a
**`WebhookVerifier`** (`sentry-verifier.ts`) so the receiver stays connector-agnostic:

- **Signature:** `Sentry-Hook-Signature` = **HMAC-SHA256, hex-encoded**, over the
  **raw** request body, keyed by the integration **Client Secret** (keychain).
  Timing-safe compare (both sides re-hashed so `timingSafeEqual` never throws on a
  length mismatch — the `shopify-webhook-server.ts` pattern). **Verify before
  parsing** — a body-parser that drains the stream first would break it. An empty
  secret is refused outright.
- **Routing:** `Sentry-Hook-Resource` (`issue` | `event_alert`) selects the
  normalizer; the connector maps it + the payload `action`/`substatus` to trigger
  ids (§6.1).
- **Dedup:** on the **`Request-ID`** header (Sentry's unique delivery id) — a
  redelivery is 200-dropped and never seeds a second run. (There is no
  Shopify-style webhook-id in the body; `Request-ID` is the canonical key. Fall
  back to `issue.id + action` if a delivery lacks it.)
- **Ingress:**
  - **MVP ("for me" fork):** a developer tunnel (ngrok / Cloudflare Tunnel, or a
    small always-on relay) forwards to the local receiver; the internal
    integration's **Webhook URL** is that tunnel URL, mirrored in the non-secret
    `webhookUrl` config ref. Whole loop stays local, at the cost of a running
    tunnel. A documented v1 prerequisite.
  - **Phase 2 ("product" fork):** a thin hosted relay that HMAC-authenticates then
    forwards over a durable channel. Flagged in §13 — it changes distribution.

A bad / oversized / forged / duplicate delivery is dropped (4xx or 200-dedup) and
**never** seeds a run.

### 4.5 Reused saiife surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies;
  `IntegrationId` (edited, §6.0); `IntegrationStatus`;
  `ResolvedIntegrationDescriptor`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses (`revealForConnector` main-only plaintext exit;
  `decryptionError` feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector('sentry',…)`
  attaches the live dispatch; `deriveStatus` gives Sentry its status for free.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `sentry` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `sentry`;
  `descriptors/linear.ts` / `shopify-descriptor.ts` are the descriptor-as-code
  templates.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`getEvent.topInAppFrame.filename`) + routing over §6.3 fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` for deterministic tests.
- `src/main/webhooks/webhook-receiver.ts` (shared) + `src/main/net/ssrf-guard.ts`
  (shared) — consumed via a Sentry `WebhookVerifier` and the `baseUrl` check
  (§4.4, §5). Their internals are owned by the shared-infra track.

---

## 5. Auth, keychain & self-host SSRF

### 5.1 Auth & keychain

- **"For me" fork (MVP).** A Sentry **internal integration** (created in the org's
  settings) issues an **API auth token** (bearer) and a **Client Secret** (webhook
  signing), and is where the **Webhook URL** and **resources** (`issue`, plus the
  issue-alert `event_alert`) are configured. The user pastes the two secrets into
  the descriptor's masked fields; they go straight to the keychain via
  `CredentialStore.set`. Every REST call sends `Authorization: Bearer <token>` —
  read at call time via `revealForConnector('sentry','authToken')`
  (main-process-only, the sole plaintext exit; a grep test asserts no
  IPC/renderer caller). Scopes: `event:read` (reads) + `event:write` (resolve /
  ignore / assign / comment). No OAuth, no refresh — the token is long-lived until
  rotated in Sentry.
- **Webhook Client Secret.** Stored the same way (`webhookSecret`); used **only**
  inside `sentry-verifier.ts` to `timingSafeEqual` the `Sentry-Hook-Signature`
  header against `hmacSha256Hex(rawBody, secret)`.
- **Honoring the global secret rule.** Neither secret is **ever** written to
  `config.json`, `sessions.json`, the transcript, a log, a PR body, or any IPC
  payload. `config.json` holds only **references** (org slug, project slug,
  `baseUrl`, that an install exists — §7). Token **state** (present /
  decrypt-failing) may be surfaced via `status()`; the **value** never is. This is
  the hub's existing discipline applied to Sentry verbatim.
- **"Product" fork (deferred, §13.1).** A **public integration** uses OAuth to
  mint per-org tokens (multi-tenant, refreshable). The keychain shape already
  supports per-key storage; the additive change is a `sentry-oauth.ts` module and
  a `projects[]` config array. Same `Authorization: Bearer` at call time — only
  *acquisition* differs.
- **Disconnect.** Clearing the `authToken` / `webhookSecret` (the hub's
  `clearSecret`) flips `status()` to `needs-config`; the connector stops
  dispatching. No in-flight run is force-killed — it simply can't start a new
  Sentry action, and reports why (§11).

### 5.2 Self-host `baseUrl` — the shared SSRF guard (a REAL control)

Sentry can be **self-hosted**, so the connector exposes a non-secret **`baseUrl`**
(default `https://sentry.io`). Because the connector then makes **outbound**
requests to a **user-supplied** address, a mistyped or hostile `baseUrl` could
target loopback / RFC-1918 / link-local / `169.254.169.254` cloud-metadata. **Every
`sentry-api.ts` request passes through the shared `src/main/net/ssrf-guard.ts`
before the call** — the generalization of `woocommerce/wc-ssrf.ts`:

- `checkBaseUrl(raw)` at config-set and call time: **https-only**, no embedded
  credentials, and if the host is an IP literal (or `localhost`) it must not be
  private/loopback/link-local. A legible rejection ("Sentry base URL … is a
  private/loopback address … — refusing to call it") is surfaced, never a silent
  failure.
- `blockedIpRange(ip)` as the **post-DNS** hook the transport calls with the IP it
  actually dialed, so a DNS-rebinding flip between validate and connect can't
  redirect to a private IP.

`https://sentry.io` (SaaS) passes trivially; a legitimate self-host
(`https://sentry.mycorp.com`, public DNS) passes the literal check and is re-checked
against its resolved IP at dial time. This is a genuine security boundary, not a
formality — it is the price of supporting self-host.

---

## 6. Pinned dev/incident vocabulary (verbatim — downstream tracks consume this)

> **This section is the contract.** The flow-templates track, the canvas palette,
> and — critically — the **GitHub connector node** (§7) read these ids and this
> **stack-trace/culprit field shape** verbatim. A snapshot test in
> `sentry-descriptor.ts` guards the ids; the field shape is guarded by the
> `sentry-normalize.ts` tests.

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'sentry'`:

```ts
export type IntegrationId =
  'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'sentry'
```

Companion touch-points that move in lockstep (each a one-line add):
`INTEGRATION_IDS` (the stable order array, `integrations.ts:71`), the
`INTEGRATION_IDS` allow-list in `flow-model.ts` (the flow validator), and
`DESCRIPTOR_DEFS` (`descriptors/index.ts`). No other `IntegrationId` consumer
needs a change — they iterate the array.

### 6.1 Triggers

| trigger id | label | underlying Sentry source | note |
|---|---|---|---|
| `issue.created` | New error issue | **`issue`** resource, action **`created`** (native, 1:1). | The clean case — a brand-new error. |
| `issue.regressed` | A resolved error came back | **`issue`** resource, action **`unresolved`**, filtered to **`substatus === 'regressed'`**. | *Derived*: Sentry has no `regressed` action; the connector filters `substatus` (§2.3). |
| `alert.triggered` | An issue-alert rule fired | **`event_alert`** resource — the issue-alert rule's triggering **event, including its stack trace, arrives inline** on the webhook. | The richest sensor: `file:line` is **free on the webhook**, no `getEvent` needed for the common path. |

**Payload → trigger context.** The verified webhook normalizes to a
`SentryTriggerPayload` (§6.3) carrying at minimum `issueId`, `projectSlug`,
`level`, `culprit`, and (for `alert.triggered`) an inline `event` with `frames`
and `topInAppFrame`. This is enough for a downstream `getEvent` /
`getIssue`-free fast path, or to template `{{trigger.issueId}}` into a read.

### 6.2 Actions

**Read (no gate needed — pure reads write the fix context for the GitHub node and
for conditions):**

| action id | label | Sentry REST | writes to context |
|---|---|---|---|
| `getIssue` | Get an issue | `GET organizations/{org}/issues/{id}/` | `SentryIssueContext` (§6.3) |
| `getEvent` | Get an event's stack trace | `GET issues/{id}/events/latest/` (or `/events/{eventId}/`) | `SentryEventContext` — **the `file:line` frames + culprit a fix worker consumes** (§6.3) |
| `searchIssues` | Search issues | `GET organizations/{org}/issues/?query=` | `{ issues: SentryIssueContext[]; count }` |

**Gated mutation (the author places a gate — or a merged-PR signal — before these):**

| action id | label | Sentry REST | note |
|---|---|---|---|
| `resolveIssue` | Resolve the issue | `PUT issues {status:'resolved', statusDetails?}` | The **flagship close** — normally downstream of a merged fix PR; supports `inCommit`/`inRelease` (§2.2, §7). |
| `assignIssue` | Assign the issue | `PUT issues {assignedTo:'user:…'|'team:…'}` | Route an incident to an owner / the fix worker's identity. |
| `ignoreIssue` | Ignore / archive the issue | `PUT issues {status:'ignored', statusDetails?}` | Mute noise; optional duration/count. |
| `commentIssue` | Comment on the issue | `POST issues/{id}/comments/ {text}` | Leave an audit note (e.g. "fix PR #123 opened by saiife"). |

**Failure convention (pinned):** a mutation that fails **rejects** its promise
with the real Sentry error text; a resolved promise (any value) is success and its
value becomes the node's context output. The connector never resolves a
sentinel-failure.

### 6.3 Context-field shape (what a read writes — the fix worker's input)

A read writes a **normalized, stable** object under its node id
(`sentry-normalize.ts` produces it — GID/`entries` flattened, `inApp` frames
selected, culprit surfaced). Downstream edge conditions read it via dotted paths;
**the GitHub node reads the same paths** to author the PR (§7). **Pinned shape:**

```ts
// src/shared/sentry.ts

/** One stack frame — the atom a fix worker edits. */
export interface SentryStackFrame {
  filename: string        // e.g. "src/checkout/cart.ts"  ← the file to fix
  absPath: string         // absolute/URL path as Sentry recorded it
  function: string        // enclosing function, e.g. "applyDiscount"
  lineNo: number          // 1-based line             ← the line to fix
  colNo?: number
  module?: string
  inApp: boolean          // true = the app's own code (not a dependency)
  contextLine?: string    // the source line itself, when Sentry has it
}

export interface SentryIssueContext {
  issue: {
    id: string            // numeric issue id, e.g. "4509876543"
    shortId: string       // human id, e.g. "FRONTEND-42"
    title: string
    culprit: string       // Sentry's culprit, e.g. "cart.ts in applyDiscount"
    level: 'error' | 'warning' | 'info' | 'debug' | 'fatal' | 'sample'
    status: 'unresolved' | 'resolved' | 'ignored'
    substatus?: string    // e.g. "regressed" | "new" | "ongoing"
    permalink: string     // the Sentry UI URL (for PR bodies / comments)
    platform: string      // e.g. "javascript", "python"
    project: string       // project slug
    count: number         // event count (severity signal for conditions)
    userCount: number
    firstSeen: string     // ISO 8601
    lastSeen: string      // ISO 8601
  }
}

export interface SentryEventContext {
  event: {
    id: string            // event id (32-char hex)
    issueId: string
    message: string
    culprit: string
    platform: string
    exception: {          // the primary exception, flattened for conditions
      type: string        // e.g. "TypeError"
      value: string       // e.g. "Cannot read property 'id' of undefined"
    }
    frames: SentryStackFrame[]        // full stack, app + dependency frames
    inAppFrames: SentryStackFrame[]   // just the app's own frames (fix targets)
    /** The single most useful pointer for a fix PR: the top in-app frame
     *  (first `inApp` frame from the crash), or undefined if none is in-app. */
    topInAppFrame?: SentryStackFrame
    permalink: string
  }
}

/** What a verified webhook seeds a run with (§6.1). For `alert.triggered` the
 *  inline `event` is present so the stack trace needs no extra fetch. */
export interface SentryTriggerPayload {
  issueId: string
  shortId: string
  projectSlug: string
  level: string
  culprit: string
  substatus?: string      // carries "regressed" for the derived trigger
  resource: 'issue' | 'event_alert'
  action?: string         // "created" | "unresolved" | …
  event?: SentryEventContext['event']   // inline for alert.triggered
}
```

**Why `topInAppFrame` is pinned.** A fix worker needs *one* place to start:
`{{getEvent.topInAppFrame.filename}}:{{getEvent.topInAppFrame.lineNo}}` in the
crashing function. Sentry's raw event buries frames three levels deep in
`entries[…].data.values[].stacktrace.frames[]`, ordered variably and mixing
dependency frames. Normalizing **once** — flattening, selecting `inApp`, exposing
`topInAppFrame` — is the correctness boundary the GitHub node and the conditions
track both rely on. Money-as-number was Shopify's normalization stake; **file:line
+ inApp selection** is Sentry's.

### 6.4 Pinned id tuples

```ts
// src/shared/sentry.ts
export const SENTRY_TRIGGER_IDS = ['issue.created', 'issue.regressed', 'alert.triggered'] as const
export const SENTRY_READ_ACTION_IDS = ['getIssue', 'getEvent', 'searchIssues'] as const
export const SENTRY_MUTATION_ACTION_IDS =
  ['resolveIssue', 'assignIssue', 'ignoreIssue', 'commentIssue'] as const
```

---

## 7. The flagship loop — Sentry (sensor) → GitHub (actuator), composed via flow context

This is the direction's whole point: **Sentry senses the error and closes it;
GitHub authors the fix.** The two are **separate connectors that never call each
other** — they compose entirely through the **flow graph + shared run context**,
exactly the Shopify "authority in the graph" model. Sentry pins the context shape
(§6.3); the GitHub node reads it.

**Scenario the author drew on the canvas:** *"When a new error appears, open a
draft fix PR pointed at the failing file:line; when that PR merges, resolve the
Sentry issue in the fixing commit."*

```
[trigger: issue.created  (or alert.triggered)]     Sentry issue webhook (HMAC-verified)
        │  SentryTriggerPayload → context['t'] = { issueId, projectSlug, culprit, event? }
        ▼
[action: getEvent]  ref=getEvent, params={ id: "{{t.issueId}}" }        (SENTRY = SENSOR)
        │  invokeAction('sentry','getEvent',…) → sentry-api → normalize
        │  writes context['crash'] = SentryEventContext
        │     .topInAppFrame = { filename:"src/checkout/cart.ts", lineNo: 88, function:"applyDiscount" }
        │     .exception     = { type:"TypeError", value:"Cannot read property 'id' of undefined" }
        ▼
[router]  edge: crash.event.topInAppFrame.inApp truthy   (only act on our own code)
        ▼
[gate: "open a fix PR?"]  (optional — author may auto-run for low-risk repos)
        ▼
[action: github.openFixPR]                                              (GITHUB = ACTUATOR)
        │  a DOWNSTREAM GitHub-connector node — NOT Sentry. It reads the pinned
        │  Sentry context by dotted path:
        │     file    = "{{crash.event.topInAppFrame.filename}}"
        │     line    = "{{crash.event.topInAppFrame.lineNo}}"
        │     title   = "Fix: {{crash.event.exception.type}} in {{crash.event.topInAppFrame.function}}"
        │     body    = "Fixes Sentry {{t.shortId}} — {{crash.event.permalink}}"
        │  → drives a fix pane / opens a PR; resolves { prNumber, branch, headSha } → context['pr']
        ▼
        … PR is reviewed & merged in GitHub …
        │
[trigger: github.pull_request.merged]  (a SECOND flow, or a wait-node — GitHub connector)
        │  payload → context['merged'] = { prNumber, mergeCommitSha, issueRef }
        ▼
[action: sentry.resolveIssue]                                          (SENTRY = ACTUATOR / close)
        │  invokeAction('sentry','resolveIssue',
        │     { id:"{{merged.issueRef}}", statusDetails:{ inCommit:{ commit:"{{merged.mergeCommitSha}}" } } })
        │  → PUT (project-scoped, §2.2) → issue resolves IN the fixing commit
        ▼
[action: sentry.commentIssue]  text="Resolved by PR #{{merged.prNumber}} (saiife)"   (audit)
        ▼ (done)
```

**How the compose actually works (the mechanism, not magic):**

1. **Sentry is the front sensor.** Its trigger seeds the run; its `getEvent` read
   writes `SentryEventContext` — the **`topInAppFrame` file:line + exception + culprit**
   — into run context under a node id. For the `alert.triggered` path the event is
   already inline on the webhook (§6.1), so even the `getEvent` hop is optional.
2. **GitHub is a downstream node in the *same* graph.** The GitHub connector
   (sibling, `src/main/github/`) exposes an action (`openFixPR` / drive-a-fix-pane)
   that **reads the pinned Sentry context by dotted path** — it depends on §6.3's
   field names, not on the Sentry connector object. The GitHub node produces
   `{ prNumber, branch, headSha }` into context.
3. **The close comes back to Sentry.** A GitHub **merge** signal (a second trigger
   or a wait) drives the terminal `sentry.resolveIssue` with
   `statusDetails.inCommit` = the merge commit, so Sentry marks the issue resolved
   **in the fixing commit** (and auto-regresses it if the error ever returns — which
   re-enters the loop via `issue.regressed`). An optional `commentIssue` leaves the
   audit trail.

**The contract between the two connectors is §6.3, nothing else.** Sentry
guarantees `topInAppFrame.filename` / `.lineNo` / `.function`, `exception.type/value`,
`issue.shortId`, `issue.permalink`. The GitHub node guarantees its own
`{ prNumber, mergeCommitSha }`. The **flow author** wires which feeds which. No
connector imports another; the graph is the integration. This is why the module
boundaries are connector-shaped — a third sensor (Rollbar) or a third actuator
(GitLab) slots in by matching the same context contract, not by editing Sentry.

---

## 8. The connector as an `IntegrationDescriptor`

The static half is a `sentryDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as for the others.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `authToken` | Sentry auth token | **yes** | yes | string | Internal-integration bearer token. Keychain only. Scopes `event:read` + `event:write`. |
| `webhookSecret` | Webhook Client Secret | **yes** | yes | string | Verifies `Sentry-Hook-Signature`. Keychain only. |
| `orgSlug` | Organization slug | no | yes | string | e.g. `my-org`. Non-secret ref. |
| `projectSlug` | Project slug | no | no | string | Scopes reads/searches and the project-scoped resolve (§2.2). Recommended. |
| `baseUrl` | Sentry base URL (self-host) | no | no | string | Default `https://sentry.io`; SSRF-guarded (§5.2). Placeholder `https://sentry.io`. |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts Sentry work (same field/validation as Shopify's). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay URL registered in the internal integration. Placeholder `https://<tunnel>/sentry/webhook`. |

`status('sentry')` reports `needs-config` until `authToken`, `webhookSecret`,
`orgSlug`, and `environment` are present; `error` if a stored secret can't be
decrypted; `disabled` if configured-but-off; `connected` otherwise. The
action-runner refuses any non-`connected` Sentry node before any network call.

---

## 9. Authority & safety

**Primary control — the flow's gates (already enforced).** Every mutation
(`resolveIssue`, `assignIssue`, `ignoreIssue`, `commentIssue`) is an `action`
node. Authority is whatever the author wired: a `gate` node pauses the run
`needs-you` for human approval; a conditional edge (or, in the flagship loop, a
**merged-PR signal**) restricts *when* the mutation is even reached. The engine
already implements this — a gate the author drew is honored, a human "no" ends the
run `rejected` (not a failure), and a mutation with no path to it never runs. **The
connector never auto-mutates outside the graph the author drew.**

**Why `resolveIssue` is the one to watch.** Resolving an issue that isn't actually
fixed silences a live error. The intended pattern (§7) is that `resolveIssue` sits
downstream of a **real merge signal** — the author is strongly steered (in the
starter template) to gate it on a merged PR, not on a read. `ignoreIssue` is
similarly a "mute" the author should place deliberately. `commentIssue` and
`assignIssue` are low-risk and safe to leave un-gated if the author chooses.

**Optional deterministic backstop (phased — §14 Phase 3).** In the spirit of
**saiifeguard** and the Shopify ecom backstop: a small declarative `sentry.limits`
block (non-secret), e.g. `{ resolveRequiresMergeContext: true }` — the connector
**rejects** a `resolveIssue` that carries no `statusDetails.inCommit`/`inRelease`
unless explicitly allowed, so a mis-authored flow can't blanket-resolve. Defense
in depth under the author's gate, deterministic, no model in the loop. Its default
is a product call (§13.2).

**Never render secrets.** The auth token and Client Secret live in the keychain;
no error message, log line, or context field ever contains them (§5, §11).

---

## 10. Shared-infra dependencies (owned elsewhere — named, not designed)

Two shared modules this spec **consumes** and does **not** design:

- **`src/main/webhooks/webhook-receiver.ts`** — the connector-agnostic HTTP
  receiver (the generalization of `hook-server.ts` / `shopify-webhook-server.ts`):
  `createServer`, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`, `responded` guard,
  verify-before-parse, 200-fast-then-deliver, dedup, route+reason logging. It
  takes a pluggable **`WebhookVerifier`**; Sentry supplies `sentry-verifier.ts`
  (§4.4). This spec depends on that seam existing; if it is not yet extracted,
  Sentry ships a per-connector `sentry-webhook-server.ts` mirroring
  `shopify-webhook-server.ts` and the extraction is a later, behavior-preserving
  refactor.
- **`src/main/net/ssrf-guard.ts`** — the shared SSRF validator (the
  generalization of `woocommerce/wc-ssrf.ts`): `checkBaseUrl` (literal validate:
  https-only, no creds, no private/loopback/link-local IP literal) + a post-DNS
  `blockedIpRange` hook. Sentry calls it on the self-host `baseUrl` (§5.2). Same
  fallback: if not yet extracted, Sentry uses a local copy of the Woo pattern.

The **GitHub connector** (`src/main/github/`) is a third dependency, named in §7
and owned by its own spec. This spec pins only the **context contract** (§6.3)
that the GitHub node reads; it does not design GitHub's auth, PR flow, or its
`pull_request.merged` trigger.

---

## 11. Error handling

saiife's principle (error-message-style memory; `credential-store.ts` /
`action-runner.ts`): **every failure is human-readable, actionable, and carries
the real underlying exception. No silent catch. No bare "failed" / "not found".**
A mutation signals failure by **rejecting** its promise with that message; the
action-runner prefixes it with the node/action and surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook signature invalid** | signature mismatch (never the body or secret) | Receiver `console.warn` route + reason only; 401; **no run started**. Mirrors `control-api`'s "never log token material". |
| **Webhook duplicate** (`Request-ID` seen) | the request id | 200 (Sentry may redeliver); dedup-drop; no second run. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | 4xx; dropped; no run. Never seeds on unvalidated shape. |
| **Derived trigger filtered out** (`unresolved` but `substatus !== 'regressed'`) | the substatus | 200; not an error — simply doesn't match `issue.regressed`; no run. |
| **`status('sentry') !== 'connected'`** | the derived reason (missing token / decrypt error / disabled) | The action-runner fails the node *before* any call: "Flow needs Sentry connected — action '<id>' can't run. Connect it in Settings." |
| **Auth token invalid/revoked (401)** | Sentry's auth error | `invokeAction` **rejects**: "Sentry rejected the auth token (401) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing scope (403)** | Sentry's scope error | Rejects verbatim: "Sentry refused 'resolveIssue': the token is missing the `event:write` scope — add it to the internal integration." |
| **Issue/event not found (404)** | the id that missed | Rejects: "Sentry has no issue '<id>' (wrong project, or it was deleted/merged)." — actionable, not a bare 404. |
| **`baseUrl` blocked by SSRF guard** | the range label | Rejects **before** the call: "Sentry base URL '<host>' is a private/loopback address (<range>) — refusing to call it. Fix it in Settings." (§5.2). |
| **Rate-limit (429)** | `Retry-After` | `sentry-api` retries with backoff honoring `Retry-After`; only after exhausting retries does it reject with "Sentry throttled the request (retry in ~Ns)". Not swallowed. |
| **Resolve/ignore business rejection** | Sentry's error body | Rejects with the verbatim message (e.g. "issue already resolved"). The run fails with the true reason, never a silent no-op. |
| **`statusDetails` silently ignored** (the org-endpoint quirk, §2.2) | — | Avoided by construction: the client uses the **project-scoped** endpoint whenever `statusDetails` is present, so `inCommit`/`inRelease` actually apply. |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "Sentry webhook URL '<url>' is unreachable — no error events will arrive." Never a silent dead trigger. |

The connector **never** catches-and-drops. Where Sentry returns a precise message,
the connector forwards *that* rather than minting a vaguer one.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Sentry org**, matching saiife's existing seams (pure
modules, injected backends, fixture events):

- **`SentryApi` interface + `MockSentryApi` seam.** `sentry-api.ts` is written
  *against* a `SentryApi` interface (`getIssue`, `getEvent`, `searchIssues`,
  `resolveIssue`, `assignIssue`, `ignoreIssue`, `commentIssue`); the real impl
  wraps the HTTP transport + SSRF guard. Tests inject a `MockSentryApi` returning
  canned issues, canned events **with real nested `entries[exception]…frames`
  fixtures**, and canned 401/403/404/429 envelopes. **No test performs a live
  Sentry call**; CI has no Sentry credentials. (Same posture as `MockShopifyApi`.)
- **`sentry-normalize.ts` unit tests** — the correctness boundary, guarded
  hardest. Assert raw issue → `SentryIssueContext`; raw event → `SentryEventContext`
  with the **frames flattened out of `entries[exception].data.values[].stacktrace`**,
  the **`inAppFrames` filter**, and **`topInAppFrame` selection** (first `inApp`
  frame; `undefined` when none is in-app); culprit/exception extraction. This is
  what the GitHub node depends on, so a fixture-rich table is mandatory.
- **`sentry-verifier.ts` unit tests** — feed fake `issue`/`event_alert` bodies
  with **valid and invalid `Sentry-Hook-Signature`** (correct HMAC-SHA256 **hex**,
  wrong hex, empty secret), the `Sentry-Hook-Resource` routing, and duplicate
  `Request-ID`; assert only valid+signed+novel events pass, and that regression
  filtering (`substatus`) happens. Reuses the `shopify-webhook-server.ts`
  boundary-test approach against the shared receiver.
- **`sentry-connector` dispatch tests** — with a `MockSentryApi`: assert
  `invokeAction('sentry','getEvent',…)` resolves the normalized context; assert a
  404/401 response **rejects** with the verbatim message (pinned failure
  convention); assert `resolveIssue` with `statusDetails` routes to the
  project-scoped endpoint (§2.2); assert the `issue.regressed` filter.
- **Compose integration test (offline)** — wire the real `FlowEngine` + the
  registry with the Sentry connector over `MockSentryApi` **and a fake GitHub
  connector**, drive the §7 loop: inject an `issue.created` `SeedEvent` → assert
  `getEvent` writes `topInAppFrame` → assert the fake GitHub node reads
  `{{crash.event.topInAppFrame.filename}}`/`.lineNo` and produces `{ prNumber,
  mergeCommitSha }` → inject a `merged` event → assert `resolveIssue` is called
  with `inCommit` = the merge sha. This proves the **sensor→actuator→close**
  compose end-to-end with no network. Deterministic via the engine's injected
  `now()`.
- **Token-store test** — `revealForConnector` round-trip via a fake backend; a
  regression guard asserts **no token/secret value appears** in any emitted
  log/console/error string (the secret rule).
- **SSRF guard test** — `baseUrl` = `http://…`, `https://127.0.0.1`,
  `https://169.254.169.254`, an embedded-credential URL all rejected legibly;
  `https://sentry.io` and a public self-host pass. (Reuses the shared guard's
  own suite; the Sentry test asserts the connector *calls* it before every request.)
- **Snapshot test on `sentryDescriptor`** — pins the trigger/action ids the
  templates + GitHub tracks consume; a change is a deliberate, reviewed edit.

No test requires Sentry credentials or a live org; the real API is exercised only
in manual dogfooding against a dev org (SaaS) and, once, a self-host instance.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **SaaS vs self-host as the MVP dogfood target.** Both use the same API (§2.2)
   and the same auth shape. SaaS (`sentry.io`) is fastest to a dogfood loop (no
   infra). Self-host exercises the **SSRF guard** on a real non-default `baseUrl`
   and is the harder customer story. Recommendation: **build against SaaS first**,
   but keep `baseUrl` + the SSRF guard on the hot path from day one (they're cheap
   and self-host is a named product direction). Decide whether MVP must *also* be
   validated against a self-host instance before calling the connector done.
2. **Which alert/issue events ship in MVP.** `issue.created` is unambiguous. But
   is the richest sensor `issue.created` (fires on *first* occurrence) or
   `alert.triggered` (fires when an **issue-alert rule** crosses a threshold — the
   event + stack trace arrive inline, and it lets the *user's* alert rules decide
   what's worth a fix PR)? And is `issue.regressed` (the derived `substatus`
   filter) worth shipping in MVP or a phase-2 add? Leaning: **`issue.created` +
   `alert.triggered` in MVP** (alert is the better product signal — the user's
   rules gate noise), `issue.regressed` in phase 2. Flagged for a product call.
3. **Public integration vs internal integration.** MVP uses an **internal
   integration** (token + Client Secret in one place, single org). A **public
   integration** (OAuth, multi-org, marketplace) is the product fork — it changes
   auth (OAuth + refresh), ingress (hosted relay), and config (`projects[]`).
   Recommendation: internal for MVP, keep shapes multi-org-ready (they are — §5,
   §7). Decide before phase 2.
4. **The `resolveIssue` safety default (§9).** Should the connector ship the
   deterministic backstop (`resolveRequiresMergeContext`) **on by default**, so a
   mis-authored flow can't blanket-resolve live errors? Or off, trusting the
   author's gate + the starter template's wiring? A product-safety call; whatever
   the default, it is deterministic (saiifeguard-style), never model-mediated.
5. **Webhook subscription management — manual vs programmatic.** MVP can have the
   user configure the internal integration's Webhook URL + resources in the Sentry
   UI (pointing at their tunnel), or the connector can register them via API on
   connect. Manual is simpler for MVP; programmatic is nicer UX with a teardown
   story. Leaning **manual** for the walking skeleton.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One org/project, the sensor read + the GitHub compose + the resolve close,
happy path:**

1. `IntegrationId` gains `'sentry'` (+ the lockstep touch-points, §6.0);
   `sentryDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `authToken` + `webhookSecret` + `orgSlug` (+ `projectSlug`) stored (secrets →
   keychain); `status('sentry') === 'connected'`.
3. `sentry-api.ts` behind `SentryApi`: `getEvent` (`issues/{id}/events/latest/`)
   and `resolveIssue` (`PUT`, project-scoped when `statusDetails` present) live,
   routed through the SSRF guard. `sentry-normalize` produces `SentryEventContext`
   with `topInAppFrame`.
4. The registry live dispatch: `registerConnector('sentry', …)`;
   `invokeAction('sentry',…)` reaches the connector; `subscribe('sentry',
   'issue.created',…)` reaches the shared receiver via the Sentry verifier.
5. Shared `webhook-receiver` + `sentry-verifier` handling the **`issue`** resource
   `created` action (HMAC-SHA256 hex verify, `Request-ID` dedup), behind a dev
   tunnel, emitting a `SeedEvent`.
6. On the canvas: `[issue.created] → [getEvent] → [gate] → [github.openFixPR]`,
   and a second `[github.pull_request.merged] → [sentry.resolveIssue(inCommit)]`
   — the **sensor → actuator → close** loop end-to-end. Errors per §11.

That slice proves the whole flagship loop (a real Sentry error wakes a real flow
that pulls the failing `file:line`, a GitHub node opens a fix PR, and the merge
resolves the issue in the fixing commit) and is dogfoodable against a Sentry dev
org + a test repo.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. Internal integration, SaaS. Single
  org/project, single environment. `issue.created` + `getEvent` + `resolveIssue` +
  the GitHub compose.
- **Phase 2 — full vocabulary:** the rest of §6 — `getIssue` / `searchIssues`;
  `assignIssue` / `ignoreIssue` / `commentIssue`; the `alert.triggered`
  (`event_alert`, inline-event) and `issue.regressed` (derived `substatus`)
  triggers; programmatic webhook-subscription management (§13.5).
- **Phase 3 — deterministic resolve backstop:** the `sentry.limits` policy (§9),
  saiifeguard-style, default decided (§13.4).
- **Phase 4 — self-host hardening:** validate the SSRF guard against a real
  self-host instance; document the `baseUrl` + tunnel story for on-prem Sentry.
- **Phase 5 — product fork:** public integration OAuth, hosted webhook relay,
  `projects[]` multi-org isolation (§13.3).
- **Phase 6 — expand sensors/actuators:** a second **sensor** (Rollbar/Bugsnag)
  under `src/main/rollbar/`, and a second **actuator** (GitLab) — each matching the
  §6.3 context contract so the compose (§7) is unchanged. No shared cross-tool
  standard — each is its own connector; the **flow graph** is the integration.

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses; `revealForConnector` (main-only plaintext exit),
  `decryptionError` (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector('sentry',…)`
  attaches the live dispatch (`invokeAction`/`subscribe` delegate to it);
  `deriveStatus` gives Sentry its status for free.
- `src/main/integrations/integration-config.ts` — validate-at-the-boundary config
  parsing the `sentry` block reuses (secrets dropped-with-notice).
- `src/main/integrations/descriptors/` — `DESCRIPTOR_DEFS` gains `sentry`;
  `descriptors/linear.ts` / `shopify-descriptor.ts` are the descriptor-as-code
  templates.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`getEvent.topInAppFrame.filename`) + routing over §6.3 fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` for deterministic tests.
- `src/main/webhooks/webhook-receiver.ts` (shared) — the receiver the Sentry
  `WebhookVerifier` plugs into; mirrors `shopify-webhook-server.ts` /
  `hook-server.ts` (createServer, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`,
  `timingSafeEqual`, `responded`, verify-before-parse, 200-fast, dedup).
- `src/main/net/ssrf-guard.ts` (shared) — the self-host `baseUrl` guard
  (generalization of `woocommerce/wc-ssrf.ts`): `checkBaseUrl` + post-DNS
  `blockedIpRange`.
- `guard/` (saiifeguard) — the deterministic-guard *posture* the optional resolve
  backstop (§9) borrows (a policy floor under the author's gates, no model).
