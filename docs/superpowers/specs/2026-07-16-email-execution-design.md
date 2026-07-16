# Email Execution Layer — Design (Direction 4)

**Date:** 2026-07-16
**Status:** Draft (design), pending brainstorm + spec review
**Feature:** Let localflow agents work an email inbox as a task queue — read/triage →
draft/reply/act → surface status → **a human approves the draft before it sends**.
Hard invariant: **never auto-send**. Every outbound message is a draft a human must
approve with an explicit click.

**Research basis:** `scratchpad/feasibility-email.md` (all three providers verified
live against provider docs, 2026-07-16) and Direction 4 in
`scratchpad/design-scope-integrations.md`. Consolidated verdict: **all three
providers YELLOW**; the loop is buildable on every one with a clean
draft→*separate*-send gate; **Gmail is the cleanest first target**; the only real
gate is OAuth verification, which own-inbox/testing-mode sidesteps entirely.

> This spec is written to be built from directly by localflow's own agents. It
> grounds every mechanism in localflow's *actual* architecture (paths cited inline)
> and reuses the existing peek/Approve `needs-you` gate rather than inventing a new
> approval primitive. Sequencing note (from `design-scope-integrations.md`): Linear
> (Direction 1) is the chosen *first* build; email pairs with that CRM direction and
> follows. Treat this spec as living until the Linear build validates the shared
> connector pattern.

---

## 1. Goal + MVP scope

### Goal

Turn an inbox into a `working / needs-you / done` task queue that localflow agents
work autonomously *up to the send boundary*. An agent may read, search, triage,
label, archive, mark-read, and **draft** replies. It may never send. A drafted
reply surfaces in localflow exactly like any other `needs-you` — a human peeks the
draft, clicks approve, and only then does a separate call actually send it. This
reuses the existing draft-approval gate (`ApproveButton` + `session:peek`), not a
bespoke email UI.

### MVP scope (in)

- **One provider: Gmail (consumer), own-inbox / testing-mode.** No OAuth
  verification, no CASA. The connected mailbox is the developer's / operator's own
  Google account, added as a test user on an unverified Cloud project (Google's
  testing mode covers ~100 users with restricted scopes — enough to build, dogfood,
  and prove the loop end-to-end before paying for verification).
- **Least-privilege scopes:** `gmail.readonly` (read/triage/watch) + `gmail.compose`
  (create drafts, send only drafts the app itself created). Explicitly **not**
  `gmail.modify` or `gmail.send`.
- **Triage + draft-reply with approval.** Inbound message → spawn/route an agent
  pane → agent reads the thread and drafts a reply via `users.drafts.create` → the
  pane goes `needs-you` → human peeks the draft body → approve → `users.drafts.send`.
- **Autonomous non-send actions:** label / archive / mark-read via the read+compose
  scope surface where possible (see §7 for the exact scope constraint — archiving
  requires `gmail.modify`, which the MVP *excludes*; MVP treats archive/label as
  out-of-scope actions performed by the human in Gmail, or deferred to a later scope
  decision — flagged in §11).
- **Secret handling honors the global never-render-secrets rule** (§6): OAuth
  tokens live in the OS keychain, never in the transcript, a log, config.json, or a
  message.

### MVP scope (out)

- Microsoft Graph and IMAP/SMTP providers (designed-for behind the abstraction, not
  built in MVP — Phases 2/3).
- A public, installable product with third-party mailboxes (that's the
  CASA/admin-consent fork — §11, the pivotal open decision).
- New-message composition to arbitrary recipients (MVP is reply-in-thread only;
  richer compose is a later phase — narrower blast radius, and it keeps every draft
  anchored to an inbound task).
- Any provider-side send that localflow initiates without a recorded human-approval
  event. There is deliberately no such code path (§5).
- Deliverability engineering (SPF/DKIM/reputation) — inherited from the provider
  since sends go through the user's own mailbox; explicitly not localflow's problem.
- A rich email-rendering pane. MVP surfaces the draft as peek text next to the
  Approve control, matching the existing agent-pane idiom, not an HTML mail viewer.

---

## 2. Feasibility summary

From `feasibility-email.md`: **all three providers are YELLOW.** None is RED; the
loop is buildable on every one, and the never-auto-send invariant is enforceable at
the API-call level on all three (draft-create and send are distinct calls/protocols
everywhere).

| Provider | Verdict | Draft-create | Separate send | Inbound trigger | Gate to ship broadly |
|---|---|---|---|---|---|
| **Gmail API** | YELLOW (cleanest) | `users.drafts.create` | `users.drafts.send` | `users.watch` + Pub/Sub (renew ≤7d) | CASA security assessment (~$500–4.5k/yr) for restricted scopes on a public product |
| Microsoft Graph | YELLOW | `POST …/createReply` or `POST /messages` | `POST …/messages/{id}/send` | subscription webhook (7d, no auto-renew) | admin consent for mail scopes in most tenants |
| IMAP/SMTP | YELLOW (→RED for Gmail/M365) | `APPEND` to Drafts w/ `\Draft` | separate SMTP submission | IMAP IDLE (re-issue ~29 min) | XOAUTH2 required for Gmail/M365 anyway (Basic Auth retiring 2026–27) — dodges no OAuth hurdle for the two big providers |

