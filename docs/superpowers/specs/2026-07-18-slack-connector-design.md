# Slack Connector — Design

**Date:** 2026-07-18
**Status:** Design (spec) — not started. Design-approval gate for the **remote
approval + notification + control surface** product direction. The
highest-leverage connector: it is the human-in-the-loop surface for **every**
worker, not just its own vertical.
**Feature:** A **Slack connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`, **and** — uniquely — supplies localflow's first real
`ApprovalPort`. A worker hits a gate → the connector posts a Block Kit message
with Approve / Deny buttons → the user taps (on their phone) → the tap resolves
`ApprovalPort.requestApproval(req): Promise<boolean>` `true`/`false` → the gated
action runs or the run cleanly stops. It also **notifies** (`postMessage`), lets
a run **converse** (`replyInThread`), and exposes a **control surface**
(`/localflow run|status|stop`) to seed and query flow runs from chat.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and copies the module shape of the merged Shopify/WooCommerce connectors under
`src/main/{shopify,woocommerce}/` (CredentialStore keychain, descriptor-as-code,
presence-derived `status()`, all API shapes isolated in one client). It reuses
the Shopify connector spec as its style and depth template
(`docs/superpowers/specs/2026-07-17-shopify-connector-design.md`).

**A note on scope and unique value.** The other connectors (Shopify, Linear,
email, cloud) are *vertical capability* connectors — they read and act on one
external system. Slack is a **cross-cutting control connector**: its most
important export is not "a Slack action" but the **`ApprovalPort` adapter (§3,
§7)** that makes *any* gate in *any* flow — an email send, a `cloud apply`, a
Stripe refund, a Shopify `refundOrder` — approvable from a phone. This spec pins
the Slack vocabulary (§6) **and** designs the general approval seam (§3, §7) that
every connector benefits from without knowing Slack exists.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user approve or deny any worker's gate
from Slack on their phone, receive run notifications and converse with a run in a
thread, and drive runs with `/localflow run|status|stop` — with the bot token,
app token, and signing secret in the OS keychain, **never** rendered, and every
send/mutation flowing through the flow engine's gates.

### In scope (MVP)

- A new **Slack connector** module set under `src/main/slack/`, exposing a static
  `slackDescriptor` (`IntegrationDescriptorDef`) added to `DESCRIPTOR_DEFS`, plus
  the **live dispatch** (`invokeAction` / `subscribe`) registered via
  `registry.registerConnector('slack', …)` (the seam Shopify already uses —
  `integration-registry.ts:53-56`).
- **The `ApprovalPort` adapter (`slack-approval-port.ts`)** — the headline. A real
  `ApprovalPort` implementation that replaces the deliberately-stubbed one in
  `index.ts:435` (which today always rejects — "interactive gates aren't wired yet,
  rejecting safely"). It posts an approval Block Kit message, awaits a button tap,
  and resolves `requestApproval` `true`/`false`. This is **connector-agnostic**:
  it services every gate in every flow (§3, §7).
- **A Socket Mode client (`slack-socket.ts`)** — a persistent **outbound**
  WebSocket (opened with the app token) that carries events, slash commands, and
  interaction (button) payloads with **no public ingress**. This is Slack's unique
  advantage over every other connector: it dodges the NAT/cloud-ingress problem
  that Shopify/Linear/Woo all confront (§2, §4.4).
- **An Events-API receiver path (`slack-events-server.ts`)** — the alternative for
  users who prefer HTTP ingress, built on the **shared webhook receiver**
  (`src/main/webhooks/webhook-receiver.ts`, being built as the base) configured
  with Slack's `WebhookVerifier` (§4.4, §8). Spec'd, not the default.
- **A Web API client (`slack-client.ts`)** — the **sole** place any Slack API shape
  lives: `chat.postMessage`, `chat.update`, `views`/message replies, and the
  Socket-Mode ack envelope. Isolated behind a `SlackApi` interface so tests inject
  a `MockSlackApi` (§12).
- **The pinned Slack vocabulary (§6):** three triggers (`message.received`,
  `slash.command`, `approval.responded`), three actions (`postMessage`,
  `postApproval`, `replyInThread`), and the trigger/context payload shapes.
- **The control surface:** the reserved `/localflow run|status|stop` slash command
  (`slack-control-bridge.ts`) seeds/queries/stops flow runs against the engine —
  openclaw's chat-control, upgraded and gated.
- **Single workspace, single localflow environment.** Config-as-code `slack` block
  in `config.json` (non-secret refs only); the three secrets in the keychain.

### Out of scope (MVP) — explicitly deferred

- **Distributable / public app OAuth install** (Slack app directory, per-workspace
  OAuth, multi-workspace token isolation). MVP is the **"for me" fork** — one app
  installed to one workspace via a manifest, its tokens in the keychain (§8, §13.3).
- **Composite / racing approval surfaces.** MVP wires Slack **as** the
  `ApprovalPort`. Racing it against the in-cockpit `ApproveButton` (first responder
  wins, the other message is retracted) is designed-for but phased (§7.4, §13.4).
- **Rich interactive surfaces** beyond Approve/Deny + notify + thread reply: modals,
  home tabs, ephemeral menus, message shortcuts, workflow steps. Phase 2+.
- **Discord** — the **same-slot analog** (a persistent-gateway chat control surface
  with the same three actions and the same approval round-trip). Deferred; the
  module boundaries (§4) are chat-platform-shaped so a `src/main/discord/` peer
  reuses them. Slack first for the widest install base + first-class Socket Mode +
  Block Kit interactivity.
- **Per-user approver authorization** (only certain Slack users may approve a given
  gate). MVP trusts any member of the approval channel; an allow-list is phase 2
  (§13.5).

---

## 2. Feasibility + landscape (DONE — summarized)

Feasibility is complete; the verdict is **GREEN**. The two ingress modes and the
approval round-trip are all buildable today on GA Slack APIs.

### 2.1 Two ingress modes — the defining choice

| Mode | How events/interactions arrive | Ingress needed? | Verdict |
|---|---|---|---|
| **Socket Mode** | The app opens an **outbound** WebSocket via `apps.connections.open` (app-level token, `connections:write`). Events, slash commands, **and interaction (button) payloads** all arrive over that socket; the app `ack`s each on the wire. | **None.** Pure outbound — dodges NAT, tunnels, relays entirely. | **Chosen default** for the local / self-host tier. |
| **Events API** | Slack **HTTP POSTs** events to a public **Request URL**, and posts interaction payloads to a separate **Interactivity Request URL**. Each is signature-verified (`X-Slack-Signature` = `v0=` + HMAC-SHA256 over `v0:{ts}:{body}`, 5-min tolerance). | **Yes** — a public URL (tunnel/relay), the same problem Shopify/Linear/Woo confront. | Spec'd (§4.4); for users who already run HTTPS ingress. |

**Why Socket Mode is the recommended default.** localflow is a **local-first
desktop app** on a laptop behind NAT (the dev-machine memory: an 8 GB Apple-silicon
Mac). Every other connector needs a public URL for its triggers and must document a
tunnel/relay as a v1 prerequisite. Slack is the **one connector that does not** —
Socket Mode gives a fully local, zero-ingress event + interaction path. That
uniquely fits the product and is why Slack is the highest-leverage connector to
build: it is both the most valuable surface (remote approval for everything) and
the cheapest to run (no ingress).

### 2.2 The approval round-trip is GA

- **Post** an interactive message with Block Kit `actions` blocks (Approve / Deny
  buttons) via `chat.postMessage` (`chat:write`).
- **Receive** the button tap as a `block_actions` interaction payload — over the
  Socket Mode socket (no ingress) or the Interactivity Request URL (Events mode).
- **Correlate** the tap to the waiting gate via the button `value` / `action_id`
  (we embed `runId:nodeId`).
- **Finalize** by `chat.update`-ing the original message (disable buttons, stamp
  "Approved by @user" / "Denied by @user") so the surface is not tappable twice.

All GA, all documented, all covered by the bolt-js / Slack Web API surface. Nothing
is preview-gated.

### 2.3 Constraints (why not GREEN-with-zero-caveats)

1. **Slack's signing scheme has two Slack-specific prefixes.** The signed base
   string is `v0:{timestamp}:{rawBody}` and the header value is `v0=` + hex(HMAC).
   The shared `WebhookVerifier` (§4.4) expresses the HMAC-SHA256 / header /
   hex-encoding / timestamp-signing / 5-min-tolerance parts directly; the `v0:` /
   `v0=` **prefixes** are a Slack adaptation the verifier config must carry (a
   `basePrefix`/`sigPrefix`, or a small pre-formatter the connector supplies). Named
   honestly (§4.4) so the shared-infra owner knows the one Slack-shaped requirement.
   **Socket Mode needs none of this** — the socket is authenticated at open time.
2. **Approval liveness.** A gate posted to Slack waits for a human. If no one ever
   taps, the promise must not hang forever — a configurable **timeout resolves
   `false` (clean stop)**, mirroring the "a human 'no' is not a failure" semantics
   the engine already has (§7.3). This is a design requirement, not a capability gap.
3. **Rate limits + reconnects.** `chat.postMessage` is tiered-rate-limited (Slack
   returns `429` + `Retry-After`); the Socket Mode socket issues periodic
   `disconnect` (refresh) frames and must transparently reconnect. Both are handled
   in the client/socket modules (§11) — operational, not blocking.

### 2.4 Verdict: **GREEN.** The approval round-trip, both ingress modes, and the
control surface are all GA. Socket Mode makes it the only connector with a
zero-ingress trigger path. The three constraints are a known signing quirk, a
liveness timeout the engine's semantics already model, and standard
rate-limit/reconnect handling.

---

## 3. The unique value: the approval round-trip as a first-class `ApprovalPort`

localflow's gate seam is already pinned (`src/main/flow/types.ts`):

```ts
export interface ApprovalRequest { runId: string; nodeId: string; prompt: string; peek: string[] }
export interface ApprovalPort { requestApproval(req: ApprovalRequest): Promise<boolean> }
```

Today the **production `ApprovalPort` is a stub** (`index.ts:435-444`) that always
resolves `false` with the note *"interactive gates aren't wired yet, rejecting
safely."* Every gate in every flow therefore cleanly stops. **The Slack connector
supplies the first real implementation.**

The seam is exactly right for this and requires **no change to the gate, the
gate-runner, or the engine**:

- The `gate-runner` (`node-runners/gate-runner.ts:27`) calls
  `deps.approvals.requestApproval({ runId, nodeId, prompt, peek })` and records the
  boolean under the node id (`{ approved }`). It "NEVER auto-proceeds: it always
  awaits the port."
- The `FlowEngine` takes `approvals: ApprovalPort` as a constructor dep
  (`flow-engine.ts:31`) and routes on the boolean the gate recorded — `true` →
  approve edge; `false` with no reject edge → the run ends **`rejected`** cleanly
  (`flow-engine.ts:304-317`), which is a human "no", **not a failure**.

So the Slack connector's approval adapter is **not a Slack-specific gate**. It is a
drop-in `ApprovalPort` that happens to render its question in Slack. Because *every*
gate goes through this one seam, wiring Slack once makes **every** connector's
gated action — email send, `cloud apply`, Stripe refund, Shopify `refundOrder` —
approvable from a phone. That is the leverage: one adapter, universal remote
approval. The design deliberately targets **the seam, not a Slack gate node**.

**Data-flow sketch** (full node-by-node in §7):

```
worker run reaches a [gate] node
   │  gate-runner → approvals.requestApproval({ runId, nodeId, prompt, peek })
   ▼
