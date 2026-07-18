# GitLab Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Design-approval gate for the **dev-tool
worker** product direction: the OSS / self-host sibling of the GitHub connector.
Anchor connector for "a coding worker that wakes on a repo event and drives a
fix through a merge request."
**Feature:** A **GitLab connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. A repo event (issue opened, MR opened, **pipeline
failed**) **triggers** a run; the flow **reads** issue / MR / pipeline state via
GitLab's REST API; and — behind gates the author places — **acts** (comment,
label, create an issue, open an MR) and, in the flagship loop, **drives a coding
agent pane** to fix a red pipeline and open the fix as an MR. It does **not**
hardcode a CI-fix pipeline; the authority lives in the flow (conditions on
edges, gates where the author puts them), exactly as the flow engine enforces.

This connector is a **deliberate re-skin of the GitHub connector**
(`docs/superpowers/specs/2026-07-18-github-connector-design.md`, being written in
a parallel worktree). Where semantics match, the **trigger / action ids are kept
parallel** so a single flow template can target either forge (§7); the one
systematic rename is GitHub's **PR** → GitLab's **MR** (merge request), which is
the platform's own term. GitLab earns its own connector rather than a shared
"forge" abstraction because its **self-host + on-LAN-no-tunnel** story is a
first-class open-core advantage GitHub SaaS does not have (§4.4) — that is the
reason this is worth building as a sibling, not a config flag.

It satisfies the **pinned** `IntegrationDescriptor` / `IntegrationRegistry`
contract in `src/shared/integrations.ts` and copies the module shape of
`src/main/integrations/` (CredentialStore keychain, descriptor-as-code,
presence-derived `status()`). It reuses the Linear / Shopify / WooCommerce
connector specs as its style and depth template
(`docs/superpowers/specs/2026-07-16-linear-integration-design.md`,
`docs/superpowers/specs/2026-07-17-{shopify,woocommerce}-connector-design.md`),
and — unlike those earlier specs, which each shipped a private webhook server and
a private SSRF helper — it consumes the two **shared** infra modules those specs
motivated: the shared **webhook receiver** (`src/main/webhooks/webhook-receiver.ts`)
and the shared **SSRF guard** (`src/main/net/ssrf-guard.ts`).

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user assemble, on the canvas, a dev-tool
worker that wakes on a GitLab repo event (issue opened, MR opened, or a **failed
pipeline**), reads the relevant issue / MR / pipeline facts through the GitLab
REST API, routes on those facts via edge conditions, and — behind author-placed
gates — comments / labels / creates issues / **opens an MR from a coding-agent
fix**, while **never** auto-merging (the human merges) — with the PAT in the OS
keychain, **never** rendered, and the self-hosted `baseUrl` passed through the
shared SSRF guard on every call.

### In scope (MVP)

- A new **`gitlab` integration** satisfying the pinned `IntegrationDescriptor`
  in `src/shared/integrations.ts` (`IntegrationId` gains `'gitlab'`), authored as
  a descriptor def in `src/main/integrations/descriptors/gitlab.ts`.
- **Live dispatch** — a connector module set under `src/main/gitlab/` that
  supplies the real `invokeAction`/`subscribe` behaviour the registry delegates
  to for id `'gitlab'` (registered via `registry.registerConnector('gitlab', …)`,
  `integration-registry.ts:54`).
- **Auth (MVP): a GitLab Personal Access Token (PAT)** — the single
  `PRIVATE-TOKEN` header (or `Authorization: Bearer`) — stored in the keychain via
  `CredentialStore`. **OAuth** (authorization-code, for a distributable product
  fork) is designed-for and deferred (§5, §13).
- **A self-hosted `baseUrl`** config field (SaaS defaults to `https://gitlab.com`;
  self-host is any URL the user runs). It is **user-supplied → every outbound
  call passes the shared SSRF guard** (`src/main/net/ssrf-guard.ts`), including
  the explicit **self-host-on-LAN allow** path (§5.1), which is a *primary* use
  case here, not an edge case.
- **A REST API client** (`gitlab-api.ts`) — the **sole** place any GitLab API
  shape lives — implementing the read + write surface behind the pinned actions
  (§6.2).
- **Triggers** via the **shared webhook receiver** using the **`token` scheme**
  (`WebhookVerifier { scheme: 'token', header: 'X-Gitlab-Token' }`) — a plain
  shared-secret compare, **not HMAC** (§4.4, §5.2): `issue.opened`, `mr.opened`,
  `pipeline.failed`.
- **The on-LAN no-tunnel ingress** — a self-hosted GitLab on the same LAN posts
  webhooks **directly** to localflow's receiver with **no public tunnel** (§4.4).
  This is the open-core / local-first advantage the whole connector is built
  around.
- **The pinned dev-tool vocabulary** (§6): three webhook-backed triggers, four
  read actions, five gated-write actions, and the **context-field shape** an
  action writes for downstream edge conditions.
- **The fix-MR loop** (§7): `pipeline.failed` → a gated flow drives a coding-agent
  pane (via the operator control API) to fix the failure → the connector
  **opens** an MR — and **`mergeMR` is never auto-run** ("I merge myself"; §9).
- **Authority = the flow's gates.** Every write is an `action` node the author
  gates. No write ever runs un-gated by construction of the graph the author
  drew. `mergeMR` is gated the **same way as every other write** — a `gate` node
  the author places before it — because merging is irreversible, not because the
  connector adds a bespoke param check (§9).
- **Single project, single localflow environment.** Config-as-code `gitlab` block
  in `config.json` (non-secret refs only: `baseUrl`, `projectPath`, environment,
  webhook path); PAT + webhook secret in the keychain.

### Out of scope (MVP) — explicitly deferred

- **OAuth authorization-code + a distributable/product install** (multi-project,
  hosted relay, guided "Connect a GitLab" wizard). MVP is the **"for me" fork** —
  one PAT for one project in one environment (§5, §13.1).
- **Multi-project fan-out.** The config/token shapes are drawn so a
  `projects: [...]` array is the additive path (§13.1), not built now.
- **The GraphQL API.** GitLab's REST v4 is GA and covers the whole loop; GraphQL
  is a later optimisation, not a day-one path (§2).
- **Merge automation of any kind.** `mergeMR` is a normal gated action — the author
  places a `gate` node before it, same as any sensitive write; there is **no**
  "auto-merge on green" convenience anywhere, and no trigger ever fires it directly
  (§9).
- **The richer edge-condition operators** (`gt`/`gte`/`contains`/…). Owned by the
  sibling conditions track (§10); this spec only guarantees its fields are shaped
  to be referenced by them.
- **HMAC-signed webhooks.** GitLab's webhook auth **is** the weak `X-Gitlab-Token`
  shared secret — there is no HMAC option to adopt. The mitigation is posture, not
  a stronger scheme (§5.2); a future GitLab HMAC option would be a receiver-verifier
  swap, not a connector change.
- **Non-GitLab forges** (Gitea, Bitbucket). GitHub is the parallel sibling; others
  are later peer connectors under the same module boundaries.

---

## 2. Feasibility + landscape

### 2.1 Landscape — why GitLab as GitHub's sibling