**The verification gate is the whole story.** Technically Gmail is the cleanest
surface (scopes map exactly to least-privilege read/draft/send). The one thing
holding it to YELLOW is that any restricted scope (`gmail.readonly`, `gmail.compose`,
`gmail.modify`) requires Google's OAuth verification **plus** an annual CASA security
assessment *once the app is public*. **Testing mode sidesteps this entirely** for up
to ~100 test users — which is exactly the MVP's own-inbox posture. So: build and
dogfood immediately in testing mode; the CASA process is only a precondition for the
"product others install" fork (§11), not for the MVP.

Why Gmail first (from the research): self-serve consent for consumer accounts (no
admin gate blocking the first pilot users, unlike M365); testing mode's 100-user
cap is enough to validate the full loop before paying for CASA; Pub/Sub push is
simpler to operate than Graph's 7-day-renew subscriptions or self-managed IMAP IDLE
reconnect logic; and the CASA cost is *known and bounded* in advance, versus the
unpredictable "convince an enterprise admin to consent" that blocks Graph.

---

## 3. Core loop → email primitives

The localflow status feed (`src/shared/types.ts`: `SessionStatus =
'idle' | 'working' | 'needs-you' | 'running' | 'exited'`) maps directly onto an
email task's lifecycle. Here is the loop, primitives named for Gmail first with the
other providers' equivalents in brackets.

```
  (1) WATCH / PULL          inbound signal that a message arrived
        Gmail : users.watch → Pub/Sub notification → users.history.list (delta)
        Graph : subscription webhook → /me/messages/delta (fallback)
        IMAP  : IDLE untagged EXISTS → FETCH new UIDs
        │
        ▼
  (2) TRIAGE / DRAFT        an agent pane works the thread
        read : users.messages.get / threads.get   [GET /me/messages | IMAP FETCH]
        the agent reasons over the thread, decides an action, and if a reply is
        warranted builds an RFC 2822 MIME reply (correct In-Reply-To / References /
        threadId) and calls:
        draft: users.drafts.create               [createReply | APPEND \Draft]
        │
        ▼
  (3) STATUS                the pane's status reflects the task
        working  = agent is reading/reasoning/drafting
        needs-you = a DRAFT exists and awaits human approval   ◄── the gate
        done/idle = task closed (draft sent, or no reply needed, or archived)
        │
        ▼
  (4) DRAFT-APPROVAL GATE   the EXISTING peek/Approve mechanism
        human peeks the draft body next to the Approve control (ApproveButton.tsx),
        reads exactly what will be sent, and clicks approve — or cancels.
        NOTHING sends without this click. (§4, §5)
        │
        ▼ (only on approve)
  (5) SEND / ARCHIVE        the separate, gated send call
        send : users.drafts.send                 [POST …/{id}/send | SMTP submit]
        then close: mark-read / archive the source thread; pane → done.
```

The critical property, true for all three providers (§2 table): step (2)'s draft
call and step (5)'s send call are **distinct** API calls. The gate lives in the seam
between them. localflow's job is to make step (5) reachable *only* from step (4)'s
human-approval event — never from an agent's own reasoning.

---

## 4. Architecture in localflow

### 4.1 The email connector

A new **email connector** subsystem in the main process, structured as a
**provider abstraction** so Gmail / Graph / IMAP are pluggable. Only the Gmail
provider is implemented in the MVP; the interface exists from day one so Phases 2/3
drop in behind it without touching the loop.

Proposed modules (main process, mirroring the existing `operator-*` / `browser-*`
naming families in `src/main/`):

| Module | Responsibility |
|---|---|
| `src/main/email/provider.ts` | The `EmailProvider` interface (§4.2) + shared types (`EmailMessage`, `EmailThreadRef`, `DraftRef`, `MailboxCursor`). Pure types + interface — no I/O, importable by renderer for view types the way `src/shared/*` is. |
| `src/main/email/gmail-provider.ts` | Gmail implementation of `EmailProvider`: REST calls (`users.messages`, `users.threads`, `users.drafts`, `users.watch`, `users.history`). Owns MIME build for reply drafts. |
| `src/main/email/gmail-auth.ts` | Gmail OAuth2: authorization-code flow, refresh, token load/store **via keychain only** (§6). Never returns a token to any surface that logs or renders it. |
| `src/main/email/watch-receiver.ts` | The inbound receiver: hosts the Pub/Sub pull/push endpoint (Gmail), the webhook (Graph), or the IDLE loop (IMAP) behind a common `onInbound(mailbox, cursor)` callback. Owns watch/subscription **renewal** and the reconciliation fallback poll. |
| `src/main/email/mailbox-registry.ts` | The set of connected mailboxes (config + runtime state): account ref, provider id, scope grant state, in-scope labels/folders, label→status map, watch expiry, last cursor. Persists the non-secret parts to `config.json` / a sidecar; secrets stay in keychain (§6, §8). |
| `src/main/email/task-router.ts` | Maps an inbound message/thread to a localflow pane: spawn an agent pane per thread, or route to a standing triage pane (§4.4). Bridges provider events → `SessionManager` / `PaneRegistry`. |
| `src/main/email/draft-gate.ts` | The **send seam** (§5). The *only* module that calls a provider's `sendDraft`. Exposes one function invoked solely from the approval IPC handler. Records the approval event. Nothing else in the codebase imports a provider's send call. |
| `src/shared/email.ts` | Shared view/DTO types for the renderer (draft peek payload, mailbox status), analogous to `src/shared/operator.ts`. |

