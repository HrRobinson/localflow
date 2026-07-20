# Discord Connector — Design

**Date:** 2026-07-20
**Status:** Design (spec) — not started. Design-approval gate for a **second
remote approval + notification + control surface**, aimed at the
indie / community / OSS tier where Discord — not Slack — is the room everyone is
already in. The Slack-analog: the same connector slot, filled by the second
chat platform, supplying localflow's **second** real `ApprovalPort`.
**Feature:** A **Discord connector** that plugs into the merged flow-builder
(integration registry + hybrid flow engine + drag-drop canvas) as an
`IntegrationDescriptor`, **and** — like Slack — supplies an `ApprovalPort`. A
worker hits a gate → the connector posts a message with Approve / Deny **buttons
(message components)** → the user taps (on their phone) → the tap resolves
`ApprovalPort.requestApproval(req): Promise<boolean>` `true`/`false` → the gated
action runs or the run cleanly stops. It also **notifies** (`postMessage`), lets
a run **converse** (`replyInThread`), and exposes a **control surface**
(`/localflow run|status|stop`) to seed and query flow runs from a Discord server.

This connector satisfies the **pinned** `IntegrationDescriptor` /
`IntegrationRegistry` / `LiveConnector` contract in `src/shared/integrations.ts`
and is a **near-exact peer of the merged Slack connector** under
`src/main/slack/` — same module shape (`*-connector` / `*-client` /
`*-gateway`(socket) / `*-approval-port` / `*-components`(blocks) / token store /
config / descriptor), the same `ApprovalPort` seam, the same failure convention.
It reuses the **Slack connector spec** as its style and depth template
(`docs/superpowers/specs/2026-07-18-slack-connector-design.md`, whose §10 named
Discord as "the same-slot analog"). **This spec is that peer, designed.**

**A note on scope and unique value.** As with Slack, the other connectors
(Shopify, Linear, email, cloud) are *vertical capability* connectors. Discord is
the second **cross-cutting control connector**: its most important export is not
"a Discord action" but the **second `ApprovalPort` adapter (§3, §7)** — built
against the *same* connector-agnostic seam Slack already fills, with **no engine
change**. Slack shipped first (widest business install base). Discord is the
right second surface: for the indie / community / self-host user, Discord *is*
the phone-in-your-pocket approval room. Wiring it makes *any* gate in *any* flow
approvable from Discord exactly as Slack made it approvable from Slack.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a localflow user approve or deny any worker's gate
from Discord on their phone, receive run notifications and converse with a run in
a thread, and drive runs with `/localflow run|status|stop` — with the **bot
token** in the OS keychain, **never** rendered, every send/mutation flowing
through the flow engine's gates, and **zero public ingress** (the Gateway, the
Socket-Mode analog).

### In scope (MVP)

- A new **Discord connector** module set under `src/main/discord/`, exposing a
  static `discordDescriptor` (`IntegrationDescriptorDef`) added to
  `DESCRIPTOR_DEFS`, plus the **live dispatch** (`invokeAction` / `subscribe`)
  registered via `registry.registerConnector('discord', …)` (the seam Slack and
  Shopify already use — `integration-registry.ts:54`).
- **The `ApprovalPort` adapter (`discord-approval-port.ts`)** — the headline.
  localflow's **second** real `ApprovalPort`, a byte-for-byte peer of
  `SlackApprovalPort` against the same `flow/types.ts` seam. It posts an approval
  message with Approve/Deny **buttons**, awaits a tap, and resolves
  `requestApproval` `true`/`false`. **Connector-agnostic** — it services every
  gate in every flow (§3, §7). Selected as the engine's `ApprovalPort` when
  Discord is connected and Slack is not (or per config — §4.3, §13.2).
- **A Gateway client (`discord-gateway.ts`)** — a persistent **outbound**
  WebSocket (opened after `GET /gateway/bot`, authenticated by an `IDENTIFY` op
  carrying the bot token + intents) that carries message events **and
  `INTERACTION_CREATE` (button + slash) payloads** with **no public ingress**.
  This is Discord's Socket-Mode analog and the recommended default — the same
  zero-ingress advantage that made Slack the highest-leverage connector (§2, §4.4).
- **An HTTP Interactions path (`discord-interactions-server.ts`)** — the
  alternative for users who prefer HTTP ingress, built on the **shared webhook
  receiver** (`src/main/webhooks/webhook-receiver.ts`). **Crucial difference from
  Slack:** Discord's Interactions Endpoint is **Ed25519**-signed, not HMAC — the
  shared receiver is `hmac`/`token` only, so this path needs a new **`ed25519`
  verifier scheme** (§2.3, §4.4, §13.7). Spec'd, **not** the default; the Gateway
  path avoids it entirely.
- **A REST client (`discord-client.ts`)** — the **sole** place any Discord API
  shape lives: `POST /channels/{id}/messages`, `PATCH …/messages/{id}`, the
  interaction-callback (`POST /interactions/{id}/{token}/callback`), command
  registration, and the `{ code, message }` error envelope. Isolated behind a
  `DiscordApi` interface so tests inject a `MockDiscordApi` (§12).
- **The pinned Discord vocabulary (§6):** three triggers (`message.received`,
  `interaction`, `approval.responded`), three actions (`postMessage`,
  `postApproval`, `replyInThread`), and the trigger/context payload shapes.
- **The control surface:** the reserved **`/localflow run|status|stop`** slash
  command (`discord-control-bridge.ts`) seeds/queries/stops flow runs against the
  engine — the *same* `EngineControlSeam` Slack's bridge uses (§4.2).
- **Single guild (server), single localflow environment.** Config-as-code
  `discord` block in `config.json` (non-secret refs only); the **one** secret
  (bot token) in the keychain.

### Out of scope (MVP) — explicitly deferred

- **HTTP Interactions endpoint + the Ed25519 verifier scheme.** MVP is
  Gateway-only (zero ingress, no signature verification). The `ed25519` scheme is
  a **shared-receiver extension** (§4.4, §13.7); the HTTP path lands with the
  ingress tier (§14, Phase 3). Also: the HTTP Interactions endpoint carries
  *only* interactions — **message events still require the Gateway** — so that
  path would run *both*, a strong second reason to ship Gateway-only (§13.1).
- **Distributable / public app OAuth install** (Discord "Add to Server" flow,
  per-guild install, multi-guild token isolation). MVP is the **"for me" fork** —
  one bot invited to one server, its token in the keychain (§8, §13.5).
- **Composite / racing approval surfaces across Slack *and* Discord.** MVP wires
  **one** `ApprovalPort` (Slack *or* Discord, selected at startup — §4.3). Racing
  both (first responder wins, the other message retracted) is designed-for but
  phased (§7.4, §13.2).
- **Rich component surfaces** beyond Approve/Deny buttons + notify + thread
  reply: modals, select menus, context menus, autocomplete. Phase 2+.
- **The privileged Message Content intent gate.** `message.received` needs the
  **Message Content** privileged intent (§2.3, §13.3); MVP ships the trigger but
  documents the Developer-Portal toggle, and the connector degrades legibly when
  the intent is absent rather than silently receiving empty text.
- **Per-user approver authorization** (only certain Discord users may resolve a
  gate). MVP trusts any member who can see the approval channel; an allow-list is
  phase 2 (`decidedBy` is already carried — §9, §13.6).

---

## 2. Feasibility + landscape (DONE — summarized)

Feasibility is complete; the verdict is **GREEN**. Both ingress modes and the
approval round-trip are buildable today on GA Discord APIs (Gateway v10, REST
v10, message components, application commands).

