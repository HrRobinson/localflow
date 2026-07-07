import type { HookAdapterKind } from '../shared/agents'
import { writeHookSettings } from './hook-settings'
import { buildCodexHookArgs } from './codex-hooks'
import { writeGeminiHookSettings } from './gemini-hooks'

export interface HookInjection {
  args: string[]
  env: Record<string, string>
}

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