### 4.2 The provider-abstraction interface

`EmailProvider` is the pluggable seam. Shape (documented here, not implemented in
this doc):

```
interface EmailProvider {
  readonly id: 'gmail' | 'graph' | 'imap'

  // AUTH — returns nothing renderable; tokens flow through keychain only (§6).
  authorize(account: AccountRef): Promise<void>          // interactive consent
  ensureFresh(account: AccountRef): Promise<void>         // silent refresh

  // READ / TRIAGE
  listInbound(account: AccountRef, cursor: MailboxCursor): Promise<EmailMessage[]>
  getThread(account: AccountRef, threadRef: EmailThreadRef): Promise<EmailThread>

  // DRAFT (create only — never sends)
  createReplyDraft(account: AccountRef, threadRef: EmailThreadRef,
                   body: MimeBody): Promise<DraftRef>

  // SEND — deliberately a SEPARATE method, callable only via draft-gate.ts (§5).
  sendDraft(account: AccountRef, draft: DraftRef): Promise<SendResult>

  // INBOUND TRIGGER lifecycle
  startWatch(account: AccountRef, onInbound: InboundHandler): Promise<WatchHandle>
  renewWatch(handle: WatchHandle): Promise<WatchHandle>
  reconcile(account: AccountRef, cursor: MailboxCursor): Promise<EmailMessage[]>
}
```

Each provider implements this against its own primitives (Gmail REST, Graph REST,
IMAP/SMTP). The loop (`task-router.ts`, `draft-gate.ts`, `watch-receiver.ts`) is
written *once* against `EmailProvider` and never branches on provider identity.
`sendDraft` being a named, isolated method is what makes §5's structural guarantee
auditable: exactly one caller in the whole codebase.

### 4.3 How it pulls (watch / Pub/Sub receiver)

For Gmail (MVP):

