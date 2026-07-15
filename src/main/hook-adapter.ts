import type { HookAdapterKind } from '../shared/agents'
import { removeHookSettings, writeHookSettings } from './hook-settings'
import { buildCodexHookArgs } from './codex-hooks'
import { removeGeminiHookSettings, writeGeminiHookSettings } from './gemini-hooks'
import { type ResolvedGuard } from './guard-hook'

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
  token: string,
  guard: ResolvedGuard | null
): HookInjection {
  switch (kind) {
    case 'settings-file':
      return { args: ['--settings', writeHookSettings(dir, paneId, port, token, guard)], env: {} }
    case 'env-settings-file':
      return {
        args: [],
        env: {
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: writeGeminiHookSettings(dir, paneId, port, token, guard)
        }
      }
    case 'cli-args-full':
      return { args: buildCodexHookArgs(paneId, port, token, 'full', guard), env: {} }
    case 'cli-args-notify':
      return { args: buildCodexHookArgs(paneId, port, token, 'notify', guard), env: {} }
    case 'none':
      return { args: [], env: {} }
  }
}

/**
 * Best-effort inverse of buildHookInjection's on-disk side effects: removes
 * the per-session settings files a spawn may have written. Called when a
 * session is deleted for good; adapters that never write files (Codex's
 * inline CLI args, 'none') simply have nothing to remove. Removal is keyed
 * on paneId alone rather than adapter kind — a session's agent can change
 * across restores, and deleting a file that was never written is a no-op.
 */
export function removeHookInjectionFiles(dir: string, paneId: string): void {
  removeHookSettings(dir, paneId)
  removeGeminiHookSettings(dir, paneId)
}