| Forge | API posture for trigger→read→act | Self-host / on-LAN | Verdict |
|---|---|---|---|
| **GitHub** | First-class REST + GraphQL; issues, PRs, checks; **HMAC-SHA256** webhooks (`X-Hub-Signature-256`); PAT + GitHub App. Largest install base. | GitHub Enterprise Server exists but is rare; the common case is cloud SaaS → needs a tunnel. | The parallel sibling (its own spec); the vocabulary source of truth this re-skins. |
| **GitLab** | First-class **REST v4** (issues, MRs, pipelines, notes, labels); **PAT / OAuth**; webhooks with a **plain `X-Gitlab-Token` shared secret** (weaker than HMAC). Second-largest forge, dominant in **self-hosted** installs. | **Self-managed GitLab is the norm for a huge segment** — and a self-hosted instance on the user's LAN can webhook localflow with **no public tunnel**. | **Chosen (this spec).** Near-free re-skin of GitHub; the self-host / on-LAN story is a genuine open-core advantage. |
| **Gitea / Bitbucket** | Capable REST; smaller reach. | Gitea is self-host-first (fits the same on-LAN story). | Deferred; peer connectors later. |

**GitLab-first-among-siblings rationale:** it is the **cheapest possible new
connector** (the GitHub loop re-skinned), and it unlocks the one thing GitHub SaaS
structurally cannot — a **fully local, no-tunnel** trigger path when the forge is a
self-hosted instance on the same network as localflow. That is on-brand for a
local-first, open-core product (memory: *Product integration directions*).

### 2.2 The GitLab REST API for trigger → read → act

Grounded in the current GitLab REST v4 docs (research: `scratchpad/research/B-dev-incident.md`,
verified against docs.gitlab.com):

- **Go-forward surface is REST v4 (GA).** `GET /projects/:id/issues/:iid`,
  `GET /projects/:id/merge_requests/:iid`, `GET /projects/:id/pipelines/:id`,
  `GET /projects/:id/issues?…` cover **read** (`getIssue`, `getMR`, `getPipeline`,
  `searchIssues`). All GA. The same v4 base works identically on SaaS and
  self-managed — only the `baseUrl` differs.
- **Write.** `POST …/issues/:iid/notes` (`commentIssue`), `PUT …/issues/:iid`
  with `labels` (`labelIssue`), `POST …/issues` (`createIssue`),
  `POST …/merge_requests` (`openMR`), `PUT …/merge_requests/:iid/merge`
  (`mergeMR`). All GA. Every write maps to a first-class REST call.
- **Auth.**
  - **PAT (MVP):** a Personal (or Project/Group) Access Token sent as the
    `PRIVATE-TOKEN: <token>` header (or `Authorization: Bearer <token>`). One
    long-lived secret → keychain. No dance. Scopes: `api` (read+write) or
    `read_api` for read-only.
  - **OAuth (deferred product fork):** authorization-code mints a refreshable
    token; same header at call time — only *acquisition* + multi-tenant differ
    (§5, §13.1).
- **Self-hosted `baseUrl`.** Unlike GitHub SaaS's fixed `api.github.com`, GitLab's
  API base is **wherever the instance runs** — `https://gitlab.com/api/v4` on SaaS,
  or `https://gitlab.internal.lan/api/v4` / `https://192.168.1.10/api/v4` on a
  self-managed box. **The base is user-supplied**, so it is an **SSRF surface** and
  must pass the shared guard on every call (§5.1).
- **Webhooks (push, not poll).** GitLab **Project Hooks** POST a JSON body with an
  `X-Gitlab-Event` header (e.g. `Issue Hook`, `Merge Request Hook`,
  `Pipeline Hook`) and — the only authenticity control — an **`X-Gitlab-Token`
  header** carrying a **plain shared secret** the user configured on the hook.
  **This is a bearer-style equality check, not an HMAC over the body** — it is
  weaker than GitHub's / Shopify's signed webhooks, and the mitigation is posture
  (§5.2), not cryptography. Relevant events: **`Issue Hook`** (→ `issue.opened`),
  **`Merge Request Hook`** (→ `mr.opened`), **`Pipeline Hook`** (→
  `pipeline.failed`, filtered on `object_attributes.status === 'failed'`).
- **Rate limits.** SaaS gitlab.com enforces per-minute request ceilings (per user /
  per IP) surfaced as `429` with `RateLimit-*` / `Retry-After` headers;
  **self-managed limits are admin-configured and often absent**. The client ships
  `Retry-After`-honouring backoff on `429`/`5xx` (like the Woo client, which faced
  the same "no guaranteed limit on self-host" reality — §11). Webhooks keep the loop
  push-primary, far under any budget.

### 2.3 Constraints (why not pure GREEN-with-no-caveats)

1. **Webhook auth is a weak shared secret.** `X-Gitlab-Token` is a plaintext
   equality compare, not an HMAC over the body — a leaked token (or a token sent
   over cleartext ingress) fully forges events. Mitigated by posture: an
   **unguessable receiver path**, **HTTPS-only ingress**, and — for the on-LAN bind
   — an **IP allowlist** to the GitLab instance (§5.2). Honest, not fatal.
2. **Self-host `baseUrl` is an SSRF target *and* is frequently private by design.**
   The primary self-host case has `baseUrl` on **RFC-1918 / LAN** — which the SSRF
   guard blocks by default. The guard therefore needs an **explicit per-connector
   allow** for the user's configured self-host host (§5.1), while still hard-blocking
   cloud metadata (`169.254.169.254`) and pinning the resolved IP against DNS
   rebinding. Nuanced, but exactly the guard's job.
3. **`pipeline.failed` drives a real code-fix.** The flagship loop spawns a coding
   agent that edits and pushes code, then opens an MR. That is powerful and must
   stay **gated + human-merged** — a safety posture, not a feasibility gap, and
   precisely what the flow's author-placed gates and the `mergeMR` mandate provide
   (§9).

### 2.4 Verdict: **GREEN** (with named security caveats)