1. On mailbox connect, `gmail-provider.startWatch` calls `users.watch` naming the
   Cloud Pub/Sub topic. `watch-receiver` holds a **pull** subscription (simpler to
   operate locally than exposing a public push webhook from a desktop app — no
   inbound port, no TLS endpoint to run on the user's machine).
2. A Pub/Sub notification carries only a `historyId` (not message content). The
   receiver calls `users.history.list(startHistoryId)` to learn *what* changed, then
   `users.messages.get` for the new message(s).
3. **Renewal:** `users.watch` expires in 7 days; Google recommends daily renewal. A
   timer in `watch-receiver` re-calls `watch` daily. A lapse is a first-class error
   (§9), never silent.
4. **Reconciliation fallback:** Pub/Sub notifications "might be delayed or dropped."
   A periodic `history.list` poll (defense-in-depth) catches anything the push
   missed. The cursor (`historyId`) is persisted (`mailbox-registry`) so a restart
   resumes without missing or re-processing mail.

Graph and IMAP slot into the same `watch-receiver` behind `startWatch` /
`renewWatch` / `reconcile` — Graph via subscription webhook + `/messages/delta`
reconcile (7-day, no auto-renew — the renew timer just runs at a different cadence);
IMAP via a long-lived IDLE connection with ~29-minute re-IDLE and a periodic
`SEARCH`-since reconcile. The lifecycle differences are entirely inside each
provider; the receiver's contract is identical.

### 4.4 Spawning a pane per email/thread (or a triage pane)

Two shapes, both reusing the existing pane/session model
(`src/main/pane-registry.ts`, `src/main/session-manager.ts`) and the operator
pane-creation path (`POST /panes` in `src/main/control-api.ts`):

- **Pane-per-thread (MVP default):** `task-router` creates one agent terminal pane
  per inbound thread (an agent preset from `src/shared/agents.ts` — `claude` in the
  MVP), in a dedicated email *environment*. The agent is prompted with the thread
  context and the drafting task. Thread↔pane is 1:1: the pane's lifecycle *is* the
  task's lifecycle, so the status feed maps cleanly (working→needs-you→done). This
  matches how the operator loop already drives panes and how Direction 1 (Linear)
  spawns a session per item.
- **Standing triage pane (alternative, flagged §11):** one long-lived pane receives
  a queue of inbound summaries and triages in bulk, spawning per-thread panes only
  when a reply is warranted. Lower pane churn for high-volume inboxes; muddier
  status mapping (one pane, many tasks). MVP picks pane-per-thread for the clean
  status mapping; the router is written so the triage-pane strategy is a later swap.

Thread/conversation state → pane mapping is an explicit open decision (§11): a reply
often reopens a thread days later, after its pane went `done` or was closed. The
router keys panes by provider thread id and, on a new inbound message for a
known-but-closed thread, either resurrects the durable session
(`src/main/persistence.ts` already persists sessions/groups by id) or spawns a fresh
pane carrying the prior thread context. MVP: spawn fresh, load thread history from
the provider (`getThread`) so no local thread state has to be durable.

### 4.5 Mapping status onto the feed

The agent pane already emits `working / needs-you / done` via the hook-driven status
feed (`src/main/state-machine.ts`, `src/main/hook-server.ts`). The email connector
does **not** invent a parallel status system — it *reads* the same feed:

- Agent starts reading/drafting → hooks drive `working` (via `UserPromptSubmit`).
- Agent finishes a draft and asks the human to approve → the agent emits its
  turn-complete / `Notification`, driving `needs-you` (`state-machine.ts` maps
  `Notification → needs-you`). This is the **exact** signal `ApproveButton` already
  keys on — a drafted reply surfaces as `needs-you` with no new machinery.
- Human approves → send fires (§5) → the task closes → pane goes `idle`/`done`.

So "a draft awaiting approval" and "an agent pane waiting on the human" are the same
feed state, surfaced by the same UI control. That reuse is the core architectural
bet.

### 4.6 The draft-approval gate — reusing peek/ApproveButton

This is the load-bearing reuse. The existing control
(`src/renderer/src/components/ApproveButton.tsx`) is *arm-then-confirm, never
blind*: clicking it fetches a **peek** of the pane's recent output
(`window.localflow.peekSession` → `session:peek` → `src/main/peek.ts`
`extractPeekLines`) and shows it beside a confirm button; confirming writes Enter to
the pane's pty. For email we keep the identical interaction and swap what "peek"
returns and what "confirm" does:

- **Peek shows the draft, not terminal tail.** For an email-task pane, the peek
  payload is the **draft body that will be sent** (subject, To/Cc, and the reply
  text), fetched from the provider by `DraftRef`. A human reads *exactly* what will
  go out — same "never blind" property `ApproveButton` already guarantees, applied
  to the outbound message. (Implementation: the peek IPC for an email pane resolves
  through `draft-gate`/`gmail-provider` to the draft content rather than
  `extractPeekLines` on pty output.)
- **Confirm sends the draft, not Enter.** The confirm action calls the approval IPC
  (§5), which is the *sole* path into `draft-gate.sendDraft`. The button already
  reads "Send ⏎" in `ApproveButton.tsx` — the label needs no change; its meaning
  becomes literal.
- Cancel / outside-click / bare-Escape disarm exactly as today — leaving the draft
  in place (a real Gmail draft the human can also edit/send in Gmail itself).

No new approval widget. The email layer's UI surface is: the pane appears in the
feed as `needs-you`; the human uses the same Approve control they use for every
other agent question; the peek is the outbound email.

### 4.7 Textual data flow (Gmail, end to end)

```
new mail arrives in Gmail
  → Gmail publishes historyId to Pub/Sub topic
  → watch-receiver (pull subscription) receives it
  → gmail-provider.reconcile/listInbound: history.list → messages.get
  → task-router: is this thread in scope? (mailbox-registry label/folder filter)
        no  → ignore
        yes → resolve/spawn agent pane for threadId (pane-per-thread)
  → agent pane (SessionManager pty): prompted with thread context
  → agent reads thread (getThread), reasons, decides to reply
  → agent calls createReplyDraft → users.drafts.create → DraftRef (NO send)
  → agent signals turn-complete → hook → state-machine → pane status = needs-you
  → localflow feed shows the pane as needs-you; user clicks Approve
  → ApproveButton arms: peek IPC returns the DRAFT BODY (not pty tail)
  → user reads the exact outbound text, clicks "Send ⏎"
  → approval IPC → draft-gate.sendDraft (THE ONLY SEND CALLER)
        → records approval event (who/when/which draft)
        → gmail-provider.sendDraft → users.drafts.send
  → send result → pane status → done; source thread mark-read/archive (scope perms)
  ── any failure at watch/draft/send/auth → §9 legible error, never silent ──
```

---

## 5. The never-auto-send invariant

**Statement:** localflow must have *no* code path that sends an email except one
gated behind an explicit, recorded human-approval event. An agent — however it
reasons, whatever it is prompted or jailbroken to do — cannot cause a send.

This is enforced **structurally**, not by policy or prompt:

1. **Distinct calls, by construction.** Draft-create and send are separate provider
   calls on all three providers (§2). The combined "compose-and-send in one call"
   verbs (Gmail has none for drafts; Graph's `sendMail`; SMTP direct `DATA` without
   the draft step) are **never wired** — `EmailProvider` exposes `createReplyDraft`
   and `sendDraft` as two methods and offers no combined verb. A code review can
   confirm no provider file calls a one-shot send.

2. **A single send caller.** `sendDraft` is invoked from exactly one place:
   `src/main/email/draft-gate.ts`, itself reachable only from the approval IPC
   handler (the "Send ⏎" confirm in `ApproveButton`). Grep for `.sendDraft(` yields
   one non-test caller. This is enforceable as a test (§10) and a review checklist
   item. The agent's pane has *no* tool, control-API route, or IPC that reaches
   `sendDraft`.

3. **The agent surface is read+draft only.** The agent works the pane through the
   normal pty/operator surface. Its available email actions are read/triage/draft —
   it can call `createReplyDraft` (which cannot send). It has no send affordance at
   all. The send lives on the *human* side of the peek/Approve gate, in the
   renderer→main IPC that only fires on a confirm click.

4. **Scope as a backstop where possible.** Least-privilege scopes reinforce the
   above but are not the primary control (because `gmail.compose` bundles
   create-draft *and* send-a-draft — the same scope can do both). The real
   enforcement point is application-level: the one gated caller. Where role-splitting
   is feasible later (a separate "sender" credential the drafting agent never holds),
   it can harden further — flagged, not required for MVP.

5. **Approval is recorded, not ephemeral.** `draft-gate` records each approval event
   (draft id, mailbox, timestamp) before it calls `sendDraft`, so every send is
   traceable to a human action. This mirrors localflow's existing guard-audit trail
   posture (`src/main/guard-audit-tail.ts`) — an auditable "who approved this send"
   log, no email content or secrets in it.

The invariant is buildable as a *hard design constraint*, confirmed by the research:
the platform's send-executing code is simply never invoked until the `needs-you →
approved` transition fires.

---

## 6. Auth & credentials

### OAuth2 scopes — least privilege

MVP (Gmail): `https://www.googleapis.com/auth/gmail.readonly` +
`https://www.googleapis.com/auth/gmail.compose`.

- `gmail.readonly` — read messages/threads/labels, and it is sufficient for
  `users.watch`. Covers triage + inbound.
- `gmail.compose` — create/read/update/delete **drafts**, and send *those* drafts.
  Scoped to the draft lifecycle; does **not** grant blanket send of arbitrary
  pre-composed mail (that's `gmail.send`, deliberately avoided). Maps exactly onto
  "draft, then send-the-draft-after-approval."
- Explicitly **not** `gmail.modify` (adds label/archive/permanent surface beyond
  what MVP triage strictly needs — see the §11 archive/label trade-off) and **not**
  `mail.google.com/` (full access incl. permanent delete).

Per provider (behind the abstraction, later phases):

- **Graph:** delegated `Mail.ReadWrite` (read + create drafts, no send) +
  `Mail.Send` (send the approved draft). Delegated, not application — keeps blast
  radius to the single connected mailbox, not tenant-wide.
- **IMAP/SMTP:** XOAUTH2 (SASL) against the provider's OAuth app; no scope names of
  its own — inherits the provider's (so IMAP against Gmail lands in the same
  restricted-scope bucket; against a small provider, an app-specific password with
  no OAuth review). Basic Auth is treated as legacy/dying and not designed around.

### Token storage — honoring never-render-secrets

Per the user's global rule (secret material must never be rendered into the
transcript, a file, a commit, a log, a PR, or a message):