SlackApprovalPort.requestApproval(req):
   1. build an approval Block Kit message (prompt + peek, Approve/Deny buttons,
      button value = "approve|deny:{runId}:{nodeId}")
   2. chat.postMessage → messageRef (channel+ts)
   3. store a pending resolver in a Map keyed by "{runId}:{nodeId}"
   4. return the Promise  (the gate awaits; run status → needs-you)
   ▼
user taps Approve on their phone
   ▼
interaction payload arrives (Socket Mode socket, or Interactivity URL)
   → correlate action value → look up pending resolver
   → chat.update the message ("Approved by @user", buttons removed)
   → resolve(true)           (idempotent: a second tap is a no-op)
   ▼
gate-runner records { approved: true } → engine routes the approve edge →
the gated action (refund / send / apply) runs. (Deny → resolve(false) → clean stop.)
```

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/slack/`, mirroring
`src/main/shopify/` and `src/main/woocommerce/` (the `*-connector` / `*-client` /
`*-webhook`/socket / token store / config / normalize shape). It is **opt-in**:
with no `slack` config entry (and no stored tokens) the descriptor's `status()`
returns `needs-config`, the engine refuses any Slack node
(`action-runner.ts`), and — critically — the `ApprovalPort` **falls back to the
safe-reject stub** so a gate without Slack configured still stops cleanly rather
than hanging. localflow's "works with no integration" guarantee is unchanged.

