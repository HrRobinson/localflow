# Agent-facing API client — brainstorm primer

**Status:** Starting point for a brainstorm. NOT a design, NOT a spec.
**Date:** 2026-07-23
**Origin:** Raised while working in the `saiife.com` repo; written here because the
work belongs in `localflow`.

## How to use this

Open a session in this repo and start with the `superpowers:brainstorming` skill.
This file is context for that conversation, not a substitute for it. Everything
below marked **open** is genuinely undecided and should be argued out, not
assumed.

---

## The idea, as originally stated

Build something Postman-like into localflow: manage endpoint/API docs, compose
requests, keep collections. Then make it usable by an agent — where a stored
bearer token is exposed to the agent through a hash key that rotates every 12
hours, so a session can be handed the hash and use the credential without being
handed the credential.

## The reframe worth arguing about

The rotation framing has one flaw: **if the agent can dereference the secret, the
agent has the secret.** A 12-hour rotation bounds how long a *leaked handle*
stays useful. It does nothing about what the agent can do while the handle is
live, and nothing about the real leak vector — the raw token landing in a
transcript that gets logged, written to a session file, sent to a model provider,
or pasted into a bug report. Once a token is in context, it is in context.

The stronger version inverts it. The agent never receives anything that
dereferences to the secret. It receives a **reference it cannot resolve**, and
only the main process can:

```
agent  →  POST /http/send { requestId, overrides }     (session capability)
             ↓
        main process substitutes the real credential
             ↓
        request goes out; response returns REDACTED
```

The agent composes requests, sends them, reads results, iterates — the whole
workflow — and the credential never enters its context at any point. Rotation
then becomes a nice-to-have on the capability rather than the thing security
rests on.

**Why this is not a new invention here:** it is the discipline this codebase
already enforces at a different boundary. See below.

---

## What already exists (this is the strongest argument for building it)

Verified by reading the source on 2026-07-23. Roughly 80% of the hard parts are
already in place.

| File | What it already gives you |
| --- | --- |
| `src/main/integrations/credential-store.ts` | The only module that touches raw secret material. Electron `safeStorage`, encrypted sidecar in userData, never config.json. **`revealForConnector` is documented as "the sole plaintext exit and is MAIN-PROCESS-ONLY", with a grep test asserting zero IPC/renderer callers.** This is exactly the inversion above, already enforced against the renderer. |
| `src/main/operator-grant.ts` | `OperatorGrantStore` — mints a bearer per environment, resolves a token back to its environment in **constant time** (`timingSafeEqual`), revocation drops it so the token stops resolving immediately. In-memory, does not survive restart. This is the capability primitive. |
| `src/main/http/http-token-store.ts` | Per-node secrets for the generic HTTP connector, under a **collision-safe composite key** (length-prefixed `nodeId`). Plaintext read at call time, never stored on `this`, never logged or placed in any IPC payload. |
| `src/main/http/` | `http-client.ts`, `http-connector.ts`, `http-descriptor.ts`, `http-node-config.ts`, `http-normalize.ts` — the outgoing HTTP path already exists and is the one connector genuinely on the wire. |
| `src/main/net/ssrf-guard.ts` | SSRF protection, 242 lines. Already written. |
| `src/main/control-api.ts` | The local control API router — 340 lines, "pure over its inputs (no socket), so auth, scoping…" are testable. Already has `/panes`, `/panes/:handle/prompt`, `/watchpoints`, `/captures`, browser verbs. A new route lands here. |
| `saiifeguard` + rule packs + approval gates | Adjudicates shell commands before they run. The same machinery could adjudicate HTTP requests. |
| `guard-audit.jsonl`, `--audit-tag <paneId>` | Per-pane attribution already exists for guard decisions. |
| Environments 1–9 | Postman "environments", already a first-class concept. |

The practical read: this is less "build a Postman" and more "put a UI and an agent
boundary on the HTTP connector that already exists, reusing the credential
discipline that already exists."

---

## Open questions for the brainstorm

These are the ones I'd want settled before any design. Roughly in order of how
much they change the shape of the thing.

### 1. What is the agent's actual interface? **open**

Options worth comparing:
- **Named requests only.** The human curates a collection; the agent may invoke
  request-by-id with parameter overrides, nothing else. Tightest, least useful.
- **Constrained composition.** The agent may compose arbitrary requests, but only
  against an allowlist of hosts/methods/paths, with credentials by reference.
- **Full composition with gates.** Anything goes, but writes and unknown hosts
  hit an approval gate.

This choice determines almost everything else.

### 2. The response path leaks too. **open — most underestimated**

API responses routinely carry tokens, session cookies, PII, other people's data.
If the agent reads responses, secrets reach its context through the back door,
and the request-side discipline was theatre.

Redaction on the response path is genuinely harder than substitution on the
request path — you do not know the shape of an arbitrary response. Worth deciding
whether this is: pattern-based redaction, schema-declared redaction per request,
a "summarise, don't return raw" mode, or an accepted limitation stated plainly.

### 3. Rotation does not stop a confused deputy. **open**

An agent that reads a malicious repo file, issue comment, or web page can be
induced to call the proxy. A shorter timer is no defense at all. The defenses
that actually apply are scoping (hosts/methods/paths) and the approval gates that
already exist. Decide how much weight rotation is really carrying, and whether
12h is the right number or a number that sounds right.

### 4. What happens at the rotation boundary? **open**

A long agent session failing silently mid-task at hour 12 is a bad experience.
Grace window, renewal, or re-grant? Note `OperatorGrantStore` is in-memory and
does not survive a restart, which is a related decision already made for
operators — worth checking whether the same lifetime is right here.

### 5. Is this the `http` connector, or beside it? **open — architectural**

There are already per-node URLs and per-node secrets in `src/main/http/`. Building
a parallel system means two credential stores, two audit paths, and two places to
fix an SSRF bug. Strong prior: same engine, new surface. But that needs checking
against what the flow canvas expects from `http` nodes.

### 6. Scope. **open**

Postman is enormous and the temptation to keep going is strong. A candidate
minimum: collections, environments, secret refs, send, history. Explicitly not:
mocking, monitors, test scripting, codegen, team sync.

### 7. Where does the guard fit? **open**

If `saiifeguard` adjudicates HTTP the way it adjudicates shell, what does an HTTP
rule pack look like? `DELETE` against a production host, writes to money
endpoints, requests carrying an `Authorization` header to a non-allowlisted
origin. This may be the most differentiating part of the whole idea — or scope
creep. Decide deliberately.

---

## The framing I'd argue for

Not "Postman with AI access." Rather: **the first API client whose primary user is
an agent** — where a human curates requests and grants scoped, auditable,
revocable capability, and the agent works inside it, never holding the
credential.

That is a direct extension of what the product already claims — local-first, your
keys stay yours, no telemetry — rather than a bolt-on. It is also the version
that is hard for a cloud-hosted competitor to copy, because it depends on the
credential and the agent being on the same machine.

## Suggested first move in the new session

Read these three files before answering any design question — they set the
constraints, and two of them already solve the hard part:

1. `src/main/integrations/credential-store.ts` — the secret discipline
2. `src/main/operator-grant.ts` — the capability primitive
3. `src/main/control-api.ts` — where a new route lands

Then start `superpowers:brainstorming` and work question 1 first.
