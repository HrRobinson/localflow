import type { AgentId } from './types'

export interface AgentPreset {
  id: AgentId
  label: string
  bin: string
  /** Args appended when resuming a dead session in the same folder. */
  resumeArgs: string[]
  /**
   * Whether localflow injects status hooks for this agent. Only Claude Code
   * for now; Codex/Gemini adapters are planned (their hooks systems support it).
   */
  useHooks: boolean
}

export const AGENT_PRESETS: AgentPreset[] = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', resumeArgs: ['--continue'], useHooks: true },
  { id: 'codex', label: 'Codex', bin: 'codex', resumeArgs: ['resume', '--last'], useHooks: false },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    resumeArgs: ['--resume', 'latest'],
    useHooks: false
  }
]

export function presetFor(id: AgentId): AgentPreset | undefined {
  return AGENT_PRESETS.find((p) => p.id === id)
}
