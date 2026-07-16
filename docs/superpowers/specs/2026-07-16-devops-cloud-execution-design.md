# Agent DevOps / cloud execution layer (Direction 3) — design

Date: 2026-07-16. Status: proposed design (pre-brainstorm-gate spec).
Direction 3 of the four product-integration directions
(`memory/product-integration-directions.md`). Research basis:
`scratchpad/feasibility-aws-devops.md`, `scratchpad/feasibility-cloud-iam.md`,
and Direction 3 in `scratchpad/design-scope-integrations.md`.

This is a **design document, not an implementation**. It is written to be
detailed enough that localflow's own agents (dogfooding, per the execution plan
in the scope doc) can build the MVP from it.

---

## 1. Goal + MVP scope

### Goal

Let a localflow agent do **real DevOps** — provision infrastructure as code, run
deployments, and operate cloud resources — inside a cloud account under strict,
user-controlled, short-lived, least-privilege identity, so that a human bounds
exactly what the agent can touch and every mutation passes an explicit approval
gate. The pitch is **defense in depth**: even if a destructive command slips
past one layer, another structurally caps the blast radius.

This is DevOps architecture and deployment execution — provisioning, deploys,
cloud ops — **not** task/CRM (that is Direction 1) and not email (Direction 4).

### Build target

**All three clouds** (`aws`, `gcloud`, `az` CLIs), **AWS-first for the MVP**.
GCP and Azure follow in later phases (§12). The identity model (§6) is designed
cross-cloud from day one so the later clouds slot into the same shape.

### MVP scope — IN

- **AWS + Terraform**, single **sandbox account**.
- Per-pane short-lived AWS credentials via `sts:AssumeRole` (keyless from
  localflow's side wherever possible — §6), injected into the pane's child-
  process env and **never rendered** to any log, transcript, or peek.
- The `terraform plan -out=plan.tfplan` → review → `terraform apply plan.tfplan`
  loop, surfaced through localflow's **existing** `needs-you` + `peek()` +
  `ApproveButton` primitives (no new UI primitive).
- Two new lfguard packs: **`iac.terraform`** and **`cloud.aws`**, blocking the
  enumerated destructive command shapes (§7).
- A **"plan ready for review" `needs-you` detector** (§4).
- Per-project config for the role ARN, sandbox account id, external id, and the
  optional budget/SCP references (§8).
- Loud, actionable, real-detail error surfaces for every failure mode (§9),
  honoring `memory/error-message-style.md`.

### MVP scope — OUT (explicitly deferred)

- GCP and Azure execution (identity model designed for them; packs and minting
  adapters are phased — §12).
- AWS CDK and CloudFormation change-sets as the plan primitive (Terraform only
  for MVP; change-sets are the documented fallback/reference design — §3).
- CodePipeline / CodeBuild / CodeDeploy orchestration, SSM Session Manager
  interactive shells, `container.docker` / `container.k8s` packs.
- Cross-account promotion (sandbox → staging → prod), OIDC-issuer hosting for
  fully keyless federation (localflow-as-hosted-service), IAM Roles Anywhere.
- localflow **auto-provisioning** the cloud identity. The MVP ships a
  copy-pasteable Terraform/CloudFormation snippet the user applies themselves;
  guided in-app provisioning is a later phase (§11 open decision).

---

## 2. Feasibility summary

**Verdict: YELLOW — feasible and can be made safe, but not "safe by default
today."** (from `feasibility-aws-devops.md` §Verdict and the cross-cloud verdict
in `feasibility-cloud-iam.md`.)

Every cloud-side primitive this design depends on is **mature, GA, and
well-documented**: STS `AssumeRole` with capped `DurationSeconds` + `ExternalId`;
IAM permission boundaries; AWS Organizations SCPs (full IAM policy language as of
Sept 2025); Control Tower multi-account separation; AWS Budgets **budget
actions**; CloudTrail; CloudFormation change-sets and drift detection; the
Terraform `plan`/`apply` split; and keyless federation on all three clouds (AWS
OIDC + `AssumeRoleWithWebIdentity`, GCP Workload Identity Federation, Azure
federated identity credentials). Nothing is missing from the cloud providers'
side.

**The gaps are all on localflow's integration side, and they are concrete build
items, not research problems:**

1. No `cloud.aws` or `iac.terraform` lfguard pack exists yet
   (`guard/crates/lfguard/packs/` has only `core.*`, `cloud.gcloud`,
   `db.postgres` — confirmed by directory listing). The command-level defense
   layer is unbuilt; `cloud.gcloud.toml` is the pattern to copy.
2. No `needs-you` detector for "a plan/change-set is ready for review" exists.
   The UI primitive (`peek()` + `ApproveButton`) is reusable **as-is**; only the
   detection logic is new.
3. No credential-minting flow exists. localflow has no `AssumeRole`/WIF/federated
   integration today; this is new main-process code that must never let the
   session token touch a log, transcript, or peek (the user's global
   never-render-secrets rule, extended to localflow's own architecture).

Secondary caveats from the research, carried into open decisions (§11): IAM
Access Analyzer's unused-access findings are **visibility-only** (a human/
automation must act on them), and AWS's multi-account (sandbox/staging/prod)
guidance is a real onboarding cost that the MVP should recommend, not require.

Because the gaps are localflow-side and buildable, and because the layered
guardrail stack (§5) genuinely prevents scope excess once built, this lands
YELLOW rather than RED — the pitch is sound and the primitives exist, but "safe
by default" is not yet true of the current codebase and must not be marketed as
already-shipped.

---

