import type { HookAdapterKind } from '../shared/agents'
import { writeHookSettings } from './hook-settings'
import { buildCodexHookArgs } from './codex-hooks'
import { writeGeminiHookSettings } from './gemini-hooks'

export interface HookInjection {
  args: string[]
  env: Record<string, string>
}

/**
 * Env keys the hook injection owns (buildHookInjection puts them in the
 * spawn env). User per-agent env overrides win last in the spawn merge, so
 * an override on one of these would silently kill that agent's status feed
 * — setAgentOverride rejects them at the config boundary instead.
 */
export const RESERVED_ENV_KEYS: readonly string[] = ['GEMINI_CLI_SYSTEM_SETTINGS_PATH']

/**
 * Dispatches to the per-agent hook-injection mechanism: a written settings
 * file + CLI flag (Claude), an env var pointing at a written settings file
 * (Gemini), inline `-c` CLI overrides (Codex), or nothing at all.
 */
export function buildHookInjection(
  kind: HookAdapterKind,
  dir: string,
  paneId: string,
  port: number,
  token: string
): HookInjection {
  switch (kind) {
    case 'settings-file':
      return { args: ['--settings', writeHookSettings(dir, paneId, port, token)], env: {} }
    case 'env-settings-file':
      return {
        args: [],
        env: {
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: writeGeminiHookSettings(dir, paneId, port, token)
        }
      }
    case 'cli-args-full':
      return { args: buildCodexHookArgs(paneId, port, token, 'full'), env: {} }
    case 'cli-args-notify':
      return { args: buildCodexHookArgs(paneId, port, token, 'notify'), env: {} }
    case 'none':
      return { args: [], env: {} }
  }
}