### 2.1 Two ingress modes — the defining choice (mirrors Slack §2.1)

| Mode | How events/interactions arrive | Ingress needed? | Signatures | Verdict |
|---|---|---|---|---|
| **Gateway** (Socket-Mode analog) | The bot opens an **outbound** WSS (`GET /gateway/bot` → `IDENTIFY` with the bot token + intents). `MESSAGE_CREATE` events **and** `INTERACTION_CREATE` (button + slash) dispatches all arrive over that socket. The bot **acks each interaction** with a REST interaction-callback (`POST /interactions/{id}/{token}/callback`, ≤3s). | **None.** Pure outbound — dodges NAT/tunnels/relays. | **None** — the socket is authenticated at `IDENTIFY`. | **Chosen default** for the local / self-host tier. |
| **HTTP Interactions** | Discord **HTTP POSTs** interactions to a configured public **Interactions Endpoint URL**, each signed **Ed25519** (`X-Signature-Ed25519` + `X-Signature-Timestamp`, verified against the app **public key**). **Message events do NOT come here** — they still require the Gateway. | **Yes** — a public URL, and **still the Gateway** for messages. | **Ed25519** (asymmetric; a *public* key, not a shared secret). | Spec'd (§4.4); needs the shared-receiver `ed25519` extension (§13.7). |

**Why the Gateway is the recommended default.** Same reason as Slack Socket Mode
— localflow is a **local-first desktop app** behind NAT (the dev-machine memory:
an 8 GB Apple-silicon Mac). The Gateway gives a fully local, zero-ingress event +
interaction path and **needs no signature verification at all**. It is *also* the
only path that carries `message.received`; the HTTP Interactions endpoint would
have to run *alongside* the Gateway, never instead of it (§13.1). Gateway-only is
both the cheapest to run and the simplest to secure.

### 2.2 The approval round-trip is GA

- **Post** a message with an `actions` component row (Approve / Deny buttons,
  `style: SUCCESS`/`DANGER`) via `POST /channels/{id}/messages`. Peek lines
  render as an **embed** (the Block-Kit-context analog).
- **Receive** the button tap as an `INTERACTION_CREATE` (component interaction) —
  over the Gateway (no ingress) or the Interactions Endpoint (HTTP mode).
- **Correlate** the tap to the waiting gate via the button **`custom_id`** (we
  embed `lf:approve|deny:{runId}:{nodeId}`; `custom_id` allows 100 chars — ample).
- **Finalize + ack in one call** by responding to the interaction with an
  `UPDATE_MESSAGE` callback (type 7) that strips the buttons and stamps
  "Approved by @user" / "Denied by @user" — this both satisfies Discord's ≤3s ack
  requirement **and** edits the surface so it is not tappable twice. (The
  timeout/expiry path, with no live interaction, edits via REST `PATCH` instead.)

All GA, all documented. Nothing is preview-gated.

### 2.3 Constraints (why not GREEN-with-zero-caveats)

1. **Ed25519, not HMAC (HTTP mode only).** Discord's Interactions Endpoint is
   verified with the application's **Ed25519 public key** over
   `timestamp + rawBody` — an *asymmetric* scheme. The shared `WebhookVerifier`
   (`webhook-receiver.ts`) is a union of **only** `scheme: 'hmac'` and
   `scheme: 'token'` — both symmetric-secret schemes. So the HTTP path requires a
   **new `scheme: 'ed25519'`** variant carrying a *public* key (not a secret) and
   an Ed25519-verify over `timestamp+body`, plus answering Discord's `PING`
   (type 1) with a `PONG` (the `url_verification` analog). Named honestly as a
   **shared-receiver extension** (§4.4, §13.7) so the shared-infra owner sizes it.
   **The Gateway path needs none of this** — the socket is authenticated at
   `IDENTIFY`. This is the single biggest divergence from Slack, and the strongest
   reason to ship Gateway-only for MVP.
2. **The Message Content privileged intent.** To receive the *text* of a
   `message.received` event, Discord requires the **Message Content** privileged
   intent (Developer-Portal toggle + requested in `IDENTIFY`; Discord verification
   required past 100 servers). Without it, message events arrive with **empty
   content**. MVP documents the toggle and the connector surfaces a legible notice
   rather than silently waking flows on blank text (§11, §13.3). Approvals and
   slash commands do **not** need it.
3. **Approval liveness.** Identical to Slack §2.3.2: a posted gate awaits a human;
   a configurable **timeout resolves `false` (clean stop)** so a worker never
   hangs. A design requirement, not a capability gap (§7.3).
4. **Gateway lifecycle + rate limits.** The Gateway sends `HELLO` with a
   `heartbeat_interval`; the client must heartbeat (op 1) or be disconnected, and
   `RESUME` (session id + last sequence) after a drop. REST is per-route
   rate-limited (`429` + `retry_after`, plus a global limit). Both are handled in
   the gateway/client modules (§11) — operational, not blocking. (Discord's
   heartbeat + RESUME is modestly more involved than Slack's disconnect-and-reopen;
   still standard.)

### 2.4 Verdict: **GREEN.** The approval round-trip, both ingress modes, and the
control surface are all GA. The Gateway makes it — like Slack Socket Mode — a
zero-ingress trigger path. The four constraints are the Ed25519 HTTP-path
divergence (sidestepped by the Gateway), one privileged-intent toggle for message
text, a liveness timeout the engine already models, and standard
heartbeat/RESUME/rate-limit handling.

---

## 3. The unique value: a SECOND `ApprovalPort` against the same seam

localflow's gate seam is already pinned (`src/main/flow/types.ts`), and Slack
already supplied the **first** real implementation:

```ts
export interface ApprovalRequest { runId: string; nodeId: string; prompt: string; peek: string[] }
export interface ApprovalPort { requestApproval(req: ApprovalRequest): Promise<boolean> }
```

The engine takes exactly one `approvals: ApprovalPort` (`flow-engine.ts`), chosen
at startup in `index.ts`: today it is `SlackApprovalPort` when Slack is connected,
else the always-`false` safe-reject stub. **The Discord connector supplies a
second implementation** — `DiscordApprovalPort` — selected when Discord is
connected and Slack is not (or per config, §4.3). The seam requires **no change to
the gate, the gate-runner, or the engine**:

- The `gate-runner` calls `deps.approvals.requestApproval({ runId, nodeId, prompt,
  peek })` and records the boolean. It "NEVER auto-proceeds: it always awaits the
  port."
- The `FlowEngine` routes on the boolean — `true` → approve edge; `false` with no
  reject edge → the run ends **`rejected`** cleanly, a human "no", **not a
  failure**.

So `DiscordApprovalPort`, exactly like `SlackApprovalPort`, is **not a
Discord-specific gate** — it is a drop-in `ApprovalPort` that happens to render
its question in Discord. Because *every* gate goes through this one seam, wiring
Discord once makes **every** connector's gated action — email send, `cloud
apply`, Stripe refund, Shopify `refundOrder` — approvable from Discord. **This is
the payoff of the Slack spec's connector-agnostic design: the second surface is
purely additive, no engine change, because the port never learns which
connector's action sits past the gate.**

**Data-flow sketch** (full node-by-node in §7):

```
worker run reaches a [gate] node
   │  gate-runner → approvals.requestApproval({ runId, nodeId, prompt, peek })
   ▼