- **OAuth refresh/access tokens live in the OS keychain** (macOS Keychain via
  Electron `safeStorage` / `keytar`-style secure store), keyed by account id. They
  are **never** written to `config.json`, `sessions.json`, or any sidecar; never
  logged; never returned to the renderer; never placed in a pane's env in cleartext.
- `gmail-auth.ts` is the *only* module that touches raw token material. It exposes
  `ensureFresh()` / an authenticated request helper — never a "get me the token"
  accessor that a caller could log. This mirrors how `operator-grant.ts` handles the
  bearer secret: constant-time compare, and the control-API is under strict orders
  never to log token material (`control-api.ts` logs "route + reason only, NEVER
  token material — not even a prefix or hash").
- **Auth errors prove state, not value.** Diagnostics report token *expiry*/scope/
  presence, never the token itself (mirrors the global "prove a secret's state,
  never its value" rule). An expiry error says "Gmail token for <account> expired,
  re-consent needed" — no token, no prefix, no hash.
- The OAuth *client secret* of the Cloud project (if a desktop client is used) is
  itself sensitive: stored in keychain / injected at build, never committed. For a
  desktop-app OAuth client Google treats the client secret as non-confidential (PKCE
  is the real protection), but localflow still keeps it out of the repo and logs.
- The provider abstraction's auth is per-provider (`EmailProvider.authorize` /
  `ensureFresh`), each backed by its own keychain-stored credential; no shared global
  secret across mailboxes.

---

## 7. Inbound trigger + write-back mapping (concrete API calls)

### Gmail (MVP)

| Step | Call | Notes |
|---|---|---|
| Inbound register | `POST users.watch` (topicName) | grant `gmail-api-push@system.gserviceaccount.com` publish on the topic; expires 7d, renew daily |
| Inbound notify | Pub/Sub message → `historyId` | pull subscription in `watch-receiver` |
| Learn changes | `users.history.list(startHistoryId)` | delta since last cursor |
| Read message | `users.messages.get(id, format=full)` | body + headers |
| Read thread | `users.threads.get(threadId)` | full conversation context for the agent |
| Search/triage | `users.messages.list(q=…)` | Gmail search operators (`is:unread`, `from:` …) |
| **Draft reply** | `users.drafts.create` (`message.raw` = base64url RFC 2822, with `In-Reply-To`/`References`, `threadId`) | genuine draft; **does not send** |
| **Send (gated)** | `users.drafts.send(draftId)` | separate call; only from `draft-gate` |
| Mark-read / archive / label | `users.messages.modify` (remove `UNREAD` / remove `INBOX` / add labelId) | **requires `gmail.modify`** — outside MVP's scope set; see §11 |

Scope note: MVP's `readonly`+`compose` does the read + draft + send-draft loop fully,
but **cannot** mark-read/archive/label (those need `gmail.modify`). MVP therefore
either (a) leaves the source message state to the human in Gmail, or (b) adds
`gmail.modify` and drops `compose`+`readonly` (modify is a superset of both for these
purposes). This is a real scope trade-off flagged in §11 — the MVP default is the
narrower read+draft+send loop; archive/label is a fast-follow scope decision.

### Microsoft Graph (Phase 2)

Inbound: `POST /subscriptions` on `/me/mailFolders('inbox')/messages` (webhook, 7-day
max, PATCH `expirationDateTime` to renew; reconcile via
`/me/mailFolders/inbox/messages/delta`; handle `missed`/`reauthorizationRequired`
lifecycle events). Read: `GET /me/messages`, `GET /me/mailFolders`. **Draft:**
`POST /me/messages/{id}/createReply` (or `/messages` for fresh). **Send (gated):**
`POST /me/messages/{id}/send`. Never `sendMail` (combined compose+send). Move/read:
`PATCH /me/messages/{id}` (`isRead`), `POST /me/messages/{id}/move`.

### IMAP/SMTP (Phase 3)

Inbound: `IDLE` (RFC 2177), re-issue ~29 min, reconnect-with-backoff self-managed,
periodic `SEARCH SINCE` reconcile. Read: `SELECT`/`SEARCH`/`FETCH`. **Draft:**
`APPEND` to Drafts with the `\Draft` flag. **Send (gated):** separate SMTP
submission (`MAIL FROM`/`RCPT TO`/`DATA`) via the provider's submission server,
XOAUTH2-authenticated — naturally decoupled from the IMAP draft. Move/read: `STORE`
flags, `COPY`/`MOVE`.

---

## 8. Config & data model

Config-as-code, consistent with localflow's existing `config.json`
(user-editable, validated at the boundary — see `operator-config.ts`,
`environment-names.ts`). **Secrets never appear here** (§6) — tokens are keychain
references only.

`mailbox-registry` persists (non-secret) roughly:

```
mailboxes: [
  {
    id: "acct-primary",              // stable local id; keychain key
    provider: "gmail",              // 'gmail' | 'graph' | 'imap'
    address: "me@example.com",      // display only; not a secret
    oauthAppRef: "gmail-desktop",   // which OAuth client/config to use (NOT the secret)
    environment: 7,                  // which localflow environment hosts its panes
    inScope: {                       // which inbox/labels are worked
      labels: ["INBOX", "UNREAD"],  // Gmail label ids / Graph folder ids / IMAP folders
      query: "is:unread -category:promotions"   // optional provider search filter
    },
    labelStatusMap: {                // label/folder → status hint (informational)
      "INBOX/UNREAD": "working",
      "Awaiting-Reply": "needs-you"
    },
    paneStrategy: "per-thread",     // 'per-thread' | 'triage-pane'  (§4.4, §11)
    watch: { topic: "…", expiresAt: <ms> },   // renewal bookkeeping (no secret)
    cursor: { historyId: "…" }       // last processed; resumes across restart
  }
]
```

- **account** — id + address + which localflow environment its panes live in.
- **OAuth app ref** — *which* OAuth client/config, by name; the client secret and
  user tokens are in keychain, not here.
- **label/folder → status mapping** — declares which labels mean "in scope" and an
  optional hint mapping label→status. The authoritative status is still the pane's
  live feed (§4.5); this map is for filtering inbound and for future label-driven
  triage.
- **which inbox/labels are in scope** — `inScope.labels` + optional `inScope.query`
  bound *what the agent ever sees*. A blast-radius control: the agent only receives
  messages matching the scope filter (e.g. a single label, not the whole mailbox).

Approval-audit records (§5) persist separately (append-only, like
`guard-audit.jsonl`) — draft id, mailbox id, timestamp, no content, no secret.

---

## 9. Error handling

localflow's error principle (from the trust-foundation work, `[[error-message-style]]`
/ loud-and-legible): every failure surfaces a message that is **human-readable,
actionable, and carries the real underlying error** — never silent, never a swallowed
exception. The email layer has several failure modes that *must* be legible because
the whole system is autonomous and a silent lapse means mail quietly stops being
worked. Each maps to a console/feed notice via the existing `emitNotice` /
console-bus / guard-audit surfaces (`session-manager.ts` `emitNotice`,
`console-bus.ts`).

