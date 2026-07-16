# Integrations Hub — Design

**Date:** 2026-07-16
**Status:** Design (spec) — not started. Sub-project **#1 of 3** of the
"visual-flows pilot" initiative (Integrations Hub → Flow Engine → Flow Canvas),
brainstorm-approved 2026-07-16.
**Feature:** A single, opt-in place in localflow where a user **enables** an
integration, sets its **credentials** (secret fields → OS keychain; non-secret
refs → `config.json`), and sees a live **connection status**. It owns the
**IntegrationRegistry** — the single source of truth of `IntegrationDescriptor`s
that sub-project 2 (Flow Engine: trigger/action dispatch) and sub-project 3
(Flow Canvas: palette UI) read. It reuses the connectors just built as offline
foundations (Linear `src/main/linear/*`, Email `src/main/email/*`, Cloud
`src/main/cloud-credentials.ts` + the two lfguard packs) — it does **not**
reinvent their loops; it configures and reports on them.

Grounding: this spec is written to be built directly by localflow's agents. Every
mechanism is anchored to the *actual* codebase (paths cited inline). It reuses
the Settings section idiom (`src/renderer/src/components/Settings.tsx`), the
Cockpit status-pill + token-never-shown hygiene
(`src/renderer/src/components/Cockpit.tsx`), and the config-as-code
validate-at-the-boundary pattern
(`src/main/operator-config.ts`, `src/main/environment-names.ts`,
`src/main/agent-registry.ts`). It is the sibling of the three connector specs
(`2026-07-16-linear-integration-design.md`, `-email-execution-design.md`,
`-devops-cloud-execution-design.md`) and follows their house style.

---

## 1. Goal + MVP scope

**Goal (one sentence):** Give each integration (`linear`, `email`, `cloud`) a
first-class **tab** where a human enables it and provides its config — with every
secret field written **only** to the OS keychain and every non-secret reference
written to `config.json` — behind one **IntegrationRegistry** whose
`IntegrationDescriptor`s the flow engine and canvas consume, so that "what
integrations exist, what they need, and whether they're connected" has exactly
one authority.

### In scope (MVP — the foundation slice)

- **`CredentialStore`** — a keychain-backed secret store (Electron `safeStorage`)
  behind an **injectable seam** (`SecretBackend`), so it is fully unit-testable
  offline. It exposes **presence/status only** across any IPC/log boundary and
  **never** returns a secret value to the renderer, a log line, a transcript, or
  a config file. (§4.1)
- **`IntegrationRegistry`** — holds the three `IntegrationDescriptor`s and derives
  each one's `status()`. The single source of truth sub-projects 2 and 3 read.
  (§4.2)
- **Three descriptors** — `linear`, `email`, `cloud` — each declaring its
  `configFields` (secret vs non-secret), `triggers`, and `actions`, drawn from
  the three connector specs' auth/config sections (§4.3, §7).
- **Config-as-code** for the non-secret references: an `integrations` block in
  `config.json`, parsed and **validated at the boundary** (malformed → dropped +
  feature disabled, never a throw), exactly like `parseEnvironmentNames` /
  `parseOperatorRevokeOnExit`. (§4.4, §8)
- **The per-integration tab UI** — an `Integrations` view with one panel per
  integration: an **enable toggle**, **typed config fields**, **masked secret
  entry** that writes to the keychain (and only ever reports back "set / not
  set"), and a **live status pill** (green connected / yellow needs-config / red
  error), reusing the Settings card idiom and the Cockpit status-dot idiom.
  (§4.5)
- **The load-bearing invariant test:** no secret value ever appears in any IPC
  payload or any emitted log/notice string. (§9, §10)

### Out of scope (MVP) — explicitly deferred

- **Any live OAuth handshake or live connector start.** MVP only *stores,
  validates the shape of, and reports* credential state. The Linear `actor=app`
  install, the Gmail consent flow, and the AWS `AssumeRole` mint are Phase 2 —
  the descriptors and store are shaped so those drop in behind the same fields.
- **The flow engine's action dispatch** (sub-project 2) and the **canvas palette
  UI** (sub-project 3). This spec *defines and owns* the `IntegrationDescriptor`
  interface they consume (§11) and stops there.
- **Live credential validation via a real network round-trip.** MVP `status()` is
  derived from config + credential *presence*; a per-descriptor async
  `validate()` that makes a cheap read call is Phase 2 (§10 open decision).
- **More connectors** (Salesforce, MS Graph, GCP/Azure). The registry is additive
  — a new descriptor file is the whole change (§12).
- **Secret rotation/expiry UX, multi-account/multi-workspace fan-out.** The field
  and store shapes are designed to make these additive (§8, §12).

localflow with **no** integration configured behaves exactly as it does today —
the Integrations view simply shows three disabled panels. Opt-in is absolute.

---

## 2. Where this sits in the initiative