DiscordApprovalPort.requestApproval(req):
   1. build an approval message (prompt + peek embed, Approve/Deny buttons,
      button custom_id = "lf:approve|deny:{runId}:{nodeId}")
   2. POST /channels/{channel}/messages → messageRef (channelId + messageId)
   3. store a pending resolver in a Map keyed by "{runId}:{nodeId}"
   4. return the Promise  (the gate awaits; run status → needs-you)
   ▼
user taps Approve on their phone
   ▼
INTERACTION_CREATE arrives (Gateway, or the Interactions Endpoint in HTTP mode)
   → correlate custom_id → look up pending resolver
   → respond UPDATE_MESSAGE (type 7): "Approved by @user", components removed
     (this ALSO acks the interaction within 3s — one call)
   → resolve(true)           (idempotent: a second tap is a no-op)
   ▼
gate-runner records { approved: true } → engine routes the approve edge →
the gated action runs. (Deny → resolve(false) → clean rejected stop.)
```

---

## 4. Architecture in localflow

### 4.1 Where it sits

A new **main-process module set** under `src/main/discord/`, a peer of
`src/main/slack/`. It is **opt-in**: with no `discord` config entry (and no stored
bot token) the descriptor's `status()` returns `needs-config`, the engine refuses
any Discord node (`action-runner.ts`), and — critically — if Discord is *not* the
selected approval surface, the engine's `ApprovalPort` is unchanged (Slack's, or
the safe-reject stub) so a gate still stops cleanly rather than hanging.
localflow's "works with no integration" guarantee is unchanged.

Architecturally the connector is **the live implementation behind the registry's
pinned `invokeAction`/`subscribe`** (registered via
`registerConnector('discord',…)`) **plus** an optional `ApprovalPort`
construction wired into the `FlowEngine` at startup (§4.3). All Discord API shapes
are isolated in `discord-client.ts` (the blast radius for any API change).

### 4.2 New modules (named — peers of the Slack set)

| Module | Slack peer | Responsibility |
|---|---|---|
| `src/main/discord/discord-descriptor.ts` | `slack-descriptor.ts` | The static `IntegrationDescriptorDef` (`id: 'discord'`, config fields, the pinned triggers/actions of §6). Added to `DESCRIPTOR_DEFS`. A snapshot test guards the ids. |
| `src/main/discord/discord-connector.ts` | `slack-connector.ts` | The `LiveConnector`. Dispatches an action id → a `discord-client` call; a trigger id → a subscription over the active transport (Gateway or HTTP). Holds an `ApprovalMechanism` for `postApproval` + interaction routing; sources `approval.responded` from the port's decisions. The one place action/trigger dispatch lives. Holds NO API shape, NO secret. |
| `src/main/discord/discord-client.ts` | `slack-client.ts` | Thin **REST** client. **All** Discord request/response shapes live *only* here: `POST /channels/{id}/messages`, `PATCH …/messages/{id}` (edit), `POST /interactions/{id}/{token}/callback` (ack + update), `PUT /applications/{app}/…/commands` (register `/localflow`), `GET /gateway/bot`, and the `{ code, message }` error envelope. `Authorization: Bot <token>`. Per-route `429`/`retry_after` backoff. Behind a `DiscordApi` interface so tests inject `MockDiscordApi` (§12). |
| `src/main/discord/discord-gateway.ts` | `slack-socket.ts` | **Gateway** client (Socket-Mode analog). Opens the outbound WSS, sends `IDENTIFY` (bot token + intents), heartbeats on the `HELLO` interval, `RESUME`s after a drop, and emits normalized `DiscordInbound` for `MESSAGE_CREATE` / `INTERACTION_CREATE`. **No signature verification** — authenticated at `IDENTIFY`. Behind a `GatewayTransport` interface for a `MockGatewayTransport` (§12). |
| `src/main/discord/discord-interactions-server.ts` | `slack-events-server.ts` | The **HTTP Interactions** path (alt to the Gateway). Consumes the **shared** `webhook-receiver.ts` configured with a **`discordVerifier` (`scheme: 'ed25519'` — the shared-receiver extension, §4.4/§13.7)**; answers Discord's `PING` (type 1) with a `PONG`; emits the same normalized `DiscordInbound`. Only mounted when `mode: 'http'`. **Message events still need the Gateway** (§13.1). |
| `src/main/discord/discord-approval-port.ts` | `slack-approval-port.ts` | **The headline.** localflow's **second** `ApprovalPort` (`flow/types.ts`). `requestApproval` posts an approval message via `discord-client`, parks a resolver in a pending `Map<"{runId}:{nodeId}", {resolve,messageRef,timer}>`, returns the promise. An inbound component interaction resolves it `true`/`false`, responds `UPDATE_MESSAGE` (ack + strip buttons + stamp), emits the `approval.responded` decision. Enforces the liveness timeout (§7.3) and idempotency (§7.2). **Connector-agnostic** — knows only `ApprovalRequest`. A near-line-for-line peer of `SlackApprovalPort`. |
| `src/main/discord/discord-control-bridge.ts` | `slack-control-bridge.ts` | The reserved **`/localflow`** command handler: `run <flow>` / `status [run]` / `stop <run>`. Reuses the **same `EngineControlSeam` and `ControlReply` types** Slack's bridge defined (the narrow start/query/stop engine seam) — an interaction reply is delivered as an ephemeral interaction-callback. Non-`/localflow` interactions flow to the `interaction` trigger instead. |
| `src/main/discord/discord-components.ts` | `slack-blocks.ts` | **Pure** component builders: `buildApprovalMessage(req)`, `buildResolvedMessage(req, decidedBy, approved)`, `buildExpiredMessage(req)`, `buildNotifyMessage(text)`; the `custom_id` codec (`encodeCustomId`/`parseCustomId` — the `lf:approve|deny:{runId}:{nodeId}` correlation, §7.1); and the pure **parse** of a raw interaction / message / command payload → a typed `DiscordInbound` / `DiscordApprovalDecision`. Unit-testable in isolation (the correctness boundary). |
| `src/main/discord/discord-token-store.ts` | `slack-token-store.ts` | Keychain-backed token access — a **thin wrapper over the hub's `CredentialStore`** (`revealForConnector('discord', 'botToken')`). Reuses the existing keychain sidecar; opens no second one. Named to grep distinctly (asserts no IPC/renderer caller). **One secret** (vs Slack's three — §8). |
| `src/main/discord/discord-config.ts` | `slack-config.ts` | Reads the non-secret `discord` refs (guild id, default channel, application id, public key, mode, ingress url, environment) — the validate-at-the-boundary pattern. Holds only Discord-specific coercion (the `mode` default, snowflake normalization). |
| `src/shared/discord.ts` | `src/shared/slack.ts` | Shared types + the pinned id arrays (`DISCORD_TRIGGER_IDS`, `DISCORD_ACTION_IDS`) and payload/context shapes (§6.3). Consumed by main and any renderer palette surface. |

### 4.3 Wiring into the merged registry + the engine (incl. port selection)

Two attach points, both additive, both already-existing seams — mirroring the
Slack block in `index.ts`:

- **Registry (actions + triggers).** Construct the `DiscordConnector` (given the
  `CredentialStore`, config, and the active transport) and register it:
  `integrationRegistry.registerConnector('discord', discordConnector)`. Its
  `invokeAction`/`subscribe` now serve the registry's pinned surface — identical
  to how `index.ts` registers Slack.
- **Engine (the `ApprovalPort`) — the selection.** The engine still takes **one**
  `ApprovalPort`. Build `discordApprovalPort` when Discord is `connected` (peer of
  the existing `slackApprovalPort`). Then select the engine's port:

  ```
  flowApprovals =
      selectApprovalPort({ slack: slackApprovalPort, discord: discordApprovalPort, config })
      ?? safeRejectStub
  ```

  MVP selection rule (recommended): **exactly one surface** is the port —
  `config.approvalSurface` if set, else whichever of {Slack, Discord} is connected;
  if *both* are connected with no `approvalSurface` set, that is a **flagged open
  decision** (§13.2) — MVP resolves it deterministically (e.g. Slack wins as the
  first-shipped, with a loud notice) rather than silently picking. A **composite
  that races both** surfaces (first responder wins, the other retracted) is the
  phased richer form (§7.4) and needs **no engine change** — the pending-map +
  resolve-once structure already supports a second responder calling the same
  `resolve`.

The pinned contract stays **byte-for-byte unchanged**; every Discord concern lives
under `src/main/discord/`. The **engine and gate-runner are untouched** — they
already take an `ApprovalPort`.

### 4.4 Receiving inbound (Gateway default; HTTP Interactions alternative)

- **Gateway (default, zero ingress).** `discord-gateway.ts` opens the outbound WSS
  and receives every message event and interaction over it. **No public URL, no
  tunnel, no relay, no signature verification** — authenticated at `IDENTIFY`.
  Each interaction is acked with a REST interaction-callback (≤3s); the
  run/resolution happens after. This is the property no vertical connector has.
- **HTTP Interactions (alternative, needs ingress + Ed25519).** When `mode:
  'http'`, `discord-interactions-server.ts` consumes the **shared**
  `webhook-receiver.ts` configured with a **new `ed25519` verifier scheme**:

  ```ts
  // Discord Interactions verifier for the shared webhook-receiver.
  // ASYMMETRIC: verify X-Signature-Ed25519 over (X-Signature-Timestamp + rawBody)
  // against the application PUBLIC KEY (NOT a shared secret).
  const discordVerifier: WebhookVerifier = {
    scheme: 'ed25519',            // ← NEW variant on the shared union
    publicKey: '<application public key>',   // public, non-secret (may live in config.json)
    signatureHeader: 'X-Signature-Ed25519',
    timestampHeader: 'X-Signature-Timestamp',
    // signed message = timestamp + rawBody ; verify with tweetnacl/node:crypto Ed25519.
  }
  ```

  The shared `WebhookVerifier` is today `scheme: 'hmac' | 'token'` only (both
  symmetric). Adding `'ed25519'` is a **shared-infra extension** the shared owner
  must land (§13.7): a public-key field instead of `secret`, an Ed25519 verify
  over `timestamp+body`, and a distinct **PING/PONG** handshake (Discord type-1)
  the receiver echoes (the `url_verification` analog — and the receiver must be
  able to answer 200 **with a body**, `{ type: 1 }`, which the current receiver's
  "200-fast, no body" path does not do — flag §13.7). It verifies over the **raw**
  body, enforces `MAX_BODY_BYTES`, and a bad / oversized / forged / stale delivery
  is dropped and **never** seeds a run or resolves a gate. **Note:** this path
  carries *only* interactions; `message.received` still comes over the Gateway
  (§13.1).

Both modes normalize to the same `DiscordInbound`, so `discord-connector.ts`,
`discord-approval-port.ts`, and `discord-control-bridge.ts` are transport-agnostic.

### 4.5 Reused localflow surfaces

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `INTEGRATION_IDS`.
- `src/main/flow/types.ts` — the `ApprovalPort` / `ApprovalRequest` seam the
  approval adapter **implements** (the whole §3/§7 story) — **already filled by
  Slack; Discord is the second implementation, no seam change**.
- `src/main/flow/node-runners/gate-runner.ts` — the gate that calls
  `requestApproval` (unchanged).
- `src/main/flow/flow-engine.ts` — takes `approvals: ApprovalPort`, routes on the
  gate boolean, ends a "no" as `rejected` cleanly; injected `now()` for tests.
- `src/main/index.ts` — where the `ApprovalPort` is selected (§4.3, mirroring the
  existing `slackApprovalPort` block) and where the connector is
  `registerConnector('discord', …)`'d.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the
  token store reuses; `revealForConnector` (main-only plaintext exit),
  `decryptionError` (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector`;
  `deriveStatus` gives Discord its status for free.
