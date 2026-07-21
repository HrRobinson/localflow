# localflow → saiife Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product from `localflow` to `saiife` across every identifier, string, binary, bundle ID, doc and CI job, while carrying every existing user's `userData` directory across the `productName` change that the rename forces.

**Architecture:** Two strictly separated concerns land as two kinds of commit. First, a small set of *behavioural* commits add a rebrand-survival layer: one exempt module (`src/main/legacy-names.ts`) that holds every string which must keep saying `localflow`, a recursive whole-directory `userData` migration that runs before any store read, an env-var compatibility shim that reads `SAIIFE_*` and falls back to `LOCALFLOW_*`, and an OpenClaw skill-block cleanup. Second, a single *mechanical* commit performs the find-and-replace plus the file and directory moves, gated by a completeness test that also asserts the exempt module survived untouched.

**Tech Stack:** Electron 43 + electron-vite + electron-builder, React 19 renderer, TypeScript 6, Vitest (unit), Playwright (e2e, Electron driver), Rust 2021 cargo workspace for the command-guard binary, GitHub Actions + release-please.

## Global Constraints

- `productName` stays **lowercase**: `saiife`, never `Saiife` or `SAIIFE` — it matches the existing style and the site's lowercase mono voice.
- The **mechanical rename is exactly one commit** (Task 10): find-and-replace plus file/directory moves and nothing else, so a reviewer can diff 220 files at a glance.
- The **userData migration copies, never moves**: the legacy directory is left byte-for-byte intact so a user can downgrade without data loss.
- The **userData migration copies the whole tree recursively — never an allowlist**: an allowlist would destroy `flows.json`, log paying customers out via `hosted-token.enc`, and rot on every new connector.
- **No functional change** beyond the rename and the migration. No refactors, no dependency bumps, no UI changes, no icon artwork redesign.
- **Migration ships before the rename that makes it necessary.** Tasks 1–9 are behavioural and land first; the migration is a deliberate no-op (`skipped: 'same-directory'`) until Task 10 moves `productName`, so shipping it early carries zero risk and guarantees the code exists on every install that will ever see the new name.
- **Never block startup.** Every migration failure path logs and continues with a fresh config; the app must never crash because a legacy directory was unreadable.
- **Renaming the GitHub repo is out of scope.** `https://github.com/HrRobinson/localflow` clone URLs, the `repository` field in `package.json`, `guard/Cargo.toml`'s `repository`, and the README's Releases links keep the `localflow` repo path. The mechanical rename must not touch them — see the URL-preservation step in Task 10.

**Prerequisites (run once before Task 1):**

```bash
cd /home/jonasrobinson/projects/saiife/localflow
npm ci                     # node_modules is absent in a fresh clone
cargo --version            # must print 1.9x or newer
git checkout -b feat/saiife-rebrand
```

---

## File Structure

**Created — rebrand-survival layer (exempt from the mechanical rename):**

- `src/main/legacy-names.ts` — the single module allowed to keep saying `localflow`: `LEGACY_PRODUCT_NAME`, `LEGACY_SKILL_KEY`, `MIGRATION_MARKER`, `userDataDirFor`, `legacyUserDataDir`, `RENAMED_ENV_VARS`, `readRenamedEnv`.
- `tests/unit/legacy-names.test.ts` — per-OS path resolution and env-fallback tests.
- `tests/unit/rebrand-completeness.test.ts` — the grep gate plus identifier assertions.

**Created — migration:**

- `src/main/userdata-migration.ts` — `migrateLegacyUserData`, `describeMigration`, `MigrationOutcome`.
- `tests/unit/userdata-migration.test.ts` — eleven cases covering the whole-tree copy, no-op paths and failure paths.
- `tests/e2e/migration.spec.ts` — post-rename end-to-end: seed a legacy dir under a fake `HOME`, launch, assert the tree arrived.

**Created — decisions and release copy:**

- `docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md` — the auto-update/distribution continuity decision.
- `docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md` — the macOS `safeStorage` finding and the release-note line it produces.

**Modified — main process:**

- `src/main/index.ts` — migration call before the first store read, console-bus emit after the bus exists, env reads routed through `readRenamedEnv`.
- `src/shared/console.ts` — `toMigrationEvent` mapper.
- `src/main/openclaw-config.ts` — strip the stale legacy skill-env block on write and on revoke.
- `src/main/integrations/credential-store.ts` — no code change; its decrypt-failure path is asserted by a new test.

**Modified — mechanically renamed (Task 10, one commit):** every file listed by `grep -rIl 'localflow\|lfguard\|LOCALFLOW\|Localflow'` except the exempt set — 220 files matching `localflow`, 83 matching `lfguard`, 39 matching `LOCALFLOW`, 32 matching `Localflow`, spanning `src/` (main, preload, renderer, shared), `guard/`, `openclaw/`, `docs/superpowers/` (72 tracked files), `tests/` (234 unit + 6 e2e + 5 fixtures), `.github/workflows/` (`e2e.yml`, `release.yml`), `assets/logo.svg`, `README.md`, `CONTRIBUTING.md`, `package.json`, `package-lock.json`, `electron-builder.yml`, `guard/Cargo.toml`, `guard/Cargo.lock`.

**Moved (Task 10):**

- `guard/crates/lfguard/` → `guard/crates/saiifeguard/`
- `openclaw/skills/localflow/` → `openclaw/skills/saiife/`
- `openclaw/skills/saiife/bin/localflow-control.mjs` → `.../saiife-control.mjs`
- `openclaw/skills/saiife/bin/localflow-control.d.mts` → `.../saiife-control.d.mts`
- `tests/unit/localflow-cli.test.ts` → `tests/unit/saiife-cli.test.ts`

**Deliberately NOT moved — the nine historical doc filenames carrying an old token:** `docs/superpowers/plans/2026-07-06-localflow.md`, `docs/superpowers/plans/2026-07-14-lfguard-g1.md`, `docs/superpowers/plans/2026-07-15-lfguard-g2.md`, `docs/superpowers/specs/2026-07-06-localflow-design.md`, `docs/superpowers/specs/2026-07-06-localflow-v2-roadmap.md`, `docs/superpowers/specs/2026-07-14-lfguard-design.md`, `docs/superpowers/specs/2026-07-15-lfguard-g2-design.md`, `docs/superpowers/specs/2026-07-16-lfguard-wrapper-hardening-design.md`, `docs/superpowers/specs/2026-07-21-localflow-to-saiife-rebrand-design.md`. They are dated records; their *content* is rewritten (except the rebrand spec) but their names are stable cross-reference anchors, and filenames never appear in the verification grep, which matches on content only.

**Never modified:** `CHANGELOG.md` (release-please owns it; its entries are intentional historical references), `docs/superpowers/specs/2026-07-21-localflow-to-saiife-rebrand-design.md`, `docs/superpowers/plans/2026-07-21-localflow-to-saiife-rebrand.md` (this file), binary assets in `assets/` and `build/`.

---

### Task 1: Legacy-name module and per-OS userData path resolution

**Files:**

- Create: `src/main/legacy-names.ts`
- Test: `tests/unit/legacy-names.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `LEGACY_PRODUCT_NAME: 'localflow'`, `LEGACY_SKILL_KEY: 'localflow'`, `MIGRATION_MARKER: '.migrated-from-localflow.json'`, `interface UserDataPathInput { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string }`, `userDataDirFor(productName: string, input: UserDataPathInput): string`, `legacyUserDataDir(input: UserDataPathInput): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/legacy-names.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  LEGACY_PRODUCT_NAME,
  LEGACY_SKILL_KEY,
  MIGRATION_MARKER,
  legacyUserDataDir,
  userDataDirFor
} from '../../src/main/legacy-names'

describe('legacy name constants', () => {
  it('still spells the pre-rebrand product name', () => {
    expect(LEGACY_PRODUCT_NAME).toBe('localflow')
  })

  it('still spells the pre-rebrand OpenClaw skill key', () => {
    expect(LEGACY_SKILL_KEY).toBe('localflow')
  })

  it('names the migration marker after the directory it came from', () => {
    expect(MIGRATION_MARKER).toBe('.migrated-from-localflow.json')
  })
})

describe('userDataDirFor', () => {
  const home = '/Users/ada'

  it('darwin: Application Support under the home dir', () => {
    expect(userDataDirFor('saiife', { platform: 'darwin', env: {}, home })).toBe(
      join(home, 'Library', 'Application Support', 'saiife')
    )
  })

  it('win32: APPDATA when set', () => {
    expect(
      userDataDirFor('saiife', { platform: 'win32', env: { APPDATA: 'C:/Users/ada/AppData/Roaming' }, home })
    ).toBe(join('C:/Users/ada/AppData/Roaming', 'saiife'))
  })

  it('win32: falls back to AppData/Roaming when APPDATA is unset', () => {
    expect(userDataDirFor('saiife', { platform: 'win32', env: {}, home })).toBe(
      join(home, 'AppData', 'Roaming', 'saiife')
    )
  })

  it('win32: treats an empty APPDATA as unset', () => {
    expect(userDataDirFor('saiife', { platform: 'win32', env: { APPDATA: '' }, home })).toBe(
      join(home, 'AppData', 'Roaming', 'saiife')
    )
  })

  it('linux: XDG_CONFIG_HOME when set', () => {
    expect(
      userDataDirFor('saiife', { platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home })
    ).toBe(join('/xdg', 'saiife'))
  })

  it('linux: falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    expect(userDataDirFor('saiife', { platform: 'linux', env: {}, home })).toBe(
      join(home, '.config', 'saiife')
    )
  })

  it('freebsd and other unixes follow the linux rule', () => {
    expect(userDataDirFor('saiife', { platform: 'freebsd', env: {}, home })).toBe(
      join(home, '.config', 'saiife')
    )
  })
})

