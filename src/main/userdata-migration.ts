import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
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
      reason:
        | 'user-data-overridden'
        | 'same-directory'
        | 'already-migrated'
        | 'new-data-present'
        | 'no-legacy-dir'
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
  let entries: Dirent[]
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