- `src/main/webhooks/webhook-receiver.ts` — the **shared** parameterized receiver +
  `WebhookVerifier`, **consumed** by the HTTP path (§4.4) — **and extended** with
  the `ed25519` scheme (§13.7).
- `src/main/flow/trigger-subscriber.ts` — `coerceEvent` / `matchesFilter` the
  Discord `SeedEvent` flows through to seed runs.
- `src/main/slack/slack-control-bridge.ts` — the `EngineControlSeam` /
  `ControlRunSnapshot` / `ControlReply` types the Discord bridge **reuses**
  (the control seam is chat-platform-agnostic already).

---

## 5. The connector as an `IntegrationDescriptor`

The static half is a `discordDescriptor: IntegrationDescriptorDef` added to
`DESCRIPTOR_DEFS`. The registry attaches the presence-derived `status()`
(`connected` | `needs-config` | `error` | `disabled`) exactly as for the others —
no bespoke status logic.

**Config fields** (secret → keychain; non-secret → config.json, validated at the
boundary). **Note the asymmetry vs Slack:** Discord needs **one** secret (the bot
token); the interaction "verification key" is a *public* key, so it is **not**
secret and lives in config.

| key | label | secret | required | type | note |
|---|---|---|---|---|---|
| `botToken` | Discord bot token | **yes** | yes | string | The only secret. `Authorization: Bot <token>`, and the Gateway `IDENTIFY`. Keychain only. |
| `guildId` | Server (guild) id | no | yes | string | The single server the connector operates in (snowflake). |
| `defaultChannel` | Approvals / notify channel | no | yes | string | Channel id where approvals + notifications post by default (an action may override per-node). |
| `applicationId` | Application id | no | yes* | string | Needed to register `/localflow` and address interaction callbacks. (\*Required once the control surface / interactions are on — Phase 2.) |
| `publicKey` | Application public key | no | no* | string | **Public**, not secret. Ed25519 verify key for `mode: 'http'` only. Required **when `mode: 'http'`**. |
| `mode` | Ingress mode | no | no | string | `'gateway'` (default) or `'http'`. Drives which transport + which key is required. |
| `environment` | localflow environment (1-9) | no | yes | number | Which env hosts Discord work (same field/validation as the others). |
| `interactionsUrl` | Interactions endpoint URL | no | no | string | The public ingress for `mode: 'http'` only. Placeholder `https://<tunnel>/discord/interactions`. |

`status('discord')` reports `needs-config` until `botToken`, `guildId`,
`defaultChannel`, `environment` (and, under `http`, `publicKey`) are present;
`error` if the stored token can't be decrypted (the hub's `decryptionError`
path); `disabled` if configured-but-turned-off; `connected` otherwise. The
action-runner refuses any non-`connected` Discord node before any network call.
As with Slack, the mode-conditional requirement (`publicKey` under `http`) is a
thin Discord-specific readiness check, not a shared-schema change (§13.7 / Slack
§13.6).

---

## 6. Pinned Discord vocabulary (verbatim)

> **This section is the contract.** The canvas palette and any flow-templates
> track read these ids and this payload shape verbatim. A snapshot test in
> `discord-descriptor.ts` guards the ids; the payload shape is guarded by the
> `discord-components.ts` parse tests.

### 6.0 Shared-union edit (the 3 lockstep touch-points)

`src/shared/integrations.ts` — `IntegrationId` gains `'discord'`:

