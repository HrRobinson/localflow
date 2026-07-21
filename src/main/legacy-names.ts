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
