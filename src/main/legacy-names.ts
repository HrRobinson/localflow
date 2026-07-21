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