```ts
export type IntegrationId =
  | 'linear' | 'email' | 'cloud' | 'shopify' | 'woocommerce' | 'posthog'
  | 'gitlab' | 'slack' | 'http' | 'stripe' | 'github' | 'sentry' | 'hubspot'
  | 'discord'
```

Three lockstep companion touch-points (each a one-line add): **(1)**
`INTEGRATION_IDS` (the stable order array, `integrations.ts:99`), **(2)** the flow
validator's integration allow-list in `flow-model.ts`, and **(3)**
`DESCRIPTOR_DEFS` (the descriptor added). No other `IntegrationId` consumer
changes — they iterate the array.

### 6.1 Triggers

| trigger id | label | source | note |
|---|---|---|---|
| `message.received` | Message received | A Discord `MESSAGE_CREATE` in a channel the bot can see. | Wakes a flow on an inbound chat message (payload §6.3). **Needs the Message Content privileged intent for non-empty text** (§2.3, §13.3). Bot-authored messages are dropped. |
| `interaction` | Interaction | A non-`/localflow`, non-approval `INTERACTION_CREATE` (a user-defined slash command or component). | The chat analog of Slack's `slash.command`, generalized to Discord's unified interaction model. The reserved `/localflow` (control, §4.2) and Approve/Deny buttons (the port) are **not** this trigger. |
| `approval.responded` | Approval responded | An approval button was tapped (the component interaction the `ApprovalPort` also consumes). | Fires **in addition** to resolving the gate — lets a flow log/notify on the decision. Payload `{ runId, nodeId, approved, decidedBy }`. |

### 6.2 Actions

**Send (flow-gated — every send is an `action` node the author places, and the
author may gate it):**

| action id | label | Discord REST | writes to context |
|---|---|---|---|
| `postMessage` | Post a message | `POST /channels/{channel}/messages` (to `defaultChannel` or a `channel` param; optional `embeds`) | `{ channelId, messageId }` (the ref, for later `replyInThread`) |
| `postApproval` | Post an approval and await | `POST …/messages` (approval components) **then await the tap** | `{ approved: boolean; decidedBy?: string }` |
| `replyInThread` | Reply in a thread | `POST /channels/{thread}/messages` (a Discord thread *is* a channel; the ref may be a `messageReference`) | `{ channelId, messageId }` |

`postApproval` is the **action-node form** of the same round-trip the
`ApprovalPort` runs for `gate` nodes (exactly as in Slack): it shares the
pending-map + interaction routing with `discord-approval-port.ts`. A denied
`postApproval` **resolves** `{ approved: false }` (a routing fact) — it does not
reject.

**Failure convention (pinned, identical to Slack / the registry contract):** an
action that fails **rejects** its promise with the real Discord error text (the
`{ code, message }` envelope, or transport error); a resolved promise (any value)
is success and its value becomes the node's context output. The connector never
resolves a sentinel-failure. (A denied approval is a *resolved boolean fact*, not
a failure — §7.3.)

### 6.3 Payload / context shapes (pinned)

```ts
// src/shared/discord.ts

/** message.received trigger payload (normalized from a Discord MESSAGE_CREATE). */
export interface DiscordMessagePayload {
  channelId: string      // channel snowflake
  guildId?: string       // present for guild (server) messages
  userId: string         // author snowflake
  text: string           // message content (EMPTY without the Message Content intent)
  messageId: string      // message snowflake
  threadId?: string      // present when posted in a thread
}

/** interaction trigger payload (non-/localflow, non-approval interactions). */
export interface DiscordInteractionPayload {
  interactionId: string
  token: string          // per-interaction token for the callback (short-lived)
  type: number           // 2 = application command, 3 = message component, …
  name?: string          // command name for an application-command interaction
  customId?: string      // custom_id for a component interaction
  channelId: string
  userId: string
}

/** approval.responded trigger payload + the ApprovalPort's internal decision. */
export interface DiscordApprovalDecision {
  runId: string
  nodeId: string
  approved: boolean
  decidedBy: string      // the Discord user id who tapped
}
```

Normalization happens **once**, in `discord-components.ts` (pure), so conditions
and downstream nodes read a stable shape — the correctness boundary
(`discord-components.ts` parse tests guard it, §12).

---

## 7. The approval round-trip — data flow, node by node

**Scenario:** the same Shopify refund worker from the Slack spec, but the approver
lives in a Discord community server. The connector under the gate is irrelevant —
email, cloud, Stripe all behave identically.

```
[trigger: order.refundRequested]  → [action: getOrder] → [router: total > 50?]
                                                                │ (yes)
                                                                ▼
                                                    [gate: "approve refund"]
   gate-runner → approvals.requestApproval({ runId, nodeId, prompt, peek:[order summary] })
                                                                │
                                                                ▼
   DiscordApprovalPort.requestApproval:
      POST /channels/{defaultChannel}/messages(buildApprovalMessage(req)) → { channelId, messageId }
      pending.set("{runId}:{nodeId}", { resolve, messageRef, timer=setTimeout(→false) })
      return Promise<boolean>            ← run status becomes needs-you
                                                                │
                    user taps  Approve  on their phone         │
                                                                ▼
   INTERACTION_CREATE → transport (Gateway / interactions URL) →
      discord-components.parseInteraction → { action:'approve', runId, nodeId, decidedBy }
      → pending.get(key):
           clearTimeout
           respondToInteraction(id, token, UPDATE_MESSAGE, buildResolvedMessage(true, @user))
              (this ACKS within 3s AND strips the buttons — one call)
           resolve(true) ; pending.delete(key)      (2nd tap → key gone → no-op)
      → also emit approval.responded trigger event
                                                                │
                                                                ▼
   gate-runner records { approved:true } → engine routes approve edge →
   [action: refundOrder] runs the real refund.   (Deny → resolve(false):
   engine ends the run 'rejected' cleanly — a human "no" is not a failure.)
```

Node-by-node against the engine (identical to Slack §7, Discord specifics noted):

1. **Gate reached.** `gate-runner` templates the prompt and calls
   `approvals.requestApproval`. The run parks `needs-you`. It **awaits** — no
   auto-proceed.
2. **Discord posts.** `DiscordApprovalPort` builds the approval message (prompt +
   the `peek` lines as an embed) with Approve/Deny buttons whose **`custom_id`**
   encodes `lf:approve|deny:{runId}:{nodeId}`, posts via `POST …/messages`, and
   parks the resolver + a timeout timer in the pending map.
3. **Tap arrives.** The transport delivers the component `INTERACTION_CREATE`;
   `parseInteraction` yields `{ action, runId, nodeId, decidedBy, interactionId,
   token }`. The port looks up the pending resolver.
4. **Finalize + ack (idempotent, one call).** It `clearTimeout`s, responds to the
   interaction with an `UPDATE_MESSAGE` callback (type 7) to a resolved,
   button-less message ("Approved by @user") — which **also acks within Discord's
   3s window** — resolves the gate boolean, and deletes the entry. A second tap
   finds no entry → no-op (§7.2). It also emits `approval.responded`.
5. **Engine routes.** `gate-runner` returns `{ approved }`; the engine routes the
   approve edge (runs the gated action) or, on `false` with no reject edge, ends
   the run **`rejected`** — clean stop, real reason surfaced.