Architecturally the connector is **the live implementation behind the registry's
pinned `invokeAction`/`subscribe`** (registered via `registerConnector('slack',…)`,
`integration-registry.ts:53-56`) **plus** the `ApprovalPort` construction wired
into the `FlowEngine` at startup (§4.3). All Slack API shapes are isolated in
`slack-client.ts` (the blast radius for any API change).

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/slack/slack-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'slack'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the ids. Mirrors `shopify-descriptor.ts`. |
| `src/main/slack/slack-connector.ts` | The `LiveConnector`. Dispatches an action id → a `slack-client` call; a trigger id → a subscription over the active transport (Socket Mode or Events). Owns the in-memory interaction/dedup routing. The one place action/trigger dispatch lives. |
| `src/main/slack/slack-client.ts` | Thin **Web API** client. **All** Slack request/response shapes (`chat.postMessage`, `chat.update`, thread replies, `apps.connections.open`, the `ok:false` error envelope) live *only* here. Tiered-rate-limit backoff on `429`/`Retry-After`. Isolated behind a `SlackApi` interface so tests inject `MockSlackApi` (§12). |
| `src/main/slack/slack-socket.ts` | **Socket Mode** client. Opens the outbound WS via `apps.connections.open`, receives `events_api` / `slash_commands` / `interactive` envelopes, `ack`s each, and transparently reconnects on `disconnect` (refresh) frames. Emits a normalized `SlackInbound`. **No signature verification** — the socket is authenticated at open. This is the zero-ingress path (§2.1). Behind a `SocketTransport` interface for a mock (§12). |
| `src/main/slack/slack-events-server.ts` | The **Events API** path (alt to Socket Mode). Consumes the **shared** `src/main/webhooks/webhook-receiver.ts` with Slack's `WebhookVerifier` (§4.4); handles the one-time `url_verification` challenge; emits the same normalized `SlackInbound`. Only mounted when `mode: 'events'`. |
| `src/main/slack/slack-approval-port.ts` | **The headline.** Implements `ApprovalPort` (`flow/types.ts`). `requestApproval` posts an approval message via `slack-client`, parks a resolver in a pending `Map<"{runId}:{nodeId}", {resolve,messageRef,timer}>`, and returns the promise. An inbound `block_actions` interaction (routed from the transport) resolves it `true`/`false`, `chat.update`s the message, and clears the entry. Enforces the liveness timeout (§7.3) and idempotency (§7.2). **Connector-agnostic** — knows only `ApprovalRequest`, not Shopify/email/cloud. |
| `src/main/slack/slack-control-bridge.ts` | The reserved **`/localflow`** slash command handler: `run <flow>` (startRun by flow name), `status [run]` (query `RunSnapshot`s), `stop <run>` (request stop). Holds a narrow **engine control seam** (start/query/stop) injected at startup — openclaw's chat-control, upgraded and gated. Non-`/localflow` slash commands flow to the `slash.command` trigger instead. |
| `src/main/slack/slack-blocks.ts` | **Pure** Block Kit builders: `buildApprovalMessage(req)`, `buildResolvedMessage(req, decidedBy, approved)`, `buildNotifyMessage(text, blocks?)`; and the pure **parse** of a raw interaction/event/slash payload → a typed `SlackInbound` / `ApprovalDecision`. Unit-testable in isolation (the correctness boundary for correlation). |
| `src/main/slack/slack-token-store.ts` | Keychain-backed token access — a **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('slack', 'botToken'|'appToken'|'signingSecret')`). Reuses the existing keychain sidecar; opens no second one. Named to grep distinctly (asserts no IPC/renderer caller — the `revealForConnector` discipline). |
| `src/main/slack/slack-config.ts` | Reads the non-secret `slack` refs (default channel, mode, ingress url, environment) — the `integration-config.ts` validate-at-the-boundary pattern. Holds only Slack-specific coercion (e.g. channel-id vs channel-name normalization). |
| `src/shared/slack.ts` | Shared types + the pinned id arrays (`SLACK_TRIGGER_IDS`, `SLACK_ACTION_IDS`) and payload/context shapes (§6.3) — the pattern of `src/shared/shopify.ts`. Consumed by main and any renderer palette surface. |

### 4.3 Wiring into the merged registry + the engine

Two attach points, both additive, both already-existing seams:

- **Registry (actions + triggers).** Construct the `SlackConnector` (given the
  `CredentialStore`, config, and the active transport) and register it:
  `integrationRegistry.registerConnector('slack', slackConnector)`
  (`integration-registry.ts:53-56`). Its `invokeAction`/`subscribe` now serve the
  registry's pinned surface — identical to how `index.ts` registers Shopify.
- **Engine (the `ApprovalPort`).** Replace the stub `flowApprovals` at
  `index.ts:435` with the `SlackApprovalPort` **when Slack is `connected`**, else
  keep the safe-reject stub. Pass it as `new FlowEngine({ …, approvals })`
  (`index.ts:451`). The engine and gate-runner are **untouched** — they already take
  `approvals: ApprovalPort`. (§7.4 flags a composite that races Slack with the
  cockpit `ApproveButton` as the phased richer form; MVP is Slack-as-the-port.)

The pinned contract stays **byte-for-byte unchanged**; every Slack concern lives
under `src/main/slack/`.

### 4.4 Receiving inbound (Socket Mode default; Events API alternative)

- **Socket Mode (default, zero ingress).** `slack-socket.ts` opens the outbound WS
  (`apps.connections.open` with the app token) and receives every event, slash
  command, and interaction over it. **No public URL, no tunnel, no relay, no
  signature verification** — the socket is authenticated at open and Slack owns the
  channel. Each envelope is `ack`ed on the wire; the run/resolution happens after.
  This is the property no other connector has.
- **Events API (alternative, needs ingress).** When `mode: 'events'`,
  `slack-events-server.ts` consumes the **shared** `webhook-receiver.ts` configured
  with Slack's verifier:

  ```ts
  // Slack signing-secret verifier for the shared webhook-receiver.
  // Base string = "v0:{timestamp}:{rawBody}" ; header = "v0=" + hex(HMAC-SHA256).
  const slackVerifier: WebhookVerifier = {
    scheme: 'hmac',
    algo: 'sha256',
    header: 'X-Slack-Signature',
    encoding: 'hex',
    signsTimestamp: true,
    timestampHeader: 'X-Slack-Request-Timestamp',
    toleranceSec: 300
    // + Slack-specific: base prefix "v0:" and signature prefix "v0=".
    //   Named as the one Slack adaptation the shared receiver must carry
    //   (a basePrefix/sigPrefix field, or a connector-supplied pre-formatter).
  }
  ```

  It also answers Slack's one-time `url_verification` challenge and requires a
  **second** ingress URL for interactivity (button taps) — see §13.2. The receiver
  verifies over the **raw** body (a body-parser that consumes the stream first
  breaks HMAC — the receiver reads raw bytes), enforces `MAX_BODY_BYTES`, responds
  **200 fast**, and dedups on the Slack event/interaction id. A bad / oversized /
  forged / stale delivery is dropped and **never** seeds a run or resolves a gate.

Both modes normalize to the same `SlackInbound`, so `slack-connector.ts`,
`slack-approval-port.ts`, and `slack-control-bridge.ts` are transport-agnostic.

### 4.5 Reused localflow surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `resolveDescriptors`.
- `src/main/flow/types.ts` — the `ApprovalPort` / `ApprovalRequest` seam the
  approval adapter **implements** (the whole §3/§7 story).
- `src/main/flow/node-runners/gate-runner.ts` — the gate that calls
  `requestApproval` (unchanged; the adapter is what it now reaches).
- `src/main/flow/flow-engine.ts` — takes `approvals: ApprovalPort` (`:31`), routes
  on the gate boolean, ends a "no" as `rejected` cleanly (`:304-317`).
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the token
  store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError`
  (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector` (§4.3);
  `deriveStatus` gives Slack its status for free.
- `src/main/webhooks/webhook-receiver.ts` — the **shared** parameterized receiver +
  `WebhookVerifier`, consumed (not reimplemented) by the Events path (§4.4).
- `src/main/flow/trigger-subscriber.ts` — `coerceEvent` / `matchesFilter` the Slack
  `SeedEvent` flows through to start runs.
- `src/main/hook-server.ts` — the loopback receiver + `timingSafeEqual` pattern
  the shared receiver already generalizes (reference, not a new copy).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `slackDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as for the others —
no bespoke status logic (`integration-registry.ts:66-71,222-249`).

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary):

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `botToken` | Slack bot token | **yes** | yes | string | `xoxb-…`. The Web API caller (`chat:write`, …). Keychain only. |
| `appToken` | Slack app-level token | **yes** | no* | string | `xapp-…` (`connections:write`). Opens the Socket Mode WS. Required **when `mode: 'socket'`** (the default). Keychain only. |
| `signingSecret` | Signing secret | **yes** | no* | string | Verifies `X-Slack-Signature`. Required **when `mode: 'events'`**. Keychain only. |
| `defaultChannel` | Approvals / notify channel | no | yes | string | Channel id/name where approvals + notifications post by default (an action may override per-node). |
| `mode` | Ingress mode | no | no | string | `'socket'` (default) or `'events'`. Drives which secret + transport is required. |
| `environment` | localflow environment (1-9) | no | yes | number | Which env hosts Slack work (same field/validation as the others). |
| `eventsUrl` | Events request URL | no | no | string | The public ingress for `mode: 'events'` only. Placeholder `https://<tunnel>/slack/events`. |