| Failure | Detection | Legible message (human + actionable + real error) | Never |
|---|---|---|---|
| **Auth expiry** | `ensureFresh` refresh fails / 401 | "Gmail token for me@example.com expired — re-consent to resume working this inbox. (invalid_grant)" | log/render the token; silently stop pulling |
| **Watch / subscription lapse** | daily renew fails; expiry passed; Graph `missed`/`subscriptionRemoved`; IDLE socket dropped | "Inbox watch for me@example.com lapsed at <time> — new mail may be delayed; reconnecting. Fell back to reconcile poll." | let notifications silently stop; drop mail with no signal |
| **Draft API failure** | `drafts.create` non-2xx | "Couldn't save the reply draft for thread <subj> — <provider error>. The task stays needs-you; retry or draft manually in Gmail." | mark the task done; lose the reply |
| **Send failure (post-approval)** | `drafts.send` non-2xx after a human approved | "Send failed for the approved reply to <subj> — <provider error>. The draft is preserved in Gmail; nothing was sent. Approve again to retry." | claim it sent; double-send on retry (idempotent by draft id) |
| **Rate limit / throttle** | 429 / Gmail quota / Graph `Retry-After` | "Gmail rate limit hit — backing off <n>s, then resuming. No mail lost." | hammer the API; fail the task outright |

