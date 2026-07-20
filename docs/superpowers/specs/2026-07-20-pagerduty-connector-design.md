# PagerDuty Connector — Design

**Date:** 2026-07-20
**Status:** Design (spec) — not started. Design-approval gate for localflow's
**on-call incident worker**. Where Sentry is the *sensor* (an error surfaced) and
GitHub is the *actuator* (a fix authored, a human merges), PagerDuty is the
**coordinator**: the surface an on-call human is paged through, and therefore the
natural *entry point and closing point* of an incident. This connector lets a
flow wake on a page, triage it, drive a fix through the Sentry+GitHub pair
already built, write the diagnosis back onto the incident, and — behind the
author's gate — **acknowledge / escalate / resolve** it.
**Feature:** A **PagerDuty connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. A page fires a webhook (`incident.triggered`), the flow
**reads** incident/service state through the PagerDuty REST API, drives an
**agent pane** to triage (composing with the **Sentry** and **GitHub**
connectors through shared flow context), writes a diagnosis **note** back on the
incident, and — behind author-placed gates — **escalates** to the next on-call or
**resolves** the incident. Authority lives in the flow graph; the connector is a
pure actuator.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and copies the module shape of the built Sentry and GitHub connectors
(`src/main/sentry/*`, `src/main/github/*`): descriptor-as-code, the
`CredentialStore` keychain, presence-derived `status()`, a live
`invokeAction`/`subscribe` wired via `registerConnector`. It uses the merged
**Sentry** and **GitHub** connector specs as its style and depth template
(`docs/superpowers/specs/2026-07-18-sentry-connector-design.md`,
`docs/superpowers/specs/2026-07-18-github-connector-design.md`).

**What is new here versus Sentry/GitHub.** PagerDuty is the **first connector
whose webhook needs the shared receiver's `parseHeader` hook** — its Webhooks v3
signature is a **`v1=`-prefixed** HMAC-SHA256 that may carry **multiple
comma-separated signatures** during secret rotation, unlike Sentry's bare-hex
`Sentry-Hook-Signature`. It is also the **first SaaS-only connector with no
self-host** — PagerDuty offers only fixed US/EU regions, so there is **no
user-supplied base URL and therefore no SSRF guard** on its outbound path (a
contrast with GitHub's GHES and WooCommerce's `storeUrl`). And it is the
**coordination half of a three-connector incident loop** (§7) — the first
connector designed *primarily* to compose with two others rather than to stand
alone.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user assemble, on the canvas, an on-call
incident worker that wakes on a PagerDuty page (`incident.triggered`), reads the
incident + service facts through the PagerDuty REST API, drives an agent pane to
triage it — pulling the Sentry stack trace and driving a GitHub fix PR through
the sibling connectors — writes the diagnosis back as an incident **note**, and —
behind author-placed gates — **escalates** or **resolves** the incident, with the
API key / webhook secret in the OS keychain, **never** rendered.

### In scope (MVP)

- A new **PagerDuty connector** module set under `src/main/pagerduty/`, exposing a
  static `pagerdutyDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus a live `PagerDutyConnector implements LiveConnector`
  registered via `registry.registerConnector('pagerduty', …)` — the same seam
  Sentry/GitHub already use (`integration-registry.ts`).
- **`'pagerduty'` added to `IntegrationId`, `INTEGRATION_IDS`, and
  `DESCRIPTOR_DEFS`** — the **three lockstep touch-points** (§6.0).
- **Auth: a REST API key** (account-level or user token) sent as
  `Authorization: Token token=<key>`, stored in the keychain via `CredentialStore`.
  Write actions additionally send the **`From:` header** with a configured PagerDuty
  user's email (PagerDuty attributes REST mutations to a real user — §8). The
  **Events API v2 routing key** (for *creating*/triggering incidents from localflow)
  is designed-for and stored the same way, but the MVP write surface is
  REST-management, not enqueue (§8, §13.1).
- A **PagerDuty API client** (`pagerduty-api.ts`) — the **sole** place any
  PagerDuty REST or Events-API shape lives — implementing the read + write surface
  behind the pinned actions (§6.2). Isolated behind a `PagerDutyApi` interface so
  tests inject a `MockPagerDutyApi` (§12).
- **Webhook triggers via the shared receiver.** A thin
  `pagerduty-webhook-server.ts` (mirroring `sentry-webhook-server.ts`) wraps the
  shared `startWebhookReceiver` (`src/main/webhooks/webhook-receiver.ts`),
  supplying the **pinned v3 `WebhookVerifier`** — `scheme:'hmac'`, `algo:'sha256'`,
  `header:'x-pagerduty-signature'`, `encoding:'hex'`, and a **`parseHeader` that
  selects the `v1=` signature** from the (possibly comma-separated) header (§4.4).
  It writes **no** webhook server of its own.
- The **pinned on-call vocabulary** (§6): four webhook-backed triggers, two read
  actions, four gated-write actions, and the **context-field shape** an action
  writes for downstream edge conditions.
- **The flagship on-call loop** (§7): `incident.triggered` → a builtin **`agent`
  node** triages (reading the paged service, and — composing with Sentry+GitHub —
  the underlying error and a candidate fix) → a gated **`addNote`** posts the
  diagnosis back onto the incident → **either** a gated `escalateIncident` (the
  agent can't fix it) **or** a GitHub fix-PR sub-loop → a gated `resolveIncident`
  once the human has merged. The connector supplies capability + facts; the flow
  supplies authority.
- **Authority = the flow's gates.** Every write is an `action` node the author
  gates. **`acknowledgeIncident`, `resolveIncident`, `escalateIncident`, and
  `addNote` all flow-gated** — even `acknowledge`, which is arguably auto-safe
  (§9). The connector **never auto-mutates**.
- **Single account, single localflow environment.** Config-as-code `pagerduty`
  block in `config.json` (non-secret refs only: region, `fromEmail`, default
  service/escalation-policy ids, `webhookUrl`); API key + webhook secret +
  (optional) routing key in the keychain.

### Out of scope (MVP) — explicitly deferred

- **Creating/triggering incidents from localflow** (Events API v2 `enqueue` with a
  routing key — `event_action: trigger`). The routing-key credential + client path
  are *built* so a phase-2 `triggerIncident` action is additive; the MVP write
  surface is management of an **existing** incident (§8, §13.1).
- **Multi-service / multi-escalation-policy fan-out.** The config/credential shapes
  are drawn so a `services: […]` array is the additive path (§14), not built now.
- **Rich incident-timeline reasoning** (auto-parsing every log-entry, alert-group
  correlation). MVP hands the incident + service + linked Sentry issue to the agent
  and lets *it* reason — the connector does not itself analyze the timeline.
- **Programmatic webhook-subscription management** (creating the v3 subscription via
  the Webhook Subscriptions REST API on connect). MVP has the user create the
  subscription in PagerDuty pointing at their tunnel; phase 2 automates it (§13.5).
- **The richer edge-condition operators** (`gt`/`contains`/…). Owned by the sibling
  conditions track; this spec only guarantees its fields are shaped to be referenced
  by them (§10).
- **Flow templates / the "starter on-call worker" graph.** Owned by the templates
  track, which consumes §6 verbatim.
- **Opsgenie / other alerting hosts.** Deferred; the module boundaries are
  incident-shaped so a same-slot sibling reuses them (§14).

---

## 2. Feasibility + landscape

Feasibility is **DONE** (research: `scratchpad/research/B-dev-incident.md` — the
sensor→coordinator→actuator framing and the on-call loop; PagerDuty as the *cloud
coordinator* and the Webhooks v3 `v1=` signature). This section records the
verdict that gate produced; it does not re-derive it.

### 2.1 Why PagerDuty is the coordinator, not another sensor

Sentry answers *"what broke?"*; GitHub answers *"who fixes it and how?"*.
PagerDuty answers *"whose problem is this right now, and is it still open?"* — it
is the **on-call coordination layer**: the page that wakes a human, the
acknowledge that says "I've got it", the escalation that says "I don't, wake the
next person", and the resolve that closes the loop. That is a **coordination**
role, and it is exactly the role a flow can automate *around* the Sentry+GitHub
pair: PagerDuty pages → localflow triages and (if it can) fixes → PagerDuty
records the outcome. PagerDuty's own **Incident Workflows / Event Orchestration**
cannot drive a coding agent across a git host; localflow's value here is the
**cross-tool compose** (§7), not re-implementing PagerDuty's routing.

### 2.2 The PagerDuty API for trigger → read → act

Grounded in the completed feasibility gate:

- **Two API surfaces, both GA.** The **REST API v2** (`https://api.pagerduty.com`,
  EU: `https://api.eu.pagerduty.com`) is the read + incident-management surface
  (`GET /incidents/{id}`, `GET /services/{id}`, `PUT /incidents/{id}`,
  `POST /incidents/{id}/notes`). The **Events API v2**
  (`https://events.pagerduty.com/v2/enqueue`) *creates* incidents from a routing
  key and can `acknowledge`/`resolve` by `dedup_key`. MVP uses **REST for reads and
  management writes** (one endpoint per action, addressed by incident id); Events
  API v2 is the *creation*/trigger surface, deferred to phase 2 (§13.1).