*The two `no*` secrets are **conditionally required by `mode`**: `status()` treats
`appToken` as required under `socket` and `signingSecret` as required under
`events`. (`deriveStatus` today filters on the static `required` flag; the Slack
descriptor's `status()` note documents this mode-conditional requirement — an open
item is whether to encode it in the descriptor or a thin Slack-specific check,
§13.6.)

`status('slack')` reports `needs-config` until `botToken`, the mode-appropriate
secret, `defaultChannel`, and `environment` are present; `error` if a stored secret
can't be decrypted (the hub's `decryptionError` path); `disabled` if
configured-but-turned-off; `connected` otherwise. The action-runner refuses any
non-`connected` Slack node before any network call, and the `ApprovalPort` falls
back to the safe-reject stub unless Slack is `connected` (§4.1).

---

## 6. Pinned Slack vocabulary (verbatim)

> **This section is the contract.** The canvas palette and any flow-templates track
> read these ids and this payload shape verbatim. A snapshot test in
> `slack-descriptor.ts` guards the ids; the payload shape is guarded by the
> `slack-blocks.ts` parse tests.

### 6.0 Shared-union edit

`src/shared/integrations.ts` — `IntegrationId` gains `'slack'`:

```ts
export type IntegrationId = 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'slack'
```

Lockstep companion touch-points (each a one-line add): `INTEGRATION_IDS` (the
stable order array, `integrations.ts:71`), the flow validator's allow-list in
`flow-model.ts`, and `DESCRIPTOR_DEFS`. No other `IntegrationId` consumer changes —
they iterate the array.

### 6.1 Triggers

| trigger id | label | source | note |
|---|---|---|---|
| `message.received` | Message received | A Slack `message` event (Socket Mode or Events) in a channel the bot is in / mentioned in. | Wakes a flow on an inbound chat message (payload §6.3). The chat analog of the email trigger. |
| `slash.command` | Slash command | A **non-`/localflow`** slash command the app owns (e.g. a user-defined `/deploy`). | The reserved `/localflow` command is control (§4.2, `slack-control-bridge`), **not** this trigger. |
| `approval.responded` | Approval responded | An approval button was tapped (the `block_actions` interaction the `ApprovalPort` also consumes). | Fires **in addition** to resolving the gate — lets a flow log/notify on the decision. Payload carries `{ runId, nodeId, approved, decidedBy }`. |

### 6.2 Actions

**Send (flow-gated — every send is an `action` node the author places, and the
author may gate it):**

