import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AgentId, AgentInfo, LastAgent } from '../shared/types'
import { AGENT_PRESETS, presetFor, type AgentPreset } from '../shared/agents'

export interface AgentConfig {
  /** User-configured absolute paths per agent, overriding PATH lookup. */
  agentPaths: Partial<Record<AgentId, string>>
  lastAgent?: LastAgent
  /**
   * Unknown top-level keys found in config.json, preserved verbatim so
   * hand-added config-as-code entries survive a save round-trip.
   */
  extra?: Record<string, unknown>
}

function parseLastAgent(raw: unknown): LastAgent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const agentId = (raw as { agentId?: unknown }).agentId
  const isKnown = agentId === 'custom' || AGENT_PRESETS.some((p) => p.id === agentId)
  if (typeof agentId !== 'string' || !isKnown) return null
  if (agentId === 'custom') {
    const cmd = (raw as { customCommand?: unknown }).customCommand
    return typeof cmd === 'string' && cmd.trim().length > 0
      ? { agentId: 'custom', customCommand: cmd }
      : null
  }
  return { agentId: agentId as AgentId }
}

const KNOWN_TOP_LEVEL_KEYS = new Set(['agentPaths', 'lastAgent'])

export function loadAgentConfig(file: string): AgentConfig {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof data !== 'object' || data === null) return { agentPaths: {} }
    const obj = data as Record<string, unknown>
    const paths = obj.agentPaths
    const agentPaths: AgentConfig['agentPaths'] = {}
    if (typeof paths === 'object' && paths !== null) {
      for (const preset of AGENT_PRESETS) {
        const value = (paths as Record<string, unknown>)[preset.id]
        if (typeof value === 'string' && value.length > 0) agentPaths[preset.id] = value
      }
    }
    const config: AgentConfig = { agentPaths }
    const lastAgent = parseLastAgent(obj.lastAgent)
    if (lastAgent !== null) {
      config.lastAgent = lastAgent
    }
    // Preserve any hand-added top-level keys (config-as-code) so they
    // survive a later saveAgentConfig call untouched.
    const extra: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      if (!KNOWN_TOP_LEVEL_KEYS.has(key)) extra[key] = obj[key]
    }
    if (Object.keys(extra).length > 0) {
      config.extra = extra
    }
    return config
  } catch {
    return { agentPaths: {} }
  }
}

export function saveAgentConfig(file: string, config: AgentConfig): void {
  // Unknown keys go first so the known, typed fields always win on conflict.
  const { extra, ...known } = config
  const out = { ...extra, ...known }
  writeFileSync(file, JSON.stringify(out, null, 2))
}

/**
 * Resolve a command via the user's login shell, because a GUI app on macOS
 * does not inherit the terminal PATH (nvm, homebrew, ~/.local/bin, ...).
 */
export function whichViaLoginShell(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.env['SHELL'] ?? '/bin/zsh',
      ['-ilc', `command -v ${bin}`],
      { timeout: 5000 },
      (err, stdout) => {
        const found = stdout.trim().split('\n').pop() ?? ''
        resolve(!err && found.startsWith('/') ? found : null)
      }
    )
  })
}

export class AgentRegistry {
  private config: AgentConfig
  private resolved = new Map<AgentId, string | null>()

  constructor(
    private configFile: string,
    private whichFn: (bin: string) => Promise<string | null> = whichViaLoginShell,
    /** Env override used by tests/e2e: forces the claude preset's command. */
    private claudeBinOverride?: string
  ) {
    this.config = loadAgentConfig(configFile)
  }

  /** The command to spawn for an agent (does not check existence). */
  commandFor(agentId: AgentId, customCommand?: string): string {
    if (agentId === 'custom') return customCommand ?? ''
    if (agentId === 'claude' && this.claudeBinOverride) return this.claudeBinOverride
    return this.config.agentPaths[agentId] ?? presetFor(agentId)?.bin ?? ''
  }

  argsFor(agentId: AgentId, resume: boolean): string[] {
    if (!resume) return []
    return presetFor(agentId)?.resumeArgs ?? []
  }

  useHooks(agentId: AgentId): boolean {
    return presetFor(agentId)?.useHooks ?? false
  }

  setPath(agentId: AgentId, path: string): void {
    if (agentId === 'custom') return
    this.config.agentPaths[agentId] = path
    saveAgentConfig(this.configFile, this.config)
    this.resolved.delete(agentId)
  }

  getLastAgent(): LastAgent | null {
    return this.config.lastAgent ?? null
  }

  recordLastAgent(agentId: AgentId, customCommand?: string): void {
    this.config.lastAgent =
      agentId === 'custom' ? { agentId, customCommand: customCommand ?? '' } : { agentId }
    saveAgentConfig(this.configFile, this.config)
  }

  async list(): Promise<AgentInfo[]> {
    const infos: AgentInfo[] = []
    for (const preset of AGENT_PRESETS) {
      const command = this.commandFor(preset.id)
      infos.push({
        id: preset.id,
        label: preset.label,
        command,
        resolvedPath: await this.resolve(preset, command),
        hasStatusFeed: preset.useHooks
      })
    }
    return infos
  }

  private async resolve(preset: AgentPreset, command: string): Promise<string | null> {
    if (command.startsWith('/')) return existsSync(command) ? command : null
    if (!this.resolved.has(preset.id)) {
      this.resolved.set(preset.id, await this.whichFn(command))
    }
    return this.resolved.get(preset.id) ?? null
  }
}