The trigger → read → act loop is **fully buildable today** on GA REST v4, with a
clean single-PAT auth and the shared receiver's existing `token` scheme. It is
GREEN because every surface the loop needs (issue/MR/pipeline reads, note/label/
issue/MR writes, the three webhook events) is generally available and identical on
SaaS and self-managed. The three constraints in §2.3 are the weak webhook secret
(mitigated by posture), the self-host SSRF nuance (the guard's explicit job), and a
safety posture the flow engine's gates + the `mergeMR` mandate already provide.
Nothing in the loop is blocked or preview-gated.

---

## 3. The core loop → GitLab primitives

localflow's dev-tool loop is `trigger → read → route → act (gated)`. Each stage
maps to a concrete GitLab primitive and the concrete flow-engine mechanism:

| Stage | GitLab primitive | localflow / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified webhook: `Issue Hook` / `Merge Request Hook` / `Pipeline Hook` (status `failed`), arriving via a public tunnel (SaaS) **or directly on the LAN** (self-host, §4.4). | The **shared** `webhook-receiver` verifies the `X-Gitlab-Token` (`token` scheme) → normalizes to a `SeedEvent` → the connector's `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context (`trigger-subscriber.ts`, `flow-engine.ts`). |
| **read** | REST `GET …/issues/:iid` / `…/merge_requests/:iid` / `…/pipelines/:id` / `…/issues?…`. | An `action` node (`getIssue` / `getMR` / `getPipeline` / `searchIssues`) → `registry.invokeAction('gitlab', ref, params)` → `gitlab-api.ts` (through the SSRF guard) → **resolves** the normalized result, which the action-runner writes to context under the node id. |
| **route** | *(none — pure localflow)* | `selectEdges` evaluates edge conditions over the context the read wrote (`context.ts`). Today `field === equals`; soon the richer `FlowEdgeCondition` operators (§10) over e.g. `pipeline.status`. **No LLM decides routing.** |
| **fix** *(the flagship extra stage)* | *(none — a coding agent, driven via the operator control API)* | On the `pipeline.failed` path, a flow node drives a **coding-agent pane** (`POST /panes` → `POST /panes/:handle/prompt`, `control-api.ts:169,222`) to reproduce and fix the failure, then push a branch. Mirrors the Linear connector's pane-drive (§7). |
| **gate** | *(none — pure localflow)* | A `gate` node the author placed pauses the run `needs-you`; the human approves in the cockpit. Every write node sits **downstream of the gate the author drew**; `mergeMR` **must** (§9). |
| **act** | REST `…/notes` / `PUT …/issues/:iid` (labels) / `POST …/issues` / `POST …/merge_requests` / `PUT …/merge_requests/:iid/merge`. | The gated `action` node (`commentIssue` / `labelIssue` / `createIssue` / `openMR` / `mergeMR`) → `invokeAction` → `gitlab-api.ts` write. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* GitLab error. |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities*; the *flow* decides which run, in what order, behind which
gates. There is no hardcoded CI-fix pipeline — the author assembles the worker with
the authority they choose. `mergeMR` is a write like any other: it runs when the
action node is reached, and — because merging is irreversible — the author is
expected to place a `gate` node before it, same as any sensitive mutation (§9).

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/gitlab/`, peer to
`src/main/shopify/` and `src/main/woocommerce/`. It is **opt-in**: with no
`gitlab` config entry (and no stored PAT) the descriptor's `status()` returns
`needs-config` and the engine refuses any GitLab node (`action-runner.ts`) —
localflow's "works with no integration" guarantee is unchanged.

The connector is, architecturally, the **live implementation behind the registry's
pinned `invokeAction` / `subscribe`** (`integration-registry.ts:73-96`) for id
`'gitlab'`, registered via `registerConnector` (`integration-registry.ts:54`). For
the **fix stage** it is *also* an **in-process operator client**: like the Linear
connector, it does not reach into `SessionManager` privately — it drives panes
through the **same control-API surface** OpenClaw uses (`src/main/control-api.ts`),
so grants, lfguard, and per-environment isolation all apply (§7).

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/integrations/descriptors/gitlab.ts` | The static `IntegrationDescriptorDef` (`id: 'gitlab'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS` (`descriptors/index.ts`). A snapshot test guards the ids (the contract the templates track consumes). Copies `descriptors/linear.ts`. |
| `src/main/gitlab/gitlab-connector.ts` | Orchestrator + the live `invokeAction`/`subscribe` impl (implements `LiveConnector`). Dispatches an action id → a `gitlab-api` call; dispatches a trigger id → a shared-receiver subscription. Owns the `pipeline.failed` → pane-drive fix loop (§7). The one place the loop lives. **Never auto-mutates** — every write, `mergeMR` included, runs only when an action node invokes it; authority is the graph's `gate` nodes, not a connector-level check (§9). |
| `src/main/gitlab/gitlab-api.ts` | Thin **REST v4** client. **All** GitLab request/response shapes live *only* here — the blast radius for any API bump. Sends the PAT header; **routes every request through the shared SSRF guard** (§5.1); `Retry-After`-aware backoff on `429`/`5xx`. Isolated behind a `GitLabApi` interface so tests inject a `MockGitLabApi` (§12). |
| `src/main/gitlab/gitlab-normalize.ts` | **Pure** mapping: a raw GitLab issue / MR / pipeline JSON → the pinned **context-field shape** (§6.3); and a raw webhook payload (`Issue`/`Merge Request`/`Pipeline` Hook) → a `SeedEvent`. Unit-testable in isolation (mirrors `status-map.ts` purity). Where iid↔id, status-enum, and timestamp normalization happen — **once**, so conditions read a stable shape. |
| `src/main/gitlab/gitlab-fix.ts` | The `pipeline.failed` → coding-agent-pane fix driver (§7). An in-process operator client over `control-api.ts` (`POST /panes` terminal + `POST /panes/:handle/prompt`), mirroring `linear-connector.ts`'s pane-drive. Kept separate so the read/write API surface has no operator dependency. |
| `src/shared/gitlab.ts` | Shared types (`GitLabIssueContext`, `GitLabMrContext`, `GitLabPipelineContext`, the action param shapes, the trigger payload shapes) needed by main and any renderer palette surface. No I/O. |

**No private webhook server, no private SSRF helper.** Unlike the Shopify/Woo
connectors (each shipped a `*-webhook-server.ts` and, for Woo, a `wc-ssrf.ts`),
GitLab consumes the **shared** `src/main/webhooks/webhook-receiver.ts` (register a
verifier + path) and the **shared** `src/main/net/ssrf-guard.ts`. That shared infra
is exactly what the ecom connectors motivated; GitLab is its first forge consumer.

**No separate token/config module.** Secrets ride the merged registry's
`CredentialStore` (`revealForConnector('gitlab', key)` — the main-only plaintext
exit, grep-asserted to have no IPC/renderer caller). Non-secret refs (`baseUrl`,
`projectPath`, `environment`, `webhookPath`) are ordinary non-secret `configFields`
that flow through `integration-config.ts` validation.

### 4.3 Wiring the live dispatch into the merged registry

The seam already exists (the Shopify/Woo connectors use it). `IntegrationRegistry`
holds `connectors: Partial<Record<IntegrationId, LiveConnector>>` and exposes
`registerConnector(id, connector)` (`integration-registry.ts:41,54`). `src/main/
index.ts` constructs the `GitLabConnector` (given the `CredentialStore`, config, the
shared receiver, and — for the fix loop — the control-API client / grant store) and
calls `registry.registerConnector('gitlab', connector)` next to the existing
Shopify/Woo registrations. The pinned `IntegrationDescriptor` /
`IntegrationRegistry` contract is **unchanged**.

### 4.4 Receiving webhooks — the on-LAN no-tunnel advantage

This is the connector's signature architectural point. GitLab webhooks POST from
the instance; where the instance lives decides the ingress:

- **SaaS (`gitlab.com`) — tunnel, like every prior connector.** gitlab.com posts
  from the public cloud, so the local receiver needs a reachable URL: a dev tunnel
  (ngrok / Cloudflare Tunnel) forwards to the shared `webhook-receiver`; the hook's
  URL is that tunnel address, stored as the non-secret `webhookUrl` ref. Same
  posture as Linear §4.4 / Shopify §4.4.

- **Self-hosted on the LAN — NO tunnel (the open-core win).** When the GitLab
  instance is a self-managed box **on the same network** as the localflow machine
  (the common self-host case), it can reach localflow **directly**:
  `http(s)://<localflow-lan-ip>:<port>/<unguessable-path>`. No public tunnel, no
  third-party relay, no cloud round-trip — **the entire trigger path stays on the
  private network**. This is a real local-first advantage GitHub SaaS structurally
  cannot offer, and it is *why GitLab is worth a sibling connector*. Concretely:
  - The shared `webhook-receiver` must be able to **bind a LAN interface** (not only
    loopback) for this mode — a capability gated behind an explicit
    `webhook.lanBind` opt-in, because binding beyond loopback widens the attack
    surface (§5.2, §13.2).
  - Because the ingress is now reachable by anything on the LAN and the only auth is
    the weak `X-Gitlab-Token`, the on-LAN bind **requires** the mitigations of §5.2:
    an **unguessable path**, and an **IP allowlist** pinning the accepted source to
    the GitLab instance's address.
  - **SSRF interplay:** the same self-host instance is *also* the outbound `baseUrl`
    target — a private/LAN address the SSRF guard blocks by default. §5.1's explicit
    self-host allow covers the outbound side; §5.2's LAN-bind posture covers the
    inbound side. The two are the connector's self-host security spine.

Regardless of ingress, the receiver **verifies `X-Gitlab-Token`** (timing-safe
equality), enforces `MAX_BODY_BYTES`, **dedups** on the event's delivery identity
(`X-Gitlab-Event-UUID` when present, else a payload-derived key), filters `Pipeline
Hook` to `status === 'failed'`, and responds **200 fast** — the run is started after
the response so GitLab's delivery-timeout never triggers a redelivery storm. A bad /
oversized / forged / duplicate delivery is dropped and **never** seeds a run.

### 4.5 Reused localflow surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor` transport.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain;
  `revealForConnector` (main-only plaintext exit), `decryptionError` (feeds
  `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3),
  the `invokeAction`/`subscribe` delegation, `deriveStatus`.
- `src/main/webhooks/webhook-receiver.ts` — **shared** ingress; GitLab registers a
  `WebhookVerifier { scheme: 'token', header: 'X-Gitlab-Token' }` + an unguessable
  path (§4.4, §5.2).
- `src/main/net/ssrf-guard.ts` — **shared** outbound guard; every `gitlab-api` call
  passes it; the self-host `baseUrl` uses the explicit-allow path (§5.1).
- `src/main/control-api.ts` — the operator surface the fix loop drives (`POST
  /panes`, `POST /panes/:handle/prompt`), with lfguard + grant isolation intact.
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called, the
  **reject = failure** convention, how the resolved value lands in context, the
  not-connected guard.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; `coerceEvent`
  / `matchesFilter` the webhook `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`:
  dotted-path reads (`pipeline.status`) + boolean routing over the pinned fields.
- `src/main/flow/flow-engine.ts` — run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), injected `now()` for deterministic tests.

---

## 5. Auth, keychain & the two self-host security surfaces

- **PAT (MVP).** The user pastes a Personal (or Project/Group) Access Token into the
  descriptor's masked `personalAccessToken` field; it goes straight to the keychain
  via `CredentialStore.set` (`integration-registry.ts:197`). Every REST request
  sends it as `PRIVATE-TOKEN: <token>` — read at call time via
  `revealForConnector('gitlab','personalAccessToken')` (main-only; grep-asserted no
  IPC/renderer caller). No refresh: the token is long-lived until the user rotates
  it in GitLab.
- **Webhook secret.** Stored the same way (`webhookSecret`), used only inside the
  shared receiver's `token`-scheme verifier to `timingSafeEqual` the `X-Gitlab-Token`
  header against the stored value.
- **OAuth (deferred, §13.1).** A distributable app uses OAuth authorization-code to
  mint per-project refreshable tokens. The keychain shape already supports per-key
  storage; the additive change is a `gitlab-oauth.ts` module and a `projects[]`
  config array. Same `PRIVATE-TOKEN`/`Bearer` at call time — only *acquisition*
  differs.
- **Honouring the global secret rule (CLAUDE.md).** Neither the PAT nor the webhook
  secret is **ever** written to `config.json`, `sessions.json`, the transcript, a
  log, a PR body, or any IPC payload. `config.json` holds only **references**
  (`baseUrl`, `projectPath`, that an install exists). Token **state** (present /
  decrypt-failing) may be surfaced via `status()`; the **value** never is
  (`SetSecretResult` returns status only — `integration-registry.ts:199`). The hub
  already drops a secret found in `config.json` with a loud notice.
- **Disconnect.** Clearing the PAT / webhook secret flips `status()` to
  `needs-config`; the connector stops dispatching, unsubscribes from the receiver,
  and the LAN bind (if any) is torn down. No in-flight run is force-killed.

### 5.1 Outbound: the self-hosted `baseUrl` SSRF guard (shared)

Because `baseUrl` is user-supplied and the client makes **outbound** requests to it,
**every** `gitlab-api` call passes through `src/main/net/ssrf-guard.ts` **before**
the request:

- **HTTPS-only by default** — reject `http://` (a self-host box should have TLS;
  plain HTTP would put the PAT on the wire). A `baseUrl` on the LAN with a
  self-signed cert is the one place §13.2 may relax this behind an explicit opt-in.
- **Reject embedded credentials** (`https://user:pass@host`).
- **Resolve-and-pin the IP; block cloud metadata unconditionally.** `169.254.169.254`
  (and the IPv6 metadata address) are **always** blocked, self-host or not. The
  guard pins the resolved IP so a **DNS-rebinding** flip between validate and connect
  can't redirect a request to a blocked target (it validates the IP actually dialed).
- **The self-host explicit-allow — the primary path here.** By default the guard
  blocks loopback / RFC-1918 / link-local. But **self-host-on-LAN is the whole point
  of this connector**, and those instances *are* on private ranges. So the user's
  configured `baseUrl` host is added to a **per-connector allowlist** the guard
  honours: a private-range `baseUrl` the user explicitly entered is allowed (its
  pinned IP), while *every other* private/metadata target stays blocked. This is the
  inverse-default of the Woo spec's `allowInsecureLocalStore` (there a rare escape
  hatch; here the main case), and it is exactly why the guard is **shared** — one
  audited allow-mechanism, not a per-connector reimplementation.
- **SaaS needs no allow** — `gitlab.com` is a public host and passes the default
  guard untouched.

### 5.2 Inbound: the weak `X-Gitlab-Token` scheme + its mitigations

GitLab's only webhook authenticity control is the **`X-Gitlab-Token` shared
secret** — a plaintext bearer the receiver compares for equality. **It is weaker
than the HMAC-over-body schemes** Shopify (`X-Shopify-Hmac-Sha256`) and GitHub
(`X-Hub-Signature-256`) use: it does not bind to the body, so it cannot detect
tampering, and a single leak fully forges events. There is no HMAC option to adopt;
the receiver models it as its **`token` scheme**
(`WebhookVerifier { scheme: 'token', header: 'X-Gitlab-Token' }`), and the connector
compensates with **posture**:

- **An unguessable receiver path** — the hook URL carries a high-entropy random
  segment (`/gitlab/<random>`), so an attacker cannot even find the endpoint to
  spray a guessed token at. Stored as the non-secret `webhookPath` ref; treated as
  a capability URL (not logged in full).
- **HTTPS-only ingress** — the tunnel (SaaS) or the LAN bind (self-host) must be
  TLS, so the shared secret is never sent in cleartext.
- **IP allowlist on the LAN bind** — when bound beyond loopback (§4.4), the receiver
  accepts deliveries **only** from the configured GitLab instance IP (or the LAN
  CIDR). This is the strongest mitigation and is *why* the on-LAN bind is safe: the
  forge and localflow share a trusted private segment.
- **Timing-safe compare + dedup + fast-200**, exactly as the shared receiver does
  for every scheme.

This is called out as an **open decision** (§13.3): whether to *require* the IP
allowlist whenever `webhook.lanBind` is on (recommended), and whether to warn in the
UI that GitLab webhooks are shared-secret, not signed.

---

## 6. Pinned dev-tool vocabulary (verbatim — parallel to the GitHub sibling)

> **This section is the contract.** The flow-templates track and the canvas palette
> read these ids and this field shape verbatim. A snapshot test in `gitlab.ts`
> guards the ids; the field shape is guarded by the `gitlab-normalize.ts` tests.
> Ids are **kept parallel to the GitHub connector** where semantics match; the one
> systematic difference is **MR** (GitLab) vs **PR** (GitHub).

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'gitlab'`:

```ts
export type IntegrationId = 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'gitlab'
```

Three companion touch-points move in lockstep (each a one-line add):
`INTEGRATION_IDS` (the stable order array, `integrations.ts:71`), the
`INTEGRATION_IDS` allow-list in `flow-model.ts` (the flow validator), and
`DESCRIPTOR_DEFS` (`descriptors/index.ts:11`). No other `IntegrationId` consumer
needs a change — they iterate the array.

### 6.1 Triggers (webhook-backed, via the shared `token`-scheme receiver)

| trigger id | label | underlying GitLab source | GitHub-sibling parity |
|---|---|---|---|
| `issue.opened` | Issue opened | **`Issue Hook`**, `object_attributes.action === 'open'`. | **MATCH** id + semantics (`issues` opened). |
| `mr.opened` | Merge request opened | **`Merge Request Hook`**, `action === 'open'`. | **id RENAMED** `pr.opened` → `mr.opened`; same semantics (a new change-set to review). |
| `pipeline.failed` | Pipeline failed | **`Pipeline Hook`**, `object_attributes.status === 'failed'` (filtered at the receiver). | **MATCH** semantics; GitHub's sibling derives it from `check_suite`/`workflow_run` **conclusion: failure** — same "CI went red" event, different source object. |

All three arrive through the **shared** `webhook-receiver` under the connector's
registered `token`-scheme verifier + unguessable path (§5.2). The `pipeline.failed`
filter is applied at the receiver so a green/running pipeline never seeds a run.

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | GitLab REST | writes to context | GitHub parity |
|---|---|---|---|---|
| `getIssue` | Get an issue | `GET …/issues/:iid` | `GitLabIssueContext` (§6.3) | **MATCH** |
| `getMR` | Get a merge request | `GET …/merge_requests/:iid` | `GitLabMrContext` | `getPr` → `getMR` (rename) |
| `getPipeline` | Get a pipeline | `GET …/pipelines/:id` | `GitLabPipelineContext` | **MATCH** (GitHub: a checks/run read) |
| `searchIssues` | Search issues | `GET …/issues?…` | `{ issues: GitLabIssueContext[]; count }` | **MATCH** |

**Gated write (the author places a gate before these; `mergeMR` MUST be gated — §9):**

| action id | label | GitLab REST | note | GitHub parity |
|---|---|---|---|---|
| `commentIssue` | Comment on an issue | `POST …/issues/:iid/notes` | Low-risk annotate; still an action node. | **MATCH** |
| `labelIssue` | Set issue labels | `PUT …/issues/:iid` `{ labels }` | Add/replace labels (triage). | **MATCH** |
| `createIssue` | Create an issue | `POST …/issues` | e.g. file a bug from a failed pipeline. | **MATCH** |
| `openMR` | Open a merge request | `POST …/merge_requests` | Opens the fix branch as an MR (the fix-loop payoff, §7). **Never** auto-merges. | `openPr` → `openMR` (rename) |
| `mergeMR` | Merge a merge request | `PUT …/merge_requests/:iid/merge` | **Irreversible — runs when reached, same as any other write; the author's `gate` node before it is the authority** ("I merge myself", §9). | `mergePr` → `mergeMR` (rename) |

**Failure convention (pinned):** a write that fails **rejects** its promise with the
real GitLab error text; a resolved promise (any value) is success and its value
becomes the node's context output (`action-runner.ts`, `integrations.ts:33-43`). The
connector never resolves a sentinel-failure.

### 6.3 Context-field shape (what an action writes for later conditions)

A read action writes a **normalized, stable** object under its node id
(`gitlab-normalize.ts` produces it — iids as numbers, statuses as lowercase enums,
timestamps ISO 8601). Downstream edge conditions read it via dotted paths
(`context.ts` `resolveField`), e.g. `{{getPipeline.pipeline.status}}` in an action
param, or `field: 'getPipeline.pipeline.status'` in an edge condition. **Pinned
shape:**

```ts
// src/shared/gitlab.ts
export interface GitLabIssueContext {
  issue: {
    iid: number            // per-project issue number, e.g. 42
    id: number             // global id
    projectId: number
    title: string
    state: 'opened' | 'closed'
    labels: string[]       // lowercase, for `contains`
    authorUsername: string
    webUrl: string
    createdAt: string      // ISO 8601
  }
}

export interface GitLabMrContext {
  mr: {
    iid: number
    projectId: number
    title: string
    state: 'opened' | 'closed' | 'merged' | 'locked'
    sourceBranch: string
    targetBranch: string
    draft: boolean
    mergeStatus: 'can_be_merged' | 'cannot_be_merged' | 'unchecked'
    authorUsername: string
    webUrl: string
  }
}

export interface GitLabPipelineContext {
  pipeline: {
    id: number
    projectId: number
    status: 'failed' | 'success' | 'running' | 'canceled' | 'pending' | 'skipped'
    ref: string            // branch/tag the pipeline ran on
    sha: string
    webUrl: string
    failedJobCount: number // convenience for conditions
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and soon the typed `FlowEdgeCondition` operators of §10).
`status` as a lowercase enum lets `pipeline.status eq 'failed'` be exact; `labels`
as an array lets `contains 'bug'` work; `iid` as a number lets `gt` be meaningful.
Normalizing once, in one pure module, is the correctness boundary the templates and
conditions tracks depend on.

---

## 7. Data flow — the fix-MR loop, node by node

**Scenario the author drew on the canvas:** *"When a pipeline fails on `main`, have
a coding agent investigate and fix it, open the fix as an MR — and pause for me to
merge."* This is **not** hardcoded — it is the graph below, mirroring the GitHub
connector's fix-PR loop and reusing the Linear connector's operator pane-drive.

```
[trigger: pipeline.failed]              GitLab Pipeline Hook (status=failed), via shared receiver
        │  payload → context['t'] = { pipelineId, ref, sha, projectId, ... }
        ▼
[action: getPipeline]                    ref=getPipeline, params={ id: "{{t.pipelineId}}" }
        │  invokeAction('gitlab','getPipeline',…) → gitlab-api (SSRF-guarded) → normalize
        │  writes context['pipe'] = GitLabPipelineContext
        ▼
[router]                                 branch on facts
   ├── edge: pipe.pipeline.ref == 'main'  AND (richer, §10) pipe.pipeline.failedJobCount gte 1
   │        ▼
   │   [fix: drive coding agent]          gitlab-fix over control-api:
   │        │  POST /panes {kind:'terminal', agentId:'claude', groupId:<env group>}
   │        │  POST /panes/:handle/prompt  "Pipeline <id> failed on <ref>@<sha>; reproduce,
   │        │                               fix, push branch fix/pipeline-<id>."  (lfguard-gated pty)
   │        │  poll GET /panes/:handle/output until the agent reports a pushed branch
   │        ▼
   │   [action: openMR]                   invokeAction('gitlab','openMR',
   │        │                               { sourceBranch:'fix/pipeline-<id>', targetBranch:'main',
   │        │                                 title:'Fix failing pipeline <id>' })
   │        │  POST …/merge_requests → resolves GitLabMrContext → context['mr']
   │        ▼
   │   [gate: "merge?"]                   pauses run needs-you; the HUMAN reviews + merges
   │        │  approved ──► [action: mergeMR]  (runs here because the gate node sits before it; §9)
   │        │  rejected ──► run ends 'rejected' (a human "no" is not a failure)
   │
   └── edge: (else — not main / no failed jobs)
            ▼
        [action: commentIssue|createIssue]  file/annotate instead of fixing
```

Node-by-node against the engine:

1. **Trigger fires.** The shared `webhook-receiver` verifies `X-Gitlab-Token`
   (`token` scheme), confirms `object_attributes.status === 'failed'`, dedups, 200s
   fast, and `gitlab-normalize` maps the `Pipeline Hook` to a `SeedEvent`
   (`{ eventId, payload: { pipelineId, ref, sha, projectId } }`) handed to the
   connector's `subscribe` handler → `trigger-subscriber` → `startRun`. Payload in
   `context['t']`.
2. **`getPipeline` reads.** The action-runner templates params, confirms
   `status('gitlab') === 'connected'`, calls `invokeAction`; the connector calls
   `gitlab-api.getPipeline` (through the SSRF guard), `gitlab-normalize` produces
   `GitLabPipelineContext`, the connector **resolves** it → `context['pipe']`.
3. **Router branches.** `selectEdges` evaluates each out-edge over `context['pipe']`
   — deterministic, no LLM.
4. **Fix stage (the flagship).** On the fix branch, `gitlab-fix` obtains the
   environment's operator grant and drives a coding-agent pane through
   `control-api.ts`: `POST /panes` (terminal, an `OPERATOR_TERMINAL_AGENTS` agent —
   `control-api.ts:64`), then `POST /panes/:handle/prompt` with the failure context;
   it polls `GET /panes/:handle/output` until the agent reports a pushed fix branch.
   Every prompt write passes **lfguard** (`control-api.ts:227`) and per-environment
   isolation — identical to the Linear connector's pane-drive, so destructive
   commands the agent might emit are still guarded.
5. **`openMR`.** The connector calls `POST …/merge_requests` for the fix branch; a
   GitLab error **rejects** and the run fails with the real message (§11). On success
   the resolved `GitLabMrContext` is in `context['mr']`.
6. **Gate + merge.** A `gate` node pauses the run `needs-you`; the **human** reviews
   and approves (or rejects → run ends `rejected` cleanly). **`mergeMR` runs on the
   approved branch** because the flow engine only continues past the `gate` node on
   approval — the connector itself just calls the API when the `mergeMR` action node
   is reached, same as every other write. On success the run completes `done`.

The same trigger + reads + fields support arbitrarily different graphs (file an
issue instead of fixing; auto-comment triage; label-and-route; open a draft MR for a
human to finish). The connector supplies capability + facts; the **author supplies
authority**, entirely through the graph — including for `mergeMR`.

---

## 8. The connector as an `IntegrationDescriptor`

The static half is a `gitlabDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()` exactly as
for the other connectors — no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `personalAccessToken` | GitLab access token (PAT) | **yes** | yes | string | `PRIVATE-TOKEN`. Keychain only. Placeholder `glpat-…`. |
| `webhookSecret` | Webhook secret token | **yes** | yes | string | Compared against `X-Gitlab-Token` (weak — §5.2). Keychain only. |
| `baseUrl` | GitLab base URL | no | yes | string | `https://gitlab.com` (SaaS) or self-host `https://gitlab.internal.lan`. SSRF-guarded (§5.1). |
| `projectPath` | Project (path or id) | no | yes | string | `group/project` or numeric id. Non-secret ref. |
| `environment` | localflow environment (1-9) | no | yes | number | Which env hosts GitLab work + the fix-pane spawn. Same validation as Linear. |
| `webhookPath` | Ingress webhook path | no | no | string | The unguessable receiver segment (§5.2). Placeholder `/gitlab/<random>`. |
| `webhookUrl` | Ingress webhook URL | no | no | string | Tunnel (SaaS) or LAN address (self-host) the hook posts to (§4.4). |

`status('gitlab')` reports `needs-config` until `personalAccessToken`,
`webhookSecret`, `baseUrl`, `projectPath`, and `environment` are present; `error` if
a stored secret can't be decrypted; `disabled` if configured-but-off; `connected`
otherwise. The action-runner refuses any non-`connected` GitLab node before any
network call.

---

## 9. Authority & safety — the `mergeMR` mandate

**Primary control — the flow's gates (the engine's sole gating primitive).** Every
write (`commentIssue`, `labelIssue`, `createIssue`, `openMR`, `mergeMR`) is an
`action` node. Authority is whatever the author wired: a `gate` node pauses the run
`needs-you`; a conditional edge restricts *when* a write is even reached; a human
"no" ends the run `rejected` (not a failure); a write with no path to it never runs.
**The connector never auto-mutates outside the graph the author drew** — the flow
engine's `gate`-node handling (`flow-engine.ts`) is the *only* place gating is
enforced, for every connector.

**`mergeMR` is gated the same way as every other mutation — a graph `gate` node, not
a connector param.** Merging is irreversible and lands code on a protected branch,
so it is exactly the kind of write the author should place behind a `gate` (or
human-approval) node — but that authority lives in the graph, not in the connector.
The connector holds **no in-connector param check** (an earlier draft gated on a
static `approved`/`gated` param on the action node's own config, which an author
could hardcode with no gate node anywhere upstream — a bypassable, inconsistent
auto-merge path). `mergeMR` instead behaves exactly like GitHub's `mergePR`,
Stripe's `createRefund`, and Woo's `refundOrder`: it calls the API when the action
node is reached, and rejects only on a real API failure. Jonas's stated posture ("I
merge myself"; memory: *Merge handoff preference*) is realized by the author wiring
a `gate` before `mergeMR` in every shipped template — the same convention that
protects every other sensitive write, not a bespoke connector-level rule. There is
**no** "auto-merge on green" convenience anywhere in MVP (§1 out-of-scope), and a
delivered trigger still fires **zero** GitLab writes on its own (the load-bearing
authority guarantee, unchanged).

**The fix stage inherits lfguard.** The coding-agent pane the fix loop drives writes
through `POST /panes/:handle/prompt`, which is **already lfguard-gated**
(`control-api.ts:227`) — a destructive shell command the agent emits is blocked by
the same guard OpenClaw operators hit. The connector adds no privileged path around
it.

**Never render secrets.** The PAT and webhook secret live in the keychain; no error
message, log line, or context field ever contains them (§5, §11).

---

## 10. Richer-conditions dependency (owned elsewhere — named, not designed)

The flow engine's edge conditions today are `field === equals` (`context.ts`,
`flow-model.ts`). A **sibling conditions track** is upgrading them to a typed
`FlowEdgeCondition`:

```ts
// OWNED BY THE CONDITIONS TRACK — reproduced only to state the dependency.
interface FlowEdgeCondition {
  field: string
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'truthy'
  value?: unknown
}
```

The fields §6.3 pins are **designed to be referenced by those operators**:
`pipeline.status` / `mr.state` as lowercase **enums** so `eq`/`ne` are exact;
`issue.labels` as a string **array** for `contains`; `iid` / `failedJobCount` as
**numbers** for `gt`/`gte`/`lt`/`lte`; `mr.draft` as a **boolean** for `truthy`; the
`mr`/`issue` sub-object present-or-absent for `exists`. **This spec does not design
the condition system** — it only guarantees its field types are what those operators
expect, normalized once in `gitlab-normalize.ts`. The dependency is one-directional:
the connector works under the current `eq`-only routing, just less expressively.

---

## 11. Error handling

localflow's principle (error-message-style memory; demonstrated in
`control-api.ts` and `action-runner.ts`): **every failure is human-readable,
actionable, and carries the real underlying exception. No silent catch. No bare
"failed" / "not found" 404-vibe.** A write signals failure by **rejecting** its
promise; the action-runner prefixes it (`Flow action '<id>' on GitLab failed: …`)
and surfaces it on the run.

| Failure | Cause carried | Surface / behaviour |
|---|---|---|
| **Webhook token invalid** | `X-Gitlab-Token` mismatch (never the body or secret) | Receiver `console.warn` **route + reason only**; 401/403; **no run started**. Mirrors `control-api.ts:139` "never log token material". |
| **Webhook from a non-allowlisted IP** (LAN bind) | the source IP | Dropped at the receiver; warn (IP only); no run. The on-LAN mitigation (§5.2). |
| **Webhook duplicate** (`X-Gitlab-Event-UUID` seen) | the delivery uuid | 200 (GitLab redelivery is expected); dedup-drop; no second run. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | 4xx; dropped; no run. Never spawns on unvalidated shape. |
| **SSRF-blocked `baseUrl`** | the host + resolved IP | Refused **before any call**: "GitLab base URL `<host>` resolves to a blocked address (`<ip>`) — if this is your self-hosted instance, add it to the allowed hosts in Settings; cloud-metadata addresses are always refused." (§5.1) |
| **Non-HTTPS `baseUrl`** | `http://` given | Refused before any call: "GitLab base URL must be `https://` — plain HTTP would send the access token in the clear." |
| **`status('gitlab') !== 'connected'`** | missing PAT / decrypt error / disabled | The action-runner fails the node *before* any call: "Flow needs GitLab connected — action '<id>' can't run. Connect it in Settings." |
| **PAT invalid/revoked (401)** | GitLab's auth error | `invokeAction` **rejects**: "GitLab rejected the access token (401) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing scope (403)** | GitLab's scope error | Rejects verbatim: "GitLab refused '<action>': the token is missing the `api` scope (read-only `read_api` can't write) — regenerate it with `api` and re-enter." |
| **Issue/MR/pipeline not found (404)** | the iid/id that missed | Rejects: "GitLab has no <thing> '<id>' in `<projectPath>` (it may be from another project or was deleted)." — actionable, not a bare 404. |
| **Rate-limit (429)** | `Retry-After` / `RateLimit-*` | `gitlab-api` retries honouring `Retry-After`; only after exhausting retries does it reject with "GitLab throttled the request (retry in ~Ns)". Self-host may send no header → capped exponential backoff (like the Woo client). Not swallowed. |
| **MR not mergeable** (conflicts / pipeline pending) | GitLab's `merge_status` / message | Rejects with the true reason: "GitLab refused the merge: `cannot_be_merged` (source has conflicts with `main`)." Never a silent no-op. `mergeMR` has no separate gate-check failure mode — authority is the graph's `gate` node, not the connector (§9). |
| **Fix-pane spawn refused** | control-API 400/403 (bad group / lfguard block) | Rejects with the control-API reason: "Couldn't start a fix agent in environment <n>: <control-api error>." The fix stage fails loudly, not silently. |
| **Ingress unreachable** | the unreachable `webhookUrl` | Startup/health check fails loudly: "GitLab webhook URL '<url>' is unreachable — no repo events will arrive." Never a silent dead trigger. |
| **API version/path removed** | GitLab's error | Rejects: "GitLab API rejected `<path>` — the instance may be older/newer than expected." All shapes are in `gitlab-api.ts`, so the fix is one file. |