Cross-cutting rules:

- **Real error attached.** The provider's actual error code/body is included
  (sanitized of any secret) — mirrors lfguard's block reason and the control-API's
  "route + reason" logging. No generic "something went wrong."
- **Reconcile is the safety net.** Any inbound-path failure (watch lapse, dropped
  Pub/Sub, IDLE drop) degrades to the periodic reconcile poll (§4.3) so mail is
  worked late, never lost — and the degradation is announced, not silent.
- **Send failures never double-send.** Retry re-sends *the same draft id*; the
  provider dedupes; the approval record ties the retry to the original approval.
- **Secret-safe by construction.** Every message above proves state (expiry, code,
  count), never value (§6). No token, prefix, or hash in any error.

---

## 10. Testing strategy

- **Mock provider.** A `MockEmailProvider` implementing `EmailProvider` (§4.2) with
  in-memory inbox/drafts/sends. The entire loop (`watch-receiver`, `task-router`,
  `draft-gate`, status mapping) is tested against the mock with **no network** —
  same posture as the control-API being "pure over its inputs, so every route is
  unit-testable" (`control-api.ts`). Gmail-specific wire behavior (MIME build,
  history delta, base64url raw) is tested separately against recorded fixtures.
- **The never-send invariant is tested explicitly** (the load-bearing test):
  1. *Single caller:* a static/grep test asserting exactly one non-test caller of
     `provider.sendDraft` (in `draft-gate.ts`) — CI fails if a second appears.
  2. *No send without approval:* drive a full inbound→draft cycle through the mock;
     assert `mock.sends` stays empty until the approval IPC fires; assert that
     agent-side actions (drafting, triage, any pane write) never increment
     `mock.sends`.
  3. *Approval → exactly one send:* on the confirm event, assert `sendDraft` called
     once with the approved `DraftRef`, and an approval-audit record was written
     first.
  4. *No combined-send verb wired:* assert no provider implementation references the
     one-shot send (`sendMail`, raw SMTP `DATA` outside the draft path) — grep test.
- **Draft-approval UI reuse:** test that an email-task pane surfaces as `needs-you`
  and that the peek payload is the draft body (not pty tail), reusing the existing
  `ApproveButton` behavior tests.
- **Error legibility:** each §9 row has a test asserting the failure produces a
  notice with the actionable text *and* the real error, and asserting **no token
  material** appears in any emitted string (regex-scan the notice for the token).
- **Watch renewal / reconcile:** simulate a lapsed watch and a dropped notification
  against the mock; assert reconcile recovers the missed message and a legible
  degradation notice was emitted.

---

## 11. Open decisions (flagged)

### ★ DECISION 1 — Own inbox (local, testing-mode, no verification) vs a product others install (CASA / admin-consent burden)

**This is the pivotal fork.** It reshapes auth, go-to-market, and cost.

- **Own inbox / testing mode (MVP posture, recommended start):** the connected
  mailbox is the operator's own Google account as a test user on an unverified Cloud
  project. Testing mode covers ~100 users with restricted scopes — enough to build,
  dogfood, and prove the whole loop. **No OAuth verification, no CASA, $0
  verification cost, no admin gate.** Local-first, matches localflow/OpenClaw
  identity. Ceiling: ~100 users, and it's *your* inbox, not a distributable product.
- **Product others install:** third parties connect their own mailboxes → Google
  restricted-scope **OAuth verification + annual CASA security assessment
  (~$500–$4,500/yr via a third-party assessor)**, re-verified every 12 months, weeks
  of lead time; for Graph, **admin consent** in most M365 tenants (a per-org gate
  that can be slower than CASA in practice). This changes the auth model (a hosted
  OAuth app, publisher verification, a consent screen), the trust story, and the
  business model.

**Recommendation:** ship the MVP entirely in the own-inbox/testing-mode posture;
treat CASA/admin-consent as a *gated* precondition for a public launch, decided
only after the loop is proven. The architecture (provider abstraction, keychain
tokens, gated send) is identical either way — only the OAuth app registration and
verification status differ — so this fork does not block building now.

### ★ DECISION 2 — Which provider after Gmail: Microsoft Graph vs IMAP/SMTP