- **Read.** `GET /incidents/{id}` → `getIncident`; `GET /services/{id}` →
  `getService`. GA.
- **Act (management, REST).** `PUT /incidents/{id}` `{status:'acknowledged'}` →
  `acknowledgeIncident`; `PUT /incidents/{id}` `{status:'resolved'}` →
  `resolveIncident`; `PUT /incidents/{id}` `{escalation_level:N}` (or reassign to
  the next on-call) → `escalateIncident`; `POST /incidents/{id}/notes` → `addNote`.
  All GA. This covers the four gated writes (§6.2).
- **The `From:` acting-user requirement (a YELLOW wrinkle).** REST mutations
  (status changes, notes, escalation) require a **`From:` header carrying the email
  of a valid PagerDuty user** — PagerDuty attributes the action to *that human*.
  There is no pure "app/bot" actor as GitHub Apps or Linear's `actor=app` offer;
  the connector acts **as a configured service-account user** (§8). This is a real
  identity-posture wrinkle (it is why the verdict is YELLOW, not GREEN), not a
  blocker: a dedicated "localflow automation" PagerDuty user is the clean shape.
- **Auth.** A single **REST API key** (`Authorization: Token token=<key>`) — either
  an account-level "General Access" key or a user token. No JWT dance (simpler than
  GitHub's App path). The **Events API v2 routing key** is a *separate* per-service
  integration key used only for `enqueue`.
- **Webhooks v3 (push, not poll).** A webhook subscription POSTs an event envelope
  with an **`X-PagerDuty-Signature`** header whose value is one or more
  comma-separated **`v1=<hex HMAC-SHA256 of the raw body>`** signatures, keyed by
  the subscription's generated secret. **It signs the body alone — no timestamp**
  (unlike Stripe/Slack). The event envelope carries `event.event_type`
  (`incident.triggered`, `.acknowledged`, `.escalated`, `.resolved`, `.annotated`,
  …), `event.id` (the redelivery-safe idempotency id), and `event.data` (the
  incident). This maps onto the shared receiver's pinned
  `WebhookVerifier{scheme:'hmac',algo:'sha256',header,encoding:'hex',parseHeader}`
  (§4.4).
- **SaaS-only — no self-host, so no SSRF guard.** PagerDuty is hosted; the base URL
  is a **fixed region choice** (US / EU), not a user-supplied host. There is
  therefore **no `pagerduty-ssrf.ts` and no shared-guard call** on its outbound path
  — a deliberate contrast with GitHub (GHES) and WooCommerce (`storeUrl`), which
  needed it. The region is a validated enum, not free-form (§4.5).
- **Rate limits.** REST API v2 is roughly **960 requests/minute** per account (the
  Events API is higher); the client honors `429` + `Retry-After` with capped
  backoff (§11). A few reads + a write per run is far under budget; push-over-poll
  keeps us there.

### 2.3 Constraints (honest caveats — the YELLOW)

1. **REST mutations act as a named human (`From:`).** No bot identity; the
   connector acts as a configured service-account user (§2.2, §8). An
   identity-posture wrinkle, not a gap.
2. **Webhook-secret rotation can present multiple `v1=` signatures.** During a
   subscription's secret rotation, PagerDuty may send two comma-separated `v1=`
   signatures (old + new secret). The shared receiver's `parseHeader` returns **one**
   signature and the verifier compares it against **one** stored secret, so a naive
   "pick the first `v1=`" can fail to match during the rotation window (§4.4, §13.2).
   Flagged; not a steady-state blocker (a subscription has one active secret).
3. **Cloud ingress is mandatory for triggers.** Identical to Sentry/GitHub:
   PagerDuty POSTs webhooks from the cloud, so the local receiver needs a reachable
   URL — a dev tunnel in MVP, a hosted relay in the product fork (§4.4). Reads +
   writes work over plain outbound HTTPS with no ingress; only *triggers* need it.
4. **Escalation needs a higher level to exist.** `escalateIncident` bumps to the
   next on-call in the escalation policy; if the incident is already at the top
   level, PagerDuty refuses. The connector forwards that real error (§11), not a
   silent no-op.

### 2.4 Verdict: **YELLOW**

The trigger → read → act loop is **fully buildable today** on PagerDuty's GA REST
+ Events v2 APIs, with a single API-key auth, standard `v1=` HMAC-SHA256 webhooks
that map onto the shared receiver's `parseHeader` hook, and a SaaS-only base URL
that needs no SSRF guard. It is **YELLOW rather than GREEN** because of two real
wrinkles: REST writes act **as a named user** (the `From:` header, no bot
identity) and webhook-secret **rotation can present multiple signatures** the
single-signature receiver must be taught to handle (§13.2). Both are designed-for
below; neither blocks the MVP slice.

---

## 3. The core loop → PagerDuty primitives

localflow's on-call loop is `trigger → read → triage (agent, compose) → act
(gated)`. Each stage maps to a concrete PagerDuty primitive and the concrete
flow-engine mechanism that runs it:

| Stage | PagerDuty primitive | localflow / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified Webhooks-v3 event: `incident.triggered` (the page), `incident.acknowledged`, `incident.escalated`, `incident.resolved`. | The shared `webhook-receiver` verifies the `X-PagerDuty-Signature` `v1=` HMAC → the thin `pagerduty-webhook-server` parses the envelope → the connector normalizes it to a `SeedEvent` → its `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context. |
| **read** | REST `GET /incidents/{id}` / `GET /services/{id}`. | An `action` node (`getIncident` / `getService`) → `registry.invokeAction('pagerduty', ref, params)` → `PagerDutyConnector` calls `pagerduty-api.ts` → normalizes → the action-runner writes the result to context under the node id. |
| **triage** | *(none — localflow's own coding-agent capability, composing with Sentry+GitHub)* | A builtin **`agent` node** (`agent-runner.ts`) drives a coding-agent pane through the guarded operator control-API (`POST /panes`, `/panes/:handle/prompt`, lfguard-guarded). It reads the Sentry stack trace and drives a GitHub fix through the sibling connectors' actions in the **same flow context** (§7); it reports via `FLOW_RESULT`. |
| **route** | *(none — pure localflow)* | `selectEdges` evaluates edge conditions over the context the reads/agent wrote (`context.ts`) — e.g. `incident.urgency eq 'high'`, or `fix.opened truthy` to choose the resolve branch vs the escalate branch. Deterministic value compares; no LLM routes. |
| **gate** | *(none — pure localflow)* | A `gate` node the author placed pauses the run `needs-you` (`ApprovalPort`, `types.ts`). `resolveIncident` / `escalateIncident` / `addNote` / `acknowledgeIncident` sit **downstream of the gate the author drew** (§9). |
| **act** | REST write: `PUT /incidents/{id}` (status / escalation), `POST /incidents/{id}/notes`. | The gated `action` node (`acknowledgeIncident` / `resolveIncident` / `escalateIncident` / `addNote`) → `invokeAction` → `pagerduty-api.ts` write with the `From:` acting-user header. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* PagerDuty error verbatim. |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities* (triggers, read actions, write actions); the *flow* decides
which run, in what order, behind which gates. The triage that composes Sentry +
GitHub is a **builtin `agent` node** plus **sibling connector actions** — the
PagerDuty connector's job is only to *start the run* (the page) and *record the
outcome* (note / escalate / resolve).

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/pagerduty/`, mirroring
`src/main/sentry/` (the closest-built sibling — same webhook-wrapper pattern, same
descriptor/connector/normalize split). It is **opt-in**: with no `pagerduty`
config entry (and no stored credential) the descriptor's `status()` returns
`needs-config` and the engine refuses any PagerDuty node before any network call —
localflow's "works with no integration" guarantee is unchanged.

The connector is the live implementation behind the registry's pinned
`invokeAction`/`subscribe`, registered with
`registry.registerConnector('pagerduty', connector)` at startup in
`src/main/index.ts` — the **same seam** Sentry and GitHub use. All PagerDuty API
shapes are isolated in `pagerduty-api.ts` (the blast radius for any API-version
change), exactly as Sentry isolated its REST in `sentry-api.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/pagerduty/pagerduty-descriptor.ts` | The static `IntegrationDescriptorDef` (`id:'pagerduty'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids. Mirrors `sentry-descriptor.ts`. |
| `src/main/pagerduty/pagerduty-connector.ts` | The `PagerDutyConnector implements LiveConnector`. Dispatches an action id → a `pagerduty-api` call (params templated by the engine); dispatches a trigger id → a webhook subscription, applying the derived-filter for any coarse event. Holds NO PagerDuty shape and NO secret; every failure REJECTS with the real cause (the pinned convention). **Never auto-mutates.** Mirrors `sentry-connector.ts`. |
| `src/main/pagerduty/pagerduty-api.ts` | Thin **PagerDuty REST v2 (+ Events v2)** client. **All** PagerDuty request/response shapes live *only* here. `Authorization: Token …` + the `From:` acting-user header on writes. Rate-limit-aware backoff honoring `429`/`Retry-After`. Isolated behind a `PagerDutyApi` interface so tests inject a `MockPagerDutyApi` (§12). |
| `src/main/pagerduty/pagerduty-normalize.ts` | **Pure** mapping: a raw incident/service JSON node → the pinned **context-field shape** (§6.3); and a raw v3 webhook envelope (`incident.triggered`/`.acknowledged`/`.escalated`/`.resolved`) → a `SeedEvent`. Unit-testable in isolation (mirrors `sentry-normalize.ts`). Numeric ids, lowercase status/urgency enums, assignee arrays are normalized **once** here so conditions read a stable shape. |
| `src/main/pagerduty/pagerduty-webhook-server.ts` | A **thin wrapper** over the shared `startWebhookReceiver`, mirroring `sentry-webhook-server.ts`: supplies the pinned v3 `WebhookVerifier` (with the `parseHeader` for `v1=`), a `dedup` short-circuit over a seen-set of `event.id`s, and the vendor `parse` (JSON-object guard → `PagerDutyWebhookDelivery`). Owns **no** HTTP/HMAC/size-cap code — that is the shared receiver's. |
| `src/shared/pagerduty.ts` | Shared types + id constants (`PAGERDUTY_TRIGGER_IDS`, `PAGERDUTY_READ_ACTION_IDS`, `PAGERDUTY_MUTATION_ACTION_IDS`, `PagerDutyIncidentContext`, `PagerDutyServiceContext`, the action param shapes) needed by both main and any renderer palette surface. Mirrors `src/shared/sentry.ts`. |

**What is deliberately absent:**

- **No hand-rolled HTTP/HMAC.** The v3 verification + 200-fast + size-cap + raw-body
  capture ride the shared `webhook-receiver.ts` (§4.4).
- **No `pagerduty-ssrf.ts`.** PagerDuty is SaaS-only; the base URL is a fixed
  region enum, not a user-supplied host (§4.5). This connector makes **no**
  SSRF-guard call — a clean contrast with GitHub/Woo.
- **No `pagerduty-auth.ts`.** Auth is a single `Token` header (plus the `From:`
  header on writes) — no JWT/installation-token dance, so no dedicated auth module
  (a contrast with `github-auth.ts`). Secrets ride the merged registry's
  `CredentialStore` (`revealForConnector('pagerduty', …)` — the sole main-only
  plaintext exit).
- **No `pagerduty-token-store.ts`.** Secrets ride `CredentialStore`, exactly as
  Sentry/GitHub do.

### 4.3 Wiring the live dispatch into the merged registry

The pinned `LiveConnector` seam already exists (`src/shared/integrations.ts:73`)
and the registry already delegates to it. So this connector needs **no contract
change** — only:

- `IntegrationId`, `INTEGRATION_IDS`, and `DESCRIPTOR_DEFS` gain `'pagerduty'` (the
  three lockstep edits, §6.0).
- `src/main/index.ts` constructs the `PagerDutyConnector` (given the
  `CredentialStore`, config, the `pagerduty-api` client, and a
  `pagerduty-webhook-server` handle) and calls
  `registry.registerConnector('pagerduty', connector)`.

The registry's pinned `invokeAction`/`subscribe` then delegate to it; an id with
no connector still returns the legible "no live connector wired" reject.
Byte-for-byte the same seam Sentry used.

### 4.4 Receiving webhooks — the shared receiver + pinned v3 verifier

PagerDuty does **not** get its own webhook server. `pagerduty-webhook-server.ts`
registers a subscription on the **shared** `startWebhookReceiver` with:

```
WebhookVerifier {
  scheme: 'hmac',
  algo: 'sha256',
  header: 'x-pagerduty-signature',
  encoding: 'hex',
  // PagerDuty v3 signs the RAW BODY ALONE — no timestamp. signsTimestamp stays
  // at its default (false); we deliberately do NOT use the receiver's Stripe/Slack
  // timestamp path. parseHeader selects the v1= signature from the (possibly
  // comma-separated) header value.
  parseHeader: (raw) => {
    const v1 = raw.split(',').map(s => s.trim()).find(s => s.startsWith('v1='))
    return v1 ? { signature: v1.slice('v1='.length) } : null
  }
}
```

i.e. verify by computing `hex( HMAC_SHA256( rawBody, webhookSecret ) )` and
`timingSafeEqual`-comparing it to the `v1=` signature the header carries. The
shared receiver owns everything Sentry/Woo re-implemented: `createServer` /
`applyLoopbackTimeouts` / `MAX_BODY_BYTES`, the `responded` latch, **raw-body
capture before any JSON parse** (a body-parser that consumes the stream first
breaks HMAC verification), the timing-safe compare, and the **200-fast** response
so PagerDuty's delivery-timeout expectation is met and a slow flow never triggers
a redelivery storm.

The wrapper supplies, per the shared config: the pinned `WebhookVerifier`, the
path (`/pagerduty/webhook`), the secret source (`revealForConnector('pagerduty',
'webhookSecret')`), a **`dedup` short-circuit** over a seen-set of **`event.id`s**
(200 + drop a redelivery, AFTER verify / BEFORE parse — exactly the Sentry
`makeSentryDedup` shape), and a `parse` (JSON-object guard →
`PagerDutyWebhookDelivery{ id, eventType, resourceType, data }`). The connector's
`onDelivery` maps `eventType` to a trigger id, normalizes via
`pagerduty-normalize`, and fans a `SeedEvent` to the matching handlers (the
`sentry-connector.ts onDelivery` shape).

**Signature rotation (the YELLOW edge — §2.3.2, §13.2).** During a secret
rotation PagerDuty can send two comma-separated `v1=` signatures. The pinned
`parseHeader` above picks the **first** `v1=`; if that was signed with the *other*
active secret, verification fails until rotation completes. The steady state (one
active secret, one signature) is clean. Options flagged in §13.2: (a) accept a
brief manual-rotation gap; (b) teach the shared receiver a "any-of-N signatures"
mode; (c) keep two secrets in the keychain during rotation and try both.

**Cloud ingress:** identical to Sentry §4.4 — a dev tunnel in MVP (the tunnel URL
is the webhook's delivery address, stored as the non-secret `webhookUrl` config
ref), a hosted relay in the product fork (§13.1). A forged / oversized / duplicate
/ unparseable delivery is dropped by the shared receiver and **never** seeds a run.

### 4.5 Region base URL — no SSRF guard needed

`region` is a non-secret config field, a **validated enum** (`us` →
`https://api.pagerduty.com`, `eu` → `https://api.eu.pagerduty.com`). Because the
base URL is a **fixed PagerDuty-owned host chosen from a closed set** — never a
user-supplied host — there is **no SSRF surface** and the connector makes **no**
call to the shared `ssrf-guard.ts`. This is a deliberate, documented contrast with
GitHub (GHES `baseUrl`) and WooCommerce (`storeUrl`), where the host *is*
user-supplied and the guard is mandatory. The Events API host
(`events.pagerduty.com`) is likewise fixed.

### 4.6 Driving the triage agent pane (reusing the operator control-API)

The connector **does not** spawn or drive panes. That is the builtin **`agent`
node** (`src/main/flow/node-runners/agent-runner.ts`), which the author places
between the PagerDuty trigger and the gated writes. The agent node drives the pane
through `PaneDriver` (`src/main/flow/pane-driver.ts`) → the exported
`handleRequest` router (`src/main/control-api.ts`) under an `OperatorGrantStore`
grant: `createTerminal` → `POST /panes` (`agentId` ∈ `OPERATOR_TERMINAL_AGENTS` =
`{claude, codex, gemini}`), `prompt` → `POST /panes/:handle/prompt`
(lfguard-guarded). The pane's cwd is derived server-side from the group's members.
This keeps the PagerDuty-triggered triage **inside the operator boundary** — the
capability gate, the lfguard prompt guard, and per-environment isolation apply
identically. The connector only *starts the run* and *records the outcome*.

### 4.7 Reused localflow surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  + `INTEGRATION_IDS` (edited, §6.0); `IntegrationStatus`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain;
  `revealForConnector` (main-only plaintext exit); `decryptionError` (feeds
  `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3);
  `deriveStatus` gives PagerDuty its status for free; the live-dispatch delegation.
- `src/main/integrations/descriptors/index.ts` — `DESCRIPTOR_DEFS` gains
  `pagerduty`.
- `src/main/webhooks/webhook-receiver.ts` — **the shared receiver**; PagerDuty's
  thin wrapper registers its `WebhookVerifier` (with the `parseHeader` for `v1=`)
  here (§4.4). First consumer of the `parseHeader` hook.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, the not-connected guard, and how the
  resolved value lands in context.
- `src/main/flow/node-runners/agent-runner.ts` + `src/main/flow/pane-driver.ts` —
  the builtin `agent` node that triages (§4.6, §7).
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; the
  `coerceEvent`/`matchesFilter` normalization the webhook `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField`/`applyTemplate`/`selectEdges`;
  `parseFlowResult` (the `FLOW_RESULT` sentinel the triage agent reports through).
- `src/main/sentry/*` + `src/main/github/*` — the **sibling connectors** this loop
  composes with (§7): `sentry/getIssue`+`getEvent` for the stack trace, the GitHub
  `agent`+`openPR` fix sub-loop.

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `pagerdutyDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as it does for the
other connectors — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `apiKey` | PagerDuty REST API key | **yes** | yes | string | `Authorization: Token token=…`. Keychain only. Placeholder `u+…` / account key. |
| `fromEmail` | Acting user email (`From:`) | no | yes | string | The PagerDuty user REST mutations are attributed to (§8). Non-secret ref. A dedicated "localflow automation" user is recommended. |
| `webhookSecret` | Webhook v3 signing secret | **yes** | yes | string | Verifies `X-PagerDuty-Signature` `v1=`. Keychain only. |
| `routingKey` | Events API v2 routing key | **yes** | no | string | Per-service integration key for `enqueue` (create/trigger). Keychain only. Deferred write path (§13.1). |
| `region` | Region (`us` / `eu`) | no | yes | string | Selects the fixed base URL (§4.5). Default `us`. Validated enum, **not** free-form (no SSRF). |
| `serviceId` | Default service id | no | no | string | e.g. `PXXXXXX`. Optional; actions/triggers may filter per-node. |
| `escalationPolicyId` | Default escalation policy | no | no | string | Used by `escalateIncident` when reassigning. Non-secret ref. |
| `environment` | localflow environment (1-9) | no | yes | number | Which env hosts PagerDuty work (same field/validation as the siblings). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay delivery address (§4.4). Placeholder `https://<tunnel>/pagerduty/webhook`. |

`status('pagerduty')` reports `needs-config` until `apiKey` + `webhookSecret` +
`fromEmail` + `region` + `environment` are present; `error` on a decrypt failure;
`disabled` if configured-but-off; `connected` otherwise. The action-runner refuses
any non-`connected` PagerDuty node before any network call.

---

## 6. Pinned on-call vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `pagerduty-descriptor.ts` guards the ids; the field shape is guarded by the
> `pagerduty-normalize.ts` tests. Mirrors the Sentry vocabulary pinning.

### 6.0 Shared-union edit (the three lockstep touch-points)

`src/shared/integrations.ts` — `IntegrationId` gains `'pagerduty'`:

```ts
export type IntegrationId =
  | 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'posthog'
  | 'gitlab' | 'slack' | 'http' | 'stripe' | 'github' | 'sentry' | 'hubspot'
  | 'pagerduty'
```

The **three lockstep edits** (each a one-line add): the `IntegrationId` union
(`integrations.ts:11`), the `INTEGRATION_IDS` stable-order array
(`integrations.ts:99`), and `DESCRIPTOR_DEFS` (`descriptors/index.ts:19`). No other
`IntegrationId` consumer needs a change — they iterate the array.

### 6.1 Triggers (webhook-backed)

| trigger id | label | underlying v3 event | note |
|---|---|---|---|
| `incident.triggered` | Incident triggered (paged) | `incident.triggered` | **The flagship trigger** — the on-call loop's entry (§7). Seeds a `PagerDutyIncidentContext`. |
| `incident.acknowledged` | Incident acknowledged | `incident.acknowledged` | Someone (a human or a flow) took it. Useful for "auto-triage on ack". |
| `incident.escalated` | Incident escalated | `incident.escalated` | The page climbed the policy — a flow can react (e.g. gather more context for the next on-call). |
| `incident.resolved` | Incident resolved | `incident.resolved` | Loop-close event; useful for postmortem/record flows. |

All four are **clean 1:1** maps to native v3 event types (no derived-filter needed,
unlike Sentry's `issue.regressed`). The `incident.annotated` (note added) and
`incident.reassigned` events are phase-2 additions (§14).

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | PagerDuty call | writes to context |
|---|---|---|---|
| `getIncident` | Get an incident | `GET /incidents/{id}` | `PagerDutyIncidentContext` (§6.3) |
| `getService` | Get a service | `GET /services/{id}` | `PagerDutyServiceContext` (§6.3) |

**Gated write (the author places a gate before these):**

| action id | label | PagerDuty call | note |
|---|---|---|---|
| `acknowledgeIncident` | Acknowledge the incident | `PUT /incidents/{id}` `{status:'acknowledged'}` | **Arguably auto-safe** (low blast radius — it only says "a worker is on it"). **Still flow-gated** for consistency (§9) — the flow author, not the connector, decides to skip the gate. |
| `resolveIncident` | Resolve the incident | `PUT /incidents/{id}` `{status:'resolved'}` | Closes the incident. State change; gated. The on-call loop's clean close after a merged fix (§7). |
| `escalateIncident` | Escalate to the next on-call | `PUT /incidents/{id}` `{escalation_level}` / reassign | Wakes the next person / policy level. Refuses if already at the top level (§11). The "I can't fix this" branch (§7). |
| `addNote` | Add a note to the incident | `POST /incidents/{id}/notes` | Posts the agent's diagnosis (+ PR link) onto the incident timeline. Gated (it is a mutation), though low-risk. |

Every REST write sends the **`From:` acting-user header** (`fromEmail`, §8).

**Failure convention (pinned):** a write that fails **rejects** its promise with
the real PagerDuty error text; a resolved promise (any value) is success and its
value becomes the node's context output (`action-runner.ts`,
`integrations.ts:46-56`). The connector never resolves a sentinel-failure.

### 6.3 Context-field shape (what an action writes for later conditions)

A read/trigger writes a **normalized, stable** object (`pagerduty-normalize.ts`
produces it — string ids, lowercase status/urgency enums, `assignees` as a
`string[]`). Downstream edge conditions read it via dotted paths (`context.ts`
`resolveField`), e.g. `{{getIncident.incident.id}}` in an action param, or
`field: 'trigger.incident.urgency'` in an edge condition. **Pinned shape:**

```ts
// src/shared/pagerduty.ts
export type PagerDutyIncidentStatus = 'triggered' | 'acknowledged' | 'resolved'
export type PagerDutyUrgency = 'high' | 'low'

export interface PagerDutyIncidentContext {
  incident: {
    id: string                 // "PXXXXXX" — the API id used by every write
    number: number             // human incident #
    title: string
    status: PagerDutyIncidentStatus
    urgency: PagerDutyUrgency
    priority: string | undefined       // e.g. "P1"; undefined when unset
    serviceId: string
    serviceName: string
    escalationPolicyId: string
    assignees: string[]        // user summaries/emails currently assigned
    htmlUrl: string            // the incident's PagerDuty URL
    createdAt: string          // ISO 8601
    // Cross-tool compose hooks (§7): links PagerDuty surfaces to the source error.
    // Best-effort — populated from the incident body / first trigger, may be absent.
    sentryIssueId: string | undefined
    serviceUrl: string | undefined     // the service's linked repo/dashboard, if any
  }
}

export interface PagerDutyServiceContext {
  service: {
    id: string
    name: string
    status: 'active' | 'warning' | 'critical' | 'maintenance' | 'disabled'
    escalationPolicyId: string
    htmlUrl: string
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and soon the typed `FlowEdgeCondition` operators of §10).
`incident.number` as a **number**, `status`/`urgency`/`priority` as lowercase
**enums**, `assignees` as a **string[]** — so `incident.urgency eq 'high'`,
`incident.priority eq 'p1'`, `incident.assignees contains 'oncall@acme.com'` all
work. Normalizing once, in one pure module, is the correctness boundary the
templates and conditions tracks both rely on.

---

## 7. The flagship on-call loop — node by node (composing Sentry + GitHub)

**Scenario the author drew on the canvas:** *"When PagerDuty pages me for a
high-urgency incident, triage it — read the Sentry error behind it, try a GitHub
fix — post the diagnosis back on the incident, then behind my approval either
escalate (if we can't fix it) or resolve it (once the fix is merged)."* This is
**not** hardcoded; it is the graph below. The PagerDuty connector supplies only the
trigger, the reads, and the gated writes; the **triage + fix** live in a builtin
`agent` node and the **Sentry + GitHub sibling connectors**.

```
[trigger: pagerduty / incident.triggered]     shared receiver verifies X-PagerDuty-Signature v1=
        │  payload → context['inc'] = PagerDutyIncidentContext
        │  { incident: { id, number, urgency, serviceName, sentryIssueId?, ... } }
        ▼
[router]  edge: inc.incident.urgency == 'high'   (else: end — low-urgency isn't worked)
        ▼
[action: sentry / getIssue + getEvent]        ref uses inc.incident.sentryIssueId
        │  writes context['err'] = SentryEventContext { frames[], topInAppFrame, ... }
        │  (skipped when the incident has no linked Sentry issue)
        ▼
[agent: claude]                               BUILTIN node — triage + author a fix
        │  groupId = a group whose member cwd is the service's repo working tree
        │  promptTemplate: "PagerDuty incident #{{inc.incident.number}}
        │     ({{inc.incident.title}}) on {{inc.incident.serviceName}}. The likely
        │     cause is {{err.topInAppFrame.filename}}:{{err.topInAppFrame.lineNo}}.
        │     Diagnose it. If you can fix it, fix it on a new branch and end with
        │     FLOW_RESULT: {\"branch\":\"<name>\",\"summary\":\"<diagnosis>\",\"fixable\":true};
        │     if not, end with FLOW_RESULT: {\"summary\":\"<why>\",\"fixable\":false}."
        │  → PaneDriver.createTerminal / prompt (guarded control-API, lfguard)
        │  → parseFlowResult(peek) → context['triage'] = { branch?, summary, fixable }
        ▼
[action: pagerduty / addNote]                 GATED upstream OR posted straight —
        │  params={ id:"{{inc.incident.id}}", note:"{{triage.summary}}" }
        │  invokeAction('pagerduty','addNote',…) → POST /incidents/{id}/notes (From: fromEmail)
        ▼
[router]  edge: triage.fixable == true ? → FIX branch : → ESCALATE branch
        │
        ├── FIX branch ─────────────────────────────────────────────────────────
        │   [agent already authored branch]
        │   [gate: "open a PR for this fix?"]       pauses needs-you; human reviews summary
        │   [action: github / openPR]               head={{triage.branch}} → context['pr']
        │   [action: pagerduty / addNote]           "Fix PR opened: {{pr.url}}"
        │      … the human merges the PR in GitHub …
        │   [gate: "resolve the incident?"]         pauses needs-you
        │   [action: pagerduty / resolveIncident]   PUT /incidents/{id} {status:'resolved'}
        │      ▼ (done)
        │
        └── ESCALATE branch ───────────────────────────────────────────────────
            [gate: "escalate to the next on-call?"]  pauses needs-you
            [action: pagerduty / escalateIncident]   PUT /incidents/{id} {escalation_level:+1}
               ▼ (done)

        ✱ resolveIncident / escalateIncident NEVER run un-gated. ✱  (§9)
```

**The three-connector compose is the point.** PagerDuty is the coordination frame
(page in, note/escalate/resolve out); **Sentry** supplies the error detail
(`getEvent` → `frames[]`/`topInAppFrame` — the fields the Sentry spec pinned
precisely so a downstream fix node consumes them); **GitHub** supplies the fix
(the agent authors a branch, the gated `openPR` publishes it, a human merges).
They share **one flow context** — `inc.incident.sentryIssueId` feeds
`sentry/getIssue`, `err.topInAppFrame` feeds the agent prompt, `triage.branch`
feeds `github/openPR`, `pr.url` feeds `pagerduty/addNote` — with **no connector
knowing about another**. The composition lives entirely in the graph the author
drew. This is the payoff of the pinned, normalized context shapes across all three
specs.

Node-by-node against the engine:

1. **Trigger fires.** The shared receiver verifies the `v1=` HMAC, dedups on
   `event.id`, 200s fast; the connector normalizes the `incident.triggered`
   envelope to a `SeedEvent` → `startRun`. Payload in `context['inc']`.
2. **Router branches on urgency.** `selectEdges` gates on `inc.incident.urgency`
   (deterministic, no LLM).
3. **Sentry reads the error.** `sentry/getIssue`+`getEvent` (the sibling
   connector) writes `err` — the stack trace the triage agent needs. Skipped when
   there is no linked Sentry issue.
4. **Agent triages.** The builtin `agent` node diagnoses and (if fixable) authors a
   branch, reporting `{ branch?, summary, fixable }` via `FLOW_RESULT`.
5. **`addNote` records the diagnosis.** The agent's `summary` (+ later the PR link)
   lands on the incident timeline — the human sees localflow's reasoning in
   PagerDuty.
6. **Route on `fixable`.** Fixable → the GitHub fix sub-loop (gate → `openPR` → the
   human merges → gate → `resolveIncident`). Not fixable → gate → `escalateIncident`.
7. **The human owns the sharp writes.** `resolveIncident` and `escalateIncident`
   run only behind the gate the author drew; a human "no" ends the run `rejected`
   (not a failure).

The same trigger + reads + agent node support arbitrarily different graphs
(note-only triage, auto-acknowledge-then-gather-context, escalate-on-P1, postmortem
on `incident.resolved`). The connector supplies capability + facts; the flow
supplies authority.

---

## 8. Auth & keychain

- **REST API key (the auth).** The user pastes a PagerDuty API key into the masked
  `apiKey` field; it goes straight to the keychain via `CredentialStore.set`. Every
  REST request sends `Authorization: Token token=<key>`, read at call time via
  `revealForConnector('pagerduty','apiKey')` (main-process-only, the sole plaintext
  exit; a grep test asserts no IPC/renderer caller). No JWT/OAuth dance (simpler
  than GitHub's App path).
- **The `From:` acting-user header (writes).** PagerDuty attributes REST mutations
  (status changes, notes, escalation) to a **named user**, supplied as
  `From: <fromEmail>`. `fromEmail` is a **non-secret** ref (an email, not a
  credential); the recommended shape is a dedicated **"localflow automation"
  PagerDuty user** so the incident timeline reads clearly and the actor is auditable.
  This is the closest PagerDuty offers to an app identity (§2.2) — there is no bot
  actor, which is why the verdict is YELLOW.
- **Events API v2 routing key (deferred write path).** A per-service integration
  key for `POST events.pagerduty.com/v2/enqueue` to *create*/trigger incidents
  (`event_action: trigger`) or ack/resolve by `dedup_key`. Stored the same way
  (`routingKey`, keychain), **built but not surfaced as an MVP action** (§13.1) — a
  phase-2 `triggerIncident` is additive.
- **Webhook secret.** Stored the same way (`webhookSecret`), used only by the shared
  receiver to verify `X-PagerDuty-Signature` `v1=` (§4.4).
- **Honoring the global secret rule.** Neither the API key, the routing key, nor the
  webhook secret is **ever** written to `config.json`, the transcript, a log, a PR
  body, or any IPC payload. `config.json` holds only **references** (`region`,
  `fromEmail`, `serviceId`, `escalationPolicyId`, `webhookUrl`, that a credential
  exists). Secret **state** (present / decrypt-failing) may be surfaced via
  `status()`; the **value** never is — the hub's existing discipline applied to
  PagerDuty verbatim.
- **Disconnect.** Clearing the secrets (the hub's `clearSecret`) flips `status()` to
  `needs-config`; the connector stops dispatching. No in-flight run is force-killed —
  it simply can't start a new PagerDuty action, and reports why (§11).

---

## 9. Authority & safety — the writes are the human's

**Primary control — the flow's gates (already enforced).** Every write
(`acknowledgeIncident`, `resolveIncident`, `escalateIncident`, `addNote`) is an
`action` node. Authority is whatever the author wired: a `gate` node pauses the run
`needs-you` for human approval (`ApprovalPort`, `types.ts` — "a gate NEVER
auto-proceeds"); a conditional edge restricts *when* the write is even reached; a
human "no" ends the run `rejected` (not a failure). **The connector never
auto-mutates outside the graph the author drew** — exactly the
`sentry-connector.ts` posture.

**All four mutations are flow-gated — including `acknowledge`.**
`acknowledgeIncident` is arguably **auto-safe**: its blast radius is low (it only
signals "a worker is on this"; it does not close, escalate, or notify anyone new),
and one could justify letting a flow auto-ack a page the moment triage starts. **We
keep it flow-gated anyway, for consistency:** the connector treats *all* mutations
uniformly, and the **flow author decides** whether an `acknowledge` needs a human by
whether they place a `gate` node before it. Baking an "acknowledge is safe" policy
into the connector would put an authority decision in the wrong place — the graph,
not the connector, is where "which writes need a human" is expressed. (An author who
wants auto-ack simply omits the gate before the `acknowledgeIncident` node; nothing
in the connector forces or forbids it.)

**`resolveIncident` and `escalateIncident` are the sharp writes.** Resolving closes
an incident (it can be re-triggered, but a premature resolve hides a live problem);
escalating **wakes another human**. Both belong behind an author-placed gate by
construction (§7). There is no "connector default policy" that resolves or escalates
on its own.

**Optional deterministic backstop (phased, §14).** In the spirit of **lfguard**
(`guard/`), a small declarative `pagerduty.limits` policy enforced **inside the
connector before any mutation** — e.g. `resolveRequiresGate: true` (default on),
`maxEscalationsPerRun: 1`. Deterministic, no model in the loop — defense in depth
under the author's gate, not a replacement for it.

**Never render secrets.** The API key / routing key / webhook secret live in the
keychain; no error message, log line, or context field ever contains one (§8, §11).

---

## 10. Richer-conditions dependency (owned elsewhere — named, not designed)

The flow engine's edge conditions today are `field === equals` (`context.ts`,
`flow-model.ts`). A **sibling conditions track** is upgrading them to a typed
`FlowEdgeCondition { field; op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|
'exists'|'truthy'; value? }`. The fields this spec pins (§6.3) are **designed to be
referenced by those operators**: `incident.number` as a **number** for `gt`/`lte`;
`status`/`urgency`/`priority` as lowercase **enums** for `eq`/`ne`; `assignees` as a
**string[]** for `contains`; `sentryIssueId` present-or-absent for `exists`. This
spec does not design the condition system — it only guarantees its field types are
the ones those operators expect, normalized once in `pagerduty-normalize.ts`. The
dependency is one-directional; the connector works under the current `eq`-only
routing, just less expressively.

---

## 11. Error handling

localflow's principle (error-message-style memory; demonstrated in
`credential-store.ts`, `action-runner.ts`, `control-api.ts`): **every failure is
human-readable, actionable, and carries the real underlying exception. No silent
catch. No bare "failed" / 404-vibe.** A write signals failure by **rejecting** its
promise with that message; the action-runner prefixes it with the node/action and
surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook signature invalid** | signature mismatch (never the body or secret) | Shared receiver rejects (401); route + reason only; **no run started**. |
| **Webhook duplicate** (`event.id` seen) | the event id | 200 (redelivery is expected); dedup-drop; no second run. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | 4xx; dropped by the shared receiver; no run. |
| **Webhook signature-rotation mismatch** | the parsed `v1=` didn't match the stored secret | 401; **no run** until rotation settles or the receiver gains any-of-N support (§4.4, §13.2). Flagged, not silent. |
| **`status('pagerduty') !== 'connected'`** | the derived reason (missing secret / decrypt error / disabled) | Action-runner fails the node *before* any call: "Flow needs PagerDuty connected — action '<id>' can't run. Connect it in Settings." |
| **API key invalid (401)** | PagerDuty's auth error | `invokeAction` **rejects**: "PagerDuty rejected the API key (401) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing `From:` / invalid user (400)** | PagerDuty's `From`-header error | Rejects: "PagerDuty needs a valid acting user — set 'fromEmail' to a real PagerDuty user's email in Settings." |
| **Insufficient abilities (403)** | PagerDuty's scope error | Rejects verbatim: "PagerDuty refused '<action>': the API key lacks the ability to modify incidents on '<service>' — grant it and re-enter." |
| **Incident/service not found (404)** | the id that missed | Rejects: "PagerDuty has no incident '<id>' (it may be from another account or was deleted)." — actionable, not a bare 404. |
| **Escalate with no higher level (400)** | PagerDuty's escalation error | Rejects: "Can't escalate #<n>: it is already at the top of its escalation policy." No silent no-op. |
| **Rate-limit (429 / `Retry-After`)** | the reset time from the header | `pagerduty-api` retries with **capped backoff** honoring the header; only after exhausting retries does it reject with "PagerDuty rate limit hit; resets in ~Ns." Not swallowed. |
| **Agent pane instant-exit** (triage) | the pane's REAL exit tail | The `agent` node fails forwarding `info.message` verbatim — never a vaguer wrapper. |
| **lfguard blocks the triage prompt** | the canonical deny message | `PaneDriver.prompt` returns 403; the agent node surfaces the guard's own message verbatim. |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "PagerDuty webhook URL '<url>' is unreachable — no pages will arrive." Never a silent dead trigger. |

The connector **never** catches-and-drops. Where PagerDuty returns a precise error,
the connector forwards *that* rather than minting a vaguer one — the action-runner
only prefixes it with the node/action.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live PagerDuty account**, matching localflow's existing seams
(pure modules, injected backends, fixture events):

- **`PagerDutyApi` interface + `MockPagerDutyApi` seam.** `pagerduty-api.ts` is
  written *against* a `PagerDutyApi` interface (`getIncident`, `getService`,
  `acknowledgeIncident`, `resolveIncident`, `escalateIncident`, `addNote`); the real
  impl wraps the REST/Events transport. Tests inject a `MockPagerDutyApi` returning
  canned nodes and canned error envelopes (401/403/404/400-escalate/429). **No test
  ever performs a live PagerDuty call**; CI has no PagerDuty credentials. Same
  posture as the built `MockShopifyApi` / `MockSentryApi` seams.
- **`pagerduty-normalize.ts` unit tests** — pure function; assert every raw
  incident/service node and v3 webhook envelope → the pinned context shapes (§6.3):
  string ids, `status`/`urgency` enum lowercasing, `assignees` array, `priority`
  present/absent, the `sentryIssueId` best-effort extraction. The correctness
  boundary the conditions + compose tracks depend on — guarded hardest.
- **Shared-receiver verifier test (the `v1=` parseHeader)** — feed fake
  `incident.triggered` / `.resolved` bodies with **valid and invalid**
  `X-PagerDuty-Signature` values, including a **single `v1=`**, a **comma-separated
  multi-signature** (rotation), a **missing `v1=`**, oversized bodies, malformed
  JSON, and **duplicate `event.id`**; assert 200/4xx/401 and that only
  valid+signed+novel events produce a `SeedEvent`. Exercises the pinned
  `parseHeader` against the shared receiver (its first consumer).
- **`pagerduty-connector` dispatch tests** — with a `MockPagerDutyApi` + a fake
  registry: assert `invokeAction('pagerduty','getIncident',…)` resolves the
  normalized context; assert a PagerDuty error response **rejects** with the verbatim
  message (the pinned failure convention); assert **no write fires without an
  action-node invocation** (the authority regression); assert every write sends the
  `From:` header.
- **The compose seam (offline).** Wire the real `FlowEngine` + registry with the
  PagerDuty **+ Sentry + GitHub** connectors over their three mock apis + the fake
  pane-driver (`agent-runner`'s injected `PaneDriverLike`/`waitForTerminal`), and
  drive the §7 loop: inject an `incident.triggered` `SeedEvent` → `sentry/getEvent`
  writes `err` → the agent node "triages" (scripted `FLOW_RESULT`) → `addNote` calls
  the PD mock → route on `fixable` → the gate pauses `needs-you` → on approval
  `github/openPR` then `pagerduty/resolveIncident` fire; **assert no un-gated resolve
  or escalate.** Deterministic via the engine's injected `now()`. **No pane, no pty,
  no socket, no live API.**
- **Snapshot test on `pagerdutyDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

No test requires PagerDuty credentials or a live account; the real API is exercised
only in manual dogfooding against a scratch account.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **REST-management-only vs Events API v2 in MVP.** MVP manages an **existing**
   incident (REST: ack/resolve/escalate/note). The **Events API v2** routing-key
   path (create/trigger incidents from localflow, `event_action:trigger`) is *built*
   (credential + client) but not surfaced as an action. **Recommendation:
   REST-management MVP; add a phase-2 `triggerIncident` action** once a real
   "localflow raises a page" use-case lands. Either way, both surfaces stay isolated
   in `pagerduty-api.ts`.
2. **Webhook-secret rotation — multiple `v1=` signatures.** The shared receiver's
   `parseHeader` returns one signature and verifies against one secret; a rotation
   window can present two. **Options:** (a) accept a brief manual-rotation gap
   (simplest; steady state is clean); (b) teach the shared receiver an "any-of-N
   candidate signatures/secrets" mode (a small, general receiver enhancement that
   also helps future vendors); (c) hold two secrets in the keychain during rotation
   and try both. **Recommendation: (a) for MVP, (b) as the durable fix** — flagged
   as a shared-infra follow-up, not a connector-only concern.
3. **The `From:` acting identity — single service-account vs per-flow actor.** MVP
   uses one configured `fromEmail` (a dedicated "localflow automation" user). A
   future product surface might attribute each flow's writes to the flow's owner.
   **Recommendation: single service-account user for MVP** (clean audit trail,
   simplest config).
4. **`acknowledge` auto-safe convenience.** §9 keeps all mutations gated for
   consistency, with the author omitting the gate to auto-ack. An alternative is a
   descriptor-level "auto-acknowledge on trigger" convenience flag. **Recommendation:
   no special-casing — the graph expresses it** (omit the gate). Flagged because a
   "one-click on-call worker" template might want auto-ack baked in, which is a
   *template* choice, not a connector feature.
5. **Webhook-subscription management — manual vs programmatic.** MVP has the user
   create the v3 subscription in PagerDuty (pointing at their tunnel); the connector
   can create it via the Webhook Subscriptions REST API on connect. **Leaning manual
   for MVP**, programmatic in phase 2 (adds a scope + a teardown story).

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One account, one flow, the on-call loop's triage-and-note happy path, no
resolve:**

1. `IntegrationId` gains `'pagerduty'` (+ the two other lockstep touch-points, §6.0);
   `pagerdutyDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence.
2. `apiKey` + `webhookSecret` + `fromEmail` + `region` stored (secrets → keychain);
   `status('pagerduty') === 'connected'`.
3. `pagerduty-api.ts` behind `PagerDutyApi`: `getIncident` (`GET /incidents/{id}`)
   and `addNote` (`POST /incidents/{id}/notes`, `From:`) live; `pagerduty-normalize`
   produces `PagerDutyIncidentContext`.
4. `registerConnector('pagerduty', …)`: `invokeAction('pagerduty',…)` reaches the
   connector; `subscribe('pagerduty','incident.triggered',…)` reaches the shared
   receiver via the thin wrapper.
5. The shared `webhook-receiver` handling `incident.triggered` with the pinned
   `WebhookVerifier` (the `v1=` `parseHeader`) + `event.id` dedup, behind a dev
   tunnel, emitting a `SeedEvent`.
6. On the canvas:
   `[incident.triggered] → [agent: claude] → [addNote]` runs end-to-end — a real
   page wakes a real flow that triages and writes a diagnosis note back. Errors per
   §11.

That slice proves the coordination spine (a real page wakes a real flow that reads
the incident, triages it, and records its reasoning on the incident) and is
dogfoodable against a scratch account.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. `incident.triggered` + `getIncident` +
  `agent` + `addNote`. Single account, single environment. **No auto-resolve.**
- **Phase 2 — full vocabulary + the three-connector compose:** the rest of §6 —
  `incident.acknowledged`/`.escalated`/`.resolved`; `getService`; and — behind gates
  + the §9 backstop — `acknowledgeIncident` / `resolveIncident` / `escalateIncident`.
  Wire the full §7 loop composing **Sentry** (`getEvent`) + **GitHub** (`openPR`).
  Programmatic webhook-subscription management (§13.5).
- **Phase 3 — deterministic write backstop:** the `pagerduty.limits` policy (§9),
  lfguard-style (`resolveRequiresGate`, `maxEscalationsPerRun`).
- **Phase 4 — richer conditions consumption:** once the conditions track lands
  `FlowEdgeCondition` (§10), verify the pinned fields drive
  `eq`/`ne`/`gt`/`contains`/`exists` end-to-end (e.g. "only escalate when
  `incident.urgency eq 'high'` and `incident.priority eq 'p1'`").
- **Phase 5 — the Events API v2 trigger path:** a `triggerIncident` action so a flow
  can *raise* a page from localflow (§13.1), plus `incident.annotated`/`.reassigned`
  triggers and multi-service fan-out.
- **Phase 6 — expand alerting hosts (the same-slot sibling): Opsgenie.** **Opsgenie**
  (Atlassian) occupies the **same on-call/alerting slot** as PagerDuty — a page, an
  ack, an escalation, a close. It is the natural peer connector: a
  `src/main/opsgenie/` module set with a **different auth** (`GenieKey <api-key>`)
  and a **different webhook shape**, but reusing the shared `webhook-receiver` /
  `CredentialStore` and the `*-connector` / `*-api` / `*-normalize` /
  `*-webhook-server` module shape verbatim. It slots into the **same §7 loop**
  (page → triage → note → escalate/close) with no engine change — the incident-shaped
  boundaries this spec draws are what make that a peer connector, not a rewrite. No
  shared cross-host "alerting standard" — each is its own connector, exactly as the
  git-host family (GitHub/GitLab) is.

---

## Appendix — reused / satisfied localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  + `INTEGRATION_IDS` edited (§6.0); `IntegrationStatus`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain;
  `revealForConnector` (main-only plaintext exit); `decryptionError` (feeds
  `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3);
  `deriveStatus`; the live-dispatch delegation the PagerDuty connector plugs into.
- `src/main/integrations/descriptors/index.ts` — `DESCRIPTOR_DEFS` gains
  `pagerduty` (the third lockstep edit); `sentry-descriptor.ts` is the
  descriptor-as-code template.
- `src/main/webhooks/webhook-receiver.ts` — **the shared receiver**; PagerDuty
  registers `WebhookVerifier{scheme:'hmac',algo:'sha256',header:'x-pagerduty-
  signature',encoding:'hex',parseHeader:<pick v1=>}` here (§4.4). **First consumer
  of the `parseHeader` hook**; deliberately does **not** use `signsTimestamp`
  (PagerDuty v3 signs the body alone).
- `src/main/sentry/sentry-webhook-server.ts` — the **thin-wrapper pattern**
  `pagerduty-webhook-server.ts` copies (shared receiver + verifier + dedup + parse).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, the not-connected guard, and how the resolved
  value lands in context.
- `src/main/flow/node-runners/agent-runner.ts` — the builtin `agent` node that
  triages by driving a coding-agent pane; its `PaneDriverLike` + `waitForTerminal`
  seams are the triage/compose test surface (§12).
- `src/main/flow/pane-driver.ts` — `PaneDriver.createTerminal`/`prompt` → the
  guarded operator control-API (`POST /panes`, `/panes/:handle/prompt`).
- `src/main/control-api.ts` — `handleRequest`, `OPERATOR_TERMINAL_AGENTS`
  (`{claude, codex, gemini}`), the lfguard prompt guard on `/prompt`.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs;
  `coerceEvent` / `matchesFilter` the webhook `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`;
  `parseFlowResult` (the `FLOW_RESULT` sentinel the triage agent reports through).
- `src/main/flow/types.ts` — `NodeOutcome` (`done`/`failed`/`rejected` — the
  human-"no"-is-not-a-failure gate contract) and the `ApprovalPort` gate seam.
- `src/main/sentry/*` + `src/main/github/*` — the **sibling connectors** the §7
  on-call loop composes with (Sentry for the error detail, GitHub for the fix PR).
- `guard/` (lfguard) — the deterministic-guard *posture* the optional §9 write
  backstop borrows (a policy floor under the author's gates, no model in the loop).
- `docs/superpowers/specs/2026-07-18-sentry-connector-design.md` — the built sibling
  whose webhook-wrapper shape, vocabulary-pinning, error-table, and offline-testing
  posture this spec mirrors.
- `docs/superpowers/specs/2026-07-18-github-connector-design.md` — the flagship
  actuator this connector composes with; the style/depth template for this spec.
</content>