The connector **never** catches-and-drops; where GitLab returns a precise message it
forwards **that**, never a vaguer mint.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live GitLab instance**, matching localflow's seams (pure
modules, injected backends, fixture events):

- **`GitLabApi` interface + `MockGitLabApi` seam.** `gitlab-api.ts` is written
  *against* a `GitLabApi` interface (`getIssue`, `getMR`, `getPipeline`,
  `searchIssues`, `createNote`, `updateIssue`, `createIssue`, `createMR`, `mergeMR`);
  the real impl wraps the REST transport **and** the SSRF guard. Tests inject a
  `MockGitLabApi` returning canned nodes and canned error/`429` envelopes. **No test
  performs a live GitLab call**; CI has no GitLab credentials. (Same posture as the
  Shopify `MockShopifyApi` / Woo `MockWcApi` seams.)
- **`gitlab-normalize.ts` unit tests** — pure function; assert every raw issue / MR /
  pipeline node and every raw webhook payload → the pinned context shapes (§6.3):
  iid/id split, status-enum lowercasing, `labels` array, `failedJobCount` derivation,
  `Pipeline Hook`→`SeedEvent`. The correctness boundary the conditions track depends
  on — guarded hardest.
- **Shared-receiver `token`-scheme tests (GitLab fixtures)** — feed fake
  `Issue`/`Merge Request`/`Pipeline` Hook bodies with **valid and invalid
  `X-Gitlab-Token`**, a non-failed pipeline (must not seed), oversized bodies,
  malformed JSON, a **duplicate `X-Gitlab-Event-UUID`**, and (LAN-bind) an
  off-allowlist source IP; assert 200/4xx/401 and that only valid+novel+failed events
  produce a `SeedEvent`.