| action id | label | Slack Web API | writes to context |
|---|---|---|---|
| `postMessage` | Post a message | `chat.postMessage` (to `defaultChannel` or a `channel` param; optional `blocks`) | `{ channel, ts }` (the message ref, for later `replyInThread`) |
| `postApproval` | Post an approval and await | `chat.postMessage` (approval blocks) **then await the tap** | `{ approved: boolean; decidedBy?: string }` |
| `replyInThread` | Reply in a thread | `chat.postMessage(thread_ts:)` | `{ channel, ts }` |

`postApproval` is the **action-node form** of the same round-trip the
`ApprovalPort` runs for `gate` nodes: an author who wants an approval *inside* a
flow (not on a generic gate) drops a `postApproval` action; the connector posts and
**awaits the boolean**, resolving the node's context `{ approved }`. It shares the
pending-map + interaction routing with `slack-approval-port.ts` (§7). A denied
`postApproval` **resolves** `{ approved: false }` (a fact for routing) — it does not
reject; rejection is reserved for real failures (§6-failure-convention).

**Failure convention (pinned):** an action that fails **rejects** its promise with
the real Slack error text (`ok:false` `error` code, or transport error); a resolved
promise (any value) is success and its value becomes the node's context output
(`integrations.ts:33-43`, `action-runner.ts`). The connector never resolves a
sentinel-failure. (A denied approval is a *resolved boolean fact*, not a failure —
§7.3.)

### 6.3 Payload / context shapes (pinned)

```ts
// src/shared/slack.ts

/** message.received trigger payload (normalized from a Slack message event). */
export interface SlackMessagePayload {
  channel: string        // channel id, e.g. "C0123"
  user: string           // author user id, e.g. "U0123"
  text: string           // message text (mentions resolved to <@id> as Slack sends)
  ts: string             // message timestamp id (also the thread root if replied)
  threadTs?: string      // present when the message is in a thread
}

/** slash.command trigger payload (non-/localflow commands). */
export interface SlackSlashPayload {
  command: string        // e.g. "/deploy"
  text: string           // the args after the command
  channel: string
  user: string
  responseUrl: string    // Slack response_url for a delayed reply (short-lived)
}

/** approval.responded trigger payload + the ApprovalPort's internal decision. */
export interface SlackApprovalDecision {
  runId: string
  nodeId: string
  approved: boolean
  decidedBy: string      // the Slack user id who tapped
}
```

Normalization happens **once**, in `slack-blocks.ts` (pure), so conditions and
downstream nodes read a stable shape — the correctness boundary
(`slack-blocks.ts` parse tests guard it, §12).

---

## 7. The approval round-trip — data flow, node by node

**Scenario:** a Shopify refund worker reaches a gate the author placed before
`refundOrder`. The approver is at lunch with only a phone. (The connector under the
gate is irrelevant — email, cloud, Stripe all behave identically.)

```
[trigger: order.refundRequested]  → [action: getOrder] → [router: total > 50?]
                                                                │ (yes)
                                                                ▼
                                                    [gate: "approve refund"]
   gate-runner → approvals.requestApproval({ runId, nodeId, prompt, peek:[order summary] })
                                                                │
                                                                ▼
   SlackApprovalPort.requestApproval:
      chat.postMessage(defaultChannel, buildApprovalMessage(req))  → { channel, ts }
      pending.set("{runId}:{nodeId}", { resolve, messageRef, timer=setTimeout(→false) })
      return Promise<boolean>            ← run status becomes needs-you
                                                                │
                    user taps  Approve  on their phone         │
                                                                ▼
   interaction payload → transport (Socket Mode socket / interactivity URL) →
      slack-blocks.parseInteraction → { action:'approve', runId, nodeId, decidedBy }
      → pending.get(key):
           clearTimeout ; chat.update(messageRef, buildResolvedMessage(approved:true, @user))
           resolve(true) ; pending.delete(key)      (2nd tap → key gone → no-op)
      → also emit approval.responded trigger event
                                                                │
                                                                ▼
   gate-runner records { approved:true } → engine routes approve edge →
   [action: refundOrder] runs the real refund.   (Deny → resolve(false):
   engine ends the run 'rejected' cleanly — a human "no" is not a failure.)
```

Node-by-node against the engine:

1. **Gate reached.** `gate-runner` templates the prompt from context and calls
   `approvals.requestApproval` (`gate-runner.ts:25-27`). The run parks
   `needs-you` (`flow-engine.ts:342`). It **awaits** — no auto-proceed.
2. **Slack posts.** `SlackApprovalPort` builds the approval message (prompt + the
   `peek` lines Slack renders as context blocks) with Approve/Deny buttons whose
   `value` encodes `approve|deny:{runId}:{nodeId}`, posts via `chat.postMessage`,
   and parks the resolver + a timeout timer in the pending map.
3. **Tap arrives.** The transport delivers the `block_actions` interaction;
   `slack-blocks.parseInteraction` yields `{ action, runId, nodeId, decidedBy }`.
   The port looks up the pending resolver.
4. **Finalize (idempotent).** It `clearTimeout`s, `chat.update`s the message to a
   resolved, button-less card ("Approved by @user"), resolves the gate boolean, and
   deletes the entry. A second tap finds no entry → no-op (§7.2). It also emits the
   `approval.responded` trigger so a flow can log the decision.
5. **Engine routes.** `gate-runner` returns `{ approved }`; the engine routes the
   approve edge (runs the gated action) or, on `false` with no reject edge, ends the
   run **`rejected`** (`flow-engine.ts:304-317`) — clean stop, real reason surfaced.

### 7.1 Correlation
The pending-map key is `"{runId}:{nodeId}"`, embedded in the button `value`. This is
unforgeable-for-our-purposes (a random runId), survives reconnects (the map is
in-memory, keyed independent of the socket), and lets one Slack workspace service
many concurrent gates across many runs.

### 7.2 Idempotency & double-taps
Resolution deletes the pending entry **before** any await; a duplicate interaction
(double tap, redelivery, or a race between two approvers) finds no entry and is a
no-op. The `chat.update` also strips the buttons, so the surface is not tappable
twice under normal use.