## 3. Core loop → cloud primitives

The execution loop is **identity → plan → approve → apply → audit**. Each stage
maps onto a specific, GA cloud primitive.

| Stage | What happens | AWS primitive (MVP) | Cross-cloud equivalent |
|---|---|---|---|
| **Identity** | Mint a fresh, minimally-scoped, short-duration credential for this pane/task; inject into the pane env; let it expire. | `sts:AssumeRole` (`DurationSeconds` 900–1800s, `ExternalId`, per-task `RoleSessionName`) | GCP WIF → SA impersonation; Azure FIC → Entra token |
| **Plan** | Agent runs `terraform plan -out=plan.tfplan` under the assumed role. The plan is a durable local artifact + human-readable diff; no mutation happens. | `terraform plan -out=` (tool-native; cloud-agnostic) | same Terraform command on any cloud |
| **Approve** | The plan diff surfaces as a `needs-you` (yellow) peek; the human reviews it in place and explicitly confirms. | localflow `peek()` + `ApproveButton` (existing) | same |
| **Apply** | On approval, `terraform apply plan.tfplan` runs in the **same pane/session** (same STS credentials, same CloudTrail session — no re-auth TOCTOU). | `terraform apply <planfile>` | same |
| **Audit** | Every API call the assumed-role session made is recorded independently, correlated by the per-task `RoleSessionName`. | CloudTrail (management events; a Trail to S3 for retention) | GCP Cloud Audit Logs; Azure Activity Log |

**Why Terraform for the MVP** (from `feasibility-aws-devops.md` §1): the
`plan`/`apply` split is the most battle-tested "propose then confirm" primitive
in the industry and is 1:1 aligned with localflow's own approve/deny idiom. It is
also cloud-agnostic, so the same primitive carries to GCP and Azure unchanged.
The one place it is weaker than CloudFormation change-sets is that the approval
artifact (`.tfplan`) is a **local file**, not a queryable AWS-side object — the
approval record lives in localflow's session, not in an AWS API object. That is
acceptable for a single-operator MVP; **CloudFormation change-sets are the
documented fallback/reference design** for a pure-AWS-native slice or a
production high-blast-radius environment, where the change set's ARN is a durable
server-side pending-approval object (`create-change-set --no-execute-changeset` →
`describe-change-set` → `execute-change-set`).

**Where the agent sits** (research role 2): the MVP agent is an **interactive
operator** — it calls `terraform plan`/`apply` directly under its own time-boxed
assumed-role session and surfaces the plan as a `needs-you`. This is what
"agent-driven deployment" actually means for the pitch. It means the agent
process briefly holds a credentialed session, so the guardrail stack (§5) carries
the weight. The safer fallback pattern — **agent authors a pipeline PR**, a
human-owned CI pipeline (GitHub Actions + OIDC, or CodePipeline) does the actual
plan/apply with its own manual-approval gate, keeping the agent out of the
credentialed path — is the recommended shape for production once the guardrail
stack is proven, and is noted as a phased option (§12).

---

## 4. Architecture in localflow

Four new/extended pieces, each grounded in an existing module. Nothing here
requires a new UI primitive.

### 4.1 Credential-minting / injection module — `src/main/cloud-credentials.ts` (new)

**Responsibility:** given a pane's project config (§8), mint a short-lived cloud
credential and hand it to the session as an env override — without the secret
material ever leaving the main process's memory for a durable surface.

**Shape:**

```
interface CloudCredentialRequest {
  cloud: 'aws' | 'gcp' | 'azure'
  roleArn?: string          // AWS: role to assume
  externalId?: string       // AWS: confused-deputy mitigation
  sessionName: string       // e.g. `localflow-<paneId>-<taskShortId>`
  durationSeconds: number   // capped 900–1800 for MVP
  region?: string
  // GCP: workloadIdentityPool/provider/serviceAccount; Azure: tenant/clientId/fic
}

type MintedCredential = {
  cloud: 'aws' | 'gcp' | 'azure'
  env: Record<string, string>   // the ONLY thing that leaves this module
  expiresAt: number             // epoch ms; drives refresh/expiry UX
  // no field ever holds the raw secret for logging — env is opaque to callers
}
```

- **AWS MVP:** call `sts:AssumeRole` (AWS SDK for JS v3 `@aws-sdk/client-sts`, or
  shell out to `aws sts assume-role` — SDK preferred so the secret never touches
  an argv or a captured stdout string). Produce
  `{ AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION }`
  as the `env` map. localflow itself authenticates to STS via the user's existing
  local AWS identity (their `~/.aws` profile / SSO) for the MVP; a fully-keyless
  `AssumeRoleWithWebIdentity` path (localflow as its own OIDC issuer) is a later
  phase.
- **Injection point:** `SessionManager.updateSpecEnv(id, env)` **already exists**
  (`session-manager.ts:266`) for exactly this purpose — its doc comment cites
  "refresh injected credentials (e.g. a relaunched OpenClaw session's re-granted
  operator token)." The minted `env` map is merged into the pane's `SpawnSpec.env`
  and takes effect on the pane's next (re)spawn, flowing through the existing
  env precedence at `session-manager.ts:337`
  (`{ ...process.env, ...injection.env, ...(spec.env ?? {}) }`) — user/cred
  overrides win last. A live pty keeps the env it was spawned with, so minting
  happens **before** the agent pane is spawned (or on an explicit re-mint +
  restart).
