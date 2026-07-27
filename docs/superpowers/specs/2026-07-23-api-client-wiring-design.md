# API client — wiring & curation surface (design)

Decided with Jonas 2026-07-23. The second milestone of the agent-facing API
client, following `2026-07-23-agent-api-client-design.md` (the engine, layers
1–3, main process only — merged and inert).

## Why

The engine is built and tested, and **nothing can reach it.**
`ControlDeps.apiClient` is typed at `control-api.ts:44` but never populated, so
every `/http/*` route returns 404 in a real build. Nothing here has executed
outside tests.

This milestone makes the feature exist: a human curates a collection, stores a
credential, grants an agent scoped access, and the agent sends. It also closes
the one claim the engine spec had to mark as untrue — §6's "the exposure window
is the agent session."

## Guiding principle

**Copy the operator milestone's shapes, not just its style.** Nearly every piece
here has a working precedent: `Integrations.tsx` for credential entry,
`Cockpit.tsx` for the grant toggle and indicator, `credentialEnv` +
`OperatorLaunchTracker` for token delivery and pane binding. Where this design
deviates, it says why.

**The renderer never holds capability material.** Not the credential (already
true — DTOs carry `hasValue: boolean`), and not the grant token either.

## Scope

**In:** main-process wiring, grant lifecycle with pane binding, collection
curation UI, credential entry, grant/revoke UI, and an agent-side skill.

**Out, deliberately:**

- **Response viewer.** The human sees *that* sends happened (the cockpit log
  works for free, see §1) but cannot read bodies in the UI. It is genuinely its
  own surface — a JSON tree over a shape/pull model — and benefits from seeing
  the rest in use first.
- **Persistent history.** Premature while nothing is generating history worth
  keeping. Engine spec §4 still describes it; it lands with the viewer.
- **The approval gate** (engine spec layer 5) and **`$ref` chaining** (layer 4),
  both already deferred to their own plans.

## 1. Main-process wiring

Construction goes in a new block immediately before the `controlDeps` literal at
`index.ts:931`, where `userData`, `safeStorage` and `manager` are all in scope:

```ts
const apiCollections = new CollectionStore({ file: join(userData, 'api-collections.json') })
const apiSecrets = new CollectionSecretStore({
  backend: safeStorage,
  file: join(userData, 'api-secrets.enc')
})
const apiResponses = new ResponseStore({})
const apiSender = new ApiSender({
  collections: apiCollections,
  secrets: apiSecrets,
  client: new HttpClient({ transport: new FetchHttpTransport() }),
  responses: apiResponses
})
const apiGrants = new ApiGrantStore()
```

Then `apiClient: { grants: apiGrants, sender: apiSender, collections: apiCollections, responses: apiResponses }` inside the `controlDeps` literal.

File naming follows the established split: `.enc` sidecar with
`{ backend, file }` for keychain material, plain `.json` with `{ file }`
otherwise. The `HttpClient`/`FetchHttpTransport` idiom is copied from
`index.ts:747`.

**Agent sends reach the cockpit for free.** `onActivity: pushActivity` is
already in `controlDeps`, and `control-api.ts:250` already calls it on
`POST /http/send`. No new UI is needed for the action log.

### New module: `grant-binding.ts`

`src/main/api-client/grant-binding.ts` — environment → the pane id holding the
grant, plus the collection set it was minted with (needed to re-mint on
restart, §2).

`OperatorLaunchTracker` was considered and rejected: its semantics are
operator-specific (it tracks *whether saiife launched the pane* and carries a
`revokeOnExit` config flag). Bending it to answer a second, unrelated question
would make one module serve two masters. This one is ~20 lines and
independently testable.

### IPC surface

Eight handlers, `namespace:verbNoun`, every cross-boundary argument runtime
type-checked, every result the discriminated `{ ok: true; … } | { ok: false; reason }`:

```
apiClient:listCollections   apiClient:upsertCollection   apiClient:removeCollection
apiClient:setSecret         apiClient:clearSecret
apiClient:grant             apiClient:revoke             apiClient:status
```

There is deliberately **no** `listPanes` handler — `App.tsx` already holds
`sessions`, so the Cockpit takes them as a prop and filters on `environment` and
`kind === 'terminal'`.

