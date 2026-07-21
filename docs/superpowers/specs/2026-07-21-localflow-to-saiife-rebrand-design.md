# localflow → saiife — rebrand design

**Status:** Design (spec) — not started
**Date:** 2026-07-21
**Repo:** `HrRobinson/localflow` (public, v1.11.0)

## Purpose

Rename the product from `localflow` to `saiife`, completely — user-visible strings, identifiers, the Rust guard binary, bundle IDs, docs and release artifacts.

## Why the name changes

Not arbitrary. **saiife = Safe AI Integration For Everyone**, and the acronym describes this product more accurately than it described its predecessor:

- **Safe** — the Rust command guard, approval gates, local-first, no telemetry
- **AI Integration** — 20 connectors, the flow engine
- **For Everyone** — the roadmap explicitly targets both vibe coders and keyboard-first power users

The name also unifies the family: `saiife` (app), `saiife.com` (site), `saiife-hub` (control plane), `saiife-cloud` (relay).

## Decision: full rename, with config migration

Agreed explicitly over the cheaper surface-only option. Internal and external naming must not diverge.

## The rename surface

Measured, not estimated:

| Token | Files |
|---|---|
| `localflow` | 218 |
| `lfguard` | 83 |
| `LOCALFLOW` | 39 |
| `Localflow` | 32 |

Plus these specific identifiers:

| Where | From | To |
|---|---|---|
| `electron-builder.yml` | `appId: dev.hrrobinson.localflow` | `dev.hrrobinson.saiife` |
| `electron-builder.yml` | `productName: localflow` | `saiife` |
| `electron-builder.yml` | `extraResources: guard/target/release/lfguard → lfguard` | `…/saiifeguard → saiifeguard` |
| `package.json` | `"name": "localflow"` | `"saiife"` |
| `guard/crates/lfguard/Cargo.toml` | `name = "lfguard"` ×3 (package, lib, bin) | `saiifeguard` |
| Directory | `guard/crates/lfguard/` | `guard/crates/saiifeguard/` |

Keep `productName` **lowercase** — it matches the existing style and the site's lowercase mono voice.

The description stays accurate but should lose the old name: *"Mission control for Claude Code sessions — one window, many agents, glanceable status."*

## The userData migration — the part that can break users

`src/main/index.ts:303` reads `app.getPath('userData')`. Electron derives that path from `productName`. **Renaming it silently relocates the directory**, so every existing install loses `config.json`, `sessions.json`, `keybindings.json` and custom themes, and the app appears factory-reset.

This is a public v1.11.0 release with real users. The migration is mandatory.

### Behaviour

On first launch, before any store reads:

1. Resolve the new userData dir. If it already contains `config.json`, do nothing — migration is complete.
2. Resolve the legacy dir (the platform-specific `localflow` path — note this differs per OS and must be computed, not assumed relative to the new path).
3. If the legacy dir exists and the new one is empty, **recursively copy the entire directory.**
4. **Copy, never move.** Leave the original intact so a user can downgrade without data loss.
5. Write a marker so the check is cheap on subsequent launches.
6. Log the outcome to the existing console bus. Never block startup: on any failure, log and continue with a fresh config rather than crashing.

### Copy everything — do not enumerate

Migrate the whole directory, not an allowlist. The app writes at least sixteen things to userData:

`config.json` · `sessions.json` · `keybindings.json` · `flows.json` · `endpoint.json` · `integration-secrets.enc` · `hosted-token.enc` · `guard-audit.jsonl` · `guard-seen` · `airtable-cursors.json` · `posthog-cursors.json` · `salesforce-cursors.json` · `operator-grant-<env>.json` · `themes/` · `captures/` · `openclaw.json`

An allowlist would silently destroy user data. The worst cases:

- **`flows.json`** — every flow the user built by hand, gone
- **`hosted-token.enc`** — the paid-tier credential, so a rename would log paying customers out of the thing they pay for
- **`integration-secrets.enc`** — every connector credential
- **`*-cursors.json`** — connector sync positions; losing these causes duplicate event reprocessing on next poll, which is worse than losing them cleanly

An allowlist also rots immediately: there are 23 connector branches in flight, and each new connector adds files. A recursive copy stays correct without maintenance.

### Tests

- Legacy exists, new empty → whole tree copied, legacy untouched
- Both exist → no-op, new config wins
- Neither exists → clean first run, no error
- Nested directories (`themes/`, `captures/`, `guard-seen`) copied intact, not flattened
- `.enc` and `.jsonl` files copied byte-for-byte, not parsed or re-serialised
- Unreadable legacy dir, or one unreadable file mid-copy → logged, startup continues, partial copy does not corrupt state