Gmail is settled as first. Second target is a real choice: **Graph** reaches the
large M365/Outlook market with the same clean draft/send split and managed
subscriptions, but carries admin-consent friction and 7-day no-auto-renew
subscription bookkeeping. **IMAP/SMTP** is universal for small/self-hosted providers
with *no* OAuth review — but for Gmail/M365 it dodges no OAuth hurdle (XOAUTH2
required as Basic Auth retires 2026–27) while giving up structured search and managed
push. Research leans **Graph second** (same architecture, big market, "convince an
admin" is the main cost), reserving IMAP for the long tail. Flag for the phase-2
brainstorm.

### ★ DECISION 3 — How thread/conversation state maps to a pane

A reply can reopen a thread days after its pane went `done`/closed. Options:
(a) **pane-per-thread, spawn-fresh** (MVP): key panes by provider thread id; on a new
message for a closed thread, spawn a fresh pane and reload history from the provider
(`getThread`) — no durable local thread state, simplest, clean status mapping, but
loses in-pane context between reopenings. (b) **Resurrect durable session:** reuse
the persisted session (`persistence.ts` keys by id) so the pane resumes with its
prior context — richer, but couples thread lifecycle to session durability and
muddies "done." (c) **Standing triage pane** (§4.4): one pane, many threads — least
churn, worst status mapping. MVP picks (a); (b)/(c) are the scaling questions. Also
bundled here: the **scope trade-off** from §7 — read+draft+send (`readonly`+`compose`,
no archive/label) vs adding `gmail.modify` to let the agent mark-read/archive/label
autonomously. MVP defaults to the narrower loop; the archive/label capability is a
fast-follow scope decision.

---

## 12. MVP slice + phased roadmap

**MVP (Phase 1) — Gmail own-inbox, triage + draft-reply with approval:**

1. `EmailProvider` interface + `MockEmailProvider` (test-first — §10).
2. `gmail-auth` (authorization-code + refresh, keychain-only tokens).
3. `gmail-provider`: read (messages/threads/history), `createReplyDraft` (MIME build),
   `sendDraft` (isolated), `startWatch`/`renewWatch`/`reconcile`.
4. `watch-receiver` (Pub/Sub pull) + daily renew + reconcile poll.
5. `mailbox-registry` + config schema (§8); `task-router` (pane-per-thread).
6. `draft-gate` (the single send caller) + approval IPC wired to the existing
   `ApproveButton` confirm; peek returns the draft body.
7. Status mapping verified end-to-end; the never-send invariant tests green (§10).
8. Error legibility for all §9 rows.

Ships as: connect your own Gmail (testing mode) → new mail spawns an agent pane →
agent drafts a reply → pane goes `needs-you` → you peek the exact draft and click
approve → it sends. Nothing sends without that click.

**Phase 2 — Microsoft Graph** (pending Decision 2): implement `EmailProvider` for
Graph (delegated `Mail.ReadWrite`+`Mail.Send`, subscription webhook + delta,
createReply/send split). Loop code unchanged.

**Phase 3 — IMAP/SMTP** (long-tail providers): XOAUTH2, IDLE receiver, `APPEND
\Draft` + separate SMTP submit. Loop code unchanged.

**Phase 4 — richer actions:** autonomous label/archive/mark-read (the `gmail.modify`
scope decision, Decision 3); fresh compose to new recipients (with the same
draft-approval gate); label-driven triage; the standing triage-pane strategy for
high-volume inboxes; and — the public-product path — OAuth verification + CASA /
admin-consent (Decision 1) if localflow goes distributable.

**Sequencing reminder** (`design-scope-integrations.md`): Linear (Direction 1) is the
chosen first integration build; email follows and pairs with it. Expect the Linear
build to surface connector-pattern gaps that refine this spec — treat it as living
until then.

---

## Appendix — localflow modules this design reuses (by path)

- `src/renderer/src/components/ApproveButton.tsx` — the draft-approval gate UI, reused
  verbatim (peek → confirm), with peek returning the draft body and confirm calling
  the send IPC.
- `src/main/peek.ts` (`extractPeekLines`) + `session:peek` — the peek mechanism; email
  panes resolve peek to draft content instead of pty tail.
- `src/shared/agents.ts` (`SessionStatus`, agent presets) + `src/main/state-machine.ts`
  — the `working / needs-you / done` feed the email lifecycle maps onto (`Notification
  → needs-you` is the draft-awaiting-approval signal).
- `src/main/control-api.ts` + `src/main/operator-grant.ts` + `src/main/pane-registry.ts`
  + `src/main/session-manager.ts` — the operator/pane loop that drives a pane per
  thread; the token-never-logged posture the email auth follows.
- `src/main/persistence.ts` — durable session model (thread↔pane resurrection option).
- `src/main/operator-config.ts` / `environment-names.ts` — the config-as-code,
  validate-at-the-boundary pattern the mailbox config follows.
- `src/main/guard-audit-tail.ts` — the append-only, secret-free audit posture the
  approval-audit log follows.
- `src/main/console-bus.ts` / `session-manager.ts` `emitNotice` — the surfaces §9's
  legible errors are emitted through.
```