**The token never crosses IPC.** `apiClient:grant` returns
`{ ok: true, endpoint, paneId }`. The token goes from `ApiGrantStore` directly
into the pane's spec env and nowhere else — the same single-exit discipline as
`revealForConnector`. `apiClient:status` returns presence, holder and scope,
never material.

**Collection DTOs carry `hasValue: boolean`**, copying `IntegrationFieldView`
(`shared/integrations.ts:164`), so the renderer structurally cannot render a
credential.

Pinned to remove ambiguity:

- **`Collection.id` is a generated UUID, minted once on create and immutable.**
  The display name is a separate, freely editable field. This matters: the
  keychain key is `collectionSecretKey(collectionId, secretRef)`, so deriving the
  id from the name would orphan every stored credential on rename.
- **`apiClient:status(environment)`** returns
  `{ granted: boolean; paneId?: string; collectionIds?: string[] }` — presence,
  holder and scope. Never the token, never a secret.
- **The Cockpit's collection multi-select lists this environment's collections
  only**, via `CollectionStore.list(environment)`, which is already
  environment-scoped.

## 2. Grant lifecycle

### Delivery

The token reaches the agent as **process environment variables on one pane**,
the same rail the operator grant uses (`credentialEnv`, `operator-launch.ts:9`):

```
SAIIFE_API_ENDPOINT   http://127.0.0.1:<control.port>
SAIIFE_API_TOKEN      <the API grant token>
```

**Distinct from `SAIIFE_TOKEN`, deliberately.** Reusing the operator's variable
would hand every operator-aware agent an API capability by accident — the exact
quiet capability-widening that justified two separate grant stores. Same
reasoning, one layer out.

**Honest limit:** an agent that runs `env` can read `SAIIFE_API_TOKEN`. That does
not weaken the guarantee — the token is a capability handle, not the API
credential, and it dereferences to nothing outside this machine's main process.
But *"the agent never sees the credential"* and *"the agent never sees the
token"* are different claims, and only the first is true.

### Granting

One path: **grant to a pane.**

```
token = apiGrants.grant(environment, collectionIds)
manager.updateSpecEnv(paneId, { SAIIFE_API_ENDPOINT, SAIIFE_API_TOKEN })
binding.bind(environment, paneId, collectionIds)
→ if the pane is running, manager.restart(paneId)
```

**The restart is a real cost, not an oversight.** `updateSpecEnv`
(`session-manager.ts:293`) only mutates the stored spec; environment variables
reach a process at launch and never mid-life. The operator code works around
this the same way, guarding `status === 'exited'` and re-granting inside the
restart handler (`index.ts:1281-1292`). The cost is bounded:
`manager.restart(id, fresh = false)` keeps the agent's resume args, so a coding
agent resumes rather than losing its conversation. The UI puts this on the
button (§3) instead of springing it.

Granting only at pane *creation* was considered — it never needs a restart,
which is why `grantOpenclawPane` works that way. Rejected because it cannot give
access to the pane you are already working in, which is the common case. One
path that sometimes restarts beats two paths.

### Revocation

Three triggers:

- **Explicit** — the Cockpit button; `apiGrants.revoke(environment)` takes
  effect on the next request.
- **Pane deletion** — `manager.onSessionsChanged` reconciliation: when the bound
  pane's id disappears from `manager.list()`, revoke. This mirrors the operator
  grant's own default (`index.ts:1161-1168`), which revokes on the pane leaving
  the session list, not on a mere exit.
- **App restart** — free; the store is in-memory.

**Why deletion, not exit.** An earlier design revoked on `'exited'` and re-minted
on restart, to shrink the exposure window to a running agent. It was dropped for
two reasons. First, it collided with granting to a *running* pane: that path
closes and restarts the pane to inject the token, and the close fires `'exited'`,
so the grant would revoke itself mid-grant. Second, the window it shrank is not a
real exposure — an exited pane's token lives only in that pane's spec env, in
main-process memory, where no running process can read it until the pane
relaunches (with the same agent and the same still-valid token). Revoking on
deletion ties the grant's life to the pane's existence, matches the operator
precedent exactly, and makes granting to a running pane work with no special
handling — the close it performs is an exit, not a deletion, so nothing revokes.