- **Secret-safety invariants (hard requirements, from the global CLAUDE.md rule
  and `feasibility-aws-devops.md` §4):**
  - The `env` map is the only representation of the secret and is passed straight
    into `spawnFn`'s `env` option. It is **never** logged, never written to the
    activity ring, never included in `emitNotice`/`onData` output, never in a
    peek.
  - Errors from minting surface the STS **error** (code + human cause), never the
    partial/whole credential (§9).
  - The credential is discarded when the pane closes or the session expires;
    localflow holds no long-lived key. `expiresAt` drives the "creds expired,
    re-mint" UX (§9).
  - A follow-up hardening item: scrub any accidental appearance of
    `AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`-shaped strings from the pane tail
    before it can reach a peek (defense in depth; the plan output itself is not
    secret).

### 4.2 Plan-ready `needs-you` detector — extend the hook/status path

**Problem:** localflow spawns each agent as a raw pty and **never inspects the
bytes inside it** (`session-manager.ts` `onData` only keeps a 16 KiB tail for
exit messages and peeks — see the G2 spec's "key finding"). So "a plan is ready"
cannot be detected by scraping the terminal reliably as the primary mechanism.

**Primary mechanism — the agent's own hook signals `needs-you`.** localflow's
status feed is already hook-driven: agents emit `Notification`/prompt events that
`transition()` maps to `needs-you` (yellow). The design leans on this: the
**operator/agent is instructed** (via the DevOps skill/prompt it runs under) to,
after producing `plan.tfplan`, stop and signal a needs-you (the same way an agent
signals a y/n prompt today). The plan's human-readable diff is already sitting in
the pane's tail, so `peek()` surfaces it with no new plumbing — exactly the
pattern `feasibility-aws-devops.md` §6 identifies ("a `terraform plan` review
needs no new UI primitive, just a new detector that recognizes 'plan is ready,
awaiting apply'").

**Secondary/defense signal — a plan-artifact watcher.** Because the approval gate
must be trustworthy, localflow additionally watches for the `plan.tfplan` artifact
in the pane's cwd (a file-existence/mtime check, analogous to the Codex
guard-observed marker watcher at `session-manager.ts:462` `markGuardObserved`).
When a fresh `plan.tfplan` appears **and** the pane is `needs-you`, localflow
tags the pane's needs-you as a **"plan ready"** variant so the UI can label the
Approve action as "Approve & apply plan" rather than a generic keystroke. This
watcher is a UX enhancement, not the security boundary — the security boundary is
that **bare `terraform apply` is an lfguard-denied shape** (§7), so there is no
apply path that skips the saved plan.

### 4.3 The plan→apply gate reuses `peek` + `ApproveButton` exactly

The existing flow (`ApproveButton.tsx`, `SessionManager.peek()`):

1. Pane enters `needs-you`; `ApproveButton` renders.
2. User clicks **approve** → `window.localflow.peekSession(id)` returns the last
   N cleaned tail lines (`peek()` → `extractPeekLines`) — here, the tail lines
   are the **plan diff** (resource adds/changes/destroys). Not secret material;
   safe to render.
3. Popover shows the diff; **arm-then-confirm** (never blind). Outside-click or
   bare Escape disarms.
4. **Send ⏎** writes `\r` to the pty (`window.localflow.write(id, '\r')`) — the
   agent-agnostic "accept the highlighted option" keystroke. The agent, waiting
   at its own prompt, proceeds to run `terraform apply plan.tfplan` **in the same
   pane/session** — same STS credentials, same CloudTrail `RoleSessionName`, no
   re-auth gap.

**No changes to `ApproveButton.tsx` are required for the MVP.** The only optional
enhancement is passing through a "plan ready" label (from 4.2) so the button
reads "Approve & apply" — a copy change, not a new primitive.

**Why there is no bypass:** the plan/apply split *is* the approval gate. If the
agent tries `terraform apply` **without** a saved plan file (which would re-plan
and apply blind), lfguard's `iac.terraform` pack denies it (§7). `-auto-approve`
is denied categorically. `terraform destroy` is denied. So the only path from
"agent wants to change infra" to "infra changes" runs through a human-reviewed
`.tfplan` + an explicit Approve.

### 4.4 New lfguard packs

Two new TOML packs under `guard/crates/lfguard/packs/` — `iac.terraform.toml` and
`cloud.aws.toml` — modeled structurally on `cloud.gcloud.toml` (specific high-
value rules first so the block reason names the resource class; a tuned catch-all
last). They are **opt-in** (`default_on = false`), toggled per-agent in Settings,
resolved to `--pack <id>` flags baked into each pane's hook command at spawn
(same wiring as the existing packs; see the G2 spec). Full rule design in §7.

### 4.5 Textual data-flow

```
User provisions (once, out-of-band): sandbox AWS account +
  IAM role `localflow-agent-sandbox` with a permissions boundary +
  trust policy (their principal, required ExternalId).  [§8 config]
        │
        ▼
Open a DevOps pane on a project
        │  main: cloud-credentials.ts → sts:AssumeRole(roleArn, externalId,
        │        sessionName=localflow-<paneId>-<task>, DurationSeconds≤1800)
        │        → { AWS_ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _SESSION_TOKEN }
        │        (secret material stays in main-process memory only)
        ▼
SessionManager.updateSpecEnv(paneId, credEnv)  → merged into SpawnSpec.env
        │  spawn: env = { ...process.env, ...hookInjection, ...credEnv }
        │  hook command carries --pack iac.terraform --pack cloud.aws
        ▼
Agent pane runs under scoped creds. Every shell command → agent PreToolUse hook
        │        → lfguard (exit 2 = deny, exit 0 = allow, fail-open on error)
        │  `terraform destroy`, bare `terraform apply`, `-auto-approve`, etc. → DENIED
        ▼
Agent: `terraform plan -out=plan.tfplan`  (allowed; no mutation)
        │  plan.tfplan appears in cwd → artifact watcher notes it
        │  agent signals needs-you (hook) → status → yellow
        ▼
Renderer: ApproveButton → peekSession(paneId) → plan diff (NOT secret) in popover
        │  human reviews, arm-then-confirm → write('\r')
        ▼
Agent (same pane, same STS session): `terraform apply plan.tfplan`
        │        → API calls hit AWS under the assumed role
        │        → permissions boundary ∩ role policy caps what any call can do
        │        → SCP (org) backstops even that; budget action is the $ circuit-breaker
        ▼
CloudTrail records every call, correlated by RoleSessionName  [independent audit]
        │  lfguard --audit-log records every DENIED command (local pre-exec record)
        ▼
STS session expires (≤30 min) or pane closes → credential discarded. No standing key.
```

---

## 5. The layered guardrail stack

The core of the pitch: **even if the agent tries to exceed scope, it structurally
can't.** Layers compose innermost (client-side, first to fire, weakest) to
outermost (cloud-enforced, last-resort, strongest). An attacker/misbehaving agent
must defeat *every* layer; each is independent.

| # | Layer | Enforced by | What it stops | Defeatable if… |
|---|---|---|---|---|
| **L1** | **lfguard command block** | localflow (client) | Destructive command *shapes* before they hit the network (`terraform destroy`, bare `apply`, `-auto-approve`, `aws ... delete-*`, self-priv-esc — §7) | agent bypasses localflow's pty entirely (runs commands outside the guarded hook). First line of defense, **not** the last. |
| **L2** | **IAM permissions boundary** on the assumed role | AWS IAM | Any API call outside the boundary — effective perms = role policy ∩ boundary, regardless of what the role's own policy grants. Blocks the classic `iam:CreateRole`/`PassRole` self-escalation structurally. | someone edits the boundary itself (which the boundary + SCP forbid). |
| **L3** | **Service Control Policy (SCP)** at the OU/account | AWS Organizations | A hard ceiling on *every* principal in the account — the agent's role, root, even a forgetful admin. Never grants, only restricts. Sept-2025 full IAM policy language enables precise denies (e.g. deny `ec2:TerminateInstances` on `Tag/Environment=prod`). | the org management account is compromised (out of scope). |
| **L4** | **Separate sandbox account** | AWS Organizations / Control Tower | The agent's default identity literally **cannot reach** staging/prod resources — they live in different accounts. Promotion needs a distinct, human-issued credential (different trust policy/ExternalId). | the user hands the agent a prod credential (a deliberate human act). |
| **L5** | **AWS Budget action** | AWS Budgets | Automatic financial circuit-breaker — attaches a restrictive/deny policy or SCP to the sandbox account when spend crosses a threshold. Caps runaway cost from a looping agent. | threshold set too high (config discipline). |
| **L6** | **CloudTrail audit** | AWS CloudTrail | Independent, tamper-evident record of what the assumed-role session *actually did*, correlated by `RoleSessionName`. Cross-checks localflow's own local logs. | it doesn't *prevent*, it *proves* — the always-on backstop. |

**How they compose (worked example — the agent tries to nuke prod):**

1. Agent (buggy or adversarial) tries `terraform destroy` → **L1 lfguard** denies
   at the command level (exit 2). Suppose the agent finds a way to bypass the
   guard.
2. The destroy calls hit AWS under the assumed role → the **L2 permissions
   boundary** doesn't grant `*:Delete*` on anything outside its curated set, so
   most calls fail `AccessDenied`.
3. Even where the boundary is looser than intended, the **L3 SCP** denies deletes
   tagged `Environment=prod` for every principal.
4. There *are* no prod resources in this account — **L4** put them in a different
   account the agent's identity can't assume into.
5. If the agent instead loops creating expensive resources, the **L5 budget
   action** attaches a deny-all policy once spend crosses the cap.
6. Regardless of which layers held, **L6 CloudTrail** records every attempt under
   the per-task `RoleSessionName` for the human to review.

**The lfguard + IAM pairing is the headline (from the scope doc):** lfguard is
*command-level* safety (fail-open, blocks destructive shapes); scoped IAM is
*capability-level* safety (the cloud, not localflow, refuses the API call). Even
if a command slips past the guard, IAM caps the blast radius; even within granted
IAM, the guard blocks destructive shapes. That two-sided property is what makes
"the agent can't exceed scope even if it tries" true rather than aspirational.

---

## 6. Cross-cloud identity

The identity requirement is identical on all three clouds: **scoped, short-lived,
least-privilege, keyless-from-localflow's-side, auditable, no long-lived secret
ever held or rendered.** All three support every element (`feasibility-cloud-
iam.md` cross-cloud verdict: YELLOW — feasible on all three; Azure lags on
ergonomics, not capability). The MVP builds AWS; the module (§4.1) is
`cloud`-parameterized so GCP and Azure adapters slot in.

### AWS (MVP)

- **Identity primitive:** IAM **role** (not an IAM user — AWS steers third-party
  integration away from long-term keys). A role yields temporary credentials on
  assumption.
- **Keyless mechanisms:** (a) **cross-account role + `ExternalId`** — the classic
  SaaS-vendor pattern; localflow calls `sts:AssumeRole` from the user's own local
  AWS identity (MVP: their `~/.aws` profile/SSO) with the role ARN + external id.
  (b) **`AssumeRoleWithWebIdentity`** — fully keyless; localflow presents an OIDC
  JWT it controls to STS, no AWS identity on localflow's side at all (requires
  localflow to be a conformant OIDC issuer — a later phase).