### Encrypted files need more than a copy

`credential-store.ts` does **not** use the OS keychain directly. It encrypts via Electron `safeStorage` and persists to a sidecar file in userData (`integration-secrets.enc`, a JSON map of `"<id>:<key>" -> base64(ciphertext)`). `hosted-token.enc` follows the same pattern.

The recursive copy moves those files, but **the ciphertext may not survive the rename.** On macOS, `safeStorage` derives its key from a Keychain entry tied to the application, so a new `appId`/product name can mean the copied ciphertext no longer decrypts. Linux (kwallet/gnome-libsecret) has the same exposure; Windows DPAPI is user-scoped and should be unaffected.

**Verify this on macOS specifically before shipping.** If the ciphertext is unreadable after rename, the app must fail gracefully — `credential-store.ts` already has the path for it, emitting *"Stored `<id>` credential `<key>` can't be decrypted (safeStorage: …)"*. Confirm that path triggers cleanly and prompts re-entry rather than crashing or silently treating the connector as unconfigured. Whatever the outcome, document it in the release notes: users may need to re-enter connector credentials once.

## Auto-update continuity

Changing `appId` means the renamed build is a **different application** to the OS and to the updater. Before shipping:

- Confirm whether release-please and `release.yml` publish under a path the existing updater polls
- Decide whether existing installs can auto-update across the ID change, or whether this needs a final `localflow` release that points users at the new download

If continuity is impossible, that is acceptable — but it must be a deliberate, documented choice, not a discovery made after release.

## Also in scope

- **README, CHANGELOG, CONTRIBUTING, all of `docs/superpowers/`** (20 plans, 51 specs)
- **`openclaw/skills/localflow/`** — skill directory name, `SKILL.md`, and `bin/localflow-control.mjs`
- **`.github/workflows/`** — `ci.yml`, `e2e.yml`, `codeql.yml`, `release.yml`, `release-please.yml`. The guard build job and the universal-mac guard binary job both reference `lfguard` paths.
- **`tests/`** — 237 Vitest files and 6 Playwright specs; fixtures reference binary names
- **Icons and branding assets** in `assets/`
- **Environment variables.** `LOCALFLOW_CLAUDE_BIN` and `LOCALFLOW_OPENCLAW_BIN` are read in `src/main/index.ts`; the `LOCALFLOW` token appears in 39 files. Renaming these to `SAIIFE_*` breaks anyone who has set them. Read the new name first and **fall back to the old one** for a release or two, logging a deprecation notice when the legacy variable is used.

## Explicitly out of scope

- **Renaming the GitHub repo.** Separate decision with external consequences (clone URLs, stars, inbound links). GitHub redirects, but coordinate it deliberately.
- Any functional change. This is a rename and a migration. Nothing else.

## The `build/*` branches are not a blocker — verified

An earlier draft of this spec warned that 22 open `origin/build/*` branches would conflict with a 218-file rename. **That was checked and is wrong.** Measured on 2026-07-21:

- `git diff --name-status main origin/build/<b>` reports **zero** files present on any branch and absent from main
- Main is 53,000+ lines ahead of each branch tip
- Branch tips date from 2026-07-16 to 2026-07-18; main is 2026-07-20

They are stale leftovers from **squash-merged** PRs. Squashing creates a new commit and breaks ancestry, so `git branch --merged` still lists them as unmerged even though their content shipped. Nothing will ever be rebased off them.

**Conclusion: the rename can proceed immediately.** It carries no cross-branch conflict cost.

Housekeeping, not part of this spec: those 22 branch pointers can be deleted once the user confirms. Verify emptiness per-branch before deleting any of them.

Still keep the rename to **one mechanical commit** — find-and-replace plus file moves — with the userData migration as a separate commit. Not for conflict reasons, but because a reviewer can diff a mechanical commit at a glance and cannot meaningfully review 218 files of mixed mechanical and behavioural change.

## Verification

Before claiming done:

- `grep -ri 'localflow\|lfguard' src guard openclaw docs tests .github` returns only intentional historical references (CHANGELOG entries predating the rename)
- Full unit suite passes (237 files)
- Playwright e2e passes, including `guard.spec.ts`, which exercises the renamed binary
- `npm run build:guard` produces `saiifeguard`
- A packaged build launches, and a seeded legacy userData dir migrates correctly on a clean machine