### 7.3 Liveness / timeout (a "no" is not a failure)
Each pending approval carries a configurable timeout (`slack.approvalTimeoutSec`,
default e.g. 3600). On expiry the port `chat.update`s the message to "Expired — no
response" and **resolves `false`** — which the engine treats as a clean `rejected`
stop, exactly as a human "no". A worker never hangs forever on an unanswered gate.
(Whether the default is a timeout-to-deny vs leave-pending is flagged §13.4.)

### 7.4 Connector-agnostic + the phased composite
The port receives only `ApprovalRequest` — it never learns which connector's action
sits past the gate. **Therefore one wiring covers every gate.** MVP installs Slack
**as** the `ApprovalPort`. A **phased composite** (§13.4) races Slack against the
in-cockpit `ApproveButton`: whichever responds first wins, and the port retracts the
other surface (`chat.update` "Handled in the cockpit"). Designed-for; the pending-map
+ resolve-once structure already supports it (add a second responder that calls the
same `resolve`). Not built in MVP.

---

## 8. Auth & keychain

- **"For me" fork (MVP).** One Slack app created from a **manifest** and installed to
  the user's own workspace. It yields a **bot token** (`xoxb-…`), an **app-level
  token** (`xapp-…`, for Socket Mode), and a **signing secret** (for the Events
  path). The user pastes each into the descriptor's masked field; each goes straight
  to the keychain via `CredentialStore.set` (`credential-store.ts:61`).
  - The bot token is read at call time via
    `revealForConnector('slack','botToken')` and sent as the `Authorization:
    Bearer` header on every Web API request (main-process-only, the sole plaintext
    exit; a grep test asserts no IPC/renderer caller — `credential-store.ts:94-105`).
  - The app token is read once to open the Socket Mode WS.
  - The signing secret is used only inside the Events path to verify
    `X-Slack-Signature` (Socket Mode needs it not at all).
- **Honoring the global secret rule.** None of the three tokens is **ever** written
  to `config.json`, `sessions.json`, the transcript, a log, a PR body, or any IPC
  payload. `config.json` holds only **references** (default channel, mode, ingress
  url, that an install exists — §5). Token **state** (present / decrypt-failing) may
  be surfaced via `status()`; the **value** never is. This is the hub's existing
  discipline (`integration-config.ts` drops a secret found in config.json with a
  loud notice) applied to Slack verbatim.
- **"Product" fork (deferred, §13.3).** A distributable app uses **OAuth v2** to
  mint per-workspace bot tokens (multi-workspace, `workspaces[]` config). The
  keychain shape already supports per-key storage; the additive change is a
  `slack-oauth.ts` module and a workspace array. Same `Bearer` at call time — only
  *acquisition* and *multi-tenant isolation* differ.
- **Disconnect.** Clearing the tokens (the hub's `clearSecret`) flips `status()` to
  `needs-config`; the connector stops dispatching, the Socket Mode WS is closed, and
  the `ApprovalPort` reverts to the safe-reject stub (so any in-flight gate cleanly
  stops rather than hanging). No in-flight run is force-killed — it simply can't post
  or resolve a new Slack approval, and reports why (§11).

---

## 9. Authority & safety

**Primary control — the flow's gates (already enforced), now remotely answerable.**
Every Slack send (`postMessage`, `postApproval`, `replyInThread`) is an `action`
node the author places and may gate. The connector **never** posts or mutates
outside the graph the author drew — there is no "connector default" that messages on
its own. And the *headline* is the inverse direction: the `ApprovalPort` makes the
engine's existing gates **answerable from Slack**, which strengthens safety
everywhere (a human can now approve/deny a `cloud apply` or a refund from their
phone instead of the gate silently rejecting).

**Never render secrets.** The three tokens live in the keychain; no error message,
log line, posted message, `peek`, or context field ever contains one (§8, §11). A
`peek` shown in an approval message is the flow author's content (an order summary,
a diff) — the connector renders it as Block Kit context but performs no secret
substitution.

**Approver trust (MVP → phase 2).** MVP trusts any member of the approval channel to
tap. A per-gate approver allow-list (only certain Slack user ids may resolve a given
gate; others' taps are rejected with an ephemeral "not an approver") is phase 2
(§13.5) — the interaction payload already carries `decidedBy` to enforce it.

**Control-surface authority.** `/localflow run|status|stop` (§4.2) can start and stop
runs. It is gated by workspace membership (only the installed workspace can reach the
app) and — as a phased item — the same approver allow-list. `run` starts a flow the
user already authored; `stop` requests a stop (never force-kills mid-action). The
bridge carries a **narrow** engine seam (start/query/stop), not arbitrary engine
access.

---

## 10. Discord — the same-slot analog (named, not designed)

Discord occupies the **same connector slot** as Slack: a persistent-gateway chat
platform with an outbound WebSocket (the Gateway — the Socket-Mode analog, also
zero-ingress), interactive components (buttons → the same approval round-trip), and
slash commands (the same control surface). A future `src/main/discord/` peer reuses
this spec's module boundaries (`*-connector` / `*-client` / `*-socket` /
`*-approval-port` / `*-blocks`) and the **same** `ApprovalPort` seam — the adapter is
already connector-agnostic, so Discord would supply a *second* real `ApprovalPort`
implementation with no engine change. **This spec does not design Discord**; it only
notes the boundaries are chat-platform-shaped so the peer is additive. Slack first for
the widest business install base, first-class Socket Mode, and Block Kit
interactivity.

---

## 11. Error handling