- **SSRF-guard tests (GitLab cases)** — assert: a public `gitlab.com` base passes;
  an unlisted loopback/RFC-1918/link-local base is refused; the **explicit self-host
  allow** admits the user's configured private `baseUrl` (its pinned IP) while a
  *different* private target stays blocked; `169.254.169.254` is refused even when
  self-host-allow is on; a DNS-rebind flip to a blocked IP is caught at connect;
  `http://` is refused; embedded credentials refused.
- **`gitlab-connector` dispatch tests** — with a `MockGitLabApi` + a fake registry:
  assert `invokeAction('gitlab','getIssue',…)` resolves the normalized context; a
  GitLab error response **rejects** with the verbatim message; `mergeMR` runs when
  invoked (no in-connector param gate — same as `openMR`/`commentIssue`), rejecting
  only on a real API failure; and **a delivered trigger fires zero GitLab writes on
  its own** (the load-bearing §9 authority guarantee, independent of gating).
- **Fix-loop tests (offline)** — `gitlab-fix` drives a **fake control-API** (the
  router `handleRequest` is pure over its deps — `control-api.ts:125`): assert it
  `POST /panes` → `POST /panes/:handle/prompt` → polls `GET output` → calls `openMR`;
  assert a control-API 403 (lfguard block) rejects with the §11 message. No socket.