### 7.1 Correlation
The pending-map key is `"{runId}:{nodeId}"`, embedded in the button `custom_id` as
`lf:approve:{key}` / `lf:deny:{key}` (the `lf:approve|deny:` prefix carries the
decision, since a Discord button has no separate action-id + value like Slack —
both are folded into `custom_id`). `custom_id` allows 100 chars; a uuid runId (36)
+ `:` + a nodeId fits comfortably. The key is unforgeable-for-our-purposes (random
runId), survives reconnects (the map is in-memory, independent of the socket), and
lets one server service many concurrent gates across many runs.

### 7.2 Idempotency & double-taps
Resolution deletes the pending entry **before** any await; a duplicate interaction
(double tap, redelivery) finds no entry and is a no-op — with a bounded `settled`
tombstone set (FIFO-capped, peer of `SlackApprovalPort.SETTLED_CAP`) distinguishing
a *double-tap* (silent no-op) from a *truly unknown/stale* gate (legible reply).
The `UPDATE_MESSAGE` callback also strips the buttons, so the surface is not
tappable twice under normal use.

### 7.3 Liveness / timeout (a "no" is not a failure)
Each pending approval carries a configurable timeout (`discord.approvalTimeoutSec`,
default e.g. 3600). On expiry — with **no live interaction to respond to** — the
port edits the message via REST `PATCH …/messages/{id}` to "Expired — no response"
and **resolves `false`** (a clean `rejected` stop, exactly as a human "no"). A
worker never hangs forever. (The expiry path is the one place Discord uses `PATCH`
rather than the interaction callback, because there is no interaction token in
hand — noted because it differs subtly from the tap path.)

### 7.4 Connector-agnostic + the phased composite
The port receives only `ApprovalRequest` — it never learns which connector's action
sits past the gate, **and it never learns whether Slack also exists.** MVP installs
**one** surface as the `ApprovalPort` (§4.3). The **phased composite** races Slack
*and* Discord (whichever responds first wins, the other message retracted via
`UPDATE_MESSAGE`/`chat.update` "Handled elsewhere"). Designed-for; the pending-map +
resolve-once structure already supports it (a second responder calls the same
`resolve`). Not built in MVP (§13.2).

---

## 8. Auth & keychain

- **"For me" fork (MVP).** One bot application created in the Discord Developer
  Portal and invited to the user's own server with the needed scopes
  (`bot`, `applications.commands`) and permissions (send messages, embeds, use
  application commands; read message history / message content intent for
  `message.received`). It yields **one secret — the bot token.** The user pastes it
  into the descriptor's masked field; it goes straight to the keychain via
  `CredentialStore.set`.
  - The bot token is read at call time via
    `revealForConnector('discord','botToken')` and sent as the `Authorization:
    Bot <token>` header on every REST request, and once at Gateway `IDENTIFY`
    (main-process-only, the sole plaintext exit; a grep test asserts no
    IPC/renderer caller).
  - The **application public key** (for `mode: 'http'` Ed25519 verification) is
    **public**, not a secret — it lives in `config.json`, not the keychain. This is
    a genuine simplification over Slack (one secret, not three; the verification
    key is asymmetric and public).
- **Honoring the global secret rule.** The bot token is **never** written to
  `config.json`, `sessions.json`, the transcript, a log, a PR body, or any IPC
  payload. `config.json` holds only **references** (guild, channel, application id,
  public key, mode, ingress url — §5). Token **state** (present / decrypt-failing)
  may be surfaced via `status()`; the **value** never is. The hub's existing
  discipline applied to Discord verbatim.
- **"Product" fork (deferred, §13.5).** A distributable "Add to Server" app uses
  **OAuth2** to install per guild (multi-guild, `guilds[]` config). The keychain
  shape already supports per-key storage; the additive change is a `discord-oauth.ts`
  module and a guild array. Same `Bot`/`Bearer` at call time — only *acquisition*
  and *multi-tenant isolation* differ.
