import type { AgentId } from './types'

export type HookAdapterKind =
  'settings-file' | 'env-settings-file' | 'cli-args-full' | 'cli-args-notify' | 'none'

export function hasHookAdapter(kind: HookAdapterKind): boolean {
  return kind !== 'none'
}

export interface AgentPreset {
  id: AgentId
  label: string
  bin: string
  /** Args appended when resuming a dead session in the same folder. */
  resumeArgs: string[]
  /**
   * Which hook-injection mechanism/tier localflow uses for this agent's
   * status feed. 'cli-args-notify' (not the optimistic 'cli-args-full')
   * is Codex's shipped default — see
   * docs/superpowers/specs/2026-07-07-m2-status-adapters-design.md for
   * why the degraded tier is the safer default until manually verified.
   */
  hookAdapter: HookAdapterKind
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    resumeArgs: ['--continue'],
    hookAdapter: 'settings-file'
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    resumeArgs: ['resume', '--last'],
    hookAdapter: 'cli-args-notify'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    resumeArgs: ['--resume', 'latest'],
    hookAdapter: 'env-settings-file'
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    bin: 'openclaw',
    resumeArgs: [],
    hookAdapter: 'none'
  },
  {
    id: 'shell',
    label: 'Shell',
    // Unused: the user's login shell always exists, so there's no fixed
    // binary name to fall back on here. AgentRegistry.commandFor resolves
    // the real command (process.env.SHELL, falling back to /bin/zsh) —
    // this stays env-free because src/shared is imported by the renderer.
    bin: '',
    resumeArgs: [],
    hookAdapter: 'none'
  }
]

export function presetFor(id: AgentId): AgentPreset | undefined {
  return AGENT_PRESETS.find((p) => p.id === id)
}