This is what makes engine spec §6 true in the sense that matters: the grant
cannot outlive the pane that holds it.

### One grant per environment

Unchanged from `ApiGrantStore`. Granting to a second pane in the same
environment **moves** the grant; the first pane's token stops resolving. The UI
names the holding pane, so this is visible rather than silent.

This also sidesteps the engine spec's known scope-mutation backlog item
(re-granting with a different set silently keeps the original scope): every
grant here is a fresh mint with an explicit set, so the stale-scope path is
never taken.

## 3. The curation surface

### Navigation

A new `'apiclient'` view, placed after Integrations in the sidebar — both
configure something external. Touches the five places this codebase requires:
the union at `App.tsx:95`, an `enterApiClient`, the render ternary at `:975`,
the `view=` ternary at `:832`, and `Sidebar`'s `Props` plus a button.

### `ApiClient.tsx`

Modelled on `Integrations.tsx`: the shared page shell
(`mx-auto flex w-full max-w-[720px] flex-1 flex-col items-stretch gap-7 overflow-auto px-6 py-8 text-left`),
and it re-declares `card` / `rowBtn` / `inputCls` verbatim with the same
"reused so this reads as native saiife" comment the codebase already carries.
Scoped by an `environment: number` prop, like `Cockpit`.

Each collection renders as a `card` section with name and origins; an auth row
(scheme, header name when the scheme is `header`, `secretRef`); the credential
via the **`SecretField` pattern copied wholesale** — `•••• set`, `Replace`,
`Clear`, `type="password"`, value never returned; then varSets and saved
requests.

`Collection.varSets` is `Record<string, Record<string, string>>` — named sets of
variables, not a flat list. It edits as **one block per varSet name** (`test`,
`live`, …), each containing key/value rows, with add/remove at both levels.
`requests` is a flat list of rows: name, method (a select over the pinned
`HttpMethod`), and path.

Pure form/shaping logic goes in a sibling `apiClientLogic.ts`, following
`settingsLogic.ts`.

### The hazard this UI must prevent

varSet values live in `api-collections.json` — **plaintext on disk.**
Credentials belong in the keychain via `secretRef`. Nothing otherwise stops
someone typing an API key into a varSet value and silently writing it
unencrypted, and it is an easy mistake: both are "things you type into a
collection."

So `apiClient:upsertCollection` **runs `looksLikeSecretLiteral` over every
varSet value and refuses the save**, naming `auth.secretRef` as the right home.

Enforced in main, never the renderer — the renderer may warn live for
ergonomics, but it is not the gate. This is the fourth use of that one shared
table, and the reasoning is identical every time: it exists to stop a secret
being written somewhere that is not the keychain.

**Origin validation** is likewise authoritative in main, reusing
`normalizeOrigin` from `api-client/origins.ts`. That module is deliberately
*not* moved to `src/shared/` for renderer import: main must validate regardless,
so a shared copy would only add a second place to drift.

### Cockpit

A separate **"API access"** section beside the operator's — not merged into one
"capabilities" block. Two grants, two tokens, and the whole design rests on
neither authenticating the other's routes; presenting them as one unit would
visually imply exactly the conflation two separate stores exist to prevent.

It carries a status line (granted / holding pane / collection count), a
collection multi-select, a pane picker fed from the `sessions` prop, and
grant/revoke. The grant button reads `Grant API access (restarts <pane>)` when
the target is running.

### Sidebar

A second per-environment dot with its own `api-indicator` class and
`data-api-granted` hook, beside the existing operator dot — distinguishable at a
glance and selectable by e2e. The existing 3-second poll (`App.tsx:171-190`)
extends to fetch `apiClient:status` in the same fan-out.

## 4. The agent-side skill

`openclaw/skills/saiife-api/` — a sibling of the existing operator skill,
following its structure exactly: a `SKILL.md` with frontmatter
`requires: { bins: [node], env: [SAIIFE_API_ENDPOINT, SAIIFE_API_TOKEN] }`, and a
small node CLI at `bin/saiife-api.mjs`.

Verbs map one-to-one onto the routes: `collections`, `send`, `response`, `pull`.

**No `openclaw.json` auto-write plumbing.** The operator grant carries
`writeSkillEnv`/`removeSkillEnv` because an external OpenClaw instance needs its
config patched. Per-pane env injection (§2) makes that unnecessary here.