- **Disconnect.** Clearing the token (the hub's `clearSecret`) flips `status()` to
  `needs-config`; the connector stops dispatching, the Gateway WSS is closed, and
  if Discord was the selected `ApprovalPort` the engine reverts to Slack's port or
  the safe-reject stub (so any in-flight gate cleanly stops rather than hanging). No
  in-flight run is force-killed.

---

## 9. Authority & safety

**Primary control — the flow's gates (already enforced), now answerable from
Discord.** Every Discord send (`postMessage`, `postApproval`, `replyInThread`) is
an `action` node the author places and may gate. The connector **never** posts or
mutates outside the graph the author drew — there is no "connector default" that
messages on its own. And the *headline* is the inverse direction: the second
`ApprovalPort` makes the engine's existing gates **answerable from Discord**, which
strengthens safety for the indie/community user exactly as Slack did for the
business user.

**Never render secrets.** The bot token lives in the keychain; no error message,
log line, posted message, `peek`, or context field ever contains it (§8, §11). A
`peek` shown in an approval message is the flow author's content — the connector
renders it as an embed and performs no secret substitution.

**Approver trust (MVP → phase 2).** MVP trusts any member who can see the approval
channel to tap. A per-gate approver allow-list (only certain Discord user ids may
resolve a gate; others' taps get an ephemeral "not an approver") is phase 2
(§13.6) — the interaction payload already carries `decidedBy`.

**Control-surface authority.** `/localflow run|status|stop` can start and stop
runs. It is gated by guild membership (only members of the installed server can
reach the command) and — as a phased item — the same approver allow-list. `run`
starts a flow the user already authored; `stop` requests a stop (never
force-kills mid-action). The bridge carries the **same narrow `EngineControlSeam`**
(start/query/stop) Slack's bridge uses, not arbitrary engine access.

---

## 10. Slack ↔ Discord — two surfaces, one seam

Discord fills the **same connector slot** Slack pioneered: a persistent-gateway
chat platform with an outbound WebSocket (the Gateway — the Socket-Mode analog,
also zero-ingress), interactive components (buttons → the same approval
round-trip), and slash commands (the same control surface, same `EngineControlSeam`).
Because the Slack spec deliberately targeted **the seam, not a Slack gate**, this
peer is purely additive:

- **No engine change.** The engine still takes one `ApprovalPort`; Discord is a
  second implementation selected at wiring time (§4.3).
- **Shared control seam.** `discord-control-bridge.ts` reuses Slack's
  `EngineControlSeam` / `ControlReply` — chat-platform-agnostic already.
- **The one real divergence** is inbound verification for the *HTTP* path
  (Ed25519 vs HMAC — §2.3, §4.4, §13.7); the **Gateway path erases even that**, so
  the two connectors are, at the seam, the same shape. The differences that remain
  are Discord-local: `custom_id` (vs action-id+value), the interaction-callback ack
  (vs socket ack), the Message Content intent, and slash-command *registration*
  (§13.4) — all isolated in `discord-client.ts` / `discord-components.ts` /
  `discord-gateway.ts`.

The open question when **both** are connected (which surface answers a gate — or a
composite that races both) is flagged §13.2.

---

## 11. Error handling

localflow's principle (error-message-style memory; the Slack connector's §11):
**every failure is human-readable, actionable, and carries the real underlying
exception. No silent catch. No bare "failed" / "not found".** An action signals
failure by **rejecting** with that message; the action-runner prefixes it.

| Failure | Cause carried | Surface / behavior |
|---|---|---|
| **Bot token invalid/revoked** (`401 Unauthorized`, or Gateway close `4004`) | the HTTP status / close code | `invokeAction` **rejects**: "Discord rejected the bot token (401) — it's wrong or was regenerated; re-enter it in Settings." Value never included. |
| **Missing permission / intent** (`403 Missing Access`, or Gateway close `4014` disallowed intents) | the verbatim permission / intent | Rejects: "Discord refused the post: the bot lacks Send Messages in '<channel>' — grant it, or pick another channel." For `4014`: "Discord closed the Gateway — the Message Content intent isn't enabled; turn it on in the Developer Portal." |
| **Channel not found / bot not in it** (`404` / `403`) | the channel ref | Rejects: "Discord can't post to '<channel>' — the bot isn't a member or it doesn't exist; invite the bot or pick another channel." |
| **Rate limited** (`429`) | `retry_after` seconds | `discord-client` retries with backoff honoring `retry_after` (route + global); only after exhausting retries does it reject: "Discord throttled posting (retry in ~Ns)." Not swallowed. |
| **Gateway disconnect / resume** | the close code / reason | `discord-gateway` heartbeats and transparently `RESUME`s (or re-`IDENTIFY`s on an invalid session); no run/gate is lost (the pending map is independent of the socket). A **hard, repeated** failure surfaces loudly: "Discord Gateway can't stay connected (<reason>) — approvals won't arrive." Never a silent dead socket. |
| **Ed25519 signature invalid** (HTTP mode) | signature mismatch (never the body or key) | Receiver drops with reason only; 401; **no run started, no gate resolved.** |
| **Stale / replayed interaction** (HTTP mode) | the timestamp skew | Dropped; never resolves a gate. |
| **Interaction ack window missed** (>3s, e.g. a slow resolve) | the elapsed time | The port acks FIRST (the `UPDATE_MESSAGE` callback is the resolve step) so this is avoided by construction; if it ever races, Discord shows "interaction failed" to the user and the gate falls back to the timeout path — surfaced, never a phantom resolve. |
| **Duplicate interaction / redelivery** | the interaction id | Idempotent no-op (§7.2) — the pending entry is already gone. |
| **Approval timeout** (no tap before `approvalTimeoutSec`) | the elapsed time | Not an error: the port `PATCH`es "Expired" and **resolves `false`** → the run ends `rejected` cleanly (§7.3). Surfaced on the feed, not as a failure. |
| **Interaction for an unknown/stale gate** (run ended, or localflow restarted losing the map) | the key that missed | The port replies with an ephemeral/edited "This approval is no longer active (the run has ended or localflow restarted)." and drops the tap. No phantom resolve. |
| **Empty message text** (Message Content intent absent) | the missing intent | `message.received` surfaces a one-time legible notice ("Discord message text is empty — enable the Message Content intent in the Developer Portal") rather than waking flows on blank content (§2.3, §13.3). |
| **`status('discord') !== 'connected'`** | the derived reason (missing token / decrypt error / disabled / missing publicKey under http) | The action-runner fails the Discord node *before* any call: "Flow needs Discord connected — action '<id>' can't run. Connect it in Settings." |
| **`/localflow` control error** (unknown flow, bad run id) | the name/id that missed | The bridge replies **ephemerally** in Discord: "No flow named '<x>' — try `/localflow status` to list runs." Never a silent drop. |

The connector **never** catches-and-drops. Where Discord returns a precise code,
the connector forwards *that* rather than minting a vaguer one.

---

## 12. Testing strategy (offline / mockable — no live calls in CI)

Testable **without a live Discord server**, matching localflow's existing seams
(pure modules, injected backends, fixture payloads) — a peer of the Slack test
suite:

- **`DiscordApi` interface + `MockDiscordApi` seam.** `discord-client.ts` is
  written *against* a `DiscordApi` interface (`postMessage`, `editMessage`,
  `respondToInteraction`, `registerCommands`, `getGatewayUrl`); the real impl wraps
  the HTTP transport (`deferredLiveTransport` until the network exit lands — peer
  of Slack's). Tests inject a `MockDiscordApi` returning canned success / error
  (`403 Missing Access`, `404`, `429`) envelopes. **No test performs a live Discord
  call**; CI has no Discord credentials.
- **`GatewayTransport` mock.** `discord-gateway.ts` is behind a `GatewayTransport`
  interface; a `MockGatewayTransport` **emits** scripted `HELLO` / `DISPATCH`
  (`MESSAGE_CREATE`, `INTERACTION_CREATE`) / `RECONNECT` / `INVALID_SESSION`
  frames and records `IDENTIFY`/heartbeat/`RESUME` sends. Tests drive inbound
  Discord traffic with zero network — including a reconnect to assert transparent
  RESUME.
- **The `ApprovalPort` adapter (the headline test).** Drive
  `DiscordApprovalPort.requestApproval(req)` (with a `MockDiscordApi`), then feed a
  scripted **Approve** interaction → assert the promise resolves `true`, a
  `respondToInteraction(UPDATE_MESSAGE)` with a button-less message was called, and
  `approval.responded` was emitted. Repeat **Deny** → `false`. Assert **timeout** →
  resolves `false` via a REST `editMessage` (deterministic via an injected
  timer/`now()`). Assert a **second** tap is a no-op (idempotency). Assert an
  interaction for an **unknown key** is dropped with the "no longer active" reply.
  The correctness core — guarded hardest. (Structurally identical to the
  `SlackApprovalPort` test.)
- **`discord-components.ts` unit tests** — pure builders + parse + the `custom_id`
  codec: assert `buildApprovalMessage(req)` encodes `lf:approve:{runId}:{nodeId}` /
  `lf:deny:{…}`; assert `parseInteraction` round-trips it back to `{ action, runId,
  nodeId, decidedBy }`; assert message/command parsing → the pinned §6.3 shapes;
  assert a malformed payload yields `null` (never a throw, never a partial resolve).
- **HTTP-path Ed25519 verification test** — feed the shared `webhook-receiver`
  (configured with `discordVerifier`, once the `ed25519` scheme lands — §13.7)
  fixture bodies with **valid and invalid `X-Signature-Ed25519`**, a **stale
  timestamp**, an oversized body, and the `PING` (type 1); assert 401/drop for bad
  ones, a `PONG` for the ping, and that only valid+signed+fresh payloads produce a
  `DiscordInbound`. (Exercises the extended shared infra, not a reimplementation.)
- **Engine integration test (offline)** — wire the real `FlowEngine` with
  `DiscordApprovalPort` (over a `MockDiscordApi` + `MockGatewayTransport`), drive a
  flow to a `gate`: assert the run parks `needs-you`, inject an **Approve**
  interaction, assert the gate records `{ approved:true }` and the approve edge
  runs; repeat with **Deny** → run ends `rejected` cleanly. Deterministic via the
  engine's injected `now()`.
- **Port-selection test** — assert `selectApprovalPort` picks Discord when only
  Discord is connected, Slack when only Slack is, the configured/flagged winner when
  both, and the safe-reject stub when neither (§4.3).
- **`/localflow` control-bridge test** — with a fake `EngineControlSeam` (reused
  from Slack): assert `run <flow>` starts a run, `status` lists snapshots, `stop
  <run>` requests a stop, an unknown flow yields the ephemeral legible error.
- **Token-store test** — `revealForConnector` round-trip via a fake `SecretBackend`;
  a regression guard asserts **no token value** appears in any emitted
  log/console/error/posted-message string.
- **Snapshot test on `discordDescriptor`** — pins the trigger/action ids the palette
  consumes; a change is a deliberate, reviewed contract edit.

No test requires Discord credentials or a live server; the real APIs are exercised
only in manual dogfooding against a development server.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **Gateway vs HTTP Interactions as the shipped default.** **Recommendation:
   Gateway**, for the local/self-host tier — zero ingress, no signature
   verification, and it is the **only** path that also carries `message.received`.
   The HTTP Interactions endpoint carries *only* interactions, so choosing it would
   mean running **both** it *and* the Gateway (for messages) — strictly more moving
   parts. Gateway-only is the clear MVP default; HTTP is Phase 3 for the
   HTTPS-ingress tier.
2. **Port selection when Slack AND Discord are both connected.** The engine takes
   one `ApprovalPort`. Options: (a) a `config.approvalSurface: 'slack' | 'discord'`
   explicit selector (recommended default behaviour when set); (b) a deterministic
   precedence when unset (MVP: Slack wins as first-shipped, with a loud notice —
   never a silent pick); (c) a **composite that races both** (first responder wins,
   the other retracted — §7.4), the phased richer form needing no engine change.
   *Which* is a product call; whatever is chosen, a gate must never hang and never
   be double-resolved.
3. **The Message Content privileged intent.** `message.received` needs it for
   non-empty text (Developer-Portal toggle; Discord approval past 100 servers). Ship
   the trigger with a legible degraded notice (chosen), or gate the trigger behind a
   config flag until the intent is confirmed? Approvals + slash commands are
   unaffected either way.
4. **Slash-command registration.** Discord requires `/localflow` to be *registered*
   (`PUT /applications/{app}/guilds/{guild}/commands` — **guild-scoped is instant**;
   global takes up to ~1h to propagate). Does MVP register it automatically on
   connect (guild-scoped, recommended), or document a manual one-time step? (Slack
   configures slash commands in the app manifest — this registration step is
   Discord-specific.)
5. **"For me" vs "a product others install."** The biggest fork (peer of Slack
   §13.3). *For me* (MVP): one bot invited to one server, one token in the keychain,
   Gateway (no ingress). *Product*: an "Add to Server" **OAuth2** app, `guilds[]`
   multi-guild isolation, a hosted relay for the HTTP path. Recommendation: build
   MVP "for me", keep the token/config shapes guild-ready (they already are — §8).
6. **Per-approver authorization.** MVP trusts any member who can see the channel. An
   allow-list (only certain Discord user ids may resolve a gate / drive `/localflow`)
   is a phase-2 safety upgrade; `decidedBy` is already carried. The *default* (open
   vs restricted) is a product-security call.
7. **The `ed25519` shared-receiver extension (HTTP path only).** The shared
   `WebhookVerifier` is `scheme: 'hmac' | 'token'` today — both symmetric. Discord's
   HTTP Interactions need a **new `scheme: 'ed25519'`** variant: a *public key*
   (not a `secret`), an Ed25519 verify over `timestamp+rawBody`, and a **PING/PONG**
   handshake that requires the receiver to answer **200 with a body** (`{ type: 1 }`)
   — which the current "200-fast, no body" receiver path does not do. Options: land
   `ed25519` (+ the body-echo capability) in the shared receiver (recommended, one
   place, benefits any future asymmetric connector), or a thin Discord-local
   verifier that wraps the shared receiver's raw-body/replay plumbing. A shared-infra
   owner decision. **Not needed for the Gateway-only MVP.**

---

## 14. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One server, Gateway mode, the approval round-trip end-to-end:**

1. `IntegrationId` gains `'discord'` (+ the 3 lockstep touch-points, §6.0);
   `discordDescriptor` added to `DESCRIPTOR_DEFS`; `status()` derives from config +
   keychain presence (free from the hub).
2. `botToken` + `guildId` + `defaultChannel` stored (token → keychain);
   `status('discord') === 'connected'`.
3. `discord-gateway.ts` opens the Gateway WSS behind a `GatewayTransport`;
   `discord-client.ts` behind `DiscordApi` does `POST …/messages`,
   `POST /interactions/{id}/{token}/callback` (UPDATE_MESSAGE), and `PATCH
   …/messages/{id}`.
4. `discord-approval-port.ts` implements `ApprovalPort`: post approval components →
   park resolver → an Approve/Deny tap resolves `true`/`false`, updates+acks the
   message, idempotent, with a timeout→`false`. Selected into the `FlowEngine` when
   Discord is connected and Slack is not (§4.3).
5. On the canvas: **any** flow with a `gate` — reuse the Shopify refund flow — now
   pauses `needs-you`, posts to Discord, and resolves on a phone tap. `refundOrder`
   runs on Approve; the run ends `rejected` on Deny. Errors per §11.

That slice proves the headline (a real worker's gate is approved from a Discord
server with **no ingress**) against a development server, and it already benefits
**every** connector's gates — a *second* universal remote-approval surface.

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton — Gateway, the `DiscordApprovalPort`
  adapter, `postMessage`. "For me" fork. Single server, single environment.
- **Phase 2 — full vocabulary + control:** `postApproval` / `replyInThread`
  actions; `message.received` (Message Content intent) / `interaction` /
  `approval.responded` triggers; the `/localflow run|status|stop` control bridge
  (with slash-command registration, §13.4); per-approver allow-list (§13.6).
- **Phase 3 — HTTP Interactions path:** `discord-interactions-server.ts` on the
  shared `webhook-receiver` **extended with the `ed25519` scheme + PING/PONG body
  echo** (§13.7), for the HTTPS-ingress tier — running alongside the Gateway for
  message events (§13.1).
- **Phase 4 — composite approval:** race Slack *and* Discord (first responder wins,
  other surface retracted — §7.4, §13.2), and/or Discord against the in-cockpit
  `ApproveButton`.
- **Phase 5 — product fork:** distributable "Add to Server" OAuth2 app, `guilds[]`
  multi-guild isolation, a hosted relay for the HTTP path (§13.5).

---

## Appendix — reused localflow surfaces (by path)

- `src/shared/integrations.ts` — the pinned `IntegrationDescriptor` /
  `IntegrationRegistry` / `LiveConnector` this connector satisfies; `IntegrationId`
  (edited, §6.0); `IntegrationStatus`; `INTEGRATION_IDS`.
- `src/main/flow/types.ts` — the `ApprovalPort` / `ApprovalRequest` seam the
  approval adapter **implements as a second instance** (the headline, §3/§7) — no
  seam change.
- `src/main/flow/node-runners/gate-runner.ts` — the gate that calls
  `requestApproval` (unchanged).
- `src/main/flow/flow-engine.ts` — takes `approvals: ApprovalPort`, routes on the
  gate boolean, ends a "no" as `rejected` cleanly; injected `now()` for tests.
- `src/main/index.ts` — where the `ApprovalPort` is **selected** among Slack /
  Discord / stub (§4.3, mirroring the existing `slackApprovalPort` block) and where
  the connector is `registerConnector('discord', …)`'d.
- `src/main/integrations/credential-store.ts` — the `safeStorage` keychain the token
  store reuses; `revealForConnector` (main-only plaintext exit), `decryptionError`
  (feeds `status()`).
- `src/main/integrations/integration-registry.ts` — `registerConnector`;
  `deriveStatus` gives Discord its status for free.
- `src/main/webhooks/webhook-receiver.ts` — the **shared** parameterized receiver +
  `WebhookVerifier`, **consumed** by the HTTP path and **extended** with the
  `ed25519` scheme (§4.4, §13.7).
- `src/main/flow/trigger-subscriber.ts` — `coerceEvent` / `matchesFilter` the
  Discord `SeedEvent` flows through to seed runs.
- `src/main/slack/` — the merged Slack connector this spec is a **near-exact peer**
  of (module shape, the `ApprovalPort` seam, the failure convention); its
  `slack-control-bridge.ts` `EngineControlSeam` / `ControlReply` are **reused
  directly** by the Discord control bridge.
</content>
</invoke>