- **Engine integration test (offline)** — wire the real `FlowEngine` + the registry
  with the GitLab connector over a `MockGitLabApi` and a fake control-API; inject a
  `pipeline.failed` `SeedEvent`; assert `getPipeline` writes context, the router
  selects the `main` edge, the fix stage drives the fake panes, `openMR` is called,
  and the `gate` before `mergeMR` pauses `needs-you`. Deterministic via the engine's
  injected `now()`.
- **Token-store test** — `revealForConnector` round-trip via a fake `SecretBackend`;
  a regression guard asserts **no PAT/webhook-secret value** appears in any emitted
  log/console/error string (the secret rule).
- **Snapshot test on `gitlabDescriptor`** — pins the trigger/action ids the templates
  track (and the GitHub-parity mapping) consume; a change is a reviewed contract edit.

No test requires GitLab credentials or a live instance; the real REST API is
exercised only in manual dogfooding against a self-hosted dev instance.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **SaaS vs self-host as the MVP anchor / "for me" vs "a product others install."**
   - *Self-host, for me* (recommended MVP): one PAT for one self-hosted project, the
     **on-LAN no-tunnel** ingress (§4.4), one keychain — the cheapest dogfood and the
     path that exercises the unique advantage. Requires the LAN-bind + SSRF-allow
     work up front.
   - *SaaS, for me*: `gitlab.com` PAT + a dev tunnel — no SSRF-allow, no LAN bind, but
     doesn't exercise the differentiator.
   - *Product*: OAuth app, hosted relay, `projects[]` multi-project (§13 items).
     Recommendation: build **self-host for-me** first (it forces the two security
     surfaces that are the connector's reason to exist), keep the client/config shapes
     multi-project-ready.
2. **On-LAN bind default + non-HTTPS self-host.** Should `webhook.lanBind` be
   opt-in-only (recommended — binding beyond loopback widens the surface), and should
   a self-hosted box with a **self-signed cert** be allowed to be `http://` or
   TLS-without-CA-validation behind an explicit opt-in (a real self-host reality)?
   Both are security-posture calls to settle before a LAN dogfood. MVP leans:
   LAN-bind opt-in, HTTPS required, self-signed allowed only behind an explicit
   `allowSelfSignedBaseUrl`.
3. **`token`-scheme hardening — how far.** Given `X-Gitlab-Token` is weak (§5.2):
   should the IP allowlist be **required** whenever the LAN bind is on (recommended)?
   Should the UI **warn** that GitLab webhooks are shared-secret, not signed? Should
   the connector auto-generate the unguessable path + secret on connect rather than
   ask the user to invent them? Leaning: require the IP allowlist on LAN bind,
   auto-generate path+secret, show a one-line "shared-secret, keep the URL private"
   note.
4. **`mergeMR` — graph-gate convention vs. also an lfguard-style backstop.** §9
   leaves `mergeMR` gated exactly like every other write, by the author's `gate`
   node — there is no connector-level check to fall back on. Is the graph-gate
   convention (plus every shipped template placing a `gate` before it) sufficient,
   or should there *also* be a deterministic backstop (e.g. refuse merges to a
   configurable protected-branch set regardless of the graph, in the spirit of
   `guard/` lfguard)? Leaning: convention-only for MVP; protected-branch backstop as
   a phased add.
5. **Webhook subscription management — manual vs programmatic.** MVP can have the user
   create the Project Hook in GitLab (pointing at the tunnel/LAN URL with the token),
   or the connector can create it via `POST …/hooks` on connect (nicer UX, needs the
   scope + a teardown story). Leaning manual for the MVP slice, programmatic in
   phase 2.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One self-hosted project, one flow, read + the fix-MR loop up to (not through)
merge:**

1. `IntegrationId` gains `'gitlab'` (+ the three lockstep touch-points, §6.0);
   `gitlabDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `personalAccessToken` + `webhookSecret` + `baseUrl` + `projectPath` stored
   (PAT/secret → keychain); `status('gitlab') === 'connected'`.
3. `gitlab-api.ts` behind `GitLabApi`, **every call through the shared SSRF guard**
   with the self-host allow (§5.1): `getPipeline` + `openMR` live. `gitlab-normalize`
   produces `GitLabPipelineContext` / `GitLabMrContext`.
4. `registry.registerConnector('gitlab', …)` (§4.3): `invokeAction('gitlab',…)`
   reaches the connector; `subscribe('gitlab','pipeline.failed',…)` reaches the shared
   receiver.
5. The shared `webhook-receiver` handling **`Pipeline Hook` (status=failed)** with the
   `token`-scheme verifier + unguessable path, via the **on-LAN bind** (no tunnel),
   emitting a `SeedEvent`.
6. `gitlab-fix` drives a coding-agent pane over `control-api.ts` and, on a pushed
   branch, calls `openMR`.
7. On the canvas: `[pipeline.failed] → [getPipeline] → [fix pane] → [openMR] → [gate]`
   runs end-to-end; `mergeMR` is present but **only reachable through the human gate**
   (the §9 mandate enforced). Errors per §11.

That slice proves the whole loop (a real red pipeline on a self-hosted LAN instance
wakes a real flow that drives an agent to fix it and opens an MR — with the human
merging) and is dogfoodable against a self-hosted dev instance **with no tunnel**.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. Self-host for-me fork, on-LAN no-tunnel,
  `pipeline.failed` + `getPipeline` + fix-pane + `openMR` + human-gated `mergeMR`.
  Single project, single environment.
- **Phase 2 — full vocabulary:** `getIssue` / `getMR` / `searchIssues`;
  `commentIssue` / `labelIssue` / `createIssue`; the `issue.opened` / `mr.opened`
  triggers; programmatic Project Hook management (§13.5); the SaaS-tunnel ingress
  path for gitlab.com users.
- **Phase 3 — `token`-scheme hardening + protected-branch backstop:** required IP
  allowlist on LAN bind, auto-generated path/secret, the UI shared-secret note
  (§13.3); the optional deterministic protected-branch merge backstop (§13.4),
  lfguard-style.
- **Phase 4 — richer conditions consumption:** once the conditions track lands
  `FlowEdgeCondition` (§10), verify the pinned fields drive `eq`/`contains`/`gte`/
  `truthy`/`exists` end-to-end; ship the "fix only main, only ≥1 failed job" template.
- **Phase 5 — product fork:** distributable OAuth app, hosted webhook relay for SaaS
  users, `projects[]` multi-project isolation (§13.1). The guided "Connect a GitLab"
  wizard the operator-onboarding-friction memory asks for.
- **Phase 6 — expand forges:** **Gitea** next (self-host-first — reuses the same
  on-LAN + SSRF spine), then **Bitbucket**. Each a peer under `src/main/<forge>/`,
  reusing the shared receiver + SSRF guard and the `*-connector` / `*-api` /
  `*-normalize` shape. GitHub is the parallel sibling this re-skins; no shared "forge"
  abstraction — each is its own connector.

---

## Appendix — reused / satisfied localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId` +
  `INTEGRATION_IDS` extended with `'gitlab'` (§6.0).
- `src/main/integrations/credential-store.ts` — `safeStorage` keychain the PAT/secret
  ride; `revealForConnector` (main-only plaintext exit); `decryptionError` powers
  `status()`.
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3), the
  `invokeAction`/`subscribe` delegation, `deriveStatus`, the secret/non-secret write
  split.