Without this skill the feature is *wired* but not *usable* — an agent that does
not know a capability exists effectively does not have it.

## Error handling

Every case returns `{ ok: false, reason }`; the renderer surfaces `reason` as a
notice.

- **Secure storage unavailable** → `CollectionSecretStore.set`'s existing legible
  error; the collection stays unusable and says so.
- **Secret-shaped varSet value** → refused, naming `auth.secretRef`.
- **Invalid origin** → refused, naming the `scheme://host[:port]` form.
- **Grant with no collections selected** → refused; an empty-scope grant is
  meaningless.
- **Grant to a pane that exited between picking and granting** → allowed; the
  env lands on the pane's next launch, so no restart is needed.
- **Restart fails during grant** → the grant is revoked, so a live token never
  outlives the pane that was meant to hold it.
- **Deleting a collection a live grant covers** → refused, "revoke the API grant
  first." Silently invalidating a live capability is worse: the agent would get
  `unknown collection` with no way to learn why.
- **Clearing a credential a live grant depends on** → allowed. The next send
  fails with the existing "no credential stored" message; this is a legitimate
  way to cut access fast.
- **Corrupt `api-collections.json`** → `CollectionStore.load` already starts
  empty rather than throwing; the UI shows its empty state.

## Testing

`index.ts` is ~1800 lines of inline `ipcMain.handle` calls with no test seam.
This codebase's answer elsewhere is to extract the logic and keep the handler
thin — `control-api.ts` is explicitly "pure over its inputs (no socket), so
auth, scoping… are testable," and the renderer does the same with
`settingsLogic.ts`. So:

- **`src/main/api-client/collection-validate.ts`** — pure: an upsert payload →
  `{ ok } | { ok: false, reason }`, covering origins, the varSet secret check,
  and auth shape. The handler becomes three lines.
- **`apiClientLogic.ts`** — renderer form/shaping logic, same reason.

**Unit:** `grant-binding` (bind, revoke on exit, re-mint on restart, environment
isolation); `collection-validate` (every refusal, and that a valid collection
passes); the form-shaping logic.

**e2e** (following `tests/e2e/operator.spec.ts`): create a collection and store a
credential, asserting `•••• set` and that the value never appears in the DOM;
grant to a pane and assert the Cockpit status plus the `data-api-granted`
sidebar dot; revoke and assert it clears; **close the granted pane and assert the
grant clears without an explicit revoke** — that last one is the test that makes
engine spec §6 true.

**Security probes:**

- A grep test that no `src/preload` or `src/renderer` file references
  `ApiGrantStore` or `SAIIFE_API_TOKEN`.
- `apiClient:grant`'s return value structurally cannot contain the token,
  asserted against a real grant.
- A secret-shaped varSet value is refused before anything reaches disk.

## Build order

1. **Wiring** — construct the stores, populate `controlDeps.apiClient`. The
   surface goes live; sends already appear in the cockpit log.
2. **Curation** — `collection-validate`, the collection/secret handlers,
   `ApiClient.tsx`, the nav destination. There is now something to grant.
3. **Grant lifecycle** — `grant-binding`, the grant/revoke/status handlers, env
   injection, revoke-on-exit and re-mint-on-restart.
4. **Grant UI** — the Cockpit section and the sidebar indicator.
5. **Skill** — `openclaw/skills/saiife-api/`.

Curation precedes the grant lifecycle deliberately: a grant names a collection
set, so until step 2 there is nothing to name. Each layer is shippable. After 4
the feature is usable by an agent driven with `curl`; 5 is what removes the need
for one.

## Out of scope (v1, YAGNI)

- Response viewer and persistent history (see Scope).
- Importing Postman/OpenAPI collections.
- Editing a collection's `environment` — a collection belongs to the environment
  it was created in; move by recreating, which correctly re-enters the
  credential.
- Multiple simultaneous grants per environment. `ApiGrantStore` mints one token
  per environment and this design keeps that.
- `allowLocal` — still hard-coded `false`, so `http://localhost:3000` targets
  remain unreachable. Called out in the engine plan as the first thing users will
  ask for; it needs a deliberate per-collection opt-in, not an accident.