- **Scoping:** identity-based policy scoped by resource ARN + `Condition`, plus a
  **permissions boundary** (a second managed policy capping max permissions —
  effective = intersection).
- **Short-lived:** `DurationSeconds` 900s–43200s (default 3600); MVP caps at
  ≤1800s per task pane. `RoleSessionName` + optional `SourceIdentity` stamp into
  CloudTrail for per-session attribution.
- **Audit:** CloudTrail (management events on by default; a Trail to S3 for
  retention).

### GCP (later — the easiest cloud, per research)

- **Identity primitive:** service account (SA).
- **Keyless mechanism:** **Workload Identity Federation** — external OIDC token →
  Google STS → SA impersonation (`iam.serviceAccountTokenCreator`), no SA key ever
  created. This is Google's headline-recommended pattern for exactly "external
  product accesses a customer's GCP project." Direct-impersonation
  (`generateAccessToken`) is the alternative when localflow is the trusted caller.
- **Scoping:** IAM role bindings at org/folder/project/**resource** level + **IAM
  Conditions** (time windows, resource-attribute matches) — as tight as "read/
  write only this one bucket."
- **Short-lived:** impersonation tokens default 1h, extendable to 12h only via the
  `iam.allowServiceAccountCredentialLifetimeExtension` org policy.
- **Audit:** Cloud Audit Logs (Admin Activity always on; `AuthenticationInfo`
  records the acting principal).
- **Why easiest:** single IAM surface, single admin identity to provision
  everything, audit on by default, Google explicitly documents this scenario, and
  it matches Jonas's baseline gcloud-service-account fluency.

### Azure (last — capable but most friction)

- **Identity primitive:** **service principal** backing an Entra app registration.
  **NOT managed identity** — managed identity only works for code running *on*
  Azure compute; it silently fails for an external app. This is the one cloud
  where the obvious primitive-by-analogy is a dead end, so the provisioning flow
  must steer users to the app-registration + FIC path.
- **Keyless mechanism:** **federated identity credential (FIC)** on the app
  registration ("Other issuer") trusting localflow's OIDC issuer; localflow
  presents its JWT via client-credentials and gets a short-lived Entra token — no
  client secret. Max 20 FICs per app.
- **Scoping:** Azure RBAC at management-group → subscription → resource-group →
  **resource**.
- **Short-lived:** standard OAuth2 access tokens (~1h), re-minted per fresh
  external JWT (no explicit `DurationSeconds` knob).
- **Audit:** Activity Log (control-plane on by default; **data-plane needs per-
  resource diagnostic settings** — a materially weaker default than AWS/GCP).
- **Friction (why last):** two admin surfaces (Entra directory role for the app
  registration + Azure RBAC for resource access); `subject`/`issuer`/`audience`
  mismatches fail **silently** ("the exchange fails without error") — the roughest
  failure mode of the three, which the §9 error handling must special-case.

### Secret-safety, cross-cloud

All three keyless-federation mechanisms satisfy "never render secret material"
**by construction** — none produces a long-lived secret for localflow to hold. The
only in-memory residue is a short-lived **bearer token** (AWS session credentials,
GCP access token, Azure access token) which §4.1's invariants treat like any
other in-memory secret: injected into the pane env, never logged/echoed/peeked,
discarded on expiry. The real secret-avoidance win is on the **setup** side: no
JSON key file, no client secret/cert, no IAM user access key is ever generated,
pasted, or persisted to provision access.

---

## 7. lfguard pack design

Two new opt-in packs, structurally modeled on `cloud.gcloud.toml`. Both must
preserve lfguard's two engine invariants:

- **Zero false positives (precision over coverage).** Like `core.filesystem`
  ("blocks the irrecoverable footguns and deliberately stays quiet on ordinary
  … deletes"), these packs block genuinely destructive/irreversible shapes and do
  **not** trip on read-only verbs (`describe`, `list`, `get`, `plan`, `output`).
  A false positive that blocks a safe command trains users to disable the pack —
  the worst outcome. The `cloud.gcloud` `\bdelete\b`-inside-a-resource-name lesson
  (comment at `cloud.gcloud.toml:53`) applies: `delete` must be matched as a
  whitespace-delimited **verb token**, not a substring, so
  `aws ec2 describe-instances ... delete-me-box` is not blocked.
- **Fail-open.** Any internal error, missing binary, unparseable input, timeout,
  or non-1 exit code degrades to **allow** (`operator-guard.ts`: `code === null` /
  timeout / any code ≠ 1 → `{ allowed: true }`). A broken guard becomes
  "unguarded," never "agent stuck." The packs add rules; they must not change this.

Each pack has `[pack]` id/name/description/`default_on = false`/version and cheap
`triggers` (keyword prefilter), then ordered `[[deny]]` rules (`pattern` regex +
human `reason`). Reasons follow `memory/error-message-style.md`: name the resource
class and why it's dangerous, so the block explains itself.

### `iac.terraform.toml` — triggers `["terraform"]`

The single most important pack for the pitch: the plan/apply split **is** the
approval gate, so the rules exist to make the gate unbypassable.

| Rule | Shape to deny | Reason (why) |
|---|---|---|
| **destroy** | `terraform destroy` (bare) and `terraform apply -destroy` | tears down every managed resource |
| **bare apply** | `terraform apply` with **no** saved plan-file argument (not `terraform apply <planfile>`) | re-plans and applies blind, defeating the human plan-review gate — the keystone rule |
| **auto-approve** | `-auto-approve` on `apply` **or** `destroy`, anywhere in argv | defeats interactive confirmation categorically |
| **state rm/mv** | `terraform state rm` / `terraform state mv` | silently detaches a resource from state (next apply may orphan/recreate it) — "looks like nothing happened until it's too late" |
| **force-unlock** | `terraform force-unlock` | bypasses state-lock protection (concurrent-run safety) |

Design notes: "no saved plan-file argument" is the tricky rule — match
`terraform apply` **not** followed by a non-flag token that looks like a plan file
(and not `-auto-approve`, which the auto-approve rule catches independently).
Because fail-open is the invariant, when the plan-file detection is ambiguous the
pack should err toward denying the *clearly*-bare form (`terraform apply` with no
positional arg) rather than risk false-positiving a legitimate
`terraform apply tfplan`. This rule pairs with the artifact watcher (§4.2): the
approved path is always `apply <the .tfplan the human reviewed>`.

### `cloud.aws.toml` — triggers `["aws"]`

| Rule | Shape to deny | Reason (why) |
|---|---|---|
| CFN stack delete | `aws cloudformation delete-stack` | deletes a stack and (per DeletionPolicy) its resources |
| S3 bucket force-remove | `aws s3 rb ... --force` / `aws s3 rm s3://... --recursive` | force-removes a bucket incl. all objects / recursively deletes objects |
| EC2 terminate | `aws ec2 terminate-instances` | irreversibly terminates instances (vs. stop) |
| RDS delete w/o snapshot | `aws rds delete-db-instance` / `delete-db-cluster` **without** `--final-db-snapshot-identifier` | deletes a database with no final snapshot — genuinely unrecoverable. A snapshotted delete is comparatively safe and should **not** block (mirrors gcloud's distinguish-don't-blanket approach) |
| DynamoDB drop | `aws dynamodb delete-table` | deletes a table and all its data |
| IAM self-priv-esc | `aws iam delete-role`/`detach-role-policy`/`delete-user` on the agent's **own** identity; any `put-role-policy`/`attach-role-policy`/`create-policy-version` that widens the agent's own boundary or attaches `AdministratorAccess` | self-privilege-escalation is the exact scenario L2 (§5) prevents structurally; catch the *attempt* at the command level as defense-in-depth |
| Org mutations | `aws organizations delete-organization`/`leave-organization`/`detach-policy` (SCP) | org-level blast radius — never agent-callable |
| **catch-all** | generic `aws <service> delete-*` / `*-terminate*` / `*-force*` verb pattern | destructive AWS operation — mirrors gcloud's final broad backstop, tuned to **not** trip on read verbs (`describe`/`list`/`get`) that contain "delete" in a resource name |

Both packs get **corpus tests** (§10) covering every row above plus the near-miss
safe commands that must **not** block.

### Secondary / later packs

`container.docker` (`docker system prune -a --volumes`, `docker volume rm`) and
`container.k8s` (`kubectl delete namespace`, `kubectl delete pv/pvc`,
`helm uninstall` on prod-named releases) are adjacent (a real deploy loop touches
image builds and maybe EKS) but out of MVP scope. GCP already has `cloud.gcloud`;
a `cloud.azure` pack (`az group delete`, `az vm delete`, `az account`/role-
assignment mutations) lands with the Azure phase.

---

## 8. Config & data model

Per-project DevOps config, stored alongside localflow's existing per-project
settings (extends the config surface Settings already writes). No secret material
is ever stored — only ARNs, ids, and references.

```
interface ProjectCloudConfig {
  cloud: 'aws' | 'gcp' | 'azure'          // MVP: 'aws'
  enabled: boolean                         // is the DevOps layer on for this project

  aws?: {
    roleArn: string                        // arn:aws:iam::<acct>:role/localflow-agent-sandbox
    externalId: string                     // NOT a secret; confused-deputy value
    region: string
    sandboxAccountId: string               // the account the role lives in
    durationSeconds: number                // ≤1800 (MVP cap)
    // references only — localflow does not manage these, it points at them:
    permissionsBoundaryArn?: string        // for display/verification
    scpId?: string                         // org SCP id, if the user has an Organization
    budgetName?: string                    // AWS Budget with a budget action
    cloudTrailName?: string                // trail to link the user to for audit
  }
  // gcp?: { workloadIdentityPool, provider, serviceAccount, project, ... }
  // azure?: { tenantId, clientId, ficSubject, subscriptionId, ... }

  packs: string[]                          // e.g. ['iac.terraform', 'cloud.aws']
}
```

- **Displayed, not just stored:** the pane header shows *which identity/role* it
  runs under (role ARN short form + region + "expires in N min"), so the human can
  always see the blast-radius boundary — this is part of the pitch (the user
  bounds exactly what the agent can touch, and can *see* it).
- **`externalId` is explicitly non-secret** (per `feasibility-cloud-iam.md`) and
  safe to store/display. The role ARN, account id, boundary/SCP/budget/trail refs
  are all non-secret resource identifiers.
- **What is never stored:** any access key, secret key, session token, SA key, or
  client secret. There is nothing secret to store — the whole point of the keyless
  model (§6).
- **Provisioning artifact (MVP):** localflow ships a copy-pasteable Terraform (and
  CloudFormation) snippet that creates the sandbox role + permissions boundary +
  trust policy; the user applies it themselves and pastes back the resulting role
  ARN. Guided in-app provisioning is a later phase (§11).

---

## 9. Error handling

Every failure surface follows `memory/error-message-style.md`: **one plain-human
sentence (what went wrong + what to do next) + the real technical detail (the
caught exception / error code / offending value).** Never a bare `failed` /
`not found` / silent swallow. The credential path additionally must surface the
*error* without ever surfacing the *credential*.

| Failure | Bad (rejected) | Good (required shape) |
|---|---|---|
| **AssumeRole failure** | `Auth failed` | `Couldn't assume the sandbox role arn:aws:iam::…:role/localflow-agent-sandbox — check the role's trust policy allows your identity and the ExternalId matches. (STS AccessDenied: …)` |
| **Expired creds** | pane silently 401s | `This pane's AWS credentials expired (minted 31 min ago, 30 min max). Re-mint to keep going — Settings → re-grant, then restart the pane.` The `expiresAt` from §4.1 drives a proactive warning before expiry, not just a post-hoc error. |
| **Denied plan / apply (IAM AccessDenied at apply)** | `apply failed` | `terraform apply was denied by AWS — the sandbox role's permissions boundary doesn't allow <action> on <resource>. Widen the boundary (out-of-band) or narrow the plan. (AccessDenied)` — names the boundary as the cause so the user knows this is the guardrail working, not a bug. |
| **lfguard block** | `blocked` | Reuses the existing block surface: `lfguard: BLOCKED by iac.terraform: bare 'terraform apply' re-plans and applies blind — run 'terraform plan -out=plan.tfplan', review, then approve.` (`operator-guard.ts` `parseDeny` already extracts pack + reason; the block is emitted via `emitNotice` into the pane and the `--audit-log` JSONL.) |
| **Azure silent FIC mismatch** (§6) | (nothing — the exchange fails silently) | localflow must **synthesize** a legible error: `Azure token exchange returned no token and no error — this usually means the federated-credential subject/issuer/audience don't match. Verify the FIC 'subject' equals localflow's token 'sub'. (empty token response)` |
| **Minting error must not leak the secret** | (an exception whose message embeds a partial credential) | The module (§4.1) surfaces only the STS/STS-error code + the non-secret request context (role ARN, session name, region). Any credential-shaped substring is scrubbed before display. |

The principle from the memory note: a swallowed or generic error costs the user a
debugging session (the Finder-PATH bug is the cited precedent). The technical
detail lets a developer fix it; the human sentence makes it approachable; dropping
either wastes their time.

---

## 10. Testing strategy

Layered to match the architecture; the same seams localflow already uses for
determinism.

- **lfguard corpus tests (Rust, in `guard/`).** For each `[[deny]]` rule in both
  new packs: a set of **should-block** commands (every enumerated destructive
  shape in §7, including flag/arg orderings and `sudo`-wrapped forms) and a set of
  **must-not-block** near-misses (`terraform plan`, `terraform apply plan.tfplan`,
  `terraform output`, `aws ec2 describe-instances`, `aws s3 ls`, `aws rds
  delete-db-instance --final-db-snapshot-identifier snap-1`, a resource literally
  named `delete-me`). This is the primary guarantee of the zero-false-positive
  invariant and mirrors how the existing packs are tested. Include the
  `terraform apply` "no planfile vs. planfile" boundary explicitly.
- **Credential-minting unit tests (TS).** Inject a **mock STS** (the module takes
  an SDK/runner seam exactly like `operator-guard.ts`'s `GuardRunner` and
  `session-manager.ts`'s `SpawnFn`/`now` seams). Assert: (a) a successful mint
  produces the right `env` keys and an `expiresAt`; (b) **no test ever finds the
  secret in any log/emit/peek** — a spy over `emitNotice`/`onData`/activity that
  fails if a credential-shaped string appears; (c) an STS error yields the §9
  legible message and **no** credential material; (d) expiry math drives the warn/
  re-mint path.
- **Plan-ready detector tests (TS).** Feed a mock pane a synthetic
  `terraform plan` tail + a `plan.tfplan` artifact event; assert the pane reaches
  `needs-you`, `peek()` returns the diff lines (not secrets), and the "plan ready"
  label is set. Use the existing `now`/spawn seams; no real Terraform.
- **Gate integration test (TS, mock pty).** Drive the full loop against a fake
  agent that echoes a plan then waits: assert Approve writes `\r`, and that a
  simulated bare `terraform apply` is denied by the guard before it can run.
- **No live cloud in CI.** Everything mocks STS/Terraform/pty. A manual, opt-in
  smoke test against a real throwaway sandbox account is a release checklist item,
  not a CI gate.

---

## 11. Open decisions (flagged)

1. **"For me" vs. "product" fork — the biggest one.** The MVP that assumes the
   user drives STS from their own local `~/.aws` identity (single operator,
   Jonas dogfooding) is materially simpler than the productized shape (localflow
   as a hosted OIDC issuer doing fully-keyless `AssumeRoleWithWebIdentity`/WIF/FIC
   for many users, with guided provisioning). These diverge on the credential-
   minting module (§4.1), the identity model (§6), and onboarding. **Decision
   needed before building §4.1:** build the single-operator local-identity path
   first (recommended — it proves the whole loop with the least infra), or invest
   in the hosted-issuer path up front. This spec assumes single-operator-first.

2. **Sandbox-vs-prod account policy — how hard is the wall?** Research strongly
   recommends the agent's default identity live in a **sandbox account** that
   literally cannot reach prod (L4). But full Control Tower multi-account
   separation is a real onboarding cost. **Decision:** does the MVP *require* a
   separate sandbox account (correct, higher friction) or *recommend* it while
   allowing a single account with a tight permissions boundary + SCP as the day-one
   default (lower friction, weaker wall)? This spec proposes: **require a dedicated
   sandbox account but not full Control Tower** — recommend Control Tower as the
   user graduates toward production. Also unresolved: what, exactly, is the
   promotion path (sandbox → staging → prod) and does localflow ever touch prod at
   all, or only ever author PRs for a human-owned prod pipeline (research role 1)?

3. **How much provisioning localflow automates vs. the user sets up.** The MVP
   ships a copy-paste Terraform/CFN snippet the user applies themselves (§8). A
   guided in-app wizard (pick account → pick services → mint role + boundary +
   trust policy + budget) is much better UX but is itself privileged infra-
   mutating code — ironic for a tool whose pitch is bounding what agents can
   touch, and it multiplies by three clouds (three provisioning flows, each with
   its own gotchas: GCP over-broad-role defaults, AWS loose `sub`/ExternalId, Azure
   managed-identity-dead-end + silent FIC mismatch). **Decision:** manual snippet
   for MVP (proposed); guided wizard as a phase, and *whether* localflow should
   ever hold provisioning-level permissions at all is itself open.

Additional (smaller) flags: **multi-cloud phasing** — the identity model is
cross-cloud from day one, but do GCP/Azure packs + minting adapters wait for the
AWS loop to fully prove out (proposed), or build in parallel? And **Access
Analyzer is visibility-only** — the MVP must not claim it closes the least-
privilege loop; acting on its findings is a human/automation process step, not an
enforcement layer.

---

## 12. MVP slice + phased roadmap

**MVP (smallest slice that proves identity → guardrail → approval → audit
end-to-end):** AWS + Terraform, single sandbox account.

- User provisions (once, out-of-band, via localflow's snippet) a sandbox account +
  `localflow-agent-sandbox` role with a permissions boundary and an
  `ExternalId`-gated trust policy.
- localflow mints ≤30-min STS creds per task pane (§4.1), injected via
  `updateSpecEnv`, never rendered.
- `iac.terraform` + `cloud.aws` lfguard packs block the §7 shapes.
- `terraform plan -out=plan.tfplan` → plan-ready `needs-you` → `peek()` diff →
  `ApproveButton` → `terraform apply plan.tfplan` in the same session. Bare apply
  is guard-denied, so the gate can't be bypassed.
- CloudTrail (per-task `RoleSessionName`) is the independent audit; the pane header
  shows the identity + expiry.

This deliberately excludes CDK/CloudFormation-as-primitive, CodePipeline, SSM
sessions, cross-account promotion, and GCP/Azure — every one of those layers on
top **without changing this core shape**.

**Phased roadmap:**

- **Phase 1 (MVP):** the slice above — AWS + Terraform plan/approve in a sandbox.
- **Phase 2 — more AWS surface:** `cloud.aws` catch-all coverage hardening; CFN
  change-sets as an alternative plan primitive (durable server-side approval
  object); AWS Budget action wired as the L5 circuit-breaker; CloudTrail Trail
  linking in the UI; drift-check ("run plan first") ergonomics.
- **Phase 3 — ops + CI/CD:** SSM Run Command (auditable one-shot ops) with a
  start-of-session approval gate for interactive Session Manager; the "agent
  authors a pipeline PR, human-owned CI applies" pattern (research role 1) for
  production; `container.docker`/`container.k8s` packs.
- **Phase 4 — GCP:** WIF minting adapter + `cloud.gcloud` already exists; add the
  GCP branch to `cloud-credentials.ts` and config. (Easiest cloud per research —
  single IAM surface, audit on by default.)
- **Phase 5 — Azure:** FIC minting adapter + `cloud.azure` pack; special-case the
  silent-FIC-mismatch error (§9) and the managed-identity dead-end in provisioning
  guidance. (Most friction — two admin surfaces, weaker data-plane audit default.)
- **Cross-cutting:** the "for me vs. product" fork (§11.1) decides whether/when the
  hosted-OIDC-issuer keyless path and guided provisioning wizard get built.

---

## Appendix — localflow modules this touches (by path)

- `src/main/cloud-credentials.ts` — **new**: per-pane cred minting/injection (§4.1).
- `src/main/session-manager.ts` — reuse `updateSpecEnv` (l.266) for cred env
  injection; `markGuardObserved` (l.462) is the pattern for the plan-artifact
  watcher; env precedence at l.337; `peek()` at l.700.
- `src/renderer/src/components/ApproveButton.tsx` — reused **unchanged** (optional
  "plan ready" label copy only).
- `src/main/operator-guard.ts` — the guard runner + `parseDeny`; new packs flow
  through its existing `--pack` args and fail-open contract.
- `guard/crates/lfguard/packs/iac.terraform.toml`, `cloud.aws.toml` — **new**
  packs (§7), modeled on `cloud.gcloud.toml`.
- `src/shared/agents.ts` — the status feed the plan-ready `needs-you` rides on.
- Config surface (Settings) — `ProjectCloudConfig` (§8).

## Appendix — primary sources

Full source lists (AWS docs, HashiCorp, cloud IAM docs) are in
`scratchpad/feasibility-aws-devops.md` and `scratchpad/feasibility-cloud-iam.md`.
Key anchors: STS `AssumeRole` API ref; IAM permissions boundaries; AWS
Organizations SCPs; Control Tower multi-account; AWS Budgets actions; CloudTrail;
CloudFormation change-sets + drift detection; Terraform core workflow; GCP
Workload Identity Federation; Azure federated identity credentials.