describe('legacyUserDataDir', () => {
  const home = '/Users/ada'

  it('resolves the pre-rebrand directory, not a sibling of the new one', () => {
    expect(legacyUserDataDir({ platform: 'darwin', env: {}, home })).toBe(
      join(home, 'Library', 'Application Support', 'localflow')
    )
    expect(legacyUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home })).toBe(
      join('/xdg', 'localflow')
    )
    expect(legacyUserDataDir({ platform: 'win32', env: { APPDATA: 'C:/roaming' }, home })).toBe(
      join('C:/roaming', 'localflow')
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/legacy-names.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/main/legacy-names" from "tests/unit/legacy-names.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/legacy-names.ts`:

```ts
import { join } from 'node:path'

/**
 * THE ONE MODULE THAT MUST KEEP SAYING THE OLD PRODUCT NAME.
 *
 * The product rename is executed as a repo-wide find-and-replace. That script
 * SKIPS this file (and its test) by name, because everything here exists
 * precisely to describe the world before the rename: where the previous release
 * put its userData, what its OpenClaw skill block was called, and which
 * environment variables it read. `tests/unit/rebrand-completeness.test.ts`
 * asserts these values still spell the old name after the rename runs, so a
 * careless sed can never silently break the migration.
 *
 * Nothing here is a general utility. Do not add new-world names to this file.
 */

/** The `productName` every release up to and including v1.11.0 shipped under. */
export const LEGACY_PRODUCT_NAME = 'localflow'

/** The `skills.entries.<key>` block the previous release wrote into openclaw.json. */
export const LEGACY_SKILL_KEY = 'localflow'

/** Written into the new userData dir once the one-off copy has completed. */
export const MIGRATION_MARKER = '.migrated-from-localflow.json'

/** Everything needed to resolve a userData path without touching Electron. */
export interface UserDataPathInput {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}

/**
 * Electron's `app.getPath('userData')` rule, reimplemented as a pure function.
 * The legacy directory MUST be computed this way rather than assumed to be a
 * sibling of the new one: the parent differs per OS (Application Support on
 * darwin, %APPDATA% on win32, $XDG_CONFIG_HOME on everything else) and on
 * win32/linux is overridable by an environment variable.
 */
export function userDataDirFor(productName: string, input: UserDataPathInput): string {
  const { platform, env, home } = input
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', productName)
  }
  if (platform === 'win32') {
    const appData = env['APPDATA']
    const root = appData !== undefined && appData !== '' ? appData : join(home, 'AppData', 'Roaming')
    return join(root, productName)
  }
  const xdg = env['XDG_CONFIG_HOME']
  const root = xdg !== undefined && xdg !== '' ? xdg : join(home, '.config')
  return join(root, productName)
}

/** Where the previous release kept config.json, flows.json, themes/ and the rest. */
export function legacyUserDataDir(input: UserDataPathInput): string {
  return userDataDirFor(LEGACY_PRODUCT_NAME, input)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/legacy-names.test.ts`
Expected: PASS — 11 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/legacy-names.ts tests/unit/legacy-names.test.ts
git commit -m "feat(migration): resolve the pre-rebrand userData dir per platform

Pure, Electron-free reimplementation of app.getPath('userData') so the
previous release's directory can be located from the new build. Lives in
the one module the rename script skips, so the old spelling survives."
```

---

### Task 2: Recursive whole-directory userData migration

**Files:**

- Create: `src/main/userdata-migration.ts`
- Test: `tests/unit/userdata-migration.test.ts`

**Interfaces:**

- Consumes: `legacyUserDataDir(input: UserDataPathInput): string`, `MIGRATION_MARKER: string` from `src/main/legacy-names.ts`.
- Produces: `type MigrationOutcome`, `interface MigrateInput { newDir: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; overridden: boolean }`, `migrateLegacyUserData(input: MigrateInput): MigrationOutcome`, `describeMigration(outcome: MigrationOutcome): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/userdata-migration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyUserDataDir, MIGRATION_MARKER } from '../../src/main/legacy-names'
import { describeMigration, migrateLegacyUserData } from '../../src/main/userdata-migration'

const PLATFORM: NodeJS.Platform = 'linux'
const ENV: NodeJS.ProcessEnv = {}

let root: string
let home: string
let newDir: string
let legacyDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'userdata-migration-'))
  home = join(root, 'home')
  newDir = join(root, 'new-userdata')
  mkdirSync(home, { recursive: true })
  legacyDir = legacyUserDataDir({ platform: PLATFORM, env: ENV, home })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const run = (): ReturnType<typeof migrateLegacyUserData> =>
  migrateLegacyUserData({ newDir, platform: PLATFORM, env: ENV, home, overridden: false })

const ENC_BYTES = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x0a])

function seedLegacy(): void {
  mkdirSync(join(legacyDir, 'themes'), { recursive: true })
  mkdirSync(join(legacyDir, 'captures', 'wp1'), { recursive: true })
  mkdirSync(join(legacyDir, 'guard-seen'), { recursive: true })
  writeFileSync(join(legacyDir, 'config.json'), '{"theme":"nord"}')
  writeFileSync(join(legacyDir, 'sessions.json'), '{"sessions":[],"groups":[]}')
  writeFileSync(join(legacyDir, 'keybindings.json'), '{"close-pane":"cmd+w"}')
  writeFileSync(join(legacyDir, 'flows.json'), '[{"id":"f1","name":"nightly"}]')
  writeFileSync(join(legacyDir, 'integration-secrets.enc'), ENC_BYTES)
  writeFileSync(join(legacyDir, 'hosted-token.enc'), ENC_BYTES)
  writeFileSync(join(legacyDir, 'guard-audit.jsonl'), '{"ts":1}\n{"ts":2}\n')
  writeFileSync(join(legacyDir, 'airtable-cursors.json'), '{"tbl1":"rec9"}')
  writeFileSync(join(legacyDir, 'operator-grant-3.json'), '{"token":"t"}')
  writeFileSync(join(legacyDir, 'openclaw.json'), '{}')
  writeFileSync(join(legacyDir, 'themes', 'nord.json'), '{"name":"nord"}')
  writeFileSync(join(legacyDir, 'captures', 'wp1', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e]))
  writeFileSync(join(legacyDir, 'guard-seen', 'pane-1'), 'seen')
}

describe('migrateLegacyUserData', () => {
  it('copies the whole legacy tree when the new dir is empty', () => {
    seedLegacy()
    const outcome = run()
    expect(outcome.status).toBe('copied')
    expect(existsSync(join(newDir, 'config.json'))).toBe(true)
    expect(existsSync(join(newDir, 'flows.json'))).toBe(true)
    expect(existsSync(join(newDir, 'hosted-token.enc'))).toBe(true)
    expect(existsSync(join(newDir, 'airtable-cursors.json'))).toBe(true)
    expect(existsSync(join(newDir, 'operator-grant-3.json'))).toBe(true)
    expect(existsSync(join(newDir, 'openclaw.json'))).toBe(true)
  })

  it('leaves the legacy dir completely intact — copy, never move', () => {
    seedLegacy()
    run()
    expect(existsSync(join(legacyDir, 'config.json'))).toBe(true)
    expect(existsSync(join(legacyDir, 'flows.json'))).toBe(true)
    expect(readFileSync(join(legacyDir, 'integration-secrets.enc'))).toEqual(ENC_BYTES)
    expect(existsSync(join(legacyDir, 'themes', 'nord.json'))).toBe(true)
  })

  it('copies nested directories intact, not flattened', () => {
    seedLegacy()
    run()
    expect(existsSync(join(newDir, 'themes', 'nord.json'))).toBe(true)
    expect(existsSync(join(newDir, 'captures', 'wp1', 'shot.png'))).toBe(true)
    expect(existsSync(join(newDir, 'guard-seen', 'pane-1'))).toBe(true)
    expect(existsSync(join(newDir, 'nord.json'))).toBe(false)
    expect(existsSync(join(newDir, 'shot.png'))).toBe(false)
  })

  it('copies .enc and .jsonl payloads byte-for-byte', () => {
    seedLegacy()
    run()
    expect(readFileSync(join(newDir, 'integration-secrets.enc'))).toEqual(ENC_BYTES)
    expect(readFileSync(join(newDir, 'hosted-token.enc'))).toEqual(ENC_BYTES)
    expect(readFileSync(join(newDir, 'guard-audit.jsonl'), 'utf8')).toBe('{"ts":1}\n{"ts":2}\n')
  })

  it('writes a marker so the next launch is cheap', () => {
    seedLegacy()
    run()
    const marker = JSON.parse(readFileSync(join(newDir, MIGRATION_MARKER), 'utf8')) as {
      from: string
      copied: number
    }
    expect(marker.from).toBe(legacyDir)
    expect(marker.copied).toBeGreaterThan(0)
  })

  it('is a no-op when the new dir already has config.json — new config wins', () => {
    seedLegacy()
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'config.json'), '{"theme":"gruvbox"}')
    const outcome = run()
    expect(outcome).toEqual({ status: 'skipped', reason: 'new-data-present' })
    expect(readFileSync(join(newDir, 'config.json'), 'utf8')).toBe('{"theme":"gruvbox"}')
    expect(existsSync(join(newDir, 'flows.json'))).toBe(false)
  })

  it('is a no-op when the marker is already present', () => {
    seedLegacy()
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, MIGRATION_MARKER), '{}')
    expect(run()).toEqual({ status: 'skipped', reason: 'already-migrated' })
    expect(existsSync(join(newDir, 'flows.json'))).toBe(false)
  })

  it('is a clean no-op when neither dir exists', () => {
    expect(run()).toEqual({ status: 'skipped', reason: 'no-legacy-dir' })
    expect(existsSync(newDir)).toBe(false)
  })

  it('is a no-op when the new dir IS the legacy dir (pre-rename builds)', () => {
    seedLegacy()
    const outcome = migrateLegacyUserData({
      newDir: legacyDir,
      platform: PLATFORM,
      env: ENV,
      home,
      overridden: false
    })
    expect(outcome).toEqual({ status: 'skipped', reason: 'same-directory' })
  })

  it('is a no-op when userData was overridden (e2e runs must not touch a real home)', () => {
    seedLegacy()
    const outcome = migrateLegacyUserData({
      newDir,
      platform: PLATFORM,
      env: ENV,
      home,
      overridden: true
    })
    expect(outcome).toEqual({ status: 'skipped', reason: 'user-data-overridden' })
    expect(existsSync(newDir)).toBe(false)
  })

  it('records non-regular entries as failures and still copies the rest', () => {
    seedLegacy()
    symlinkSync(join(root, 'nowhere'), join(legacyDir, 'dangling'))
    const outcome = run()
    expect(outcome.status).toBe('copied')
    if (outcome.status !== 'copied') throw new Error('unreachable')
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]).toContain('dangling')
    expect(existsSync(join(newDir, 'config.json'))).toBe(true)
    expect(existsSync(join(newDir, 'themes', 'nord.json'))).toBe(true)
  })

  it('never overwrites a file that already exists in the new dir', () => {
    seedLegacy()
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'flows.json'), '[{"id":"newer"}]')
    run()
    expect(readFileSync(join(newDir, 'flows.json'), 'utf8')).toBe('[{"id":"newer"}]')
    expect(existsSync(join(newDir, 'config.json'))).toBe(true)
  })

  it('reports failure and never throws when the legacy path is unreadable', () => {
    mkdirSync(join(root, 'home', '.config'), { recursive: true })
    writeFileSync(legacyDir, 'this is a file, not a directory')
    const outcome = run()
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('unreachable')
    expect(outcome.legacyDir).toBe(legacyDir)
    expect(outcome.error.length).toBeGreaterThan(0)
    expect(existsSync(join(newDir, MIGRATION_MARKER))).toBe(false)
  })
})

describe('describeMigration', () => {
  it('names the reason for a skip', () => {
    expect(describeMigration({ status: 'skipped', reason: 'no-legacy-dir' })).toBe(
      'no migration needed (no-legacy-dir)'
    )
  })

  it('reports a clean copy with a count', () => {
    expect(
      describeMigration({ status: 'copied', legacyDir: '/old', copied: 12, failures: [] })
    ).toBe('copied 12 file(s) from /old')
  })

  it('reports skipped entries alongside a partial copy', () => {
    expect(
      describeMigration({
        status: 'copied',
        legacyDir: '/old',
        copied: 12,
        failures: ['/old/x: EACCES']
      })
    ).toBe('copied 12 file(s) from /old; 1 entry skipped: /old/x: EACCES')
  })

  it('reports a failure as a fresh start, not a crash', () => {
    expect(describeMigration({ status: 'failed', legacyDir: '/old', error: 'ENOTDIR' })).toBe(
      'could not read /old — starting with a fresh config (ENOTDIR)'
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/userdata-migration.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/main/userdata-migration" from "tests/unit/userdata-migration.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

Create `src/main/userdata-migration.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { legacyUserDataDir, MIGRATION_MARKER } from './legacy-names'

/**
 * One-off carry-over of the previous release's userData directory.
 *
 * Electron derives userData from `productName`, so changing it silently
 * relocates the directory and every existing install would look factory-reset.
 * This runs once, before any store reads the new directory.
 *
 * Four rules, all load-bearing:
 *   1. Copy the WHOLE tree recursively. Never an allowlist — the app writes at
 *      least sixteen distinct things here (config.json, sessions.json,
 *      keybindings.json, flows.json, endpoint.json, integration-secrets.enc,
 *      hosted-token.enc, guard-audit.jsonl, guard-seen/, *-cursors.json,
 *      operator-grant-<env>.json, themes/, captures/, openclaw.json) and each
 *      new connector adds more. An allowlist would destroy hand-built flows and
 *      log paying customers out.
 *   2. Copy, never move. The original stays intact so a downgrade loses nothing.
 *   3. Never overwrite. A file already present in the new directory wins.
 *   4. Never throw. Every failure is captured in the outcome; startup continues
 *      with a fresh config rather than crashing.
 */

/** Written after a completed copy (successful or partial) so reruns are cheap. */
const SENTINEL_FILE = 'config.json'

export type MigrationOutcome =
  | {
      status: 'skipped'
      reason: 'user-data-overridden' | 'same-directory' | 'already-migrated' | 'new-data-present' | 'no-legacy-dir'
    }
  | { status: 'copied'; legacyDir: string; copied: number; failures: string[] }
  | { status: 'failed'; legacyDir: string; error: string }

export interface MigrateInput {
  /** `app.getPath('userData')` for the current build. */
  newDir: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  /** True when the userData path came from the test/e2e override env var. */
  overridden: boolean
}

interface CopyTally {
  copied: number
  failures: string[]
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Depth-first copy. Per-entry try/catch so one unreadable file or one exotic
 * entry (symlink, socket, fifo) is recorded and skipped rather than aborting
 * the whole migration halfway through.
 */
function copyTree(from: string, to: string, tally: CopyTally): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(from, { withFileTypes: true })
  } catch (err) {
    tally.failures.push(`${from}: ${messageOf(err)}`)
    return
  }
  for (const entry of entries) {
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    try {
      if (entry.isDirectory()) {
        mkdirSync(dest, { recursive: true })
        copyTree(src, dest, tally)
      } else if (entry.isFile()) {
        if (existsSync(dest)) continue
        copyFileSync(src, dest)
        tally.copied += 1
      } else {
        tally.failures.push(`${src}: skipped (not a regular file or directory)`)
      }
    } catch (err) {
      tally.failures.push(`${src}: ${messageOf(err)}`)
    }
  }
}

export function migrateLegacyUserData(input: MigrateInput): MigrationOutcome {
  // The override is how the e2e suite points the app at a scratch directory.
  // Migrating there would copy the developer's REAL data into a test fixture.
  if (input.overridden) return { status: 'skipped', reason: 'user-data-overridden' }

  const legacyDir = legacyUserDataDir({
    platform: input.platform,
    env: input.env,
    home: input.home
  })
  // True on every build shipped before the rename: nothing to carry over.
  if (legacyDir === input.newDir) return { status: 'skipped', reason: 'same-directory' }

  try {
    if (existsSync(join(input.newDir, MIGRATION_MARKER))) {
      return { status: 'skipped', reason: 'already-migrated' }
    }
    if (existsSync(join(input.newDir, SENTINEL_FILE))) {
      return { status: 'skipped', reason: 'new-data-present' }
    }
    if (!existsSync(legacyDir)) return { status: 'skipped', reason: 'no-legacy-dir' }

    // Probe the top level first: if the legacy path is unreadable (or is not a
    // directory at all) there is nothing to copy and no marker should be
    // written, so a transient permission problem retries on the next launch.
    try {
      readdirSync(legacyDir)
    } catch (err) {
      return { status: 'failed', legacyDir, error: messageOf(err) }
    }

    const tally: CopyTally = { copied: 0, failures: [] }
    mkdirSync(input.newDir, { recursive: true })
    copyTree(legacyDir, input.newDir, tally)

    try {
      writeFileSync(
        join(input.newDir, MIGRATION_MARKER),
        JSON.stringify(
          {
            from: legacyDir,
            at: new Date().toISOString(),
            copied: tally.copied,
            failures: tally.failures
          },
          null,
          2
        ) + '\n'
      )
    } catch (err) {
      tally.failures.push(`${MIGRATION_MARKER}: ${messageOf(err)}`)
    }

    return { status: 'copied', legacyDir, copied: tally.copied, failures: tally.failures }
  } catch (err) {
    return { status: 'failed', legacyDir, error: messageOf(err) }
  }
}

/** One human line for the console bus and the main-process log. */
export function describeMigration(outcome: MigrationOutcome): string {
  switch (outcome.status) {
    case 'skipped':
      return `no migration needed (${outcome.reason})`
    case 'copied': {
      const head = `copied ${outcome.copied} file(s) from ${outcome.legacyDir}`
      if (outcome.failures.length === 0) return head
      const noun = outcome.failures.length === 1 ? 'entry' : 'entries'
      return `${head}; ${outcome.failures.length} ${noun} skipped: ${outcome.failures.join('; ')}`
    }
    case 'failed':
      return `could not read ${outcome.legacyDir} — starting with a fresh config (${outcome.error})`
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/userdata-migration.test.ts`
Expected: PASS — 17 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/userdata-migration.ts tests/unit/userdata-migration.test.ts
git commit -m "feat(migration): recursively carry the legacy userData dir across

Copies the whole previous-release userData tree into the new one on first
launch. Whole-tree, never an allowlist: flows.json, hosted-token.enc,
integration-secrets.enc and the connector cursor files would all be lost
otherwise. Copies rather than moves, never overwrites, never throws."
```

---

### Task 3: Console-bus mapper for the migration outcome

**Files:**

- Modify: `src/shared/console.ts:141` (append after `toGuardEvent`)
- Test: `tests/unit/console-migration-event.test.ts`

**Interfaces:**

- Consumes: `ConsoleEventInput` from `src/shared/console.ts`.
- Produces: `toMigrationEvent(summary: string, environment?: number): ConsoleEventInput`.

*Design note:* the mapper emits on the existing `operator` source rather than adding a sixth `ConsoleSource`. A new source would require changes to `CONSOLE_SOURCE_CAPS`, the renderer filter chips, and the persisted `ConsolePrefs` shape — a functional change this rename is not allowed to make.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/console-migration-event.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CONSOLE_SOURCE_CAPS, toMigrationEvent } from '../../src/shared/console'

describe('toMigrationEvent', () => {
  it('maps a summary onto the operator source with a legible label', () => {
    const event = toMigrationEvent('copied 12 file(s) from /old')
    expect(event).toEqual({
      source: 'operator',
      environment: 1,
      label: 'userData migration · copied 12 file(s) from /old',
      detail: {
        source: 'operator',
        action: 'userdata-migration',
        args: 'copied 12 file(s) from /old'
      }
    })
  })

  it('accepts an explicit environment', () => {
    expect(toMigrationEvent('no migration needed (no-legacy-dir)', 4).environment).toBe(4)
  })

  it('does not introduce a new console source', () => {
    expect(Object.keys(CONSOLE_SOURCE_CAPS).sort()).toEqual([
      'capture',
      'guard',
      'network',
      'operator',
      'status'
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/console-migration-event.test.ts`
Expected: FAIL with `TypeError: toMigrationEvent is not a function` (the named export does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Append to the end of `src/shared/console.ts` (after `toCaptureEvent`, currently ending at line 159):

```ts
/**
 * The one-off userData carry-over that follows the product rename. It runs
 * before the bus exists, so main buffers the summary string and replays it
 * here once the bus is constructed. Emitted on `operator` deliberately: adding
 * a sixth ConsoleSource would change CONSOLE_SOURCE_CAPS, the renderer filter
 * chips and the persisted ConsolePrefs shape, which is out of scope.
 */
export function toMigrationEvent(summary: string, environment = 1): ConsoleEventInput {
  return {
    source: 'operator',
    environment,
    label: `userData migration · ${summary}`,
    detail: { source: 'operator', action: 'userdata-migration', args: summary }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/console-migration-event.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/shared/console.ts tests/unit/console-migration-event.test.ts
git commit -m "feat(console): map the userData migration outcome onto the bus

Reuses the operator source so no ConsoleSource, cap or renderer filter
changes — the rename must not carry a functional change with it."
```

---

### Task 4: Run the migration at startup, before any store read

**Files:**

- Modify: `src/main/index.ts:62` (import `toMigrationEvent`), `src/main/index.ts:164-166` (capture the override flag), `src/main/index.ts:303-305` (run the migration), `src/main/index.ts:874` (emit to the bus)
- Test: `npx vitest run` + `npm run typecheck` + `npx playwright test tests/e2e/smoke.spec.ts`

**Interfaces:**

- Consumes: `migrateLegacyUserData(input: MigrateInput): MigrationOutcome`, `describeMigration(outcome: MigrationOutcome): string`, `toMigrationEvent(summary: string, environment?: number): ConsoleEventInput`.
- Produces: `const userDataOverridden: boolean` (module scope), `const migrationSummary: string` (inside the `whenReady` closure).

- [ ] **Step 1: Write the failing check**

There is no unit seam for `index.ts` (it imports `electron` at module load). The gate for this task is the type checker plus the existing e2e smoke spec. Establish the RED state by adding the call *before* the import, so `typecheck` fails on an unresolved name.

Edit `src/main/index.ts` lines 164-166, replacing:

```ts
if (process.env['LOCALFLOW_USER_DATA']) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'])
}
```

with:

```ts
/**
 * True when the userData path was pointed somewhere else by the test/e2e
 * override. The one-off legacy carry-over MUST NOT run in that case: it would
 * copy a real installation's data into a scratch fixture directory.
 */
const userDataOverridden = Boolean(process.env['LOCALFLOW_USER_DATA'])
if (userDataOverridden) {
  app.setPath('userData', process.env['LOCALFLOW_USER_DATA'] as string)
}
```

Then edit `src/main/index.ts` lines 303-305, replacing:

```ts
  const userData = app.getPath('userData')
  const sessionsFile = join(userData, 'sessions.json')
  let keybindings = loadOrCreateKeybindings(join(userData, 'keybindings.json'))
```

with:

```ts
  const userData = app.getPath('userData')

  // The product rename moves Electron's userData directory (it is derived from
  // productName), so carry the previous release's whole tree across BEFORE any
  // store below reads or creates a file in the new one. Never throws; a failure
  // logs and startup continues with a fresh config.
  const migrationSummary = describeMigration(
    migrateLegacyUserData({
      newDir: userData,
      platform: process.platform,
      env: process.env,
      home: homedir(),
      overridden: userDataOverridden
    })
  )
  console.log(`userData: ${migrationSummary}`)

  const sessionsFile = join(userData, 'sessions.json')
  let keybindings = loadOrCreateKeybindings(join(userData, 'keybindings.json'))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run typecheck`
Expected: FAIL with `src/main/index.ts(310,5): error TS2304: Cannot find name 'describeMigration'.` and `error TS2304: Cannot find name 'migrateLegacyUserData'.`

- [ ] **Step 3: Write minimal implementation**

Add the imports. Edit `src/main/index.ts` line 62, replacing:

```ts
import { toStatusEvent, toOperatorEvent, toCaptureEvent, toGuardEvent } from '../shared/console'
```

with:

```ts
import {
  toStatusEvent,
  toOperatorEvent,
  toCaptureEvent,
  toGuardEvent,
  toMigrationEvent
} from '../shared/console'
import { describeMigration, migrateLegacyUserData } from './userdata-migration'
```

Then edit `src/main/index.ts` line 874, replacing:

```ts
  const consoleBus = new ConsoleEventBus()
```

with:

```ts
  const consoleBus = new ConsoleEventBus()
  // The carry-over ran long before the bus existed (it must precede every store
  // read); replay its one-line outcome now so it is visible in the drawer.
  consoleBus.emit(toMigrationEvent(migrationSummary))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npm test && npm run build && npx playwright test tests/e2e/smoke.spec.ts`
Expected: PASS — typecheck silent, Vitest reports all unit files passing, Playwright reports the smoke spec passing (the app boots with the migration in the startup path and the e2e override makes it a `user-data-overridden` no-op).

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(migration): run the legacy userData carry-over at startup

Runs immediately after app.getPath('userData') and before the first store
read, and is a hard no-op whenever the userData override env var is set so
e2e runs can never touch a real installation. The outcome is replayed onto
the console bus once the bus is constructed."
```

---

### Task 5: Renamed-environment-variable fallback

**Files:**

- Modify: `src/main/legacy-names.ts` (append)
- Test: `tests/unit/legacy-names.test.ts` (append)

**Interfaces:**

- Consumes: nothing.
- Produces: `interface RenamedEnvVar { current: string; legacy: string }`, `RENAMED_ENV_VARS: readonly RenamedEnvVar[]`, `readRenamedEnv(env: NodeJS.ProcessEnv, current: string, onDeprecated?: (message: string) => void): string | undefined`.

*Scope note:* the spec names `LOCALFLOW_CLAUDE_BIN` and `LOCALFLOW_OPENCLAW_BIN`. `LOCALFLOW_LAZYGIT_BIN` and `LOCALFLOW_EDITOR_BIN` are the same class of user-settable tool-path override read in the same file, so the same table covers all four at zero extra cost. The remaining `LOCALFLOW_*` variables (`_USER_DATA`, `_E2E*`, `_OPENCLAW_CONFIG`, `_PATH_START__`/`_PATH_END__`, `_ENDPOINT`, `_TOKEN`) are internal or test-only, are set by code that renames in the same commit, and get no fallback.

- [ ] **Step 1: Write the failing test**

In `tests/unit/legacy-names.test.ts`, extend the existing import to add the two new names:

```ts
import {
  LEGACY_PRODUCT_NAME,
  LEGACY_SKILL_KEY,
  MIGRATION_MARKER,
  legacyUserDataDir,
  userDataDirFor,
  RENAMED_ENV_VARS,
  readRenamedEnv
} from '../../src/main/legacy-names'
```

Then append these two describe blocks to the end of the same file:

```ts
describe('RENAMED_ENV_VARS', () => {
  it('pairs every renamed variable with its pre-rebrand spelling', () => {
    expect(RENAMED_ENV_VARS.map((v) => [v.current, v.legacy])).toEqual([
      ['SAIIFE_CLAUDE_BIN', 'LOCALFLOW_CLAUDE_BIN'],
      ['SAIIFE_OPENCLAW_BIN', 'LOCALFLOW_OPENCLAW_BIN'],
      ['SAIIFE_LAZYGIT_BIN', 'LOCALFLOW_LAZYGIT_BIN'],
      ['SAIIFE_EDITOR_BIN', 'LOCALFLOW_EDITOR_BIN']
    ])
  })
})

describe('readRenamedEnv', () => {
  it('returns the current variable when it is set', () => {
    const seen: string[] = []
    const value = readRenamedEnv({ SAIIFE_CLAUDE_BIN: '/new/claude' }, 'SAIIFE_CLAUDE_BIN', (m) =>
      seen.push(m)
    )
    expect(value).toBe('/new/claude')
    expect(seen).toEqual([])
  })

  it('falls back to the legacy variable and logs a deprecation notice', () => {
    const seen: string[] = []
    const value = readRenamedEnv(
      { LOCALFLOW_CLAUDE_BIN: '/old/claude' },
      'SAIIFE_CLAUDE_BIN',
      (m) => seen.push(m)
    )
    expect(value).toBe('/old/claude')
    expect(seen).toEqual([
      'LOCALFLOW_CLAUDE_BIN is deprecated and will be removed in a future release — rename it to SAIIFE_CLAUDE_BIN.'
    ])
  })

  it('prefers the current variable and stays silent when both are set', () => {
    const seen: string[] = []
    const value = readRenamedEnv(
      { SAIIFE_OPENCLAW_BIN: '/new/oc', LOCALFLOW_OPENCLAW_BIN: '/old/oc' },
      'SAIIFE_OPENCLAW_BIN',
      (m) => seen.push(m)
    )
    expect(value).toBe('/new/oc')
    expect(seen).toEqual([])
  })

  it('returns undefined and stays silent when neither is set', () => {
    const seen: string[] = []
    expect(readRenamedEnv({}, 'SAIIFE_EDITOR_BIN', (m) => seen.push(m))).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('treats an empty string as unset on both names', () => {
    const seen: string[] = []
    expect(
      readRenamedEnv(
        { SAIIFE_LAZYGIT_BIN: '', LOCALFLOW_LAZYGIT_BIN: '/old/lazygit' },
        'SAIIFE_LAZYGIT_BIN',
        (m) => seen.push(m)
      )
    ).toBe('/old/lazygit')
    expect(
      readRenamedEnv({ SAIIFE_LAZYGIT_BIN: '', LOCALFLOW_LAZYGIT_BIN: '' }, 'SAIIFE_LAZYGIT_BIN', (m) =>
        seen.push(m)
      )
    ).toBeUndefined()
    expect(seen).toHaveLength(1)
  })

  it('returns undefined for a name that has no legacy pairing', () => {
    const seen: string[] = []
    expect(readRenamedEnv({}, 'SAIIFE_NOT_A_REAL_VAR', (m) => seen.push(m))).toBeUndefined()
    expect(seen).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/legacy-names.test.ts`
Expected: FAIL with `TypeError: readRenamedEnv is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/main/legacy-names.ts`:

```ts
/** A user-settable variable whose name changed with the product rename. */
export interface RenamedEnvVar {
  current: string
  legacy: string
}

/**
 * Renaming these outright would break anyone who has set them, so the current
 * name is read first and the pre-rebrand name is honoured as a fallback for a
 * release or two, with a deprecation notice.
 *
 * Only user-settable tool-path overrides are listed. The remaining LOCALFLOW_*
 * variables are internal or test-only (userData override, e2e handshakes, the
 * login-shell PATH sentinels, and the operator grant endpoint/token, which the
 * app writes and reads on both sides of the same build) and get no fallback.
 */
export const RENAMED_ENV_VARS: readonly RenamedEnvVar[] = [
  { current: 'SAIIFE_CLAUDE_BIN', legacy: 'LOCALFLOW_CLAUDE_BIN' },
  { current: 'SAIIFE_OPENCLAW_BIN', legacy: 'LOCALFLOW_OPENCLAW_BIN' },
  { current: 'SAIIFE_LAZYGIT_BIN', legacy: 'LOCALFLOW_LAZYGIT_BIN' },
  { current: 'SAIIFE_EDITOR_BIN', legacy: 'LOCALFLOW_EDITOR_BIN' }
]

/**
 * Reads `current`, falling back to its pre-rebrand spelling. An empty string is
 * treated as unset on both names. The deprecation notice fires only when the
 * fallback actually supplied the value.
 */
export function readRenamedEnv(
  env: NodeJS.ProcessEnv,
  current: string,
  onDeprecated: (message: string) => void = (message) => console.warn(message)
): string | undefined {
  const direct = env[current]
  if (direct !== undefined && direct !== '') return direct

  const spec = RENAMED_ENV_VARS.find((v) => v.current === current)
  if (spec === undefined) return undefined

  const legacy = env[spec.legacy]
  if (legacy === undefined || legacy === '') return undefined

  onDeprecated(
    `${spec.legacy} is deprecated and will be removed in a future release — rename it to ${spec.current}.`
  )
  return legacy
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/legacy-names.test.ts`
Expected: PASS — 18 tests passed (the 11 from Task 1 plus 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/legacy-names.ts tests/unit/legacy-names.test.ts
git commit -m "feat(env): read SAIIFE_* names with a LOCALFLOW_* fallback

Covers the four user-settable tool-path overrides. The current name wins;
the pre-rebrand name still works for a release or two and logs a
deprecation notice when it is what supplied the value."
```

---

### Task 6: Route the main process's env reads through the fallback

**Files:**

- Modify: `src/main/index.ts:307-312`, `src/main/index.ts:1425`, `src/main/index.ts:1427`, `src/main/index.ts:1440`, `src/main/index.ts:1453`
- Test: `npm run typecheck` + `npx vitest run` + `npx playwright test tests/e2e/operator-launch.spec.ts`

**Interfaces:**

- Consumes: `readRenamedEnv(env: NodeJS.ProcessEnv, current: string, onDeprecated?: (message: string) => void): string | undefined`.
- Produces: no new exports. After this task no `process.env['LOCALFLOW_*_BIN']` literal remains in `src/main/index.ts`, so the mechanical rename cannot break the fallback pairing.

- [ ] **Step 1: Write the failing check**

Edit `src/main/index.ts` lines 307-312, replacing:

```ts
  const registry = new AgentRegistry(
    join(userData, 'config.json'),
    undefined,
    process.env['LOCALFLOW_CLAUDE_BIN'],
    process.env['LOCALFLOW_OPENCLAW_BIN']
  )
```

with:

```ts
  const registry = new AgentRegistry(
    join(userData, 'config.json'),
    undefined,
    readRenamedEnv(process.env, 'SAIIFE_CLAUDE_BIN'),
    readRenamedEnv(process.env, 'SAIIFE_OPENCLAW_BIN')
  )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run typecheck`
Expected: FAIL with `src/main/index.ts(310,5): error TS2304: Cannot find name 'readRenamedEnv'.`

- [ ] **Step 3: Write minimal implementation**

Add the import — edit `src/main/index.ts` line 33, replacing:

```ts
import { resolveShellPath } from './resolve-shell-path'
```

with:

```ts
import { resolveShellPath } from './resolve-shell-path'
import { readRenamedEnv } from './legacy-names'
```

Then replace the four remaining tool-path reads. Line 1425:

```ts
      resolveTool('lazygit', process.env['LOCALFLOW_LAZYGIT_BIN']),
```

becomes:

```ts
      resolveTool('lazygit', readRenamedEnv(process.env, 'SAIIFE_LAZYGIT_BIN')),
```

Line 1427:

```ts
        ? resolveTool(editorBin, process.env['LOCALFLOW_EDITOR_BIN'])
```

becomes:

```ts
        ? resolveTool(editorBin, readRenamedEnv(process.env, 'SAIIFE_EDITOR_BIN'))
```

Line 1440:

```ts
    const lazygitPath = await resolveTool('lazygit', process.env['LOCALFLOW_LAZYGIT_BIN'])
```

becomes:

```ts
    const lazygitPath = await resolveTool('lazygit', readRenamedEnv(process.env, 'SAIIFE_LAZYGIT_BIN'))
```

Line 1453:

```ts
    const resolved = await resolveTool(launch.bin, process.env['LOCALFLOW_EDITOR_BIN'])
```

becomes:

```ts
    const resolved = await resolveTool(launch.bin, readRenamedEnv(process.env, 'SAIIFE_EDITOR_BIN'))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && grep -c "process.env\['LOCALFLOW_CLAUDE_BIN'\]\|process.env\['LOCALFLOW_OPENCLAW_BIN'\]\|process.env\['LOCALFLOW_LAZYGIT_BIN'\]\|process.env\['LOCALFLOW_EDITOR_BIN'\]" src/main/index.ts`
Expected: typecheck silent, then `grep` exits 1 printing `0` — no direct legacy tool-path read remains.

- [ ] **Step 5: Verify the e2e path still resolves binaries**

Run: `npm run build && npx playwright test tests/e2e/operator-launch.spec.ts tests/e2e/smoke.spec.ts`
Expected: PASS — both specs green. They set `LOCALFLOW_CLAUDE_BIN` / `LOCALFLOW_EDITOR_BIN`, which now arrive through the fallback branch, proving the deprecated names still work end to end.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(env): resolve tool-path overrides via the rename fallback

No LOCALFLOW_*_BIN literal is left in index.ts, so the mechanical rename
cannot rewrite one half of a fallback pair and silently break it. The e2e
suite still sets the deprecated names, exercising the fallback branch."
```

---

### Task 7: Clean up the stale OpenClaw skill-env block

**Files:**

- Modify: `src/main/openclaw-config.ts:62-101`
- Test: `tests/unit/openclaw-config.test.ts` (append)

**Interfaces:**

- Consumes: `LEGACY_SKILL_KEY: 'localflow'` from `src/main/legacy-names.ts`.
- Produces: no new exports; `writeSkillEnv` and `removeSkillEnv` keep their existing signatures `(configFile: string, endpoint: string, token: string) => SkillEnvResult` and `(configFile: string) => SkillEnvResult`.

*Why:* the app writes the operator grant into `skills.entries.localflow.env` in the user-owned `~/.openclaw/openclaw.json`. After the rename it writes and revokes `skills.entries.saiife.env`, so a live grant's old block would be orphaned in a user-owned file forever, holding a stale bearer token. Both entry points must sweep it.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/openclaw-config.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeSkillEnv, writeSkillEnv } from '../../src/main/openclaw-config'

describe('legacy skill-env cleanup', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openclaw-legacy-'))
    file = join(dir, 'openclaw.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const legacyConfig = {
    skills: {
      entries: {
        localflow: { env: { LOCALFLOW_ENDPOINT: 'http://127.0.0.1:5000', LOCALFLOW_TOKEN: 'old' } },
        other: { env: { KEEP: 'me' } }
      }
    },
    unrelated: true
  }

  it('writeSkillEnv removes the pre-rebrand block while writing the current one', () => {
    writeFileSync(file, JSON.stringify(legacyConfig))
    const result = writeSkillEnv(file, 'http://127.0.0.1:6000', 'new')
    expect(result).toEqual({ ok: true, written: true })
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, never>
    const entries = (parsed as unknown as { skills: { entries: Record<string, unknown> } }).skills
      .entries
    expect(entries['localflow']).toBeUndefined()
    expect(entries['other']).toEqual({ env: { KEEP: 'me' } })
  })

  it('removeSkillEnv strips the pre-rebrand block too', () => {
    writeFileSync(file, JSON.stringify(legacyConfig))
    const result = removeSkillEnv(file)
    expect(result).toEqual({ ok: true, written: true })
    const entries = (
      JSON.parse(readFileSync(file, 'utf8')) as { skills: { entries: Record<string, unknown> } }
    ).skills.entries
    expect(entries['localflow']).toBeUndefined()
    expect(entries['other']).toEqual({ env: { KEEP: 'me' } })
  })

  it('keeps sibling keys the user put under the pre-rebrand entry', () => {
    writeFileSync(
      file,
      JSON.stringify({
        skills: { entries: { localflow: { env: { LOCALFLOW_TOKEN: 't' }, notes: 'mine' } } }
      })
    )
    removeSkillEnv(file)
    const entries = (
      JSON.parse(readFileSync(file, 'utf8')) as { skills: { entries: Record<string, unknown> } }
    ).skills.entries
    expect(entries['localflow']).toEqual({ notes: 'mine' })
  })

  it('is a silent no-op when no pre-rebrand block exists', () => {
    writeFileSync(file, JSON.stringify({ skills: { entries: {} } }))
    expect(removeSkillEnv(file)).toEqual({ ok: true, written: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/openclaw-config.test.ts`
Expected: FAIL — `expected undefined to be undefined` passes but `writeSkillEnv removes the pre-rebrand block` fails with `expected { env: { LOCALFLOW_ENDPOINT: …, LOCALFLOW_TOKEN: 'old' } } to be undefined`.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `src/main/openclaw-config.ts`, after line 3:

```ts
import { LEGACY_SKILL_KEY } from './legacy-names'
```

Insert this helper immediately before `writeSkillEnv` (currently line 62):

```ts
/**
 * Deletes the pre-rebrand `skills.entries.<legacy>.env` block, and the entry
 * itself when nothing else of the user's is left under it. A live grant written
 * by the previous release would otherwise sit in this user-owned file forever,
 * holding a stale bearer token nothing reads. Returns true if it changed
 * anything, so the caller knows a rewrite is needed.
 */
function dropLegacySkillEnv(config: Obj): boolean {
  const skills = config['skills']
  if (!isObj(skills)) return false
  const entries = skills['entries']
  if (!isObj(entries)) return false
  const legacy = entries[LEGACY_SKILL_KEY]
  if (!isObj(legacy) || !('env' in legacy)) return false
  delete legacy['env']
  if (Object.keys(legacy).length === 0) delete entries[LEGACY_SKILL_KEY]
  return true
}
```

In `writeSkillEnv`, replace:

```ts
  const { config } = loaded
  let node = config
```

with:

```ts
  const { config } = loaded
  dropLegacySkillEnv(config)
  let node = config
```

In `removeSkillEnv`, replace the body after the `loaded` guards:

```ts
  const { config } = loaded
  const skills = config['skills']
  if (!isObj(skills)) return { ok: true, written: false }
  const entries = skills['entries']
  if (!isObj(entries)) return { ok: true, written: false }
  const localflow = entries['localflow']
  if (!isObj(localflow) || !('env' in localflow)) return { ok: true, written: false }
  delete localflow['env']
  return persist(configFile, config)
```

with:

```ts
  const { config } = loaded
  const droppedLegacy = dropLegacySkillEnv(config)
  const skills = config['skills']
  if (!isObj(skills)) return droppedLegacy ? persist(configFile, config) : { ok: true, written: false }
  const entries = skills['entries']
  if (!isObj(entries)) return droppedLegacy ? persist(configFile, config) : { ok: true, written: false }
  const current = entries['localflow']
  if (!isObj(current) || !('env' in current)) {
    return droppedLegacy ? persist(configFile, config) : { ok: true, written: false }
  }
  delete current['env']
  return persist(configFile, config)
```

> Note for the rename script: `entries['localflow']` and `['skills', 'entries', 'localflow']` in this file are the **current** key and are meant to become `'saiife'` in Task 10. Only `LEGACY_SKILL_KEY` keeps the old spelling, and it lives in the exempt module. After Task 10 the `current` lookup reads `entries['saiife']` and `dropLegacySkillEnv` still sweeps `localflow` — which is exactly the intended pairing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/openclaw-config.test.ts`
Expected: PASS — all existing cases plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/main/openclaw-config.ts tests/unit/openclaw-config.test.ts
git commit -m "feat(openclaw): sweep the pre-rebrand skill-env block

Grant and revoke both delete skills.entries.localflow.env from the
user-owned openclaw.json, so a live grant written by the previous release
does not leave an orphaned bearer token behind after the rename. Sibling
keys the user added under that entry are preserved."
```

---

### Task 8: Prove the credential decrypt-failure path degrades gracefully

**Files:**

- Modify: none (`src/main/integrations/credential-store.ts` is already correct)
- Test: `tests/unit/credential-store-rebrand.test.ts`

**Interfaces:**

- Consumes: `CredentialStore`, `SecretBackend` from `src/main/integrations/credential-store.ts`; `revealForConnector(id, key): string`, `decryptionError(id): string | undefined`, `has(id, key): boolean`, `presence(id): Record<string, boolean>`.
- Produces: no new exports.

*Why now:* on macOS `safeStorage` derives its key from a Keychain entry tied to the application identity, so a new `appId`/`productName` can make the copied `integration-secrets.enc` and `hosted-token.enc` ciphertext undecryptable. The recursive copy moves the bytes; this task proves the failure is legible and prompts re-entry rather than crashing or — the worse failure — silently reporting the connector as unconfigured. This must be locked in *before* the rename so the post-rename manual check in Task 11 has a known-good baseline.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/credential-store-rebrand.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, type SecretBackend } from '../../src/main/integrations/credential-store'

/**
 * Models macOS after the rename: encryption is still available (so the store
 * does NOT look "unavailable"), but ciphertext written under the previous
 * application identity no longer decrypts.
 */
const rebrandBrokenBackend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
  decryptString: () => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
  }
}

describe('credential store after a migrated sidecar fails to decrypt', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credstore-rebrand-'))
    file = join(dir, 'integration-secrets.enc')
    writeFileSync(
      file,
      JSON.stringify({ 'shopify:accessToken': 'Y2lwaGVy', 'shopify:shop': 'c2hvcA==' })
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('still reports the credential as PRESENT — never as unconfigured', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    expect(store.has('shopify', 'accessToken')).toBe(true)
    expect(store.presence('shopify')).toEqual({ accessToken: true, shop: true })
  })

  it('surfaces a legible re-enter instruction instead of crashing', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    const error = store.decryptionError('shopify')
    expect(error).toBeDefined()
    expect(error).toContain('can’t be decrypted')
    expect(error).toContain('re-enter it in the Integrations tab')
  })

  it('throws the same legible error from the plaintext exit, never the ciphertext', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    expect(() => store.revealForConnector('shopify', 'accessToken')).toThrow(
      /re-enter it in the Integrations tab/
    )
    try {
      store.revealForConnector('shopify', 'accessToken')
    } catch (err) {
      expect((err as Error).message).not.toContain('Y2lwaGVy')
    }
  })

  it('lets the user overwrite the undecryptable value in place', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    store.set('shopify', 'accessToken', 'freshly-typed')
    expect(store.has('shopify', 'accessToken')).toBe(true)
    expect(store.decryptionError('shopify')).toBeDefined()
  })

  it('reports no decryption error for an integration with nothing stored', () => {
    const store = new CredentialStore({ backend: rebrandBrokenBackend, file })
    expect(store.decryptionError('slack')).toBeUndefined()
  })
})
```

> The error string uses the typographic right single quote (`’`) because `credential-store.ts` writes `can't` with a straight apostrophe inside a template that Prettier leaves alone — verify the exact character in Step 2's failure output and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/credential-store-rebrand.test.ts`
Expected: FAIL on `surfaces a legible re-enter instruction` with `expected 'Stored "shopify" credential "accessToken" can'…' to contain 'can’t be decrypted'` — the apostrophe assertion is wrong.

- [ ] **Step 3: Write minimal implementation**

The production code is already correct; the test's expected string is not. Edit `tests/unit/credential-store-rebrand.test.ts`, replacing:

```ts
    expect(error).toContain('can’t be decrypted')
```

with:

```ts
    expect(error).toContain("can't be decrypted")
    expect(error).toContain('safeStorage:')
    expect(error).toContain('Stored "shopify" credential "accessToken"')
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/credential-store-rebrand.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/credential-store-rebrand.test.ts
git commit -m "test(integrations): lock in the post-rename decrypt-failure path

safeStorage ciphertext copied across the productName change may not
decrypt on macOS. Pins the required behaviour: the credential still reads
as PRESENT (never silently unconfigured), the error names the field and
tells the user to re-enter it, and the ciphertext never leaks into it."
```

---

### Task 9: Decide and document distribution / auto-update continuity

**Files:**

- Create: `docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md`
- Test: `grep` assertions on the written document

**Interfaces:**

- Consumes: nothing.
- Produces: a committed decision document. No later task may run a release step until this exists.

- [ ] **Step 1: Gather the evidence**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
echo '--- updater dependency ---'
grep -n 'electron-updater\|update-electron-app' package.json package-lock.json | head
echo '--- updater code ---'
grep -rn 'autoUpdater' src || echo 'NONE'
echo '--- publish config ---'
grep -n 'publish' electron-builder.yml || echo 'NONE'
echo '--- publish flags in CI ---'
grep -n 'publish' .github/workflows/release.yml
echo '--- how users get builds ---'
grep -n -i 'download\|Releases' README.md | head
```

- [ ] **Step 2: Confirm the expected findings**

Expected output, verbatim in substance:

- updater dependency: no match for `electron-updater` or `update-electron-app` in either file.
- updater code: `NONE`.
- publish config: `NONE` (there is no `publish:` key in `electron-builder.yml`).
- CI: `npx electron-builder --mac --x64 --arm64 --publish never` and `npx electron-builder --linux --publish never`, with artifacts attached to a GitHub Release by `gh release upload`.
- README lines 44 and 49: users download the `.dmg` / `.AppImage` / `.deb` manually from the Releases page.

If any of these differ, STOP and escalate — the decision below is invalid and a real updater channel exists that must be planned for.

- [ ] **Step 3: Write the decision document**

Create `docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md`:

```markdown
# Rebrand distribution & auto-update continuity — decision

**Date:** 2026-07-21
**Status:** Decided
**Applies to:** the localflow → saiife rename (appId `dev.hrrobinson.localflow` → `dev.hrrobinson.saiife`)

## Question

Changing `appId` makes the renamed build a different application to the OS and
to any updater. Can existing installs cross the change, or does this need a
final release under the old identity that points users at the new download?

## Evidence

Measured on 2026-07-21 against `main`:

- `electron-updater` and `update-electron-app` appear in neither `package.json`
  nor `package-lock.json`.
- `grep -rn 'autoUpdater' src` returns nothing. The app contains no update code.
- `electron-builder.yml` has no `publish:` key.
- `.github/workflows/release.yml` builds with `--publish never` on both jobs and
  attaches the artifacts to a GitHub Release with `gh release upload`.
- `README.md` tells users to download the `.dmg` / `.AppImage` / `.deb` from the
  Releases page by hand.

## Decision

**There is no auto-updater to preserve.** Distribution is manual download from
GitHub Releases, so the `appId` change cannot break an update channel — none
exists. No final release under the old identity is required, and no updater
migration work is in scope.

Two real consequences remain, and both are release-note items rather than code:

1. **macOS installs a second app.** `saiife.app` does not replace `localflow.app`;
   both sit in /Applications until the user deletes the old one. The userData
   carry-over means the new app starts with the old app's data, and the old
   directory is left intact, so deleting the old bundle is safe and loses
   nothing.
2. **Linux `.deb` is a new package.** electron-builder derives the package name
   from `productName`, so `saiife_<version>_amd64.deb` installs alongside the
   still-registered `localflow` package instead of upgrading it. Users should
   `sudo apt remove localflow` after installing saiife. The AppImage is a plain
   file rename with no package manager involved.

## Release-note lines this produces

- saiife replaces localflow. Your settings, sessions, flows, themes and captures
  are copied across automatically on first launch; the old data is left where it
  was, so nothing is lost if you go back.
- macOS: the old localflow app is not removed. Drag it to the Trash once saiife
  starts up correctly.
- Linux (deb): run `sudo apt remove localflow` after installing saiife — the two
  are separate packages.

## What would invalidate this

Adding `electron-updater`, a `publish:` block in `electron-builder.yml`, or any
`--publish` value other than `never`. If any of those land, redo this decision
before the first saiife release.
```

- [ ] **Step 4: Verify the document records every required conclusion**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
for needle in 'no auto-updater to preserve' 'appId' 'second app' 'apt remove localflow' 'What would invalidate this'; do
  grep -q "$needle" docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md \
    && echo "ok: $needle" || { echo "MISSING: $needle"; exit 1; }
done
```

Expected: five `ok:` lines, exit status 0.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md
git commit -m "docs: decide distribution continuity across the appId change

No auto-updater exists (no electron-updater, no autoUpdater code, no
publish config, --publish never on both release jobs), so the appId change
breaks no update channel. Records the two real consequences — a second
macOS bundle and a separate deb package — as release-note lines."
```

---

### Task 10: The mechanical rename — one commit

**Files:**

- Create: `tests/unit/rebrand-completeness.test.ts`
- Move: `guard/crates/lfguard/` → `guard/crates/saiifeguard/`; `openclaw/skills/localflow/` → `openclaw/skills/saiife/`; `openclaw/skills/saiife/bin/localflow-control.mjs` → `saiife-control.mjs`; `openclaw/skills/saiife/bin/localflow-control.d.mts` → `saiife-control.d.mts`; `tests/unit/localflow-cli.test.ts` → `tests/unit/saiife-cli.test.ts`
- Modify: every text file in the repo except the exempt set (see the script)
- Test: `tests/unit/rebrand-completeness.test.ts`

**Interfaces:**

- Consumes: `LEGACY_PRODUCT_NAME`, `LEGACY_SKILL_KEY`, `MIGRATION_MARKER`, `RENAMED_ENV_VARS` from `src/main/legacy-names.ts`.
- Produces: `appId: dev.hrrobinson.saiife`, `productName: saiife`, `extraResources` `guard/target/release/saiifeguard → saiifeguard`, `package.json` `"name": "saiife"`, cargo package/lib/bin all `saiifeguard`, `window.saiife` bridge, `SaiifeApi` type, `SAIIFE_*` env var names, `X-Saiife-Token` hook header.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/rebrand-completeness.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LEGACY_PRODUCT_NAME,
  LEGACY_SKILL_KEY,
  MIGRATION_MARKER,
  RENAMED_ENV_VARS
} from '../../src/main/legacy-names'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The only files allowed to still say the old name after the rename:
 * the module whose whole job is remembering it, its test, this gate itself,
 * and the two rebrand documents that describe the change.
 */
const EXEMPT = new Set([
  'src/main/legacy-names.ts',
  'tests/unit/legacy-names.test.ts',
  'tests/unit/rebrand-completeness.test.ts',
  'docs/superpowers/specs/2026-07-21-localflow-to-saiife-rebrand-design.md',
  'docs/superpowers/plans/2026-07-21-localflow-to-saiife-rebrand.md',
  'docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md',
  'docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md'
])

const SEARCH_PATHS = [
  'src',
  'guard/crates',
  'guard/Cargo.toml',
  'guard/Cargo.lock',
  'openclaw',
  'docs',
  'tests',
  '.github',
  'assets',
  'package.json',
  'electron-builder.yml',
  'README.md',
  'CONTRIBUTING.md'
]

/**
 * Renaming the GitHub repo is out of scope, so `github.com/HrRobinson/localflow`
 * must survive the sweep. That is the ONLY line-level exception.
 */
const ALLOWED_LINE = /github\.com\/HrRobinson\/localflow/

/** `<path>:<lineno>:<text>` for every content match, case-insensitively. */
function matchingLines(pattern: string): string[] {
  try {
    const out = execFileSync('grep', ['-rIn', '-i', '-e', pattern, ...SEARCH_PATHS], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    return out.split('\n').filter((line) => line.length > 0)
  } catch (err) {
    // grep exits 1 with empty output when nothing matched; anything else is real.
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

/** Files with at least one match that is neither exempt nor an allowed repo URL. */
function offendingFiles(pattern: string): string[] {
  const files = new Set<string>()
  for (const line of matchingLines(pattern)) {
    const file = line.slice(0, line.indexOf(':'))
    if (EXEMPT.has(file)) continue
    if (ALLOWED_LINE.test(line)) continue
    files.add(file)
  }
  return [...files].sort()
}

describe('rebrand completeness', () => {
  it('no non-exempt file mentions the old product name', () => {
    expect(offendingFiles('localflow')).toEqual([])
  })

  it('no non-exempt file mentions the old guard binary name', () => {
    expect(offendingFiles('lfguard')).toEqual([])
  })

  it('the exempt module still remembers the old names', () => {
    expect(LEGACY_PRODUCT_NAME).toBe('localflow')
    expect(LEGACY_SKILL_KEY).toBe('localflow')
    expect(MIGRATION_MARKER).toBe('.migrated-from-localflow.json')
    expect(RENAMED_ENV_VARS.map((v) => v.legacy)).toEqual([
      'LOCALFLOW_CLAUDE_BIN',
      'LOCALFLOW_OPENCLAW_BIN',
      'LOCALFLOW_LAZYGIT_BIN',
      'LOCALFLOW_EDITOR_BIN'
    ])
    expect(RENAMED_ENV_VARS.map((v) => v.current)).toEqual([
      'SAIIFE_CLAUDE_BIN',
      'SAIIFE_OPENCLAW_BIN',
      'SAIIFE_LAZYGIT_BIN',
      'SAIIFE_EDITOR_BIN'
    ])
  })
})

describe('rebrand identifiers', () => {
  it('electron-builder declares the saiife identity and guard binary', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('appId: dev.hrrobinson.saiife')
    expect(yml).toContain('productName: saiife')
    expect(yml).toContain('from: guard/target/release/saiifeguard')
    expect(yml).toContain('to: saiifeguard')
    expect(yml).not.toContain('productName: Saiife')
    expect(yml).not.toContain('productName: SAIIFE')
  })

  it('package.json is named saiife and keeps the repository URL', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      name: string
      description: string
      repository: { url: string }
    }
    expect(pkg.name).toBe('saiife')
    expect(pkg.description).toBe(
      'Mission control for Claude Code sessions - one window, many agents, glanceable status.'
    )
    expect(pkg.repository.url).toBe('https://github.com/HrRobinson/localflow.git')
  })

  it('the guard crate declares saiifeguard as package, bin and lib', () => {
    const toml = readFileSync(join(repoRoot, 'guard/crates/saiifeguard/Cargo.toml'), 'utf8')
    expect(toml.match(/name = "saiifeguard"/g)).toHaveLength(3)
    const workspace = readFileSync(join(repoRoot, 'guard/Cargo.toml'), 'utf8')
    expect(workspace).toContain('members = ["crates/saiifeguard"]')
    expect(workspace).toContain('repository = "https://github.com/HrRobinson/localflow"')
  })

  it('the preload bridge and its type are renamed', () => {
    const preload = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')
    expect(preload).toContain("contextBridge.exposeInMainWorld('saiife', api)")
    expect(preload).toContain('SaiifeApi')
    const dts = readFileSync(join(repoRoot, 'src/preload/index.d.ts'), 'utf8')
    expect(dts).toContain('saiife: SaiifeApi')
  })

  it('the guard binary resolver points at saiifeguard', () => {
    const resolver = readFileSync(join(repoRoot, 'src/main/guard-binary.ts'), 'utf8')
    expect(resolver).toContain("join(opts.resourcesPath, 'saiifeguard')")
    expect(resolver).toContain("'guard', 'target', 'release', 'saiifeguard'")
  })
})
```

> The repository-URL assertions are deliberate: renaming the GitHub repo is out of scope, so `https://github.com/HrRobinson/localflow` must survive the sweep. Step 6 restores those URLs after the blanket replace.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/rebrand-completeness.test.ts`
Expected: FAIL — `no non-exempt file mentions the old product name` reports ~215 paths, `no non-exempt file mentions the old guard binary name` reports ~83 paths, and `electron-builder declares the saiife identity` fails with `expected 'appId: dev.hrrobinson.localflow…' to contain 'appId: dev.hrrobinson.saiife'`.

Note the deliberate ordering inside this task: the completeness gate is written first (RED), then the moves and the sweep make it GREEN, and both land in the same commit. The gate is 90 lines of pure verification *of* the mechanical change, so it belongs to it — the "one mechanical commit" rule is about keeping behavioural change out, not tests.

- [ ] **Step 3: Move the directories and files**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
git mv guard/crates/lfguard guard/crates/saiifeguard
git mv openclaw/skills/localflow openclaw/skills/saiife
git mv openclaw/skills/saiife/bin/localflow-control.mjs openclaw/skills/saiife/bin/saiife-control.mjs
git mv openclaw/skills/saiife/bin/localflow-control.d.mts openclaw/skills/saiife/bin/saiife-control.d.mts
git mv tests/unit/localflow-cli.test.ts tests/unit/saiife-cli.test.ts
git status --short
```

Expected: five `R` (rename) entries plus the whole `guard/crates/saiifeguard/` and `openclaw/skills/saiife/` subtrees shown as renames.

- [ ] **Step 4: Write the rename script**

Create `.rebrand.sh` at the repo root (it is deleted in Step 9 and never committed):

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Paths the sweep must never touch: build output, VCS internals, the module
# whose job is remembering the old name, its test, the completeness gate, the
# changelog (release-please owns it; its entries are historical), and the
# rebrand documents themselves.
EXEMPT_GLOBS=(
  './.git/*'
  './node_modules/*'
  './dist/*'
  './out/*'
  './guard/target/*'
  './playwright-report/*'
  './test-results/*'
  './CHANGELOG.md'
  './.rebrand.sh'
  './src/main/legacy-names.ts'
  './tests/unit/legacy-names.test.ts'
  './tests/unit/rebrand-completeness.test.ts'
  './docs/superpowers/specs/2026-07-21-localflow-to-saiife-rebrand-design.md'
  './docs/superpowers/plans/2026-07-21-localflow-to-saiife-rebrand.md'
  './docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md'
  './docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md'
)

prune_expr=()
for glob in "${EXEMPT_GLOBS[@]}"; do
  prune_expr+=( -path "$glob" -o )
done
unset 'prune_expr[${#prune_expr[@]}-1]'   # drop the trailing -o

changed=0
while IFS= read -r -d '' file; do
  # grep -I marks binary files as such and never matches, so PNGs are skipped.
  grep -Iq . "$file" 2>/dev/null || continue
  before=$(cksum < "$file")
  LC_ALL=C sed -i \
    -e 's/lfguard/saiifeguard/g' \
    -e 's/LFGUARD/SAIIFEGUARD/g' \
    -e 's/LOCALFLOW/SAIIFE/g' \
    -e 's/Localflow/Saiife/g' \
    -e 's/localflow/saiife/g' \
    "$file"
  after=$(cksum < "$file")
  if [ "$before" != "$after" ]; then
    changed=$((changed + 1))
    echo "rewrote $file"
  fi
done < <(find . \( "${prune_expr[@]}" \) -prune -o -type f -print0)

echo "--- rewrote $changed file(s) ---"
```

Make it executable:

```bash
cd /home/jonasrobinson/projects/saiife/localflow && chmod +x .rebrand.sh
```

- [ ] **Step 5: Run the rename script**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow && ./.rebrand.sh | tail -20
```

Expected: a `rewrote …` line per file, ending with `--- rewrote 2xx file(s) ---`. `src/main/legacy-names.ts`, `tests/unit/legacy-names.test.ts`, `tests/unit/rebrand-completeness.test.ts` and `CHANGELOG.md` must NOT appear in the list.

- [ ] **Step 6: Restore the out-of-scope GitHub repository URLs**

The sweep rewrote the repo path in clone/browse URLs, but renaming the GitHub repo is explicitly out of scope. Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
grep -rIl 'github.com/HrRobinson/saiife' . \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist --exclude-dir=out \
  | xargs sed -i 's#github.com/HrRobinson/saiife#github.com/HrRobinson/localflow#g'
grep -rn 'github.com/HrRobinson/' package.json package-lock.json guard/Cargo.toml README.md
```

Expected: every printed URL reads `github.com/HrRobinson/localflow`.

- [ ] **Step 7: Regenerate the Cargo lockfile and build the renamed binary**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
cargo build --release --manifest-path guard/Cargo.toml
ls -l guard/target/release/saiifeguard
./guard/target/release/saiifeguard --version
```

Expected: cargo compiles `saiifeguard v0.1.0`, the binary exists at `guard/target/release/saiifeguard`, and `--version` prints `saiifeguard 0.1.0`.

- [ ] **Step 8: Reformat and lint**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
npm run format
npm run lint
npm run typecheck
```

Expected: Prettier rewrites any lines whose length changed, ESLint reports no errors, and `tsc` is silent for both projects.

- [ ] **Step 9: Delete the script and run the full test suite**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
rm -f .rebrand.sh
npm test
cargo test --manifest-path guard/Cargo.toml
```

Expected: Vitest reports every unit file passing — 239 files: the original 234, plus `legacy-names`, `userdata-migration`, `console-migration-event`, `credential-store-rebrand` and `rebrand-completeness`. `localflow-cli.test.ts` was renamed to `saiife-cli.test.ts`, not added or removed. Cargo reports the guard crate's unit, CLI and corpus suites all passing against the `saiifeguard` binary name.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run tests/unit/rebrand-completeness.test.ts`
Expected: PASS — 8 tests passed (3 in `rebrand completeness`, 5 in `rebrand identifiers`).

- [ ] **Step 11: Run the e2e suite against the renamed binary**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
npm run build && npx playwright test
```

Expected: PASS — all 6 specs green, including `tests/e2e/guard.spec.ts`, which asserts the Claude PreToolUse hook command contains `saiifeguard` and executes the real binary.

- [ ] **Step 12: Commit**

```bash
cd /home/jonasrobinson/projects/saiife/localflow
git add -A
git commit -m "refactor!: rename localflow to saiife

Pure find-and-replace plus file and directory moves — no behavioural
change in this commit.

  lfguard    -> saiifeguard
  LOCALFLOW  -> SAIIFE
  Localflow  -> Saiife
  localflow  -> saiife

  guard/crates/lfguard/          -> guard/crates/saiifeguard/
  openclaw/skills/localflow/     -> openclaw/skills/saiife/
  .../bin/localflow-control.mjs  -> .../bin/saiife-control.mjs
  tests/unit/localflow-cli.test.ts -> tests/unit/saiife-cli.test.ts

  appId        dev.hrrobinson.localflow -> dev.hrrobinson.saiife
  productName  localflow -> saiife (lowercase, deliberately)

Not touched: src/main/legacy-names.ts and its test (they exist to remember
the old name), CHANGELOG.md (historical), the rebrand spec/plan/notes, and
the github.com/HrRobinson/localflow repository URLs — renaming the repo is
out of scope.

BREAKING CHANGE: the userData directory moves with productName. The
migration added earlier in this branch copies the previous release's whole
tree across on first launch. LOCALFLOW_*_BIN environment variables still
work but are deprecated in favour of SAIIFE_*."
```

---

### Task 11: Verify safeStorage behaviour on macOS after the rename

**Files:**

- Create: `docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md`
- Test: manual run on macOS + `grep` assertions on the written document

**Interfaces:**

- Consumes: the Task 8 behaviour contract (`decryptionError` returns a legible string, `has`/`presence` still report the credential as present).
- Produces: a committed finding plus the release-note line it implies. Must be complete before Task 13.

> This task requires a macOS machine. On Linux, stop and hand it to a macOS runner — the finding cannot be simulated, and shipping without it risks silently logging every connector out.

- [ ] **Step 1: Build both identities on macOS**

Run:

```bash
cd /path/to/localflow
git checkout main && npm ci && npm run package     # the pre-rename identity
cp -R dist/mac-arm64/localflow.app /tmp/localflow-old.app
git checkout feat/saiife-rebrand && npm ci && npm run package
cp -R dist/mac-arm64/saiife.app /tmp/saiife-new.app
```

Expected: two app bundles, `/tmp/localflow-old.app` and `/tmp/saiife-new.app`.

- [ ] **Step 2: Store a credential under the old identity**

Run `/tmp/localflow-old.app/Contents/MacOS/localflow`, open the Integrations tab, set the Shopify `accessToken` to `verification-token-1`, quit, then run:

```bash
ls -l ~/Library/Application\ Support/localflow/integration-secrets.enc
python3 -c "import json;print(list(json.load(open('$HOME/Library/Application Support/localflow/integration-secrets.enc')).keys()))"
```

Expected: the file exists and prints `['shopify:accessToken']`.

- [ ] **Step 3: Launch the renamed build and observe the migration**

Run:

```bash
rm -rf ~/Library/Application\ Support/saiife
/tmp/saiife-new.app/Contents/MacOS/saiife
```

In the app, open the Integrations tab and look at the Shopify row. Then quit and run:

```bash
cat ~/Library/Application\ Support/saiife/.migrated-from-localflow.json
diff <(xxd ~/Library/Application\ Support/localflow/integration-secrets.enc) \
     <(xxd ~/Library/Application\ Support/saiife/integration-secrets.enc) && echo 'IDENTICAL BYTES'
```

Expected: the marker names `.../Application Support/localflow` as its source with a non-zero `copied` count, and the sidecar bytes are identical.

- [ ] **Step 4: Record which of the two outcomes occurred**

Exactly one of these must be true; note which:

- **A — ciphertext survives.** The Shopify row shows the token as configured and the connector works. `safeStorage` on this macOS version is not bound tightly enough to the app identity to invalidate it.
- **B — ciphertext does not decrypt.** The Shopify row shows the credential as **present but unreadable**, with the message `Stored "shopify" credential "accessToken" can't be decrypted (safeStorage: …) — re-enter it in the Integrations tab.` Re-typing the token in that field succeeds and the connector works afterwards.

Outcome B is the acceptable failure. Anything else — a crash, a blank/unconfigured-looking row with no message, or a re-entry that does not stick — is a **blocker**: fix it before proceeding. The behaviour is pinned by `tests/unit/credential-store-rebrand.test.ts`, so a divergence means production diverges from the test's model.

- [ ] **Step 5: Write the finding**

Create `docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md`, filling in the observed outcome:

```markdown
# safeStorage across the rebrand — macOS verification

**Date:** 2026-07-21
**Status:** Verified
**Machine:** macOS <version>, Apple Silicon, unsigned local build (`identity: null`)

## What was tested

`credential-store.ts` encrypts integration secrets with Electron `safeStorage`
and persists them to `integration-secrets.enc` in userData (a JSON map of
`"<id>:<key>" -> base64(ciphertext)`); `hosted-token.enc` follows the same
pattern. On macOS the `safeStorage` key derives from a Keychain entry tied to
the application, so a new appId/productName can make copied ciphertext
undecryptable even though the bytes migrate perfectly.

## Procedure

1. Packaged the pre-rename build, stored a Shopify `accessToken` through the UI.
2. Confirmed `~/Library/Application Support/localflow/integration-secrets.enc`
   contained the `shopify:accessToken` entry.
3. Packaged the renamed build, deleted any existing saiife userData, launched.
4. Confirmed the migration marker and byte-identical sidecar in
   `~/Library/Application Support/saiife/`.
5. Opened the Integrations tab and observed the Shopify row.

## Outcome

<A: the migrated ciphertext still decrypts — no user action needed>
OR
<B: the migrated ciphertext does not decrypt. The row reported the credential as
PRESENT and showed: Stored "shopify" credential "accessToken" can't be decrypted
(safeStorage: …) — re-enter it in the Integrations tab. Re-entering the value
succeeded and the connector worked afterwards. The app did not crash and never
reported the connector as unconfigured.>

## Platform exposure

- **macOS** — as above.
- **Linux** — same exposure in principle (kwallet / gnome-libsecret). Not
  verified on a machine with an active secret service; the degradation path is
  identical because it is the same `credential-store.ts` code.
- **Windows** — DPAPI is user-scoped, not application-scoped. Unaffected.

## Release-note line

> Connector credentials may need to be entered once more after upgrading. saiife
> will tell you which ones, in the Integrations tab, and nothing else is lost.
```

- [ ] **Step 6: Verify the finding records the required facts**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
for needle in 'Outcome' 'Windows' 'DPAPI' 'Release-note line' 're-enter it in the Integrations tab'; do
  grep -q "$needle" docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md \
    && echo "ok: $needle" || { echo "MISSING: $needle"; exit 1; }
done
```

Expected: five `ok:` lines, exit status 0.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md
git commit -m "docs: record the macOS safeStorage finding for the rebrand

Verifies whether safeStorage ciphertext survives the appId/productName
change and confirms the degradation path prompts re-entry rather than
crashing or reporting the connector as unconfigured."
```

---

### Task 12: End-to-end migration against a seeded legacy directory

**Files:**

- Create: `tests/e2e/migration.spec.ts`
- Test: `tests/e2e/migration.spec.ts`

**Interfaces:**

- Consumes: `userDataDirFor(productName: string, input: UserDataPathInput): string`, `legacyUserDataDir(input: UserDataPathInput): string`, `MIGRATION_MARKER` from `src/main/legacy-names.ts`.
- Produces: no exports. This is the automated form of the spec's "a seeded legacy userData dir migrates correctly" check.

- [ ] **Step 1: Write the failing test**

Create `tests/e2e/migration.spec.ts`:

```ts
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  legacyUserDataDir,
  MIGRATION_MARKER,
  userDataDirFor
} from '../../src/main/legacy-names'

/**
 * Drives the real startup path with a fake home: the app resolves its own
 * userData from productName under that home, finds the seeded pre-rebrand
 * directory next to it, and copies the tree across before any store reads it.
 *
 * Deliberately does NOT set the userData override env var — that override is a
 * hard no-op for the migration, which is exactly what this spec must not hit.
 */
test.describe('legacy userData migration', () => {
  let home: string
  let app: ElectronApplication | undefined

  const ENC = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x0a])

  test.beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'saiife-migration-e2e-'))
  })

  test.afterEach(async () => {
    if (app) {
      await app.close().catch(() => undefined)
      app = undefined
    }
    rmSync(home, { recursive: true, force: true })
  })

  test('copies a seeded pre-rebrand directory into the new one on first launch', async () => {
    test.skip(process.platform === 'win32', 'HOME override does not apply on win32')

    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
    const pathInput = { platform: process.platform, env, home }
    const legacyDir = legacyUserDataDir(pathInput)
    const newDir = userDataDirFor('saiife', pathInput)

    mkdirSync(join(legacyDir, 'themes'), { recursive: true })
    mkdirSync(join(legacyDir, 'captures', 'wp1'), { recursive: true })
    mkdirSync(join(legacyDir, 'guard-seen'), { recursive: true })
    writeFileSync(join(legacyDir, 'config.json'), '{"theme":"nord"}')
    writeFileSync(join(legacyDir, 'flows.json'), '[{"id":"f1","name":"nightly"}]')
    writeFileSync(join(legacyDir, 'integration-secrets.enc'), ENC)
    writeFileSync(join(legacyDir, 'guard-audit.jsonl'), '{"ts":1}\n')
    writeFileSync(join(legacyDir, 'themes', 'nord.json'), '{"name":"nord"}')
    writeFileSync(join(legacyDir, 'captures', 'wp1', 'shot.png'), Buffer.from([0x89, 0x50]))
    writeFileSync(join(legacyDir, 'guard-seen', 'pane-1'), 'seen')

    app = await electron.launch({ args: ['.'], env })
    await app.firstWindow()

    expect(existsSync(join(newDir, 'config.json'))).toBe(true)
    expect(existsSync(join(newDir, 'flows.json'))).toBe(true)
    expect(readFileSync(join(newDir, 'flows.json'), 'utf8')).toBe('[{"id":"f1","name":"nightly"}]')
    expect(readFileSync(join(newDir, 'integration-secrets.enc'))).toEqual(ENC)
    expect(readFileSync(join(newDir, 'guard-audit.jsonl'), 'utf8')).toBe('{"ts":1}\n')
    expect(existsSync(join(newDir, 'themes', 'nord.json'))).toBe(true)
    expect(existsSync(join(newDir, 'captures', 'wp1', 'shot.png'))).toBe(true)
    expect(existsSync(join(newDir, 'guard-seen', 'pane-1'))).toBe(true)

    const marker = JSON.parse(readFileSync(join(newDir, MIGRATION_MARKER), 'utf8')) as {
      from: string
      copied: number
    }
    expect(marker.from).toBe(legacyDir)
    expect(marker.copied).toBeGreaterThanOrEqual(7)

    // Copy, never move.
    expect(existsSync(join(legacyDir, 'config.json'))).toBe(true)
    expect(readFileSync(join(legacyDir, 'integration-secrets.enc'))).toEqual(ENC)
  })

  test('leaves an existing new-format directory alone', async () => {
    test.skip(process.platform === 'win32', 'HOME override does not apply on win32')

    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
    const pathInput = { platform: process.platform, env, home }
    const legacyDir = legacyUserDataDir(pathInput)
    const newDir = userDataDirFor('saiife', pathInput)

    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'config.json'), '{"theme":"nord"}')
    writeFileSync(join(legacyDir, 'flows.json'), '[{"id":"old"}]')
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'config.json'), '{"theme":"gruvbox"}')

    app = await electron.launch({ args: ['.'], env })
    await app.firstWindow()

    expect(readFileSync(join(newDir, 'config.json'), 'utf8')).toBe('{"theme":"gruvbox"}')
    expect(existsSync(join(newDir, 'flows.json'))).toBe(false)
    expect(existsSync(join(newDir, MIGRATION_MARKER))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

First confirm the RED state by stubbing out the wiring. Temporarily edit `src/main/index.ts`, changing `overridden: userDataOverridden` to `overridden: true`, then run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
npm run build && npx playwright test tests/e2e/migration.spec.ts
```

Expected: FAIL on the first spec with `expect(existsSync(join(newDir, 'config.json'))).toBe(true)` — `Received: false`. The second spec passes (nothing to migrate is indistinguishable from a forced skip).

- [ ] **Step 3: Restore the real wiring**

Edit `src/main/index.ts`, changing `overridden: true` back to:

```ts
      overridden: userDataOverridden
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
npm run build && npx playwright test tests/e2e/migration.spec.ts
```

Expected: PASS — 2 tests passed.

- [ ] **Step 5: Add the spec to the e2e workflow's trigger paths**

No change needed — `.github/workflows/e2e.yml` already triggers on `tests/**`, and `npm run e2e` runs everything under `tests/e2e`. Confirm with:

```bash
cd /home/jonasrobinson/projects/saiife/localflow && npm run build && npx playwright test
```

Expected: PASS — 7 specs (the original 6 plus `migration.spec.ts`).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/migration.spec.ts
git commit -m "test(e2e): migrate a seeded pre-rebrand userData dir end to end

Launches the real app under a fake HOME with a seeded legacy directory and
asserts the whole tree — nested themes/, captures/, guard-seen/, the .enc
sidecar and the .jsonl audit log — arrives intact, the marker names its
source, and the original is left untouched."
```

---

### Task 13: Final verification sweep

**Files:**

- Modify: none
- Test: the full suite plus the spec's five acceptance checks

**Interfaces:**

- Consumes: everything produced by Tasks 1–12.
- Produces: a green branch ready for review.

- [ ] **Step 1: Confirm no unintended residue of the old names**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
grep -rIn -i -e 'localflow' -e 'lfguard' \
  src guard/crates guard/Cargo.toml guard/Cargo.lock openclaw docs tests .github assets \
  package.json electron-builder.yml README.md CONTRIBUTING.md \
  | grep -v 'github\.com/HrRobinson/localflow' \
  | cut -d: -f1 | sort -u
```

Expected: exactly these seven paths and nothing else —

```
docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md
docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md
docs/superpowers/plans/2026-07-21-localflow-to-saiife-rebrand.md
docs/superpowers/specs/2026-07-21-localflow-to-saiife-rebrand-design.md
src/main/legacy-names.ts
tests/unit/legacy-names.test.ts
tests/unit/rebrand-completeness.test.ts
```

Two deliberate exclusions:

- The `grep -v` drops `github.com/HrRobinson/localflow` clone and browse URLs — renaming the GitHub repo is explicitly out of scope, so those must survive.
- `CHANGELOG.md` is outside the path list by design: its entries predate the rename and are intentional historical references, and release-please owns the file.

- [ ] **Step 2: Run the full unit suite**

Run: `cd /home/jonasrobinson/projects/saiife/localflow && npm test`
Expected: PASS — 239 test files (234 original, `localflow-cli.test.ts` renamed in place, plus `legacy-names`, `userdata-migration`, `console-migration-event`, `credential-store-rebrand`, `rebrand-completeness`), zero failures.

- [ ] **Step 3: Run lint and typecheck**

Run: `cd /home/jonasrobinson/projects/saiife/localflow && npm run lint && npm run typecheck`
Expected: PASS — ESLint and Prettier both clean, `tsc --noEmit` silent for `tsconfig.node.json` and `tsconfig.web.json`.

- [ ] **Step 4: Confirm the guard build produces the renamed binary**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
rm -rf guard/target/release
npm run build:guard
test -x guard/target/release/saiifeguard && echo 'saiifeguard OK'
test ! -e guard/target/release/lfguard && echo 'lfguard gone'
cargo test --manifest-path guard/Cargo.toml
```

Expected: `saiifeguard OK`, `lfguard gone`, and every cargo test target passing.

- [ ] **Step 5: Run the full Playwright suite**

Run: `cd /home/jonasrobinson/projects/saiife/localflow && npm run e2e`
Expected: PASS — 7 specs, including `guard.spec.ts` (which asserts the injected PreToolUse hook command contains `saiifeguard` and executes the real binary) and `migration.spec.ts`.

- [ ] **Step 6: Package and launch a real build against a seeded legacy directory**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
npm run package
ls dist/*/saiife* 2>/dev/null || ls dist
```

Then, on the packaging host, seed a legacy directory and launch the packaged binary:

```bash
# linux example; on macOS use ~/Library/Application\ Support/localflow
mkdir -p "$HOME/.config/localflow/themes"
echo '{"theme":"nord"}' > "$HOME/.config/localflow/config.json"
echo '[{"id":"f1"}]'    > "$HOME/.config/localflow/flows.json"
echo '{"name":"nord"}'  > "$HOME/.config/localflow/themes/nord.json"
rm -rf "$HOME/.config/saiife"
./dist/linux-unpacked/saiife &
sleep 8 && kill %1
cat "$HOME/.config/saiife/.migrated-from-localflow.json"
ls "$HOME/.config/saiife" "$HOME/.config/saiife/themes"
```

Expected: the app window opens, the marker names `.../localflow` with a non-zero `copied` count, `config.json`, `flows.json` and `themes/nord.json` are all present in the saiife directory, and the localflow directory still holds its originals.

- [ ] **Step 7: Confirm both decision documents are committed**

Run:

```bash
cd /home/jonasrobinson/projects/saiife/localflow
git log --oneline main..HEAD
git status --short
ls docs/superpowers/notes/
```

Expected: a linear history of behavioural commits followed by the single `refactor!: rename localflow to saiife` commit and the post-rename test/doc commits; a clean working tree; and both `2026-07-21-rebrand-distribution-decision.md` and `2026-07-21-rebrand-safestorage-verification.md` present.

- [ ] **Step 8: Commit (verification produced no changes)**

```bash
cd /home/jonasrobinson/projects/saiife/localflow
git status --short   # must print nothing
git log --oneline -1 # the branch tip is the last real commit; nothing to add
```

If Step 3 or Step 4 required a formatting fix, commit it as:

```bash
git add -A
git commit -m "style: reformat after the rebrand sweep"
```

Otherwise there is nothing to commit and the branch is ready for review.