localflow's principle (error-message-style memory; demonstrated in
`credential-store.ts` and `action-runner.ts`): **every failure is human-readable,
actionable, and carries the real underlying exception. No silent catch. No bare
"failed" / "not found".** An action signals failure by **rejecting** with that
message; the action-runner prefixes it and surfaces it on the run.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Bot token invalid/revoked** (`invalid_auth` / `token_revoked`) | Slack's `ok:false` error code | `invokeAction` **rejects**: "Slack rejected the bot token (`invalid_auth`) — it was revoked or is wrong; re-enter it in Settings." Value never included. |
| **Missing scope** (`missing_scope`) | the verbatim required scope | Rejects: "Slack refused `chat.postMessage`: the app is missing the `chat:write` scope — add it in the app config and reinstall." |
| **Channel not found / not in channel** (`channel_not_found` / `not_in_channel`) | the channel ref | Rejects: "Slack can't post to '<channel>' — the bot isn't a member; `/invite` the bot or pick another channel." |
| **Rate limited** (`429`) | `Retry-After` seconds | `slack-client` retries with backoff honoring `Retry-After`; only after exhausting retries does it reject: "Slack throttled posting (retry in ~Ns)." Not swallowed. |
| **Socket Mode disconnect / refresh** | the disconnect reason | `slack-socket` transparently reconnects (new `apps.connections.open`); no run/gate is lost (pending map is independent of the socket). A **hard**, repeated failure surfaces loudly: "Slack Socket Mode can't stay connected (<reason>) — approvals won't arrive." Never a silent dead socket. |
| **Signature invalid** (Events mode) | signature mismatch (never the body or secret) | Receiver drops with reason only; 401; **no run started, no gate resolved.** Mirrors "never log token material". |
| **Stale / replayed request** (Events mode, ts outside 5-min) | the timestamp skew | 401; dropped; never resolves a gate (guards interaction replay). |
| **Duplicate interaction / redelivery** | the interaction id | Idempotent no-op (§7.2) — the pending entry is already gone; no second resolve, no second action. |
| **Approval timeout** (no tap before `approvalTimeoutSec`) | the elapsed time | Not an error: the port `chat.update`s "Expired" and **resolves `false`** → the run ends `rejected` cleanly (§7.3). Surfaced on the feed, not as a failure. |
| **Interaction for an unknown/stale gate** (run already finished, or app restarted losing the in-memory map) | the key that missed | The port `chat.update`s "This approval is no longer active (the run has ended or localflow restarted)." and drops the tap. No phantom resolve. |
| **`status('slack') !== 'connected'`** | the derived reason (missing token / decrypt error / disabled / wrong-mode secret) | The action-runner fails the Slack node *before* any call: "Flow needs Slack connected — action '<id>' can't run. Connect it in Settings." And the `ApprovalPort` uses the safe-reject stub so gates stop cleanly (§4.1). |
| **`/localflow` control error** (unknown flow, bad run id) | the name/id that missed | The bridge replies **ephemerally** in Slack: "No flow named '<x>' — try `/localflow status` to list runs." Never a silent drop. |

The connector **never** catches-and-drops. Where Slack returns a precise `error`
code, the connector forwards *that* rather than minting a vaguer one — the
action-runner's job is only to prefix it with the node/action.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Slack workspace**, matching localflow's existing seams
(pure modules, injected backends, fixture payloads):

- **`SlackApi` interface + `MockSlackApi` seam.** `slack-client.ts` is written
  *against* a `SlackApi` interface (`postMessage`, `updateMessage`, `openConnection`,
  …); the real impl wraps the HTTP transport. Tests inject a `MockSlackApi` returning
  canned `ok:true` / `ok:false` (`missing_scope`, `channel_not_found`) / `429`
  envelopes. **No test performs a live Slack call**; CI has no Slack credentials.
  (Same posture as the Shopify `MockShopifyApi` / the `SessionManager` `spawnFn`.)
- **`SocketTransport` mock.** `slack-socket.ts` is behind a `SocketTransport`
  interface; a `MockSocketTransport` **emits** scripted `events_api` /
  `slash_commands` / `interactive` envelopes and records `ack`s. Tests drive inbound
  Slack traffic with zero network — including a `disconnect` frame to assert
  transparent reconnect.
- **The `ApprovalPort` adapter against a mock `ApprovalPort` consumer (the headline
  test).** Drive `SlackApprovalPort.requestApproval(req)` (with a `MockSlackApi`),
  then feed a scripted **Approve** interaction → assert the promise resolves `true`,
  `chat.update` was called with a resolved/button-less message, and
  `approval.responded` was emitted. Repeat for **Deny** → `false`. Assert **timeout**
  → resolves `false` (deterministic via an injected timer/`now()`). Assert a
  **second** tap is a no-op (idempotency). Assert an interaction for an **unknown
  key** is dropped with the "no longer active" update. This is the correctness core,
  so it is guarded hardest.
- **`slack-blocks.ts` unit tests** — pure builders + parse: assert
  `buildApprovalMessage(req)` encodes `"{runId}:{nodeId}"` in the button value; assert
  `parseInteraction` round-trips it back to `{ action, runId, nodeId, decidedBy }`;
  assert message/slash event parsing → the pinned §6.3 shapes; assert a malformed
  payload yields `null` (never a throw, never a partial resolve).
- **Events-path verification test** — feed the shared `webhook-receiver` (configured
  with `slackVerifier`) fixture bodies with **valid and invalid `X-Slack-Signature`**,
  a **stale timestamp** (outside 5 min), an oversized body, and the `url_verification`
  challenge; assert 200/401/challenge-echo and that only valid+signed+fresh payloads
  produce a `SlackInbound`. (Exercises the consumed shared infra, not a reimplementation.)
- **Engine integration test (offline)** — wire the real `FlowEngine` with
  `SlackApprovalPort` (over a `MockSlackApi` + `MockSocketTransport`), drive a flow to
  a `gate`: assert the run parks `needs-you`, inject an **Approve** interaction, assert
  the gate records `{ approved:true }` and the approve edge runs; repeat with **Deny**
  → assert the run ends `rejected` cleanly. Deterministic via the engine's injected
  `now()` (`flow-engine.ts:34`).
- **`/localflow` control-bridge test** — with a fake engine seam: assert
  `run <flow>` starts a run, `status` lists snapshots, `stop <run>` requests a stop,
  and an unknown flow yields the ephemeral legible error.
- **Token-store test** — `revealForConnector` round-trip via a fake `SecretBackend`;
  a regression guard asserts **no token value** appears in any emitted
  log/console/error/posted-message string (the secret rule).
- **Snapshot test on `slackDescriptor`** — pins the trigger/action ids the palette
  consumes; a change is a deliberate, reviewed contract edit.

No test requires Slack credentials or a live workspace; the real APIs are exercised
only in manual dogfooding against a development workspace.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **Socket Mode vs Events API as the shipped default.** **Recommendation: Socket
   Mode**, for the local/self-host tier — it is the *only* zero-ingress trigger path
   any connector has, which is a decisive fit for a local-first desktop app behind
   NAT. Events API is spec'd (§4.4) for users who already run HTTPS ingress or a
   hosted relay (and is the likely path for the product fork). The `mode` config
   field selects; the connector supports both, transport-agnostic downstream.
