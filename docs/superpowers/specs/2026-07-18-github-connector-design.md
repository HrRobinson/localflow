# GitHub Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Design-approval gate for the **flagship
actuator** of the integration program. Where the ecom connectors (Shopify,
WooCommerce) point saiife at a commerce host, GitHub points it at a **git
host** — and that is native to saiife's coding-agent DNA. The connector
exists to close *the* loop the whole product is shaped around: **a coding-agent
authors a fix PR, a human merges it.**
**Feature:** A **GitHub connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`. It lets a flow author wire a dev-incident worker on the
canvas: a repo event — a failing check, a new issue, an opened PR — **triggers**
a run, the flow **reads** issue/PR/check state via GitHub's API, drives a
**coding-agent pane** to produce a branch + fix, and — behind gates the author
places — **acts** (comment, label, open a PR, dispatch a workflow, and, only ever
behind a gate, **merge**). The authority lives in the flow graph, exactly as the
engine already enforces; the connector is a pure actuator.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and copies the module shape of the merged Shopify/WooCommerce connectors
(`src/main/shopify/*`, `src/main/woocommerce/*`): descriptor-as-code, the
`CredentialStore` keychain, presence-derived `status()`, a live
`invokeAction`/`subscribe` wired via `registerConnector`. It uses the merged
Shopify and Linear specs as its style and depth template
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`,
`docs/superpowers/specs/2026-07-16-linear-integration-design.md`).

**What is new here versus the ecom siblings.** GitHub is the **first consumer of
the extracted shared infrastructure**: it does **not** hand-roll a
`github-webhook-server.ts` or a `github-ssrf.ts` (as Shopify/Woo each did their
own). It registers a `WebhookVerifier` with the shared receiver
(`src/main/webhooks/webhook-receiver.ts`) and validates its GitHub Enterprise
Server (GHES) `baseUrl` through the shared SSRF guard
(`src/main/net/ssrf-guard.ts`). The connector is therefore **leaner** than its
predecessors — the plumbing they invented is now a dependency it consumes.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a saiife user assemble, on the canvas, a
dev-incident worker that wakes on a GitHub event (a failing check or a new
issue), reads the relevant PR/issue/check facts through the GitHub API, drives a
saiife coding-agent pane to author a branch + fix, and — behind an
author-placed gate — opens a PR that **a human merges** — with the App private
key / PAT in the OS keychain, **never** rendered.

### In scope (MVP)

- A new **GitHub connector** module set under `src/main/github/`, exposing a
  static `githubDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus a live `GitHubConnector implements LiveConnector`
  registered via `registry.registerConnector('github', …)` — the same seam
  Shopify/WooCommerce already use (`integration-registry.ts:54`).
- **`'github'` added to `IntegrationId`** and `INTEGRATION_IDS`
  (`src/shared/integrations.ts`) — the shared-union edit (§6.0).
- **Auth for the MVP "for me" fork:** a **fine-grained Personal Access Token
  (PAT)** stored in the keychain via `CredentialStore`. The **GitHub App
  installation** path (recommended for the product fork, mirrors the codebase's
  app-identity posture) is designed-for and is the recommended default the moment
  the fork flips (§8, §13.1).
- A **GitHub API client** (`github-api.ts`) — the **sole** place any GitHub REST
  or GraphQL shape lives — implementing the read + write surface behind the
  pinned actions (§6.2), and routing every request through the shared SSRF guard
  when a GHES `baseUrl` is configured.
- **Webhook triggers via the shared receiver.** The connector registers a
  `WebhookVerifier{scheme:'hmac',algo:'sha256',header:'X-Hub-Signature-256',
  encoding:'hex'}` with `src/main/webhooks/webhook-receiver.ts` (body
  HMAC-SHA256, hex-encoded) — it writes **no** webhook server of its own.
- The **pinned dev vocabulary** (§6): four webhook-backed triggers, four read
  actions, seven gated-write actions, and the **context-field shape** an action
  writes for downstream edge conditions.
- **The flagship fix-PR loop** (§7): a `check.failed` / `issue.opened` trigger →
  a builtin **`agent` node** that drives a coding-agent pane (via the operator
  `control-api` `POST /panes` + `/panes/:handle/prompt` under a grant, keeping
  the saiifeguard / `OPERATOR_TERMINAL_AGENTS` boundary) → the agent authors a branch
  + fix and reports it via the `FLOW_RESULT` sentinel → a gated `openPR` action →
  **the human merges.** The connector does not own this loop; it is authored in
  the flow (§7, §13.3).
- **Authority = the flow's gates.** Every write is an `action` node the author
  gates by placing a `gate` node (or a conditional edge) before it. **`mergePR`
  and every other mutation NEVER auto-run** — they run only because the graph
  reached them behind whatever gate the author drew (§9). This literally encodes
  the user's "I merge PRs myself" preference as a contract.
- **Single account/org, single saiife environment.** Config-as-code `github`
  block in `config.json` (non-secret refs only); PAT / App private key + webhook
  secret in the keychain.

### Out of scope (MVP) — explicitly deferred

- **The GitHub App product install** (App registration UI, per-installation
  multi-tenant fan-out, the marketplace listing). MVP is the **"for me" fork** —
  one PAT (or one manually-installed App) for one account, its secret in the
  keychain (§8, §13.1). The App **auth path is built** in MVP as the recommended
  default; the *distribution* of an App is deferred.
- **Multi-repo / multi-org fan-out.** The config/credential shapes are drawn so a
  `repos: [...]` / `installations: [...]` array is the additive path (§7, §14),
  not built now.
- **Rich CI-triage** (auto-parsing every failing-check log format, flaky-test
  detection). MVP passes the failing check's `detailsUrl` + captured `output`
  summary to the coding agent and lets *it* do the reasoning — the connector does
  not itself analyze logs.
- **Push / branch / tag creation as connector actions.** The **coding-agent pane
  creates the branch** (it has a real git working tree via the `agent` node's
  group cwd); the connector's write surface is issue/PR/label/workflow/merge, not
  raw git plumbing (§6.2, §7).
- **The richer edge-condition operators** (`gt`/`gte`/`contains`/…). Owned by the
  sibling conditions track; this spec only guarantees its fields are shaped to be
  referenced by them (§10).
- **Flow templates / the "starter fix-PR worker" graph.** Owned by the templates
  track, which consumes §6 verbatim.
- **Non-GitHub git hosts** (GitLab, Bitbucket, Gitea). Deferred; the module
  boundaries are host-shaped so a peer connector can reuse them (§14).

---

## 2. Feasibility + landscape

Feasibility is **DONE** (research: `scratchpad/research/B-dev-incident.md` — the
sensor→actuator framing and the fix-PR loop). This section records the verdict
that gate produced; it does not re-derive it.

### 2.1 Why GitHub is the flagship, not just another connector

The ecom connectors are **read→act**: read an order, refund it. GitHub is
**read→author→act**: read a failing check, **drive a coding agent to write a
fix**, open a PR. That middle stage is not a connector capability at all — it is
saiife's *core* capability (a coding-agent pane), which every other part of
the product already exists to run. GitHub is therefore the connector that points
saiife's own DNA — "an agent works a coding task, a human approves" — at a git
host. It is the actuator the product was implicitly built for.

### 2.2 The GitHub API for trigger → read → author → act

Grounded in the completed feasibility gate:

- **Two API surfaces, both GA.** GitHub exposes a **REST API** (`/repos/…`,
  `/issues`, `/pulls`, `/check-runs`, `/actions`) and a **GraphQL API** (`v4`).
  Every read and every write the loop needs is a first-class, generally-available
  call on one or both. No preview gating (a contrast with Linear's Developer
  Preview). MVP uses **REST for mutations** (simplest, one endpoint per action)
  and may use **GraphQL for batched reads** (issue + PR + check state in one
  round-trip) — flagged as an open decision (§13.2).
- **Read.** `GET /repos/{o}/{r}/issues/{n}`, `GET …/pulls/{n}`,
  `GET …/check-runs/{id}`, and `GET /search/issues?q=` cover `getIssue`, `getPR`,
  `getCheckRun`, `searchIssues`. GA.
- **Act.** `POST …/issues/{n}/comments` (comment), `POST …/issues/{n}/labels`
  (label), `POST …/issues` (create), `PATCH …/issues/{n}` `{state:'closed'}`
  (close), `POST …/pulls` (open a PR), `POST …/actions/workflows/{id}/dispatches`
  (dispatch a workflow), and `PUT …/pulls/{n}/merge` (merge). All GA. This covers
  the seven gated writes (§6.2).
- **Auth (three real options, §8).**
  - **GitHub App installation (recommended).** An App holds a **private key**;
    the connector signs a short-lived **JWT** with it, exchanges the JWT for a
    per-installation **installation access token** (1-hour TTL, minted on demand,
    cached in-memory only — never persisted), and calls the API as the **App's
    own bot identity**. This mirrors the codebase's app-identity posture (Linear's
    `actor=app` bot; saiife acting as *itself*, not impersonating a human).
  - **Fine-grained PAT (MVP "for me").** A single long-lived token, sent as
    `Authorization: Bearer <pat>`. Simplest to a dogfoodable loop; no JWT dance.
  - **OAuth (user-token).** An OAuth app mints a user-scoped token. Useful for a
    "sign in with GitHub" product surface; acts *as the user*, which is exactly
    the identity posture the App path avoids. Deferred (§8, §13.1).
- **Webhooks (push, not poll).** A repo/org/App webhook POSTs an event with an
  **`X-Hub-Signature-256`** header: the **hex-encoded HMAC-SHA256** of the **raw**
  body under the webhook secret. This is precisely the shared receiver's pinned
  `WebhookVerifier{scheme:'hmac',algo:'sha256',header:'X-Hub-Signature-256',
  encoding:'hex'}` (§4.4). The `X-GitHub-Event` header carries the event type
  (`issues`, `pull_request`, `check_run`, `workflow_run`); `X-GitHub-Delivery`
  is the redelivery-safe idempotency id.
- **GHES self-host.** GitHub Enterprise Server exposes the same APIs under a
  **customer-chosen base URL** (`https://ghe.corp.example.com/api/v3` for REST,
  `/api/graphql` for GraphQL). Because that URL is **user-supplied**, every
  outbound call passes through the shared SSRF guard (§4.5, §8.1) — identical in
  spirit to WooCommerce's self-hosted `storeUrl`.
- **Rate limits.** REST is **5,000 req/h** for a PAT/OAuth token and **per
  installation** for an App (scaling with installed repos); GraphQL uses a
  point-cost budget. Generous for the loop (a few reads + a write per run).
  Push-over-poll (webhooks) keeps us far under budget; the client honors the
  `X-RateLimit-*` / `Retry-After` headers with capped backoff (§11).

### 2.3 Constraints (honest caveats — not blockers)

1. **The fix is authored by a coding agent, not the connector.** The connector
   cannot "produce a fix." The **`agent` node** (a saiife builtin) drives a
   coding-agent pane to do that; the connector supplies the *trigger* that starts
   the run and the *write* (`openPR`) that publishes the result. This is a
   division-of-labor design choice (§7, §13.3), not a gap — and it is what keeps
   authority in the flow graph rather than in the connector.
2. **Cloud ingress is mandatory for triggers.** Identical to Shopify/Linear:
   GitHub POSTs webhooks from the cloud, so the local receiver needs a reachable
   URL — a dev tunnel in MVP, a hosted relay in the product fork (§4.4). Read +
   write work over plain outbound HTTPS with no ingress; only *triggers* need it.
3. **A merge is irreversible and is the human's prerogative.** `mergePR` is the
   sharpest expression of saiife's safety posture — even more than an ecom
   refund. It **never** auto-runs; it sits behind an author-placed gate by
   contract (§9). This is a *safety* posture the flow engine's gates already
   provide, not a feasibility concern.

### 2.4 Verdict: **GREEN**

The trigger → read → author → act loop is **fully buildable today** on GitHub's
GA REST/GraphQL APIs, with three real auth options, standard HMAC-SHA256
webhooks that map **exactly** onto the shared receiver's pinned verifier, and a
GHES self-host story that rides the shared SSRF guard. Nothing in the loop is
preview-gated or missing. The three constraints in §2.3 are a division of labor
(the agent authors the fix), a known ingress pattern already solved twice, and a
safety posture the engine already enforces.

---

## 3. The core loop → GitHub primitives

saiife's dev-incident loop is `trigger → read → author (coding-agent) → act
(gated)`. Each stage maps to a concrete GitHub primitive and the concrete
flow-engine mechanism that runs it:

| Stage | GitHub primitive | saiife / flow-engine mechanism |
|---|---|---|
| **trigger** | A verified webhook: `check_run` (failed), `issues` (opened), `pull_request` (opened), `workflow_run` (failed). | The shared `webhook-receiver` verifies the `X-Hub-Signature-256` HMAC → hands the connector a verified delivery → the connector normalizes it to a `SeedEvent` → its `subscribe(triggerId, handler)` hands it to the engine, which `startRun`s the flow with the payload in trigger-node context (`trigger-subscriber.ts`, `flow-engine.ts`). |
| **read** | REST `GET issues/{n}` / `pulls/{n}` / `check-runs/{id}`; `GET /search/issues`. | An `action` node (`getIssue` / `getPR` / `getCheckRun` / `searchIssues`) → `registry.invokeAction('github', ref, params)` → `GitHubConnector` calls `github-api.ts` → **resolves** the normalized result, which the action-runner writes to context under the node id (`action-runner.ts`). |
| **author** | *(none — this is saiife's own coding-agent capability)* | A builtin **`agent` node** (`agent-runner.ts`): `driver.createTerminal(env, agentId, groupId)` → `POST /panes` under the grant; `driver.prompt(env, handle, text)` → `POST /panes/:handle/prompt` (saiifeguard-guarded). The agent works in the group's real git working tree, creates a branch + fix, and reports via `FLOW_RESULT: {...}` which the engine reduces to a typed fact (`parseFlowResult`, `agent-runner.ts:96`). |
| **route** | *(none — pure saiife)* | `selectEdges` evaluates edge conditions over the context the read/agent wrote (`context.ts`). Today `field === equals`; soon the richer `FlowEdgeCondition` operators (§10) over e.g. `pr.mergeable`. No LLM decides routing — deterministic value compares. |
| **gate** | *(none — pure saiife)* | A `gate` node the author placed pauses the run as `needs-you` (`ApprovalPort`, `types.ts:33`); the human approves in the cockpit. A `mergePR` node sits **downstream of the gate the author drew** — by contract (§9). |
| **act** | REST write: `comments`, `labels`, `issues` (create/close), `pulls` (open), `actions/…/dispatches`, `pulls/{n}/merge`. | The gated `action` node (`commentIssue` / … / `openPR` / `mergePR`) → `invokeAction` → `github-api.ts` write. **Failure = a rejected promise** (the pinned convention); the action-runner forwards the *real* GitHub/GraphQL error verbatim (`action-runner.ts`, error-message-style). |

**The authority is the graph the author drew, not the connector.** The connector
exposes *capabilities* (triggers, read actions, write actions); the *flow* decides
which run, in what order, behind which gates. The coding-agent pane that actually
authors the fix is a **builtin node**, driven through the **same guarded operator
control-API** OpenClaw and the Linear connector use — so the saiifeguard prompt guard
and per-environment isolation apply to GitHub-triggered work identically.

---

## 4. Architecture in saiife

### 4.1 Where it sits

A new **main-process module set** under `src/main/github/`, mirroring
`src/main/shopify/` (the first-built connector). It is **opt-in**: with no
`github` config entry (and no stored credential) the descriptor's `status()`
returns `needs-config` and the engine refuses any GitHub node before any network
call (`action-runner.ts` not-connected guard) — saiife's "works with no
integration" guarantee is unchanged.

The connector is the live implementation behind the registry's pinned
`invokeAction`/`subscribe`, registered with `registry.registerConnector('github',
connector)` at startup in `src/main/index.ts` — the **same seam** Shopify and
WooCommerce use (`integration-registry.ts:53-56`, 78-96). All GitHub API shapes
are isolated in `github-api.ts` (the blast radius for any API-version change),
exactly as Shopify isolated its GraphQL in `shopify-admin.ts`.

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/github/github-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'github'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the trigger/action ids (the contract the templates track consumes). Mirrors `shopify-descriptor.ts`. |
| `src/main/github/github-connector.ts` | The `GitHubConnector implements LiveConnector`. Dispatches an action id → a `github-api` call (params templated by the engine); dispatches a trigger id → a shared-receiver subscription. Holds NO GitHub shape and NO secret; every failure REJECTS with the real cause (the pinned convention). **Never auto-mutates** — a write runs only because an `action` node invoked it. Mirrors `shopify-connector.ts`. |
| `src/main/github/github-api.ts` | Thin **GitHub REST/GraphQL** client. **All** GitHub request/response shapes live *only* here. Rate-limit-aware backoff honoring `X-RateLimit-*`/`Retry-After`. Every request's base URL passes through the shared SSRF guard when GHES `baseUrl` is set. Isolated behind a `GitHubApi` interface so tests inject a `MockGitHubApi` (§12). |
| `src/main/github/github-auth.ts` | Credential → request-auth resolution. **App path:** sign a short-lived JWT with the App private key → exchange for an installation access token (in-memory cache, TTL-aware refresh) → `Authorization: Bearer <installation-token>`. **PAT path:** pass the token straight through. Reads secrets main-process-only via `revealForConnector('github', …)`; returns a header, never a value. |
| `src/main/github/github-normalize.ts` | **Pure** mapping: a raw GitHub issue/PR/check-run JSON node → the pinned **context-field shape** (§6.3); and a raw webhook payload (`issues`/`pull_request`/`check_run`/`workflow_run`) → a `SeedEvent`. Unit-testable in isolation (mirrors `shopify-normalize.ts`). This is where numeric ids, state enums, and label arrays are normalized **once**, so conditions read a stable shape. |
| `src/shared/github.ts` | Shared types + id constants (`GITHUB_TRIGGER_IDS`, `GITHUB_READ_ACTION_IDS`, `GITHUB_WRITE_ACTION_IDS`, `GitHubIssueContext`, `GitHubPRContext`, `GitHubCheckRunContext`, the action param shapes) needed by both main and any renderer palette surface. Mirrors `src/shared/shopify.ts`. |

**What is deliberately absent (the shared-infra payoff):**

- **No `github-webhook-server.ts`.** GitHub registers a `WebhookVerifier` with
  the shared `src/main/webhooks/webhook-receiver.ts` (§4.4). Shopify/Woo each
  wrote their own `*-webhook-server.ts`; that plumbing is now extracted, and
  GitHub is its first consumer.
- **No `github-ssrf.ts`.** The GHES `baseUrl` is validated by the shared
  `src/main/net/ssrf-guard.ts` (§4.5). WooCommerce wrote a bespoke `wc-ssrf.ts`;
  that logic is now shared.
- **No `github-token-store.ts`.** Secrets ride the merged registry's
  `CredentialStore` (`revealForConnector('github', …)` — the sole, main-only
  plaintext exit), exactly as WooCommerce does.

### 4.3 Wiring the live dispatch into the merged registry

The pinned `LiveConnector` seam already exists (`src/shared/integrations.ts:55`)
and the registry already delegates to it (`integration-registry.ts:73-96`). So
this connector needs **no contract change** — only:

- `IntegrationId` and `INTEGRATION_IDS` gain `'github'` (§6.0), and
  `DESCRIPTOR_DEFS` gains the descriptor (`descriptors/index.ts`).
- `src/main/index.ts` constructs the `GitHubConnector` (given the
  `CredentialStore`, config, the `github-api` client, and a subscription handle
  on the shared webhook receiver) and calls
  `registry.registerConnector('github', connector)`.

The registry's pinned `invokeAction`/`subscribe` then delegate to it; an id with
no connector still returns the legible "no live connector wired" reject
(`integration-registry.ts:79-86`). Byte-for-byte the same seam Shopify used.

### 4.4 Receiving webhooks — the shared receiver + pinned verifier

GitHub does **not** get its own webhook server. It registers, at connect, a
subscription on the **shared** `src/main/webhooks/webhook-receiver.ts` with:

```
WebhookVerifier { scheme: 'hmac', algo: 'sha256', header: 'X-Hub-Signature-256', encoding: 'hex' }
```

i.e. verify the request by computing `hex( HMAC_SHA256( rawBody, webhookSecret ) )`
and `timingSafeEqual`-comparing it to the `X-Hub-Signature-256` header (GitHub
prefixes the header value `sha256=`; the receiver strips that before the compare).
The shared receiver owns everything Shopify/Woo re-implemented: `createServer` /
`applyLoopbackTimeouts` / `MAX_BODY_BYTES`, the `responded` guard, **raw-body
capture before any JSON parse** (a body-parser that consumes the stream first
breaks HMAC verification), the timing-safe compare, and the **200-fast** response
so GitHub's delivery-timeout expectation is met and a slow flow never triggers a
redelivery storm.

The connector supplies, per subscription: the pinned `WebhookVerifier`, a path
(e.g. `/github/webhook`), the secret source (`revealForConnector('github',
'webhookSecret')`), and an `onEvent(delivery)` handler. The handler dedups on
`X-GitHub-Delivery`, reads `X-GitHub-Event` to pick the event type, normalizes
via `github-normalize`, and fans a `SeedEvent` to the matching trigger handlers
(the `shopify-connector.ts:159-173` `wireWebhook`/`onDelivery` shape, but against
the shared receiver instead of a private one).

**Cloud ingress:** identical to Shopify §4.4 — a dev tunnel in MVP (the tunnel
URL is the webhook's delivery address, stored as the non-secret `webhookUrl`
config ref), a hosted relay in the product fork (§13.1). A forged / oversized /
duplicate / unparseable delivery is dropped by the shared receiver and **never**
seeds a run.

### 4.5 GHES self-host — the shared SSRF guard

`baseUrl` is a non-secret config field (default: `https://api.github.com`; GHES:
`https://ghe.corp.example.com/api/v3`). Because a GHES `baseUrl` is
**user-supplied** and the client makes **outbound** requests to it, `github-api`
passes it through the shared `src/main/net/ssrf-guard.ts` **before every
request**: https-only, reject embedded credentials, block loopback / RFC-1918 /
link-local / the `169.254.169.254` metadata endpoint by **resolved IP**, and pin
the validated IP so a DNS-rebinding flip between validate and connect cannot
redirect the call to a private address. This is the exact posture WooCommerce's
`wc-ssrf.ts` prototyped (`2026-07-17-woocommerce-connector-design.md` §5.1), now
a shared dependency. `api.github.com` is a public host and passes trivially; the
guard exists for the GHES case.

### 4.6 Driving the coding-agent pane (reusing the operator control-API)

The connector **does not** spawn or drive panes. That is the builtin **`agent`
node** (`src/main/flow/node-runners/agent-runner.ts`), which the flow author
places between the GitHub trigger and the gated `openPR` action. The agent node
drives the pane through `PaneDriver` (`src/main/flow/pane-driver.ts`) → the
exported `handleRequest` router (`src/main/control-api.ts`) under an
`OperatorGrantStore` grant:

- `PaneDriver.createTerminal(env, agentId, groupId)` → `POST /panes`
  (`kind: terminal`, `agentId` ∈ `OPERATOR_TERMINAL_AGENTS` = `{claude, codex,
  gemini}` — `control-api.ts:64`). The pane's cwd is derived **server-side** from
  the group's members (never caller-supplied — `pane-driver.ts:34`), so
  `groupId` must name a group whose member has the repo's working tree as its cwd.
- `PaneDriver.prompt(env, handle, text)` → `POST /panes/:handle/prompt`, which is
  **saiifeguard-guarded** exactly like any operator prompt; a guard block returns 403
  with the canonical deny message, surfaced verbatim (`pane-driver.ts:53-68`).

This keeps the GitHub-triggered coding work **inside the operator boundary**: the
capability gate (`OPERATOR_TERMINAL_AGENTS`), the saiifeguard prompt guard, and
per-environment isolation all apply to it identically. The connector's job is
only to *start the run* (via a trigger) and *publish the result* (via `openPR`).

### 4.7 Reused saiife surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `ResolvedIntegrationDescriptor`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain;
  `revealForConnector` (main-only plaintext exit); `decryptionError` (feeds
  `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3);
  `deriveStatus` gives GitHub its status for free; the live-dispatch delegation.
- `src/main/webhooks/webhook-receiver.ts` — **the shared receiver**; GitHub
  registers its `WebhookVerifier` here (§4.4).
- `src/main/net/ssrf-guard.ts` — **the shared SSRF guard** for the GHES `baseUrl`
  (§4.5).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, and how the resolved value lands in context.
- `src/main/flow/node-runners/agent-runner.ts` + `src/main/flow/pane-driver.ts` —
  the builtin `agent` node that drives the coding-agent pane through the guarded
  control-API (§4.6, §7).
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs; the
  `coerceEvent` / `matchesFilter` normalization the webhook `SeedEvent` flows
  through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`;
  `parseFlowResult` (the `FLOW_RESULT` sentinel the agent reports through).
- `src/main/control-api.ts` — `handleRequest` (`POST /panes`,
  `POST /panes/:handle/prompt`, `OPERATOR_TERMINAL_AGENTS`, the prompt guard).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `githubDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as it does for the
other connectors — no bespoke status logic (`integration-registry.ts:222-249`).

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `authMode` | Auth mode (`app` / `pat`) | no | yes | string | Selects which secret(s) are required. Default `pat` for MVP. |
| `pat` | Personal access token | **yes** | no* | string | Fine-grained PAT; keychain only. Placeholder `github_pat_…`. Required when `authMode = pat`. |
| `appId` | GitHub App id | no | no* | string | Required when `authMode = app`. Non-secret ref. |
| `appPrivateKey` | GitHub App private key (PEM) | **yes** | no* | string | Keychain only. Required when `authMode = app`. |
| `installationId` | App installation id | no | no* | string | Required when `authMode = app` (MVP single-install). |
| `webhookSecret` | Webhook signing secret | **yes** | yes | string | Verifies `X-Hub-Signature-256`. Keychain only. |
| `baseUrl` | API base URL (GHES) | no | no | string | Defaults to `https://api.github.com`; GHES `https://<host>/api/v3`. SSRF-guarded (§4.5). |
| `owner` | Default repo owner/org | no | yes | string | e.g. `acme`. Non-secret ref. |
| `repo` | Default repo | no | no | string | e.g. `web`. Optional; actions may override per-node. |
| `environment` | saiife environment (1-9) | no | yes | number | Which env hosts GitHub work (same field/validation as the siblings). |
| `webhookUrl` | Ingress webhook URL | no | no | string | The tunnel/relay delivery address (§4.4). Placeholder `https://<tunnel>/github/webhook`. |

*The `pat` / App-triple requirements are **conditional on `authMode`** — the
descriptor marks them `required: false` at the field level and the connector's
`status()` derivation adds the mode-specific check (a small extension to
`deriveStatus`, or a connector-side presence check surfaced through the config).
`status('github')` reports `needs-config` until the mode's required secrets +
`webhookSecret` + `owner` + `environment` are present; `error` on a decrypt
failure; `disabled` if configured-but-off; `connected` otherwise. The
action-runner refuses any non-`connected` GitHub node before any network call.

---

## 6. Pinned dev vocabulary (verbatim — the templates track consumes this)

> **This section is the contract.** The flow-templates track and the canvas
> palette read these ids and this field shape verbatim. A snapshot test in
> `github-descriptor.ts` guards the ids; the field shape is guarded by the
> `github-normalize.ts` tests. Mirrors the Shopify vocabulary pinning (§6 of the
> Shopify spec).

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'github'`:

```ts
export type IntegrationId = 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'github'
```

Lockstep touch-points (each a one-line add): `INTEGRATION_IDS`
(`integrations.ts:71`, the stable order array), the `INTEGRATION_IDS` allow-list
the flow validator reads (`flow-model.ts`), and `DESCRIPTOR_DEFS`
(`descriptors/index.ts`). No other `IntegrationId` consumer needs a change — they
iterate the array.

### 6.1 Triggers (webhook-backed)

| trigger id | label | underlying GitHub event | note |
|---|---|---|---|
| `issue.opened` | New issue opened | `issues` event, `action: "opened"`. | Clean 1:1. Seeds a `GitHubIssueContext` payload. |
| `pr.opened` | Pull request opened | `pull_request` event, `action: "opened"`. | Clean 1:1. Seeds a `GitHubPRContext` payload. |
| `check.failed` | A check failed | `check_run` event, `action: "completed"` with `conclusion ∈ {failure, timed_out, cancelled}`. | **The flagship trigger** — the fix-PR loop's usual entry (§7). Filtered on the failing conclusion by the connector; carries `prNumber`, `headSha`, `checkName`, `detailsUrl`. |
| `workflow.failed` | A workflow run failed | `workflow_run` event, `action: "completed"` with `conclusion: "failure"`. | Coarser sibling of `check.failed` (whole-run granularity). |

`check.failed` and `workflow.failed` are **derived filters** over the native
`completed` events (there is no dedicated "failed" webhook), set by the connector
when the conclusion is a failure. Noted honestly so the templates track wires the
right underlying event.

### 6.2 Actions

**Read (no gate needed — pure reads write facts for conditions):**

| action id | label | GitHub call | writes to context |
|---|---|---|---|
| `getIssue` | Get an issue | `GET issues/{n}` | `GitHubIssueContext` (§6.3) |
| `getPR` | Get a pull request | `GET pulls/{n}` | `GitHubPRContext` (§6.3) |
| `getCheckRun` | Get a check run | `GET check-runs/{id}` | `GitHubCheckRunContext` (§6.3) |
| `searchIssues` | Search issues/PRs | `GET /search/issues?q=` | `{ items: GitHubIssueContext[]; count }` |

**Gated write (the author places a gate before these):**

| action id | label | GitHub call | note |
|---|---|---|---|
| `commentIssue` | Comment on an issue/PR | `POST issues/{n}/comments` | Low-risk; still an action node. |
| `labelIssue` | Add labels | `POST issues/{n}/labels` | Low-risk annotate. |
| `createIssue` | Create an issue | `POST issues` | Creates repo state. |
| `closeIssue` | Close an issue | `PATCH issues/{n}` `{state:'closed'}` | State change. |
| `openPR` | Open a pull request | `POST pulls` | **The fix-loop publish step** — opens the PR from the agent's branch (§7). |
| `dispatchWorkflow` | Dispatch a workflow | `POST actions/workflows/{id}/dispatches` | Triggers CI (e.g. re-run, deploy-preview). |
| `mergePR` | **Merge a pull request** | `PUT pulls/{n}/merge` | **Irreversible. The strongest gated-mutation contract.** NEVER auto-runs — sits behind an author-placed gate by construction (§9). This literally encodes "I merge PRs myself." |

**Failure convention (pinned):** a write that fails **rejects** its promise with
the real GitHub/GraphQL error text; a resolved promise (any value) is success and
its value becomes the node's context output (`action-runner.ts`,
`integrations.ts:33-43`). The connector never resolves a sentinel-failure.

### 6.3 Context-field shape (what an action writes for later conditions)

A read/trigger writes a **normalized, stable** object (`github-normalize.ts`
produces it — numeric ids, lowercase state enums, `labels` as a `string[]`).
Downstream edge conditions read it via dotted paths (`context.ts` `resolveField`),
e.g. `{{getPR.pr.number}}` in an action param, or `field: 'getPR.pr.mergeable'`
in an edge condition. **Pinned shape:**

```ts
// src/shared/github.ts
export interface GitHubIssueContext {
  issue: {
    number: number
    title: string
    body: string
    state: 'open' | 'closed'
    author: string          // login
    labels: string[]        // label names, lowercased for stable eq/contains
    repo: string            // "owner/name"
    url: string             // html_url
    createdAt: string       // ISO 8601
  }
}

export interface GitHubPRContext {
  pr: {
    number: number
    title: string
    state: 'open' | 'closed' | 'merged'   // 'merged' distinguished from plain 'closed'
    draft: boolean
    author: string          // login
    headRef: string         // source branch
    baseRef: string         // target branch, e.g. "main"
    headSha: string
    mergeable: boolean | undefined         // GitHub returns null while computing → undefined
    checksState: 'success' | 'failure' | 'pending' | 'unknown'
    repo: string            // "owner/name"
    url: string
    createdAt: string
  }
}

export interface GitHubCheckRunContext {
  checkRun: {
    id: number
    name: string
    status: 'queued' | 'in_progress' | 'completed'
    conclusion:
      'success' | 'failure' | 'timed_out' | 'cancelled'
      | 'action_required' | 'neutral' | 'skipped' | 'stale' | null
    prNumber: number | undefined           // the associated PR, when the check is on a PR head
    headSha: string
    repo: string
    detailsUrl: string      // where the failing logs live — handed to the coding agent (§7)
    outputSummary: string   // the check's short output text, if any
  }
}
```

**Why normalized here and not raw:** conditions must be **deterministic value
compares** (`context.ts`, and soon the typed `FlowEdgeCondition` operators of
§10). `pr.number` as a **number**, `state`/`conclusion` as lowercase **enums**,
`labels` as a **string[]**, `draft`/`mergeable` as **booleans** — so
`pr.checksState eq 'failure'`, `pr.mergeable truthy`, `issue.labels contains
'bug'` all work. Normalizing once, in one pure module, is the correctness
boundary the templates and conditions tracks both rely on.

---

## 7. The flagship fix-PR loop — node by node

**Scenario the author drew on the canvas:** *"When a check fails on a PR, drive a
coding agent to fix it on a new branch, then — behind my approval — open a PR I
will merge."* This is **not** hardcoded; it is the graph below, and the connector
supplies only the trigger, the reads, and the gated `openPR` write. The
fix-authoring lives in a builtin `agent` node, and the merge lives with the human.

```
[trigger: github / check.failed]         shared receiver verifies X-Hub-Signature-256
        │  payload → context['t'] = GitHubCheckRunContext
        │  { checkRun: { prNumber, headSha, repo, detailsUrl, name, ... } }
        ▼
[action: github / getPR]                 ref=getPR, params={ number:"{{t.checkRun.prNumber}}" }
        │  invokeAction('github','getPR',…) → github-api.pull() → normalize
        │  writes context['pr'] = GitHubPRContext
        ▼
[router]                                  edge: pr.state == 'open' AND pr.draft == false
        │  (else: end — a closed/draft PR isn't worked)
        ▼
[agent: claude]                           BUILTIN node — the coding agent authors the fix
        │  groupId = a group whose member cwd is the repo working tree (branch headRef)
        │  promptTemplate: "Check '{{t.checkRun.name}}' failed on PR
        │     #{{pr.pr.number}} ({{t.checkRun.detailsUrl}}). Reproduce it, fix it on a
        │     new branch off {{pr.pr.headRef}}, run the check locally, and end with
        │     FLOW_RESULT: {\"branch\":\"<name>\",\"summary\":\"<what you changed>\"}."
        │  → PaneDriver.createTerminal → POST /panes (OPERATOR_TERMINAL_AGENTS, grant)
        │  → PaneDriver.prompt → POST /panes/:h/prompt (saiifeguard-guarded)
        │  → waitForTerminal(handle): 'idle' (Stop hook) = done | 'exited' = fail
        │  → parseFlowResult(peek) → context['fix'] = { branch, summary }
        ▼
[gate: "open a PR for this fix?"]         pauses run needs-you; human reviews the summary
        │  approved ▼            rejected ──► run ends 'rejected' (a human "no" is not a failure)
[action: github / openPR]                 ref=openPR
        │  params={ head:"{{fix.branch}}", base:"{{pr.pr.baseRef}}",
        │           title:"Fix {{t.checkRun.name}}", body:"{{fix.summary}}" }
        │  invokeAction('github','openPR',…) → github-api.createPull()
        │  resolves { prNumber, url } → context['newPr']
        ▼
[action: github / commentIssue]           optional: link the new PR back on the issue/PR thread
        ▼   (done)

        ✱ THERE IS NO mergePR NODE ON THE AUTO-PATH. ✱
          The human merges the opened PR in GitHub (or via a SEPARATE, explicitly
          gated mergePR flow they authored). mergePR NEVER runs unattended — §9.
```

Node-by-node against the engine:

1. **Trigger fires.** The shared receiver verifies the HMAC, dedups on
   `X-GitHub-Delivery`, 200s fast; the connector normalizes the `check_run`
   payload to a `SeedEvent` and, because the conclusion is a failure, fans it to
   `check.failed` subscribers → `startRun`. Trigger node is `done`; payload in
   `context['t']`.
2. **`getPR` reads.** The action-runner templates `number` from
   `t.checkRun.prNumber`, confirms `status('github') === 'connected'`, calls
   `invokeAction`; the connector calls `github-api.pull()`, `github-normalize`
   maps it, the connector **resolves** it → `context['pr']`.
3. **Router branches.** `selectEdges` gates on `pr.state`/`pr.draft`
   (deterministic, no LLM).
4. **Agent authors the fix.** The builtin `agent` node spawns a coding-agent pane
   in the repo's working tree via the guarded control-API, prompts it to fix the
   failing check on a new branch, waits for `idle`, and reduces the pane's
   `FLOW_RESULT` sentinel to `{ branch, summary }` (`agent-runner.ts:85-98`). An
   instant-exit fails the node with the pane's **real** exit tail (§11).
5. **Gate.** The `gate` node pauses `needs-you`; the human approves (or rejects →
   run ends `rejected` cleanly). The agent's `summary` is the peek content the
   human reviews.
6. **`openPR` publishes.** On approval, `openPR` opens the PR from the agent's
   branch; a GitHub error **rejects** with the real message (§11). The resolved
   `{ prNumber, url }` is in context.
7. **The human merges.** Outside this flow, in GitHub — or via a separate,
   explicitly gated `mergePR` flow. **This flow never merges.**

The same trigger + reads + agent node support arbitrarily different graphs
(triage-only, label-and-notify, auto-comment-with-repro, dispatch-a-re-run). The
connector supplies capability + facts; the coding agent supplies the fix; the
**author supplies authority**, and the **human owns the merge**.

---

## 8. Auth & keychain

Three real options; MVP ships **PAT** and **builds the App path** as the
recommended default.

- **GitHub App installation (recommended).** `github-auth.ts` signs a short-lived
  JWT (`iss = appId`, ≤10-min expiry) with the App private key
  (`revealForConnector('github','appPrivateKey')`), POSTs it to
  `…/app/installations/{installationId}/access_tokens` to mint a **1-hour
  installation access token**, caches that token **in memory only** (never
  persisted, never rendered), refreshes it before expiry, and returns
  `Authorization: Bearer <installation-token>` at call time. The connector acts as
  the **App's own bot identity** — mirroring the codebase's app-identity posture
  (Linear's `actor=app`; saiife acting as itself, not impersonating a human).
  This is the recommended default because it is per-installation scoped, tokens
  are short-lived, and it is the multi-tenant-ready shape for the product fork.
- **Fine-grained PAT (MVP "for me").** The user pastes a PAT into the masked
  `pat` field; it goes straight to the keychain via `CredentialStore.set`. Every
  request sends `Authorization: Bearer <pat>`, read at call time via
  `revealForConnector('github','pat')` (main-process-only, the sole plaintext
  exit; a grep test asserts no IPC/renderer caller). Simplest to a dogfoodable
  loop; long-lived until the user rotates it.
- **OAuth (deferred).** A "sign in with GitHub" user-token flow; acts *as the
  user* (the identity posture the App path deliberately avoids). Deferred to the
  product fork (§13.1); the keychain shape already supports it.
- **Webhook secret.** Stored the same way (`webhookSecret`), used only by the
  shared receiver to verify `X-Hub-Signature-256` (§4.4).
- **Honoring the global secret rule.** Neither the PAT, the App private key, the
  installation token, nor the webhook secret is **ever** written to `config.json`,
  the transcript, a log, a PR body, or any IPC payload. `config.json` holds only
  **references** (`authMode`, `appId`, `installationId`, `owner`, `repo`,
  `baseUrl`, that an install exists). Secret **state** (present / decrypt-failing)
  may be surfaced via `status()`; the **value** never is — the hub's existing
  discipline applied to GitHub verbatim.
- **Disconnect.** Clearing the secrets (the hub's `clearSecret`) flips `status()`
  to `needs-config`; the connector stops dispatching and the in-memory
  installation-token cache is dropped. No in-flight run is force-killed — it
  simply can't start a new GitHub action, and reports why (§11).

### 8.1 GHES base URL (SSRF)

Covered in §4.5: the non-secret `baseUrl` (default `https://api.github.com`) is
validated by the shared `src/main/net/ssrf-guard.ts` before **every** call —
https-only, no embedded creds, no loopback/RFC-1918/link-local/metadata, DNS-
rebinding-pinned. The GHES case is why the guard is on the outbound path;
`api.github.com` passes trivially.

---

## 9. Authority & safety — the merge is the human's

**Primary control — the flow's gates (already enforced).** Every write
(`commentIssue`, `labelIssue`, `createIssue`, `closeIssue`, `openPR`,
`dispatchWorkflow`, and above all `mergePR`) is an `action` node. Authority is
whatever the author wired: a `gate` node pauses the run `needs-you` for human
approval (`ApprovalPort`, `types.ts:33` — "a gate NEVER auto-proceeds"); a
conditional edge restricts *when* the write is even reached; a human "no" ends the
run `rejected` (not a failure). **The connector never auto-mutates outside the
graph the author drew.** There is no "connector default policy" that opens or
merges a PR on its own — the connector only does what an action node invokes
(exactly the `shopify-connector.ts:13-25` posture).

**`mergePR` is the sharpest contract.** Merging is irreversible and is the human's
prerogative — this connector encodes the user's standing "**I merge PRs myself**"
preference as a **structural contract**, not a convention:

- The **flagship fix-PR template ships with no `mergePR` node on the auto-path**
  (§7). The loop ends at `openPR`; the human merges in GitHub.
- Where a flow *does* include a `mergePR` node, the descriptor + the templates
  track require a `gate` node immediately upstream of it (a lint the flow
  validator can enforce — flagged in §13). A `mergePR` reachable without a gate is
  a mis-authored flow the validator rejects.
- **Optional deterministic backstop (phased, §14).** In the spirit of **saiifeguard**
  (`guard/`), a small declarative `github.limits` policy enforced **inside the
  connector before any mutation** — e.g. `mergeAlwaysRequiresGate: true` (default
  on), `allowMergeToBranches: ['!main']`, `maxOpenPRsPerRun: 1`. A `mergePR` that
  slips through un-gated **rejects** with a legible "merge is gate-required by
  policy — place a gate before this node or set `github.limits.mergeAlwaysRequires
  Gate: false`." Deterministic, no model in the loop — defense in depth under the
  author's gate, not a replacement for it.

**Never render secrets.** The PAT / private key / installation token live in the
keychain (or memory-only, for the minted token); no error message, log line, or
context field ever contains one (§8, §11).

---

## 10. Richer-conditions dependency (owned elsewhere — named, not designed)

The flow engine's edge conditions today are `field === equals` (`context.ts`,
`flow-model.ts`). A **sibling conditions track** is upgrading them to a typed
`FlowEdgeCondition { field; op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'contains'|
'exists'|'truthy'; value? }`. The fields this spec pins (§6.3) are **designed to
be referenced by those operators**: `pr.number` / `checkRun.id` as **numbers** for
`gt`/`lte`; `state` / `conclusion` / `checksState` as lowercase **enums** for
`eq`/`ne`; `labels` as a **string[]** for `contains`; `draft` / `mergeable` as
**booleans** for `truthy`; the `prNumber` present-or-absent for `exists`. This
spec does not design the condition system — it only guarantees its field types are
the ones those operators expect, normalized once in `github-normalize.ts`. The
dependency is one-directional; the connector works under the current `eq`-only
routing, just less expressively.

---

## 11. Error handling

saiife's principle (error-message-style memory; demonstrated in
`credential-store.ts`, `action-runner.ts`, `control-api.ts`): **every failure is
human-readable, actionable, and carries the real underlying exception. No silent
catch. No bare "failed" / 404-vibe.** A write signals failure by **rejecting** its
promise with that message; the action-runner prefixes it with the node/action and
surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Webhook signature invalid** | signature mismatch (never the body or secret) | Shared receiver rejects (401); route + reason only; **no run started**. Mirrors control-api's "never log token material". |
| **Webhook duplicate** (`X-GitHub-Delivery` seen) | the delivery id | 200 (GitHub redelivery is expected); dedup-drop; no second run. |
| **Webhook oversized / malformed** | `MAX_BODY_BYTES` / JSON parse error | 4xx; dropped by the shared receiver; no run. |
| **`status('github') !== 'connected'`** | the derived reason (missing secret / decrypt error / disabled) | Action-runner fails the node *before* any call: "Flow needs GitHub connected — action '<id>' can't run. Connect it in Settings." |
| **PAT / installation-token invalid (401)** | GitHub's auth error | `invokeAction` **rejects**: "GitHub rejected the credential (401) — the token was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing scope / permission (403)** | GitHub's scope error | Rejects verbatim: "GitHub refused 'mergePR': the token lacks `pull_requests: write` on `<repo>` — grant it and re-enter." |
| **App JWT / installation-token mint failure** | the `github-auth` error (bad key, wrong appId/installationId) | Rejects: "Could not mint a GitHub App installation token — check the App id / private key / installation id in Settings." Never renders the key. |
| **Issue/PR/check not found (404)** | the id that missed | Rejects: "GitHub has no PR '#<n>' in '<repo>' (it may be from another repo or was deleted)." — actionable, not a bare 404. |
| **PR not mergeable (405 / merge conflict)** | GitHub's merge error | Rejects: "GitHub refused the merge of #<n>: <reason> (e.g. required checks pending / merge conflict)." The run fails with the true reason, never a silent no-op. |
| **Rate-limit (403 `X-RateLimit-Remaining: 0` / `Retry-After`)** | the reset time from the headers | `github-api` retries with **capped backoff** honoring the header; only after exhausting retries does it reject with "GitHub rate limit hit; resets in ~Ns." Not swallowed. |
| **SSRF-blocked GHES host** | the resolved private/loopback IP | Rejects **before** the call: "API base URL '<host>' resolves to a private/loopback address (<ip>) — refusing to call it." (§4.5) |
| **Agent pane instant-exit** (fix-loop) | the pane's REAL exit tail | The `agent` node fails forwarding `info.message` verbatim (`agent-runner.ts:86-93`) — never a vaguer wrapper. |
| **saiifeguard blocks the agent prompt** | the canonical deny message | `PaneDriver.prompt` returns 403; the agent node surfaces the guard's own message verbatim (`pane-driver.ts:53-68`). |
| **Ingress/tunnel down** | the unreachable `webhookUrl` | Startup/health check fails loudly: "GitHub webhook URL '<url>' is unreachable — no repo events will arrive." Never a silent dead trigger. |
| **Backstop policy block** (§9) | the policy + the attempted action | Rejects before the call: "merge is gate-required by policy — place a gate before this node or change `github.limits`." |

The connector **never** catches-and-drops. Where GitHub returns a precise error,
the connector forwards *that* rather than minting a vaguer one — the action-runner
only prefixes it with the node/action.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live GitHub account**, matching saiife's existing seams
(pure modules, injected backends, fixture events):

- **`GitHubApi` interface + `MockGitHubApi` seam.** `github-api.ts` is written
  *against* a `GitHubApi` interface (`issue`, `pull`, `checkRun`, `searchIssues`,
  `createComment`, `addLabels`, `createIssue`, `closeIssue`, `createPull`,
  `dispatchWorkflow`, `mergePull`); the real impl wraps the REST/GraphQL
  transport. Tests inject a `MockGitHubApi` returning canned nodes and canned
  error envelopes (401/403/404/405/rate-limit). **No test ever performs a live
  GitHub call**; CI has no GitHub credentials. Same posture as the built
  `MockShopifyApi` / `MockWcApi` seams.
- **The pane-drive seam.** The fix-PR loop is tested through the **existing
  `agent-runner` seam**: `agent-runner.ts` already takes a narrow `PaneDriverLike`
  (`createTerminal`/`prompt`) and an injected `waitForTerminal`
  (`agent-runner.ts:9-30`). Tests inject a fake driver that records the
  `POST /panes` + `/prompt` calls and a scripted `waitForTerminal` returning
  `'idle'`, plus a `manager.peek` stub returning a `FLOW_RESULT: {"branch":…}`
  line — asserting the agent node reduces it to `context['fix']` and the
  downstream `openPR` templates `head` from `fix.branch`. **No pane, no pty, no
  socket** — the guarded control-API path is exercised in `control-api`'s own
  tests; the flow test drives the seam.
- **`github-normalize.ts` unit tests** — pure function; assert every raw
  issue/PR/check-run node and webhook payload → the pinned context shapes (§6.3):
  numeric ids, enum lowercasing, `state: 'merged'` distinguished from `'closed'`,
  `mergeable: null → undefined`, `labels` array, the `check.failed`/`workflow.
  failed` failure-derivation. The correctness boundary the conditions track
  depends on — guarded hardest.
- **Shared-receiver verifier test** — feed fake `issues` / `pull_request` /
  `check_run` bodies with **valid and invalid `X-Hub-Signature-256`** (hex
  HMAC-SHA256), oversized bodies, malformed JSON, and **duplicate
  `X-GitHub-Delivery`**; assert 200/4xx/401 and that only valid+signed+novel
  events produce a `SeedEvent`. Exercises the pinned `WebhookVerifier` config
  against the shared receiver.
- **`github-connector` dispatch tests** — with a `MockGitHubApi` + a fake
  registry: assert `invokeAction('github','getPR',…)` resolves the normalized
  context; assert a GitHub error response **rejects** with the verbatim message
  (the pinned failure convention); assert **no write fires without an action-node
  invocation** (the authority regression Shopify/Woo also guard); assert the
  §9 backstop rejects an un-gated `mergePR` before the mock is called.
- **`github-auth` tests** — JWT-sign + installation-token-mint against a mock
  transport; assert the token is cached/refreshed and that **no key/token value
  appears** in any emitted log/console/error string (the secret rule).
- **SSRF test** — the shared `ssrf-guard` is exercised with a GHES-shaped
  private/loopback/link-local `baseUrl` (refused) and `api.github.com` (allowed).
- **Engine integration test (offline)** — wire the real `FlowEngine` + registry
  with the GitHub connector over a `MockGitHubApi` + the fake pane-driver, drive
  the §7 loop end-to-end: inject a `check.failed` `SeedEvent` → assert `getPR`
  writes context → router selects the open-PR edge → the agent node "authors" a
  fix (scripted `FLOW_RESULT`) → the gate pauses `needs-you` → on approval
  `openPR` calls the mock → **assert no `mergePR` is ever called.** Deterministic
  via the engine's injected `now()`.
- **Snapshot test on `githubDescriptor`** — pins the trigger/action ids the
  templates track consumes; a change is a deliberate, reviewed contract edit.

No test requires GitHub credentials or a live repo; the real API is exercised only
in manual dogfooding against a scratch repo.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **"For me" vs "a product others install."** The biggest fork.
   - *For me* (MVP): one **PAT** (or one manually-installed App) for one account,
     its secret in Jonas's keychain, a dev tunnel for ingress. Fastest to a
     dogfoodable fix-PR loop.
   - *Product*: a **distributable GitHub App** (marketplace listing, per-
     installation multi-tenant fan-out, a hosted webhook relay). Changes
     distribution, ingress (relay), and config (multi-install). **Recommendation:
     build MVP "for me" with the App auth path as the default** (it is the
     app-identity posture the codebase favors and is multi-tenant-ready), and keep
     the config/credential shapes install-array-ready (§8).
2. **REST vs GraphQL.** REST is simplest per-action (one endpoint per write) and
   is the MVP choice for mutations. GraphQL (`v4`) can batch the fix-loop reads
   (PR + checks + issue in one round-trip) and is cheaper on rate budget. Decide
   whether reads go GraphQL from day one or REST-first with a GraphQL read path in
   phase 2. Either way, **all shapes stay isolated in `github-api.ts`** so the
   choice is one file's blast radius.
3. **How much of the fix loop is in-connector vs authored in the flow.**
   **Recommendation: authored in the flow (this spec's design).** The connector
   stays a pure actuator (trigger + read + gated write); the fix-authoring is a
   builtin `agent` node the author places, driven through the guarded operator
   control-API. This keeps authority in the graph, keeps the coding-agent inside
   the saiifeguard/`OPERATOR_TERMINAL_AGENTS` boundary, and lets the author reshape the
   loop (triage-only, comment-only, dispatch-a-re-run) without connector changes.
   The alternative — a connector-owned "fix this" action that internally spawns a
   pane — would move the pane-drive out of the flow and blur the authority
   boundary; rejected for MVP. Flagged because a future "one-click fix-PR" product
   surface might want a canned sub-flow, which is a *template*, not a connector
   feature.
4. **`mergePR` gate enforcement — lint vs runtime backstop vs both.** §9 proposes
   both a flow-validator lint (a `mergePR` with no upstream gate is rejected at
   author time) and a deterministic runtime backstop (`github.limits.
   mergeAlwaysRequiresGate`, default on). Whether MVP ships one or both, and
   whether the backstop default is on, is a product-safety call — but the default
   posture is unambiguous: **merge is never unattended.**
5. **Webhook subscription management — manual vs programmatic.** MVP can have the
   user create the repo/org/App webhook in GitHub (pointing at their tunnel), or
   the connector can create it via the REST hooks API on connect. Leaning manual
   for the MVP slice, programmatic in phase 2 (adds a scope + a teardown story).

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One repo, one flow, the fix-PR loop's happy path, no merge:**

1. `IntegrationId` gains `'github'` (+ the lockstep touch-points, §6.0);
   `githubDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence.
2. `authMode: 'pat'`; `pat` + `webhookSecret` + `owner` stored (secrets →
   keychain); `status('github') === 'connected'`.
3. `github-api.ts` behind `GitHubApi`: `getPR` (`GET pulls/{n}`) and `openPR`
   (`POST pulls`) live; `github-normalize` produces `GitHubPRContext` /
   `GitHubCheckRunContext`.
4. `registerConnector('github', …)`: `invokeAction('github',…)` reaches the
   connector; `subscribe('github','check.failed',…)` reaches the shared receiver.
5. The shared `webhook-receiver` handling `check_run` (`completed`+failure) with
   the pinned `WebhookVerifier` + `X-GitHub-Delivery` dedup, behind a dev tunnel,
   emitting a `SeedEvent`.
6. On the canvas:
   `[check.failed] → [getPR] → [agent: claude] → [gate] → [openPR]` runs
   end-to-end; **no `mergePR` node**; the human merges in GitHub. Errors per §11.

That slice proves the whole flagship loop (a real failing check wakes a real flow
that reads the PR, drives a coding agent to author a fix on a branch, and — behind
a gate — opens a PR the human merges) and is dogfoodable against a scratch repo.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton. "For me" fork (PAT), App auth path
  built as the default. `check.failed` + `getPR` + `agent` + author gate +
  `openPR`. Single repo, single environment. **No auto-merge.**
- **Phase 2 — full vocabulary:** the rest of §6 — `issue.opened` / `pr.opened` /
  `workflow.failed`; `getIssue` / `getCheckRun` / `searchIssues`; `commentIssue` /
  `labelIssue` / `createIssue` / `closeIssue` / `dispatchWorkflow`; and — behind a
  gate + the §9 backstop — `mergePR`. Programmatic webhook-subscription
  management (§13.5).
- **Phase 3 — deterministic merge/write backstop:** the `github.limits` policy
  (§9), saiifeguard-style, with the `mergeAlwaysRequiresGate` default decided (§13.4);
  the flow-validator lint for un-gated `mergePR`.
- **Phase 4 — richer conditions consumption:** once the conditions track lands
  `FlowEdgeCondition` (§10), verify the pinned fields drive
  `eq`/`ne`/`gt`/`contains`/`truthy`/`exists` end-to-end (e.g. "only open a PR
  when `pr.checksState eq 'failure'` and `pr.mergeable truthy`").
- **Phase 5 — product fork:** distributable GitHub App, hosted webhook relay,
  multi-installation isolation, OAuth "sign in with GitHub" (§13.1).
- **Phase 6 — expand git hosts:** **GitLab** next (different auth/webhook shape —
  validates the connector boundary), then **Bitbucket** / **Gitea**. Each a peer
  under `src/main/gitlab/` etc., reusing the shared `webhook-receiver` /
  `ssrf-guard` / `CredentialStore` and the `*-connector` / `*-api` / `*-normalize`
  module shape. No shared cross-host standard — each is its own connector.

---

## Appendix — reused / satisfied saiife surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  + `INTEGRATION_IDS` edited (§6.0); `IntegrationStatus`;
  `ResolvedIntegrationDescriptor`.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain;
  `revealForConnector` (main-only plaintext exit); `decryptionError` (feeds
  `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3);
  `deriveStatus` (presence → `connected`/`needs-config`/`error`/`disabled`); the
  live-dispatch delegation the GitHub connector plugs into.
- `src/main/integrations/descriptors/index.ts` — `DESCRIPTOR_DEFS` gains
  `github`; `shopify-descriptor.ts` is the descriptor-as-code template.
- `src/main/webhooks/webhook-receiver.ts` — **the shared receiver**; GitHub
  registers `WebhookVerifier{scheme:'hmac',algo:'sha256',header:'X-Hub-Signature-
  256',encoding:'hex'}` here (§4.4). GitHub is its first consumer.
- `src/main/net/ssrf-guard.ts` — **the shared SSRF guard** for the GHES `baseUrl`
  (§4.5, §8.1).
- `src/main/flow/node-runners/action-runner.ts` — how `invokeAction` is called,
  the **reject = failure** convention, the not-connected guard, and how the
  resolved value lands in context.
- `src/main/flow/node-runners/agent-runner.ts` — the builtin `agent` node that
  authors the fix by driving a coding-agent pane; its `PaneDriverLike` +
  `waitForTerminal` seams are the fix-loop test surface (§12).
- `src/main/flow/pane-driver.ts` — `PaneDriver.createTerminal`/`prompt` → the
  guarded operator control-API (`POST /panes`, `/panes/:handle/prompt`).
- `src/main/control-api.ts` — `handleRequest`, `OPERATOR_TERMINAL_AGENTS`
  (`{claude, codex, gemini}`), the saiifeguard prompt guard on `/prompt`.
- `src/main/flow/trigger-subscriber.ts` — how `subscribe` seeds runs;
  `coerceEvent` / `matchesFilter` the webhook `SeedEvent` flows through.
- `src/main/flow/context.ts` — `resolveField` / `applyTemplate` / `selectEdges`;
  `parseFlowResult` (the `FLOW_RESULT` sentinel the agent reports the branch
  through).
- `src/main/flow/types.ts` — `NodeOutcome` (`done`/`failed`/`rejected` — the
  human-"no"-is-not-a-failure gate contract) and the `ApprovalPort` gate seam.
- `guard/` (saiifeguard) — the deterministic-guard *posture* the optional §9 merge
  backstop borrows (a policy floor under the author's gates, no model in the loop).
- `docs/superpowers/specs/2026-07-17-shopify-connector-design.md` — the built
  sibling whose module shape, vocabulary-pinning, error-table, and offline-testing
  posture this spec mirrors.
- `docs/superpowers/specs/2026-07-16-linear-integration-design.md` — the
  app-identity / webhook-HMAC / keychain / cloud-ingress template.
