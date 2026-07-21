# Linear Integration — Design

**Date:** 2026-07-16
**Status:** Design (spec) — not started. Design-approval gate for the first
CRM/task integration (Direction 1 of the integration-scope brainstorm).
**Feature:** Make saiife the execution layer *under* Linear — pull a
delegated issue, spawn a saiife agent pane to work it, stream live status
back onto the Linear `AgentSession`, route human approval through the existing
`needs-you` primitive, and close the loop. Reuses the pane model, the
hook-driven status feed, the operator control API + grant, `ApproveButton` /
`peek`, and saiifeguard — it does **not** reinvent any of them.

Research basis: `scratchpad/feasibility-linear.md` (primary),
`scratchpad/design-scope-integrations.md` (consolidated verdict + Direction 1),
with `feasibility-salesforce.md` / `feasibility-jira.md` for the
"expand to other CRMs later" framing.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Let a Linear user delegate an issue to saiife's app
identity and have a saiife agent pane work it end-to-end — reporting
`working / needs-you / done` live onto Linear's native `AgentSession`, and
pausing for human input via `elicitation` — with zero bespoke status-field
machinery.

### In scope (MVP)

- A new **Linear connector** module in the main process.
- OAuth2 `actor=app` install so saiife acts as its **own bot identity** (not
  user impersonation).
- A **webhook receiver** for `AgentSessionEvent` (`created`, `prompted`).
- On `created`: spawn **one saiife terminal pane per delegated issue** in a
  configured environment, seeded with the issue's `promptContext`, driven
  through the **existing operator control API** (`POST /panes`, then
  `POST /panes/:handle/prompt`).
- **Status mapping**: subscribe to `SessionManager.onStatus` / `onActivity`
  (`src/main/session-manager.ts`) and translate each saiife status into a
  Linear `AgentActivity` (`thought` / `action` / `elicitation` / `response` /
  `error`), which drives `AgentSession.state` (`pending`→`active`→
  `awaitingInput`→`complete`).
- **Human-in-the-loop, both directions**: saiife `needs-you` → Linear
  `elicitation` (→ `awaitingInput`); a human reply in Linear → `prompted`
  webhook → written into the pane via the control API. A human can *also*
  resolve it inside saiife with the existing `ApproveButton` (writes `\r`).
- **Close**: on saiife `idle`/`done`, emit a `response` activity
  (→ `complete`); optionally `issueUpdate(stateId)` to move the workflow state.
- **Single Linear workspace, single saiife environment** (env 1-9), one
  issue → one pane. Credentials stored in the OS keychain via Electron
  `safeStorage`; **never logged or rendered**.

### Out of scope (MVP) — explicitly deferred

- Cross-issue **"needs-you queue" aggregate view** inside Linear (Linear has no
  built-in one — §10, §11). saiife already has its own Overview `needs-you`
  surface; the *Linear-side* aggregate is a phase-2 item.
- **Multi-workspace** and **multi-environment** fan-out (the credential/mapping
  shapes are designed to make this additive — §7, §11).
- **@mention** triggers (only *delegation/assignment* → `AgentSessionEvent`
  `created` is wired in MVP; `app:mentionable` is a phase-2 scope).
- **Board-level status visibility** via workflow-state/label conventions
  (MVP leans purely on `AgentSession.state`; the label workaround is phase 2).
- **Public/distributed OAuth app** (verification, multi-tenant install). MVP is
  the "**for me**" fork — a private app in Jonas's own workspace (§10).
- Any **write path other than** `AgentActivity` emit + optional
  `issueUpdate` / `commentCreate`. No custom-field syncing (Linear has none).
- Non-Linear CRMs (Salesforce is the intended Direction-1 phase-2 target).

---

## 2. Feasibility summary

**Verdict from research: YELLOW** — the full loop (pull → work → live status →
human approval → close) is *fully buildable today* on Linear's native
**Agents API**, and maps unusually cleanly onto saiife's 3-state model
(`feasibility-linear.md` §"Verdict"). It is YELLOW, not GREEN, because of three
named constraints, none of them blockers:

1. **Developer Preview, not GA.** The Agents API is "currently in active
   development and available as a Developer Preview." Expect schema/behavior
   drift. Mitigation: isolate all Linear API shapes behind the connector's
   client layer (§4) so a breaking change is a one-file edit, and pin the
   Developer-Preview version header if Linear exposes one. Positive signal:
   Linear's own first-party "Coding sessions" (Claude Code/Codex delegation,
   June 2026) is built on this same API — they dogfood it.