2. **Interaction-URL ingress for buttons (Events mode).** In Socket Mode, button
   taps arrive over the **same outbound socket** — zero ingress. In Events mode,
   Slack posts interactions to a **separate Interactivity Request URL** that must be
   public — so Events mode needs **two** ingress URLs (events + interactivity), or a
   relay that serves both. This asymmetry is a strong second reason Socket Mode is
   the default; flagged so the Events path owner sizes the ingress correctly.
3. **"For me" vs "a product others install."** The biggest fork.
   - *For me* (MVP): one manifest-installed app in the user's own workspace, three
     tokens in the keychain, Socket Mode (no ingress). Fastest to a dogfoodable
     remote-approval surface.
   - *Product*: a distributable **OAuth v2** app (Slack app directory listing,
     per-workspace install, `workspaces[]` config, per-workspace token isolation, and
     — for Events mode — a hosted relay). Changes auth (OAuth), config (multi-workspace),
     and testing (multi-tenant). Recommendation: build MVP "for me", keep the
     token/config shapes workspace-ready (they already are — §8).
4. **Composite/racing approval + timeout default.** Two coupled calls: (a) MVP wires
   Slack **as** the sole `ApprovalPort`; a phased **composite** races it with the
   in-cockpit `ApproveButton` (first responder wins, other surface retracted — §7.4).
   Is the composite worth building before the cockpit `ApproveButton` UI even lands?
   (b) The approval **timeout** default — timeout-to-deny (clean stop) vs
   leave-pending-forever vs a per-gate override. Both are product-safety calls;
   whatever is chosen, an unanswered gate must **never hang a worker** (§7.3).
5. **Per-approver authorization.** MVP trusts any channel member to tap. An allow-list
   (only certain Slack user ids may resolve a given gate / drive `/localflow`) is a
   phase-2 safety upgrade; the `decidedBy` field is already carried to enforce it.
   Flagged because the *default* (open vs restricted) is a product-security call.
6. **Encoding the mode-conditional secret requirement.** `appToken` (socket) vs
   `signingSecret` (events) are conditionally required by `mode` (§5). Options:
   encode conditional-required in the descriptor (a schema change touching every
   connector), or keep the static `required:false` and add a thin Slack-specific
   check inside `deriveStatus`/the connector's readiness probe. Leaning the latter
   (localized to Slack) so the shared hub schema is untouched.

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One workspace, Socket Mode, the approval round-trip end-to-end:**

1. `IntegrationId` gains `'slack'` (+ the lockstep touch-points, §6.0);
   `slackDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `botToken` + `appToken` + `defaultChannel` stored (tokens → keychain);
   `status('slack') === 'connected'`.
3. `slack-socket.ts` opens the Socket Mode WS behind a `SocketTransport`;
   `slack-client.ts` behind `SlackApi` does `chat.postMessage` + `chat.update`.
4. `slack-approval-port.ts` implements `ApprovalPort`: post approval blocks →
   park resolver → an Approve/Deny tap resolves `true`/`false`, updates the message,
   idempotent, with a timeout→`false`. Registered into the `FlowEngine` in place of
   the stub when Slack is `connected` (§4.3).
5. On the canvas: **any** flow with a `gate` — reuse the Shopify refund flow — now
   pauses `needs-you`, posts to Slack, and resolves on a phone tap. `refundOrder`
   runs on Approve; the run ends `rejected` on Deny. Errors per §11.

That slice proves the headline (a real worker's gate is approved from a phone with
**no ingress**) against a development workspace, and it already benefits **every**
connector's gates, not just Slack's own actions.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton — Socket Mode, the `ApprovalPort` adapter,
  `postMessage`. "For me" fork. Single workspace, single environment.
- **Phase 2 — full vocabulary + control:** `postApproval` / `replyInThread` actions;
  `message.received` / `slash.command` / `approval.responded` triggers; the
  `/localflow run|status|stop` control bridge; per-approver allow-list (§13.5).
- **Phase 3 — Events API path:** `slack-events-server.ts` on the shared
  `webhook-receiver` with `slackVerifier`, the interactivity URL, `url_verification`
  — for the HTTPS-ingress tier (§13.1, §13.2).
- **Phase 4 — composite approval:** race Slack with the in-cockpit `ApproveButton`
  (first responder wins, other surface retracted — §7.4, §13.4), once the cockpit
  `ApproveButton` UI lands.
- **Phase 5 — product fork:** distributable OAuth v2 app, `workspaces[]` multi-workspace
  isolation, a hosted relay for Events mode (§13.3). App-directory viability.
- **Phase 6 — Discord peer:** a `src/main/discord/` connector reusing this spec's
  boundaries and the connector-agnostic `ApprovalPort` seam — a second real approval
  surface with no engine change (§10).

---

## Appendix — reused localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `resolveDescriptors`.
- `src/main/flow/types.ts` — the `ApprovalPort` / `ApprovalRequest` seam the approval
  adapter **implements** (the headline, §3/§7).
- `src/main/flow/node-runners/gate-runner.ts` — the gate that calls `requestApproval`
  (unchanged; the adapter is what it now reaches).
- `src/main/flow/flow-engine.ts` — takes `approvals: ApprovalPort` (`:31`), routes on
  the gate boolean, ends a "no" as `rejected` cleanly (`:304-317`); injected `now()`
  for deterministic tests.
- `src/main/index.ts` — where the stub `ApprovalPort` (`:435`) is replaced by
  `SlackApprovalPort` when Slack is `connected`, and where the connector is
  `registerConnector('slack', …)`'d.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the token
  store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError`
  (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector`
  (`:53-56`); `deriveStatus` gives Slack its status for free.
- `src/main/webhooks/webhook-receiver.ts` — the **shared** parameterized receiver +
  `WebhookVerifier`, **consumed** by the Events path (§4.4) with `slackVerifier`.
- `src/main/flow/trigger-subscriber.ts` — `coerceEvent` / `matchesFilter` the Slack
  `SeedEvent` flows through to seed runs.
- `src/main/hook-server.ts` — the loopback receiver + `timingSafeEqual` pattern the
  shared receiver generalizes (reference).
- `src/main/shopify/` — the newest full connector this spec copies for module shape
  (`*-connector` / `*-client` / token store / config / normalize) and depth.
</content>
</invoke>