- `src/main/integrations/descriptors/{index,linear}.ts` — `DESCRIPTOR_DEFS` gains
  `gitlab`; `linear.ts` is the descriptor-as-code template.
- `src/main/webhooks/webhook-receiver.ts` — **shared** ingress; GitLab registers a
  `WebhookVerifier { scheme: 'token', header: 'X-Gitlab-Token' }` + an unguessable
  path; the weak-secret mitigations are §5.2.
- `src/main/net/ssrf-guard.ts` — **shared** outbound guard; every `gitlab-api` call
  passes it; the self-host `baseUrl` uses the explicit per-connector allow (§5.1).
- `src/main/control-api.ts` — the operator surface the fix loop drives (`POST /panes`
  `control-api.ts:169`, `POST /panes/:handle/prompt` `control-api.ts:222`), with
  lfguard (`:227`) + grant isolation intact.
- `src/main/flow/node-runners/action-runner.ts` — the `invokeAction` runner + the
  **reject = failure** convention every GitLab action honours; the not-connected
  guard.
- `src/main/flow/trigger-subscriber.ts` — `subscribe`/`coerceEvent`/`matchesFilter`:
  how a GitLab webhook becomes a seeded run.
- `src/main/flow/context.ts` — `resolveField`/`applyTemplate`/`selectEdges`: dotted-
  path reads (`pipeline.status`) + boolean routing over the pinned fields.
- `src/main/flow/flow-engine.ts` — the run lifecycle, gate handling (`needs-you`,
  human-"no"-is-not-a-failure), the injected `now()` for deterministic tests.
- `docs/superpowers/specs/2026-07-16-linear-integration-design.md` — the operator
  pane-drive template the fix loop mirrors (`POST /panes` → prompt → poll output).
- `docs/superpowers/specs/2026-07-18-github-connector-design.md` — the parallel
  sibling whose vocabulary this spec re-skins (PR→MR the one systematic rename).
- `docs/superpowers/specs/2026-07-17-{shopify,woocommerce}-connector-design.md` — the
  connector-module-shape + SSRF/secret/error-table/offline-test templates; the shared
  receiver + SSRF guard this spec consumes are the infra those connectors motivated.
- `guard/` (lfguard) — the deterministic-guard posture the `mergeMR` mandate (§9) and
  the phased protected-branch backstop (§13.4) borrow.
</content>
</invoke>