2. **Cloud-only.** No self-host / on-prem / FedRAMP. Irrelevant unless a future
   customer needs on-prem tracker residency; a hard wall if they do (§10).
3. **No generic custom fields.** Linear's Issue model is fixed
   (state/label/priority/estimate/assignee/**delegate**), not schema-extensible.
   The 3-state status therefore maps onto **`AgentSession.state`** (native, the
   MVP choice) rather than a bespoke "Agent Status" field. A
   workflow-state/label convention is the only way to reflect status on the
   kanban board itself — deferred to phase 2.

Other constraints, all manageable: **rate limits** are generous (5,000 req/h,
3M complexity pts/h authenticated) but push-over-poll is mandatory to stay
under them (webhooks, not polling); the **10-second ack contract** on
`AgentSessionEvent.created` (must emit a `thought` within 10s or Linear marks
the run unresponsive) shapes the receiver's hot path; **`stale`** after ~30 min
of silence is a free "lost heartbeat" signal saiife can adopt.

---

## 3. The core loop → Linear primitives

saiife's canonical loop (`design-scope-integrations.md`, Direction 1) is
`pull → work → status back → human approval → close`. Each stage maps to a
concrete Linear primitive and a concrete saiife mechanism:

| Stage | Linear primitive | saiife mechanism |
|---|---|---|
| **pull** | `AgentSessionEvent` webhook, action `created` (fired on delegation/assignment to the app identity). Carries `AgentSession` + `promptContext`. | Connector receives webhook → obtains/uses the environment's operator grant → `POST /panes` (`kind: terminal`, an `OPERATOR_TERMINAL_AGENTS` agent) → `POST /panes/:handle/prompt` with the issue context. Must emit a `thought` **within 10s** to ack. |
| **work** | `AgentSession.state = pending → active`, driven by `AgentActivity` of kind `thought` (progress/heartbeat) and `action` (tool step). | saiife `working` status (from the hook adapter / state machine, `UserPromptSubmit` → working). Each `onStatus`/`onActivity` tick → debounced `thought`/`action` emit. |
| **status back** | Typed `AgentActivity` stream (Markdown bodies). | `SessionManager.onStatus` + `onActivity` taps (already wired in `src/main/index.ts:347,362`). The connector is a third subscriber alongside the renderer IPC + console bus. |
| **human approval** | `AgentActivity` kind `elicitation` → flips `AgentSession.state` to `awaitingInput`. Human reply in the issue thread → `prompted` webhook. | saiife `needs-you` status (state machine: `Notification` → needs-you) → emit `elicitation`. Return path: `prompted` webhook → `POST /panes/:handle/prompt` writes the human's reply into the pty. **Symmetry:** a human at the saiife cockpit can instead click `ApproveButton` (writes `\r`), which returns the pane to `working` and the connector emits a resuming `thought`. |
| **close** | `AgentActivity` kind `response` → `AgentSession.state = complete`. Optional `issueUpdate(stateId)` to move workflow state; optional `commentCreate` for a summary. | saiife `idle` after a `Stop` hook (turn complete) → emit `response`. A pane `exited` with a failure tail → emit `error` (→ `AgentSession.state = error`). |

**Failure/edge mappings:**
- saiife pane instant-exits (the `INSTANT_EXIT_MS` path in
  `session-manager.ts`, message carries the real tail) → `AgentActivity` `error`
  with that tail as the body → `AgentSession.state = error`.
- No saiife activity for ~30 min → Linear marks the session `stale`. The
  connector treats `stale` as a recoverable "lost heartbeat": surface it as a
  console notice; a later activity revives it.

---

## 4. Architecture in saiife

### 4.1 Where it sits

A new **main-process module set** under `src/main/linear/`. It is a peer of the
operator subsystem, wired in `src/main/index.ts` next to `startControlServer` /
`startHookServer`. It is **opt-in**: absent config (no OAuth install) means the
connector never starts, and nothing about saiife's "works with no
integration" guarantee changes — exactly the posture the OpenClaw operator
launch took (`2026-07-11-openclaw-operator-launch-design.md`).

The connector is, architecturally, **an in-process operator client**. It does
not reach into `SessionManager` privately to spawn/drive panes; it goes through
the **same control-API surface** OpenClaw uses (`src/main/control-api.ts`), so
the capability boundary (`OPERATOR_TERMINAL_AGENTS`), the prompt **guard**
(saiifeguard via `operatorGuard`), and per-environment isolation all apply to
Linear-driven work identically. It obtains a grant via the existing
`OperatorGrantStore.grant(env)` and calls the router. (Two wiring options in
§4.6; both preserve the guard.)

### 4.2 New modules (named)

| Module | Responsibility |
|---|---|
| `src/main/linear/linear-connector.ts` | Orchestrator. Owns the issue↔pane map, subscribes to `manager.onStatus`/`onActivity`, translates status → activities, drives panes via the control API. The one place the loop lives. |
| `src/main/linear/linear-webhook-server.ts` | HTTP receiver for `AgentSessionEvent`. Mirrors `hook-server.ts` (createServer, `applyLoopbackTimeouts`, `MAX_BODY_BYTES`, `responded` guard) **plus** HMAC signature verification (Linear signs with the webhook secret) and cloud-ingress handling (§4.4). Parses/validates the body; never trusts shape. |
| `src/main/linear/linear-client.ts` | Thin GraphQL client. All Linear API shapes (mutations, queries) live *only* here — the Developer-Preview blast radius. Emits `AgentActivity`, runs `issueUpdate`/`commentCreate`, does the auth-token refresh. |
| `src/main/linear/linear-oauth.ts` | OAuth2 `actor=app` install/callback flow + token refresh. Writes tokens **only** to the keychain store (§5). |
| `src/main/linear/linear-token-store.ts` | Keychain-backed credential storage via Electron `safeStorage`. Get/set/clear. Never returns a token into a log or IPC payload. |
| `src/main/linear/status-map.ts` | Pure mapping: saiife `SessionStatus` + `ActivityEntry` → Linear `AgentActivity` kind + body. Unit-testable in isolation (mirrors `state-machine.ts`'s purity). |
| `src/main/linear/linear-config.ts` | Reads the `linear` block from `config.json` (workspace id, environment scoping, agent choice) — the config-as-code pattern of `operator-config.ts` / `editor-config.ts`. |
| `src/shared/linear.ts` | Shared types (`LinearSessionEvent`, `AgentActivityInput`, the issue↔pane map entry) needed by both main and any renderer surface. |

### 4.3 Authenticating as the app actor

The connector authenticates as **saiife's own workspace bot**, via OAuth2
with `actor=app` on the authorization URL (`feasibility-linear.md` §1). On
install Linear creates a dedicated agent user; the app holds its own access +
refresh token. Scopes requested: `app:assignable` (be delegated issues) and,
phase 2, `app:mentionable`. Per-mutation `createAsUser` / `displayIconUrl` are
available if a run wants to render "worked by <human> via saiife", but MVP
posts as the plain app identity. The bot does **not** count as a billable seat.

### 4.4 Receiving webhooks (the cloud-ingress problem)

`hook-server.ts` binds `127.0.0.1` because the hook sender is a local agent
subprocess. **Linear webhooks originate in the cloud**, so the receiver needs a
reachable public URL. This is a real design decision, not a detail:

- **MVP ("for me" fork):** a developer tunnel (e.g. an `ngrok`/Cloudflare-tunnel
  URL, or a small always-on relay the user runs) forwards to the local
  `linear-webhook-server`. The webhook's registered `url` is that tunnel. This
  keeps the whole loop on the user's machine — the local-first ethos — at the
  cost of a running tunnel. Documented as a v1 prerequisite (same spirit as the
  OpenClaw skill being a documented prerequisite).
- **Phase 2 ("product" fork):** a thin hosted relay that authenticates the
  webhook (HMAC), then forwards over a durable channel (or the desktop app
  long-polls the relay). Flagged in §10 — it changes the distribution story.

Regardless of ingress, the receiver **verifies the HMAC signature** Linear
attaches (timing-safe compare against the webhook secret, exactly as
`hook-server.ts` / `operator-grant.ts` use `timingSafeEqual(sha256(...))`),
enforces `MAX_BODY_BYTES`, and 200s **fast** — the heavy work (spawn a pane,
emit the ack `thought`) happens after the response so the 10-second ack
contract and the webhook 5-second response expectation are both met.

### 4.5 Status mapping (saiife feed → Linear)

The connector registers as an additional listener on the two existing taps in
`index.ts`:

```
manager.onStatus((id, status) => { ...renderer + console... ; linear.onPaneStatus(id, status) })
manager.onActivity((id, entry) => { ...renderer + console... ; linear.onPaneActivity(id, entry) })
```

`status-map.ts` translates (pure function):

| saiife | Linear `AgentActivity` | resulting `AgentSession.state` |
|---|---|---|
| `working` (from `UserPromptSubmit`) | `thought` (heartbeat) / `action` (on tool-step activity entries) | `active` |
| `needs-you` (from `Notification`) | `elicitation` (body = the pending question, sourced from `manager.peek()` — the same peek `ApproveButton` shows) | `awaitingInput` |
| `idle` (from `Stop`, turn complete) | `response` (final summary) | `complete` |
| `exited` with failure message | `error` (body = the instant-exit tail) | `error` |
| no activity ~30 min | *(none — Linear auto-marks)* | `stale` |

**Debounce/coalesce:** saiife's activity ring already collapses repeated
identical hook events (`recordActivity` in `session-manager.ts` bumps a
`count`). The connector mirrors that: it does **not** emit one `thought` per
raw tick — it debounces `working` heartbeats (e.g. ≤1 `thought`/N seconds) to
respect rate limits, and only emits `elicitation`/`response`/`error` on genuine
state *transitions*. This is the rate-limit mitigation §2 calls for.

### 4.6 Driving the pane (reusing the operator control API)

Two wiring options, both keeping the guard and the capability boundary:

- **Option A (preferred): in-process control-API calls.** The connector holds
  an `OperatorGrantStore` grant for its environment and calls the exported
  `handleRequest(deps, method, url, token, body)` router directly (it's pure
  over its inputs — `control-api.ts` line ~124 documents exactly this
  testability). No socket needed; the guard on `POST /panes/:handle/prompt`
  (`deps.guard.check`) still runs, so a Linear-sourced prompt is guarded like
  any operator prompt.
- **Option B: loopback HTTP.** The connector behaves like OpenClaw — talks to
  the running control server over `http://127.0.0.1:<port>` with a bearer
  token. Simpler mental model, an extra hop.

MVP picks **A** (no reason to serialize over a socket for an in-process caller;
still fully guarded). The issue→pane creation uses `POST /panes`
(`kind: terminal`, `agentId` from config, `groupId` = the Linear "session"
group); the initial prompt and every `prompted` reply use
`POST /panes/:handle/prompt`.

### 4.7 Human-in-the-loop reuse

`needs-you` is the whole point (`design-scope-integrations.md`: "the killer
primitive"). Two surfaces, one state:

- **In Linear:** the connector emitted an `elicitation`; the human answers in
  the issue thread; the `prompted` webhook returns the text; the connector
  writes it into the pane (`POST /panes/:handle/prompt`), the pane returns to
  `working`, the connector emits a resuming `thought`.
- **In saiife:** the existing `ApproveButton` (`src/renderer/.../ApproveButton.tsx`)
  arms → peeks the pending question → confirms by writing `\r`. When the pane
  leaves `needs-you`, the connector's `onPaneStatus` sees `working` again and
  emits a `thought` so Linear reflects "resumed" even though the human acted in
  the cockpit. No new UI primitive is built — `peek` + `ApproveButton` are
  reused verbatim.

### 4.8 Textual data-flow diagram

```
                          LINEAR CLOUD
   (issue delegated to saiife app identity → AgentSession created)
        │  AgentSessionEvent{action:"created", agentSession, promptContext}
        │  (HMAC-signed)
        ▼
┌────────────────────────────── saiife main process ──────────────────────────┐
│  linear-webhook-server ──verify HMAC, size, parse──► linear-connector           │
│        (200 fast)                                        │                        │
│                                                          │ 1. grant/reuse token   │
│                                                          │ 2. POST /panes ────────┼──► control-api ─► SessionManager.create ─► pty pane
│                                                          │ 3. POST /panes/:h/prompt (guarded by saiifeguard) ─► pane gets issue context
│                                                          │ 4. emit `thought` (ack ≤10s)
│                                                          ▼
│   SessionManager.onStatus / onActivity ──► linear-connector.onPaneStatus ──► status-map ──► linear-client
│        (working/needs-you/idle/exited)                                                          │
│                                                                                                 │ GraphQL: agentActivityCreate
│                                                                                                 │ (thought/action/elicitation/response/error)
│                                                                                                 ▼
│                                                                                            LINEAR CLOUD (AgentSession.state updates)
│                                                                                                 │
│   needs-you ──► elicitation ──► awaitingInput ◄── human replies in Linear ──► AgentSessionEvent{action:"prompted"}
│        │                                                                              │
│        │  (OR human clicks ApproveButton in cockpit → write \r → pane resumes)        │ webhook back
│        ◄──────────────────────────────────────────────────────────────────────────────┘
│         linear-connector writes reply → POST /panes/:h/prompt → pane resumes → emit `thought`
│                                                                                                 │
│   idle (Stop) ──► response ──► AgentSession.state=complete ──► optional issueUpdate(stateId=Done)│
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Auth & credentials

- **Flow:** OAuth2 authorization-code with `actor=app` (`feasibility-linear.md`
  §1). `linear-oauth.ts` opens Linear's consent URL (scopes `app:assignable`
  [+ `app:mentionable` phase 2]), receives the callback, exchanges the code for
  access + refresh tokens, records the granted workspace id and the app
  identity's user id.
- **Storage — honoring the global secret rule.** Tokens live **only** in the OS
  keychain via Electron **`safeStorage`** (`linear-token-store.ts`).
  - **Never** written to `config.json`, `sessions.json`, the transcript, a log
    line, a PR body, or an IPC payload to the renderer. `config.json` holds a
    *reference* only (which workspace, that an install exists) — never the token
    (§7). This mirrors the code's existing discipline: `control-api.ts`
    explicitly refuses to log token material ("NEVER log token material — not
    even a prefix or hash. Route + reason only.").
  - The webhook **signing secret** is stored the same way.
  - Token **state** (present / expired / refresh due) may be surfaced — the
    *value* never is. This is the global CLAUDE.md rule ("prove a secret's
    state, never its value") applied verbatim.
- **Refresh:** `linear-client.ts` refreshes the access token before expiry using
  the stored refresh token; a failed refresh surfaces as a legible auth error
  (§8), not a silent stall.
- **Revoke / disconnect:** clearing the install wipes the keychain entries and
  tears down the webhook server; the connector stops. No orphaned durable panes
  are killed (they remain human-drivable) — they simply stop reporting to
  Linear, and the connector logs why.

---

## 6. Inbound triggers + write-back + human-in-the-loop mapping

Concrete API surface (all shapes isolated in `linear-client.ts` /
`linear-webhook-server.ts`). Exact field names track Developer Preview and are
verified against `developers.linear.app` at build time.

### 6.1 Inbound — webhooks

- **Register** (once, at install) via the `webhookCreate` GraphQL mutation with
  `resourceTypes` including the agent-session channel, `url` = the ingress URL
  (§4.4), scoped to the configured team(s) or `allPublicTeams`.
- **`AgentSessionEvent` payload** (the two actions the MVP handles):
  - `action: "created"` — new delegation. Body carries the `AgentSession`
    (`id`, `state`, `issue`, `promptContext`). **Contract:** ack by emitting a
    `thought` within 10s or the run is marked unresponsive.
  - `action: "prompted"` — human sent a follow-up into the session (the reply
    to an `elicitation`). Body carries the new message → written into the pane.
- **Verification:** HMAC signature (timing-safe), body size cap, JSON parse
  guard — a bad/oversized/forged body is 4xx'd and dropped, never spawned on.
- **Reliability:** Linear retries failed deliveries 3× (backoff 1m/1h/6h). A
  missed webhook is reconciled by an optional low-frequency poll of the app
  identity's `assignedIssues` / open `AgentSession`s (push-primary, poll only as
  a safety net — the rate-limit-friendly posture §2 requires).

### 6.2 Read

- Bootstrap context comes **free** on the webhook (`promptContext`) — no
  separate fetch needed for the common path.
- When more is needed: GraphQL `issue(id)` / the app user's `assignedIssues`
  connection (filter by `state`, `assignee`), standard Linear read surface.

### 6.3 Write-back (GraphQL mutations)

- **Live status / activities:** `agentActivityCreate`-style mutation emitting an
  `AgentActivity` with `content` (kind + Markdown body). This is *the* status
  channel — `thought` / `action` / `elicitation` / `response` / `error` — and it
  is what drives `AgentSession.state`. **No custom status field is used or
  needed** (Linear has none; §2).
- **Workflow state (optional, on close):** `issueUpdate(id, input: { stateId })`
  to move the issue to a Done state.
- **Comment (optional):** `commentCreate(input: { issueId, body })` for a
  human-readable summary, distinct from the activity thread.
- **Reassign (optional):** `issueUpdate(id, input: { assigneeId })` to hand back
  to a human — a lightweight alternative `needs-you` surface if desired.

### 6.4 Human-in-the-loop mapping (summary)

`needs-you` → `elicitation` → `awaitingInput` → human reply → `prompted` webhook
→ `POST /panes/:handle/prompt` → pane resumes → `thought`. OR: human clicks
`ApproveButton` in saiife → pane resumes → connector emits `thought`. One
state, two surfaces, zero new primitives.

---

## 7. Config & data model

`config.json` gains a `linear` block (config-as-code, validated at the boundary
like `parseOperatorRevokeOnExit` in `operator-config.ts` — only well-typed
values are honored; garbage disables the feature rather than throwing):

```jsonc
{
  "linear": {
    "enabled": true,
    "workspaceId": "<linear-org-id>",          // reference, not a secret
    "environment": 1,                            // which saiife env (1-9) hosts Linear work
    "agentId": "claude",                         // must be in OPERATOR_TERMINAL_AGENTS
    "webhookUrl": "https://<tunnel-or-relay>/linear/webhook",
    "moveToStateOnDone": "<optional workflow-state id>",
    "teamIds": ["<team-id>", "..."]             // or omit for allPublicTeams
  }
}
```

- **Secrets are NOT here.** The OAuth access/refresh tokens and the webhook
  signing secret live in the keychain (§5). `config.json` holds only references
  and non-secret ids.
- **Issue↔pane map** (in-memory, in `linear-connector.ts`, not persisted —
  mirrors the operator grants being in-memory): each entry ties
  `{ agentSessionId, issueId, paneId, environment, lastActivityAt, lastEmittedState }`.
  `paneId` is a saiife session id. `lastEmittedState` prevents duplicate
  activity emits; `lastActivityAt` supports the debounce and the `stale`
  reasoning. On app restart the map is empty (like grants); in-flight Linear
  sessions are reconciled from `awaitingInput`/`active` `AgentSession`s via the
  safety-net poll, and their durable panes (which *do* survive restart as
  `exited`) are re-associated by a stored `agentSessionId ↔ paneId` hint if one
  is kept, else surfaced as "needs re-link" rather than silently orphaned.
- **Environment scoping:** one environment per connected workspace in MVP. The
  block is shaped so a `workspaces: [...]` array is the additive multi-workspace
  path (§11), exactly as the operator `OperatorCredential.grants[]` was shaped
  for multi-environment.

---

## 8. Error handling

saiife's principle (from the error-message-style memory and demonstrated all
over `session-manager.ts` — instant-exit surfaces the *real tail*, the guard
*emits a visible notice*, `control-api` logs *route + reason*): **every failure
is human-readable, actionable, and carries the real underlying exception.
No silent catch. No bare "failed".** Each Linear failure maps to a legible
console/notice and, where an issue is in flight, to a Linear `error` activity so
the human sees it *in Linear too*.

| Failure | Surface in saiife | Surface in Linear |
|---|---|---|
| **Webhook signature/parse invalid** | `console.warn` route + reason, **never** the body or secret (mirrors control-api's token discipline). Console-bus `linear` row. | none (rejected before any session touch). |
| **Webhook received but pane spawn fails** (bad agent path — the `try/catch` in `session-manager.spawn` sets `info.message`) | The existing "Could not start '<cmd>' — check the agent's path" message, surfaced as a `linear` console row. | `AgentActivity` `error` with that message → `AgentSession.state = error` (so Linear doesn't hang in `pending`). |
| **10-second ack missed** (spawn slow) | Console warning naming the issue + elapsed ms. | Linear marks unresponsive; connector emits a late `thought` to recover if the pane did come up. |
| **Auth expiry / refresh failure** | Legible notice: "Linear token refresh failed: `<Linear error message>` — reconnect in Settings." **The real exception text is included**, the token value is not. Connector pauses, does not spin. | Best-effort `error` activity on any in-flight session, if a still-valid token remains; otherwise the session goes `stale` and the human is prompted in-app to reconnect. |
| **Rate-limit (HTTP 400 `RATELIMITED`)** | Notice with the `Retry-After`/reason; the emitter backs off (exponential) and coalesces pending activities. Not swallowed. | Activities are delayed, not dropped; the human sees a slightly-delayed thread, never a silent gap. |
| **Linear GraphQL error mid-session** (e.g. `issueUpdate` rejected) | Console `linear` row with the operation + the **verbatim GraphQL error** (message + code). | If the failing op *was* the status emit, retry with backoff; if it keeps failing, emit a terminal `error` activity so the session doesn't sit falsely `active`. |
| **saiifeguard blocks a Linear-sourced prompt** | The existing guard path fires: `emitNotice("⛔ saiifeguard blocked: <reason>")` into the pane + a `guard` console row (control-api already does this for operator prompts). | `AgentActivity` `error`/`elicitation` explaining the block, so the human in Linear knows why the run stopped. |
| **Ingress/tunnel down** | Startup/health check fails loudly: "Linear webhook URL `<url>` is unreachable — no issues will be picked up." Never a silent no-op. | none (inbound is dead by definition); the app makes this visible so the user knows delegation won't work. |

The connector **never** catches-and-drops. Where the code already has a loud
message (spawn failure, guard block, instant-exit tail), the connector forwards
*that* message rather than minting a vaguer one.

---

## 9. Testing strategy

Testable **without a live Linear workspace**, matching saiife's existing
seams (pure routers, injected clocks, fixture agents):

- **`status-map.ts` unit tests** — pure function; assert every
  `SessionStatus`/`ActivityEntry` → `AgentActivity` kind + body mapping,
  including the debounce/transition-only rules. (Same style as
  `state-machine.ts` tests.)
- **`linear-webhook-server` unit tests** — feed **fake `AgentSessionEvent`
  payloads** (`created`, `prompted`) with valid and invalid HMAC signatures,
  oversized bodies, malformed JSON; assert 2xx/4xx and that only valid+signed
  events reach the connector. Reuses the `hook-server.ts` test approach
  (`parseHookBody`-style boundary tests).
- **`linear-client` tests against a mocked GraphQL transport** — inject the HTTP
  seam (as `operator-guard.ts` injects its `GuardRunner`); assert the exact
  mutation/query shapes for `agentActivityCreate`, `issueUpdate`,
  `commentCreate`, and that a `RATELIMITED`/GraphQL-error response drives the
  §8 backoff/error path. No network.
- **`linear-connector` integration test** — wire a real `SessionManager` with
  the existing `spawnFn` test seam (fake pty) + a fake control-API + a mock
  Linear client. Drive a full loop: inject a `created` event → assert a pane is
  created and prompted and an ack `thought` is emitted → push a `needs-you`
  status via the fake hook event → assert an `elicitation` is emitted → inject a
  `prompted` event → assert the reply is written to the pane → push `idle` →
  assert a `response` + optional `issueUpdate`. All deterministic via the
  injected clock (`opts.now`).
- **Token store test** — `safeStorage` get/set/clear round-trips; a test asserts
  **no token value ever appears** in any emitted console/log string (a
  regression guard for the secret rule).
- **e2e (optional, phase 2)** — a `fake-linear-relay` fixture that posts canned
  webhook events at the real webhook server and captures outbound GraphQL calls,
  mirroring the `fake-openclaw.sh` / `fake-claude.sh` fixture pattern.

No test requires Linear credentials or a Developer-Preview workspace; the live
API is exercised only in manual dogfooding.

---

## 10. Open decisions (FLAGGED — not resolved here)

1. **"For me" vs "a product others install."** This is the biggest fork and it
   shapes almost everything downstream:
   - *For me* (MVP assumption): a private OAuth app in Jonas's own workspace, a
     developer tunnel for ingress, tokens in his keychain. No Linear app
     verification, no multi-tenant install, no hosted relay. Fastest to a
     working dogfood loop.
   - *Product*: a published/verified Linear app, multi-workspace OAuth install,
     a hosted webhook relay (§4.4 phase-2), per-tenant token isolation, and the
     distribution/support surface that implies. Changes auth (verification),
     ingress (relay), config (multi-workspace), and testing (multi-tenant).
   Recommendation to decide before phase 2: build MVP for "for me", but keep the
   client/token/config shapes multi-tenant-ready (they already are, by §7).
2. **Developer-Preview stability risk.** The Agents API can shift under us. How
   much to invest before it's GA? Mitigation is in place (all shapes isolated in
   `linear-client.ts`), but the *timing* of the build vs the API's GA is a
   judgment call — build now and absorb churn, or wait for GA and lose the
   first-mover dogfood value. Flagged, not resolved.
3. **The build-your-own "needs-you queue" gap.** Linear has **no** out-of-the-box
   cross-issue view of "which delegated sessions are `awaitingInput`" — only the
   per-issue activity thread + delegate-filtered views. saiife already has an
   aggregate `needs-you` surface (its Overview), so for the *operator* this gap
   is covered on the saiife side. But if the value prop is "a Linear user
   sees their agent queue *in Linear*", that aggregate view must be built (a
   saved filter / custom view over `AgentSession.state`, if filterable — not
   confirmed in the fetched docs). Decide whether the queue lives in saiife
   (MVP, free) or must also exist in Linear (phase-2 build).

---

## 11. MVP slice + phased roadmap

### Smallest first shippable slice (the "walking skeleton")

**One issue, one pane, the happy path, no board-visibility polish:**

1. Private OAuth `actor=app` install in one workspace; tokens in keychain.
2. Webhook server (behind a dev tunnel) handling `AgentSessionEvent: created`.
3. On `created`: grant + `POST /panes` (claude) + `POST /panes/:h/prompt` with
   `promptContext`, then emit the ack `thought` within 10s.
4. `onStatus` → `status-map` → emit `thought`/`response` for `working`/`idle`.
5. `needs-you` → `elicitation`; `prompted` webhook → write reply into the pane.
6. On `idle`: `response` → `complete`. Errors per §8.

That slice proves the entire loop end-to-end and is dogfoodable (Jonas delegates
a real issue and watches a saiife pane work it, reporting live in Linear).

### Phased roadmap

- **Phase 1 (MVP):** the walking skeleton above. "For me" fork. Single
  workspace, single environment, `AgentSession.state` as the sole status axis.
- **Phase 2 — board visibility + queue:** optional workflow-state/label
  convention so status shows on the Linear kanban; the Linear-side aggregate
  `needs-you` view (open decision §10.3); `@mention` triggers
  (`app:mentionable`); the safety-net reconciliation poll hardened.
- **Phase 3 — scale-out:** multi-environment and **multi-workspace** (the
  additive `workspaces: []` config + per-workspace token isolation — shaped for
  in §7); durable issue↔pane re-linking across restarts.
- **Phase 4 — product fork:** published/verified Linear app, hosted webhook
  relay, multi-tenant install (open decision §10.1).
- **Phase 5 — expand to other CRMs:** **Salesforce** is the next target
  (research verdict GREEN — plain platform APIs, Integration User + JWT/Client-
  Credentials, Approval Process API for `needs-you`; `feasibility-salesforce.md`).
  The connector's module boundaries (`*-connector` / `*-client` /
  `*-webhook-server` / `status-map`) are deliberately platform-shaped so a
  `src/main/salesforce/` peer reuses the same architecture; Jira (YELLOW) later
  if warranted. Each is a separate connector — there is no shared cross-CRM
  standard (`design-scope-integrations.md`, "Hard parts").

---

## Appendix — reused saiife surfaces (by path)

- `src/shared/agents.ts` — hook-adapter model + status-fidelity tiers; the
  connector inherits whatever fidelity the chosen agent reports.
- `src/main/session-manager.ts` — `create` / `restart` / `closeTerminal` /
  `onStatus` / `onActivity` / `applyHookEvent` / `peek` / `emitNotice`; the
  status feed the connector subscribes to; the instant-exit message the
  connector forwards to a Linear `error`.
- `src/main/state-machine.ts` — `UserPromptSubmit→working`,
  `Notification→needs-you`, `Stop→idle`, `pty-exit→exited`: the transitions
  `status-map.ts` translates from.
- `src/main/control-api.ts` — `handleRequest` router (`POST /panes`,
  `POST /panes/:handle/prompt`, `OPERATOR_TERMINAL_AGENTS`, prompt guard); the
  drive surface the connector uses in-process.
- `src/main/operator-grant.ts` — `OperatorGrantStore.grant/revoke/
  environmentForToken`; the connector's grant.
- `src/main/operator-guard.ts` + `guard/` (saiifeguard) — the prompt guard that
  covers Linear-sourced prompts identically to operator prompts.
- `src/main/hook-server.ts` — the loopback HTTP-receiver pattern the
  `linear-webhook-server` mirrors (createServer, `applyLoopbackTimeouts`,
  `MAX_BODY_BYTES`, `timingSafeEqual`, `responded` guard) + cloud ingress + HMAC.
- `src/renderer/src/components/ApproveButton.tsx` + `src/main/peek.ts` — the
  `needs-you` human-approval primitive reused verbatim (peek = the `elicitation`
  body source; `\r` = the in-cockpit resume).
- `src/main/index.ts` — the wiring point (next to `startHookServer` /
  `startControlServer`), and the `onStatus`/`onActivity` taps the connector
  joins as an additional subscriber.