The visual-flows pilot is a **hybrid** engine: deterministic routing/gating,
agent panes doing content, humans approving at gates ("boolean, not feelings of
LLMs"). It is three sub-projects:

| # | Sub-project | Owns | Consumes |
|---|---|---|---|
| **1** | **Integrations Hub (this spec)** | `IntegrationRegistry` + `IntegrationDescriptor`s; `CredentialStore`; the config block; the per-integration tabs | the three connector modules (linear/email/cloud) |
| 2 | Flow Engine | trigger→flow start, action dispatch, gating | this registry's `triggers` / `actions` / `status()` |
| 3 | Flow Canvas | the visual palette / node UI | this registry's descriptors (labels, field metadata) |

The **pinned `IntegrationDescriptor`** (§11) is the contract across all three.
This sub-project defines it verbatim and is its sole author; 2 and 3 are strict
consumers.

---

## 3. The three connectors this Hub configures

Each connector already exists as an offline foundation; the Hub does not touch
their loops — it owns their *config surface* and *status*. The auth/config facts
below are lifted from each connector spec's auth section and drive the
descriptors in §4.3 / §7.

| Integration | Secret material (→ keychain) | Non-secret refs (→ config.json) | Source spec § |
|---|---|---|---|
| **linear** | OAuth access+refresh token (or, MVP interim, a pasted API key); webhook **signing secret** | `workspaceId`, `teamIds[]`, `environment` (1-9), `agentId`, `webhookUrl`, `moveToStateOnDone` | linear §5, §7 |
| **email** (Gmail) | OAuth refresh token (and, if a desktop client secret is used, that secret) | mailbox `address`, `oauthAppRef` (client *name*, not the secret), `environment`, `inScope.labels`/`query`, `paneStrategy` | email §6, §8 |
| **cloud** (AWS) | **none** — the keyless model holds no long-lived secret | `roleArn`, `externalId` (explicitly non-secret), `region`, `sandboxAccountId`, `durationSeconds`, `packs[]` | devops §6, §8 |

**Cloud is the important edge case:** it has **zero secret fields**. Its
`status()` cannot mean "a secret is stored" — it means "the non-secret identity
refs are present (and, Phase 2, a dry `AssumeRole` succeeded)." The descriptor
model (§11) supports an all-non-secret `configFields` array precisely so `cloud`
is a first-class tab without bending the shape.

---

## 4. Architecture in localflow

A new **main-process module set** under `src/main/integrations/`, a shared types
file, IPC wiring, and one renderer view. It is a peer of the operator/agent
subsystems, wired in `src/main/index.ts` alongside the other registries.

### 4.1 `CredentialStore` — keychain-backed, seam-injected (`src/main/integrations/credential-store.ts`)

**Responsibility:** the *only* module in localflow that touches raw secret
material for integrations. Get/set/clear behind Electron `safeStorage`. It never
returns a secret across an IPC boundary, into a log, or into `config.json`.

There is **no `safeStorage` usage anywhere in the codebase today** (confirmed by
`grep -rn safeStorage src/` → no hits) — this module is the first, so it sets the
pattern the connector token-stores (`linear-token-store.ts`, `gmail-auth.ts`)
adopt rather than each rolling their own.

**The injectable seam** — mirrors `session-manager.ts`'s `SpawnFn` and
`operator-guard.ts`'s `GuardRunner` injected-dependency style, so tests pass a
fake in-memory backend and never touch the real OS keychain:

```
// Structural subset of Electron's safeStorage — the seam tests replace.
interface SecretBackend {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}
```

Electron `safeStorage` *encrypts* to a `Buffer` using an OS-provided key; it does
not itself persist. `CredentialStore` therefore persists the encrypted blob to a
**sidecar file** in `userData` (e.g. `integration-secrets.enc`, one JSON map of
`"<id>:<key>" → base64(ciphertext)`), **never** `config.json`. (Persistence
location is a flagged decision — §10.)

**Public surface (what callers may do):**

```
class CredentialStore {
  constructor(deps: { backend: SecretBackend; file: string })

  available(): boolean                        // backend.isEncryptionAvailable()
  has(id: IntegrationId, key: string): boolean          // presence only
  set(id: IntegrationId, key: string, value: string): void   // encrypt + persist
  clear(id: IntegrationId, key?: string): void          // one field, or all for id

  // Presence map for the renderer/status — NO values, ever.
  presence(id: IntegrationId): Record<string, boolean>

  // MAIN-PROCESS-ONLY. Returns plaintext for an in-process connector to use
  // when making an API call. MUST NEVER be routed to IPC, a log, or a peek.
  // Marked with a name that greps distinctly (§10 asserts no IPC caller).
  revealForConnector(id: IntegrationId, key: string): string
}
```

- **No `get()` that a caller could log.** The renderer-facing surface is
  `has` / `presence` (booleans). `revealForConnector` is the sole plaintext exit
  and is main-process-only, named so a grep test can assert **zero** IPC/renderer
  callers (same enforcement idiom the email spec uses for `sendDraft`).
- **State, never value.** This is the global rule ("prove a secret's state, never
  its value") applied as an API shape: the renderer learns *set / not-set*, never
  the bytes. It mirrors `OperatorStatus` (`src/shared/operator.ts`), which
  surfaces `granted`/`connected`/`endpoint` but **not** the operator token.
- **Backend unavailable** (Linux with no keyring, or `safeStorage` not ready) →
  `set` throws a legible, actionable error (§9); the tab shows the integration as
  un-storable rather than silently dropping the secret.
- **Decrypt failure** (keychain rotated, different OS user) → `revealForConnector`
  / status surfaces a legible "re-enter it" error (§9), `status()` → `error`.

### 4.2 `IntegrationRegistry` (`src/main/integrations/integration-registry.ts`)

**Responsibility:** hold the three `IntegrationDescriptor`s, and derive each one's
`status()` from `config.json` (via §4.4) + `CredentialStore.presence`. This is
the single object sub-projects 2 and 3 read.

```
class IntegrationRegistry {
  constructor(deps: { creds: CredentialStore; configFile: string })
  list(): IntegrationDescriptor[]                 // all three, in a stable order
  get(id: IntegrationId): IntegrationDescriptor
  // Renderer DTO — descriptor metadata + enabled + per-field presence + status.
  // NEVER includes a secret value (§4.5).
  view(id: IntegrationId): IntegrationView
  views(): IntegrationView[]
}
```

- Descriptors are **static definitions** imported from
  `src/main/integrations/descriptors/{linear,email,cloud}.ts` (§4.3). The registry
  is the assembly point + status deriver, holding no I/O of its own beyond reading
  config + credential presence — same "pure over its inputs" testability the
  control-API documents.
- `status()` is a **synchronous, presence-derived** read (see §11 note on the
  pinned sync signature): required fields all present → `connected`; enabled but a
  required field missing → `needs-config`; a decrypt/validate failure recorded →
  `error`. A Phase-2 async `validate()` refreshes a cached "last validation"
  input that `status()` reads, keeping the pinned synchronous signature intact.

### 4.3 The three descriptors (`src/main/integrations/descriptors/*.ts`)

Each file exports one `IntegrationDescriptor` (§11). `configFields` marks
`secret: true` for keychain routing and `false` for `config.json`. `triggers` and
`actions` are the flow-facing surface (sub-projects 2/3) — full field tables in
§7. Sketch:

- **`linear.ts`** — secret fields: `oauthToken`, `webhookSecret`; non-secret:
  `workspaceId`, `teamIds`, `environment`, `webhookUrl`. triggers:
  `issue.delegated`, `issue.prompted`. actions: `activity.emit`,
  `issue.updateState`, `comment.create`, `issue.reassign`.
- **`email.ts`** — secret: `refreshToken` (`+ clientSecret` if used); non-secret:
  `address`, `oauthAppRef`, `environment`, `scopeLabels`, `scopeQuery`. triggers:
  `mail.received`. actions: `draft.create`, `draft.send` (gated), `label.apply`
  (Phase 2).
- **`cloud.ts`** — secret: **(none)**; non-secret: `roleArn`, `externalId`,
  `region`, `sandboxAccountId`, `durationSeconds`, `packs`. triggers: **(none in
  MVP** — cloud is action-side; a `budget.threshold` trigger is a later idea,
  §10). actions: `mintCredential`, `terraform.plan`, `terraform.applyApproved`.

### 4.4 Config-as-code (`src/main/integrations/integration-config.ts`)

Mirrors `operator-config.ts` / `environment-names.ts` **exactly**: read the
`integrations` block **fresh** from `config.json` on each call (hand-edits apply
without restart), and **validate at the boundary** — every field is checked, and
anything malformed is *dropped*, never thrown on. Only non-secret references live
here.

```
export function parseIntegrationsConfig(raw: unknown): IntegrationsConfig { … }
export function loadIntegrationsConfig(configFile: string): IntegrationsConfig {
  try { return parseIntegrationsConfig(JSON.parse(readFileSync(configFile,'utf8'))) }
  catch { return {} }   // unreadable/garbage → all integrations disabled
}
```

- Unknown integration ids dropped; `enabled` honored only when literally `true`
  (the `parseOperatorRevokeOnExit` rule); each non-secret field type-checked and
  trimmed (the `parseEnvironmentNames` rule); `environment` accepted only in
  `1..9`.
- **Writes** go through the existing config-write pattern (`saveAgentConfig` /
  `openclaw-config.ts`'s `writeFileSync(configFile, JSON.stringify(...,2)+'\n')`)
  — held in memory, written back. Secret fields are **never** written here.

### 4.5 The per-integration tab UI (`src/renderer/src/components/Integrations.tsx`)

A new top-level view — added to `App.tsx`'s view union
(`'home' | 'environment' | 'settings' | 'changes' | 'activity' | 'cockpit'` →
`+ 'integrations'`, `src/renderer/src/App.tsx:94`) and reachable from the same nav
that routes `onSettings`/`onCockpit`. One panel per integration, each reusing the
Settings **`card`** container idiom and the Cockpit **status-dot** idiom so it
reads as native localflow.

Each panel renders from an `IntegrationView` (never a secret value):

- **Enable toggle** — optimistic with rollback, exactly like Settings'
  `togglePack` (a rejected write rolls the switch back and shows a notice rather
  than lying that it's on): `window.localflow.setIntegrationEnabled(id, next)`.
- **Typed config fields** — one control per `IntegrationConfigField`:
  - **non-secret** (`secret: false`): a normal text input, `defaultValue` from the
    view's field value (it came from `config.json`), saved on blur via
    `setIntegrationField(id, key, value)`. Same uncontrolled-input-then-blur idiom
    as Settings' "Extra args".
  - **secret** (`secret: true`): a **masked** (`type="password"`) input whose
    value is **write-only** — the view carries only `hasValue: boolean`, so the
    field renders a "•••• set" affordance + "Replace" when a secret exists and an
    empty masked box when not. Submitting calls
    `setIntegrationSecret(id, key, value)`; the response is **only** `{ ok,
    status }` and echoes nothing. A "Clear" button calls
    `clearIntegrationSecret(id, key)`.
- **Live status pill** — a colored dot + label driven by `view.status`, reusing
  Cockpit's mapping: `connected` → `bg-idle` (green) "Connected"; `needs-config`
  → `bg-needs-you` (yellow) "Needs config"; `error` → `bg-exited` (red) with the
  legible error text. The pill is the same "reflects, never owns" surface Cockpit
  is — it reports the integration's state, it does not itself hold credentials.

The renderer **never** receives a secret. `IntegrationView` is the strict DTO:

```
interface IntegrationFieldView {
  key: string; label: string; secret: boolean; required: boolean; placeholder?: string
  hasValue: boolean          // for secret fields: presence only
  value?: string             // for NON-secret fields only (from config.json)
}
interface IntegrationView {
  id: IntegrationId; label: string; enabled: boolean
  fields: IntegrationFieldView[]
  status: 'connected' | 'needs-config' | 'error'
  statusDetail?: string      // legible error text when status === 'error'
}
```

### 4.6 IPC wiring

Extends the existing `window.localflow.*` bridge (`src/preload/index.ts` +
`src/shared/api.ts` type surface + `ipcMain.handle` in `src/main/index.ts`, same
shape as `guard:getPacks` / `guard:setPacks`):

| IPC channel | Args | Returns | Secret-safety |
|---|---|---|---|
| `integrations:list` | — | `IntegrationView[]` | presence only; no values |
| `integrations:setEnabled` | `id, boolean` | `{ ok, view } \| { ok:false, reason }` | config.json write |
| `integrations:setField` | `id, key, value` | `{ ok, view } \| { ok:false, reason }` | non-secret only; rejects a `secret:true` key |
| `integrations:setSecret` | `id, key, value` | `{ ok, status } \| { ok:false, reason }` | value **inbound only**; never echoed back |
| `integrations:clearSecret` | `id, key?` | `{ ok, view }` | clears keychain entry |

`setField` **rejects** any key whose descriptor field is `secret: true` (that must
go through `setSecret`), and `setSecret` rejects a non-secret key — so the routing
(config vs keychain) can't be crossed by a mislabeled call. No handler ever puts a
secret in a return value or a log; handlers log **route + reason only**, the exact
discipline `control-api.ts` documents ("NEVER log token material — not even a
prefix or hash").

### 4.7 Textual data flow (secret set + status)

```
┌──────────────── renderer (Integrations.tsx) ───────────────┐
│ open tab → integrations:list ──────────────────────────────┼─► main
│                                            IntegrationRegistry.views()
│                                              = descriptors (§4.3)
│                                              + config.json refs (§4.4, non-secret)
│                                              + CredentialStore.presence (booleans)
│   ◄──── IntegrationView[] (labels, non-secret values, hasValue flags, status) ────
│                                                                    │
│ type non-secret field → setField(id,key,val) ─► parse/validate ─► config.json write
│                                                                    │
│ enter masked secret → setSecret(id,key,val) ─► CredentialStore.set │
│      (value crosses IPC INBOUND only)          → backend.encryptString → sidecar.enc
│   ◄──── { ok, status }  (NO value echoed) ─────────────────────────┤
│                                                                    │
│ status pill ◄── status(): presence(required) all set → 'connected'│
│                            enabled & missing required → 'needs-config'
│                            decrypt/validate failed     → 'error' + statusDetail
└────────────────────────────────────────────────────────────────────┘
       (later) Flow Engine / Canvas ── read ─► IntegrationRegistry (triggers/actions/status)
```

---

## 5. Reuse map (what this leans on, unchanged)

- `src/renderer/src/components/Settings.tsx` — the `card` / `rowBtn` styling, the
  section layout, the **optimistic-with-rollback** toggle (`togglePack`), and the
  uncontrolled-input-then-`onBlur`-save idiom. The Integrations view is a sibling
  of this file, not a fork of it.
- `src/renderer/src/components/Cockpit.tsx` — the **status-dot pill** (dot color
  by state: `bg-idle` / `bg-needs-you` / `bg-exited`) and the **token-never-shown**
  posture (`OperatorStatus` exposes state, not the token). The status pill and DTO
  copy this exactly.
- `src/main/operator-config.ts` + `src/main/environment-names.ts` — the
  **read-fresh + validate-at-boundary + drop-malformed** config-as-code pattern
  that `integration-config.ts` follows line-for-line.
- `src/main/agent-registry.ts` (`getGuardPacks`/`setGuardPacks`,
  `saveAgentConfig`) + `src/main/openclaw-config.ts` — the in-memory-config +
  `writeFileSync` write-back pattern for non-secret refs.
- `src/main/session-manager.ts` `SpawnFn` / `operator-guard.ts` `GuardRunner` —
  the **injected-seam** style `SecretBackend` follows for offline testability.
- `src/main/index.ts` + `src/preload/index.ts` + `src/shared/api.ts` — the
  `ipcMain.handle` / `ipcRenderer.invoke` bridge the new channels extend.
- The three connector specs' auth/config sections — the field lists in §7.

---

## 6. Data model & config

`config.json` gains an `integrations` block (config-as-code, validated at the
boundary; **no secrets**):

```jsonc
{
  "integrations": {
    "linear": {
      "enabled": true,
      "workspaceId": "<linear-org-id>",     // reference, not a secret
      "teamIds": ["<team-id>"],
      "environment": 1,                       // localflow env 1-9
      "webhookUrl": "https://<tunnel>/linear/webhook"
      // oauthToken, webhookSecret → keychain, NOT here
    },
    "email": {
      "enabled": false,
      "address": "me@example.com",
      "oauthAppRef": "gmail-desktop",         // the client NAME, not its secret
      "environment": 7,
      "scopeQuery": "is:unread -category:promotions"
      // refreshToken → keychain, NOT here
    },
    "cloud": {
      "enabled": false,
      "roleArn": "arn:aws:iam::<acct>:role/localflow-agent-sandbox",
      "externalId": "<non-secret confused-deputy value>",
      "region": "us-east-1",
      "sandboxAccountId": "<acct>",
      "durationSeconds": 1800,
      "packs": ["iac.terraform", "cloud.aws"]
      // no secret fields at all
    }
  }
}
```

- **Secrets live only in the keychain sidecar** (`integration-secrets.enc`,
  §4.1), keyed `"<id>:<key>"`, ciphertext produced by `safeStorage`. Never in
  `config.json`, `sessions.json`, a log, a transcript, a PR body, or an IPC
  return.
- **Presence, not value, is the durable status input.** `status()` reads the
  boolean presence map + config; nothing durable holds the secret bytes outside
  the encrypted sidecar.
- **Shaped for growth:** an integration whose value becomes an array of accounts
  (multi-workspace Linear, multi-mailbox Email) extends its block with a
  `accounts: [...]` array — the same additive path the connector specs plan, with
  keychain keys namespaced by account id (`"<id>:<accountId>:<key>"`).

---

## 7. Descriptor field tables (the source of truth for 2/3)

Drawn from the connector specs' auth/config sections; `secret` drives
keychain-vs-config routing; `required` drives `needs-config`.

### linear (`descriptors/linear.ts`)

| field key | label | secret | required | store |
|---|---|---|---|---|
| `oauthToken` | Linear access token | ✅ | ✅ | keychain |
| `webhookSecret` | Webhook signing secret | ✅ | ✅ | keychain |
| `workspaceId` | Workspace / org id | ❌ | ✅ | config |
| `teamIds` | Team ids (comma-sep) | ❌ | ❌ | config |
| `environment` | localflow environment (1-9) | ❌ | ✅ | config |
| `webhookUrl` | Ingress webhook URL | ❌ | ❌ | config |

- **triggers:** `issue.delegated` ("Issue delegated to localflow"),
  `issue.prompted` ("Human replied in the issue").
- **actions:** `activity.emit` ("Post agent activity"), `issue.updateState`
  ("Move issue to a workflow state"), `comment.create` ("Comment on the issue"),
  `issue.reassign` ("Reassign the issue").

### email (`descriptors/email.ts`)

| field key | label | secret | required | store |
|---|---|---|---|---|
| `refreshToken` | Gmail OAuth refresh token | ✅ | ✅ | keychain |
| `clientSecret` | OAuth client secret (if desktop client) | ✅ | ❌ | keychain |
| `address` | Mailbox address | ❌ | ✅ | config |
| `oauthAppRef` | OAuth client name | ❌ | ✅ | config |
| `environment` | localflow environment (1-9) | ❌ | ✅ | config |
| `scopeQuery` | In-scope search filter | ❌ | ❌ | config |

- **triggers:** `mail.received` ("New mail in scope arrives").
- **actions:** `draft.create` ("Draft a reply"), `draft.send` ("Send an approved
  draft" — gated, never agent-callable per email §5), `label.apply` ("Label /
  archive" — Phase 2, needs `gmail.modify`).

### cloud (`descriptors/cloud.ts`) — no secret fields

| field key | label | secret | required | store |
|---|---|---|---|---|
| `roleArn` | Sandbox role ARN | ❌ | ✅ | config |
| `externalId` | External id (non-secret) | ❌ | ✅ | config |
| `region` | AWS region | ❌ | ✅ | config |
| `sandboxAccountId` | Sandbox account id | ❌ | ❌ | config |
| `durationSeconds` | Session duration (≤1800) | ❌ | ❌ | config |
| `packs` | lfguard packs | ❌ | ❌ | config |

- **triggers:** none in MVP (cloud is action-side; `budget.threshold` is a later
  idea — §10).
- **actions:** `mintCredential` ("Assume the sandbox role"), `terraform.plan`
  ("Run a plan"), `terraform.applyApproved` ("Apply an approved plan" — gated).
- **`status()` for cloud** means "required non-secret refs present" (+ Phase-2 dry
  `AssumeRole`), *not* "a secret is stored" — the all-non-secret case the
  descriptor model deliberately supports (§3).

---

## 8. Config validation rules (validate-at-the-boundary)

`parseIntegrationsConfig` (§4.4) honors only well-typed values; garbage disables
rather than throws — the `operator-config.ts` / `environment-names.ts` contract:

- Top level not an object → `{}` (all disabled).
- Unknown integration id → dropped.
- `enabled` → honored only when literally `true`; anything else → `false`.
- Each declared non-secret field → type-checked against its descriptor
  (`string`/`string[]`/`number`), trimmed; wrong type → that field dropped (the
  integration may then read `needs-config`).
- `environment` → integer in `1..9` only (the `parseEnvironmentNames` canonical
  rule); out of range → dropped.
- `durationSeconds` → clamped to the connector's `≤1800` cap; absent → connector
  default.
- Fields declared `secret: true` appearing in `config.json` → **dropped and a
  loud notice emitted** ("`<id>.<key>` is a secret and was ignored in config.json
  — set it in the Integrations tab; it belongs in the keychain"). This defends the
  never-render-secrets rule even against a hand-edit mistake.

---

## 9. Error handling

Per `memory/error-message-style.md`: every failure is **human-readable +
actionable + carries the real underlying exception**; never a bare "failed", never
a silent swallow. The credential path additionally surfaces the *error* without
ever surfacing the *secret* (state, not value).

| Failure | Surface (human + actionable + real error) | Never |
|---|---|---|
| **`safeStorage` unavailable** (`isEncryptionAvailable()===false`, e.g. Linux no keyring) | "Secure storage isn't available on this machine — <OS/back-end reason>. `<integration>` credentials can't be saved, so it stays disabled." Tab shows the secret field as un-storable. | drop the secret silently; write it anywhere non-encrypted |
| **Encrypt/persist fails** (disk error on the sidecar) | "Couldn't save the `<field>` for `<integration>` — <fs error>. Nothing was stored; try again." | claim it was set; leave a half-written blob |
| **Decrypt fails** (keychain rotated / different OS user) | "Stored `<integration>` credential can't be decrypted (safeStorage: <err>) — re-enter it in the Integrations tab." `status()` → `error` with this as `statusDetail`. | log/echo the ciphertext or any value; keep reporting `connected` |
| **Required field missing** | `status()` → `needs-config`; the pill names which required field(s) are empty. | show `connected` while unusable |
| **Malformed `integrations` block** in config.json | Feature dropped per §8; a console notice names the offending path + why. | throw / crash the app; honor a garbage value |
| **Secret found in config.json** (hand-edit mistake) | §8 notice; the value is dropped, not honored, and the user is told to use the tab. | read the secret from config.json |
| **`setField` on a `secret:true` key** (or vice-versa) | Handler rejects with "`<key>` is a secret — set it via the masked field, not a config field." | route a secret into config.json |

Cross-cutting: every emitted string proves *state* (present / expired / a
back-end error code), never *value*. The §10 test regex-scans every notice + IPC
payload for the known secret and fails if it appears.

---

## 10. Testing strategy (offline, seam-injected)

No test needs the real OS keychain, a live workspace, or a network — everything
runs against the `SecretBackend` seam and fixture config, matching localflow's
existing pure-router / injected-clock / fixture-agent posture.

- **`CredentialStore` unit tests** (inject a fake in-memory `SecretBackend`):
  set/has/clear round-trips; `presence()` returns booleans only; the
  **unavailable-backend** path (`isEncryptionAvailable()===false`) yields the §9
  legible error and stores nothing; the **decrypt-failure** path (backend throws
  on `decryptString`) yields `status: error` + `statusDetail`, no value leak.
- **★ The load-bearing invariant test:** drive a full set → list → status cycle
  with a known secret value; **regex-scan every IPC return payload and every
  emitted console/notice string** and assert the secret never appears. Also a
  **grep/static test** asserting `revealForConnector` has **zero** callers in
  `src/preload/*`, `src/renderer/*`, and any `ipcMain.handle` body — the sole
  plaintext exit stays main-process-internal (same enforcement the email spec
  uses for its single `sendDraft` caller).
- **`IntegrationRegistry` tests** (pure over injected config + a stub
  `CredentialStore`): `status()` truth table — all required present →
  `connected`; enabled + a required field missing → `needs-config`; a recorded
  decrypt failure → `error`; the **cloud all-non-secret** case reaches
  `connected` with no keychain entry.
- **`parseIntegrationsConfig` tests:** every §8 rule — unknown id dropped,
  non-`true` `enabled`, wrong-typed field dropped, `environment` out of `1..9`
  dropped, `durationSeconds` clamped, **a `secret:true` key in config.json dropped
  + notice emitted**.
- **Descriptor shape tests:** each of the three descriptors round-trips through
  the pinned `IntegrationDescriptor` type; `configFields` secret/required flags
  match §7; `triggers`/`actions` ids are stable (a snapshot test guards the
  contract sub-projects 2/3 depend on).
- **Renderer view tests:** an `IntegrationView` for a secret field carries
  `hasValue` and **no** `value`; a non-secret field carries `value`; the status
  pill maps state → dot class exactly as Cockpit does. The enable toggle's
  optimistic-rollback matches Settings' `togglePack` behavior on a rejected write.

---

## 11. Interfaces

### 11.1 The pinned contract this sub-project OWNS (verbatim)

Sub-projects 2 (engine: palette/action dispatch) and 3 (canvas: palette UI)
consume these names/shapes. This spec is their sole author.

```ts
type IntegrationId = 'linear' | 'email' | 'cloud'

interface IntegrationConfigField {
  key: string
  label: string
  secret: boolean       // secret → keychain (CredentialStore); non-secret → config.json
  required: boolean
  placeholder?: string
}

interface IntegrationDescriptor {
  id: IntegrationId
  label: string
  configFields: IntegrationConfigField[]        // secret → keychain; non-secret → config.json
  triggers: { id: string; label: string }[]     // events this integration can START a flow with
  actions:  { id: string; label: string }[]     // write-back ops a flow node can invoke
  status(): 'connected' | 'needs-config' | 'error'
}
```

**Note on the synchronous `status()` signature (an owned-interface decision):**
`status()` is kept synchronous as pinned. It returns a **presence-derived** state
from config + `CredentialStore.presence` + a cached "last validation" flag. The
Phase-2 live check is a *separate* async `validate()` that refreshes that cached
flag; it does not change `status()`'s signature. This is called out in §12 so
consumers can rely on `status()` being cheap and synchronous.

### 11.2 What this sub-project adds (consumed internally + by the UI)

- `SecretBackend`, `CredentialStore` (§4.1) — internal to main; **not** exposed to
  2/3 (they read `status()`/`presence`, never a secret).
- `IntegrationRegistry` (§4.2) — the object 2/3 import to enumerate descriptors.
- `IntegrationView` / `IntegrationFieldView` (§4.5) — the renderer DTO; **secret
  values excluded by construction**.
- `IntegrationsConfig` + `parseIntegrationsConfig` (§4.4) — the config shape.
- The `integrations:*` IPC channels (§4.6).

### 11.3 What sub-projects 2 and 3 consume

- **Sub-project 2 (Flow Engine):** reads `IntegrationRegistry.list()` for
  `triggers` (to know which events can start a flow) and `actions` (the write-back
  ops a node dispatches), and calls `status()` to gate a flow ("don't run a Linear
  node while `linear` is `needs-config`"). It uses `CredentialStore` only
  indirectly — the connector it dispatches to calls `revealForConnector`
  in-process; the engine never sees a secret.
- **Sub-project 3 (Flow Canvas):** reads the same descriptors for the **palette**
  — `label`, `triggers[].label`, `actions[].label`, and `status()` to badge a
  node (green/yellow/red) in the canvas. Pure metadata; no credentials.

---

## 12. MVP slice + phased roadmap

### MVP foundation slice (first buildable, offline-testable)

1. `SecretBackend` seam + `CredentialStore` (encrypt/persist to the sidecar; the
   presence-only surface; `revealForConnector` main-only) + its unit tests
   including the **no-secret-in-IPC/log** invariant test.
2. `parseIntegrationsConfig` + `loadIntegrationsConfig` (validate-at-boundary) +
   tests.
3. `IntegrationRegistry` + the three descriptors (`linear`, `email`, `cloud`) +
   the `status()` truth-table tests.
4. The `integrations:*` IPC channels wired through `preload` + `shared/api.ts` +
   `ipcMain.handle`.
5. The `Integrations.tsx` view: per-integration panel (enable toggle, typed
   fields, masked write-only secret entry, live status pill), added to `App.tsx`'s
   view union and nav.

Ships as: open Integrations → three panels → for `linear`/`email` paste the
secret(s) into masked fields (stored in the keychain, never shown again) and fill
the non-secret refs; for `cloud` fill the role/region refs (no secret); each pill
turns green when its required fields are set. **No live handshake, no connector
start** — but the store, the registry, the config, and the tabs are proven and
the invariant test is green.

### Phased roadmap

- **Phase 1 (MVP):** the foundation slice above.
- **Phase 2 — live validation + real auth:** a per-descriptor async `validate()`
  (a cheap read call: Linear `viewer`, Gmail `getProfile`, AWS `AssumeRole` dry
  run) refreshing the cached status; the real OAuth handshakes (Linear `actor=app`
  install, Gmail consent) writing tokens **into `CredentialStore`**; wire the
  connectors to actually start when `status()===connected`.
- **Phase 3 — engine integration (sub-project 2):** the Flow Engine consumes
  `triggers`/`actions`/`status()` for trigger-start, action dispatch, and gating.
- **Phase 4 — canvas integration (sub-project 3):** the Flow Canvas renders the
  palette from the registry and badges nodes by `status()`.
- **Phase 5 — more connectors:** additive descriptors (Salesforce, MS Graph,
  GCP/Azure) + `IntegrationId` widened; multi-account/multi-workspace via the
  namespaced-keychain-key + `accounts[]` config path (§6). Each new integration is
  a new descriptor file + (optionally) a connector — the Hub itself doesn't
  change.

---

## 13. Open decisions (FLAGGED — not resolved here)

1. **Secret persistence location.** `safeStorage`-encrypted **sidecar blob file**
   in `userData` (recommended — zero native deps, Electron-native, matches the
   local-first ethos) **vs.** per-item OS keychain entries via a `keytar`-style
   native module (true keychain items, but a native dependency + notarization
   surface). The `CredentialStore` API (§4.1) is identical either way — only the
   backend changes — so this doesn't block the slice. **Recommend the sidecar.**
2. **A new `integrations` view vs. a section inside Settings.** A dedicated
   top-level view (recommended — room for per-integration panels, and 2/3 want a
   discoverable home) vs. a fourth Settings section (cheaper, but cramped and
   couples the config UI to Settings). **Recommend the dedicated view.**
3. **MVP secret shape: pasted long-lived token vs. wait for OAuth.** MVP has no
   handshake, so the masked field accepts a pasted token (Linear personal API key,
   Gmail refresh token) as the interim credential. Is an interim long-lived token
   acceptable to store, or should `linear`/`email` show "connect in Phase 2"
   rather than accept a paste now? (`cloud` is unaffected — no secret.) **Lean:
   accept the paste to make the slice end-to-end testable; label it clearly as
   interim.**
4. **`status()` synchronous vs. async** (see §11.1 note). Kept synchronous per the
   pinned interface, backed by a cached validation flag; the live check is a
   separate `validate()`. Confirm 2/3 are fine relying on a cheap synchronous
   `status()` + an explicit refresh, rather than an always-live async status.
5. **Does `cloud` need a trigger at all?** MVP gives it none (it is action-side).
   If flows should be *startable* by a cloud event (a budget-threshold breach, a
   drift detection), a `budget.threshold` / `drift.detected` trigger is added
   later. Flagged so sub-project 2 doesn't assume every integration has a trigger.
6. **Where `revealForConnector`'s consumers live.** MVP has no connector calling
   it yet. When Phase 2 wires the connectors, confirm they call it **in-process**
   (never over the control-API socket or IPC) so the plaintext never crosses a
   boundary — and add the connector paths to the §10 grep-test allowlist.

---

## Appendix — reused localflow surfaces (by path)

- `src/renderer/src/components/Settings.tsx` — `card`/`rowBtn` idiom, section
  layout, optimistic-with-rollback toggle (`togglePack`), blur-to-save inputs.
- `src/renderer/src/components/Cockpit.tsx` — status-dot pill (state→color) and
  the token-never-shown / `OperatorStatus` state-not-value posture.
- `src/main/operator-config.ts`, `src/main/environment-names.ts` — read-fresh +
  validate-at-boundary + drop-malformed config-as-code, the template for
  `integration-config.ts`.
- `src/main/agent-registry.ts` (`get/setGuardPacks`, `saveAgentConfig`),
  `src/main/openclaw-config.ts` — in-memory-config + `writeFileSync` write-back.
- `src/main/session-manager.ts` (`SpawnFn`), `src/main/operator-guard.ts`
  (`GuardRunner`) — the injected-seam style `SecretBackend` follows.
- `src/main/index.ts`, `src/preload/index.ts`, `src/shared/api.ts` — the
  `ipcMain.handle` / `ipcRenderer.invoke` bridge (`guard:getPacks`/`setPacks` is
  the closest existing pair) the `integrations:*` channels extend.
- `src/shared/operator.ts` (`OperatorStatus`) — the "surface state, never the
  token" shape the `IntegrationView` DTO mirrors.
- The three connector specs (`2026-07-16-{linear-integration,email-execution,
  devops-cloud-execution}-design.md`) — §auth/§config, the source of §7's fields.
