import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AgentId, AgentInfo, AgentOverride, LastAgent } from '../shared/types'
type StatusFidelity = AgentInfo['statusFidelity']
import {
  AGENT_PRESETS,
  presetFor,
  hasHookAdapter,
  type AgentPreset,
  type HookAdapterKind
} from '../shared/agents'
import { splitArgs } from '../shared/args'
import { RESERVED_ENV_KEYS } from './hook-adapter'
import { DEFAULT_CONSOLE_PREFS, type ConsolePrefs, type ConsoleSource } from '../shared/console'
import type { ConsoleScope } from '../shared/console-filter'

export interface AgentConfig {
  /** User-configured absolute paths per agent, overriding PATH lookup. */
  agentPaths: Partial<Record<AgentId, string>>
  lastAgent?: LastAgent
  /** Default agent for the New session launcher (M4). */
  defaultAgent?: AgentId
  /** Per-agent extra args + env overrides, composed into SpawnSpec (M4). */
  agents?: Partial<Record<AgentId, AgentOverride>>
  /** Selected theme name; resolved against userData/themes (M4). */
  theme?: string
  /** Bottom console drawer prefs: height, open state, last filter (M6). */
  console?: ConsolePrefs
  /** Enabled command-guard packs, applied globally (lfguard G2). */
  guard?: { packs: string[] }
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

const KNOWN_AGENT_IDS: AgentId[] = ['claude', 'codex', 'gemini', 'openclaw', 'shell', 'custom']

function parseAgentOverride(raw: unknown): AgentOverride | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: AgentOverride = {}
  const extraArgs = (raw as { extraArgs?: unknown }).extraArgs
  if (typeof extraArgs === 'string' && extraArgs.trim().length > 0) out.extraArgs = extraArgs
  const env = (raw as { env?: unknown }).env
  if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      if (k.length > 0 && typeof v === 'string') cleaned[k] = v
    }
    if (Object.keys(cleaned).length > 0) out.env = cleaned
  }
  return out.extraArgs || out.env ? out : null
}

function parseAgents(raw: unknown): AgentConfig['agents'] | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Partial<Record<AgentId, AgentOverride>> = {}
  for (const id of KNOWN_AGENT_IDS) {
    const override = parseAgentOverride((raw as Record<string, unknown>)[id])
    if (override) out[id] = override
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const CONSOLE_SOURCES: ConsoleSource[] = ['status', 'operator', 'capture', 'guard', 'network']

function parseConsoleScope(raw: unknown): 'auto' | ConsoleScope {
  if (raw === 'auto') return 'auto'
  if (typeof raw === 'object' && raw !== null) {
    const kind = (raw as { kind?: unknown }).kind
    if (kind === 'everywhere') return { kind: 'everywhere' }
    const env = (raw as { environment?: unknown }).environment
    if (kind === 'environment' && typeof env === 'number')
      return { kind: 'environment', environment: env }
    const sid = (raw as { sessionId?: unknown }).sessionId
    if (kind === 'session' && typeof sid === 'string') return { kind: 'session', sessionId: sid }
  }
  return 'auto'
}

/** Validates the console-prefs shape at the config-file boundary; null on any malformed field. */
function parseConsolePrefs(raw: unknown): ConsolePrefs | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const height = (raw as { height?: unknown }).height
  const open = (raw as { open?: unknown }).open
  const sources = (raw as { sources?: unknown }).sources
  const text = (raw as { text?: unknown }).text
  if (typeof height !== 'number' || !Number.isFinite(height)) return null
  if (typeof open !== 'boolean') return null
  if (!Array.isArray(sources) || !sources.every((s) => CONSOLE_SOURCES.includes(s))) return null
  if (typeof text !== 'string') return null
  return {
    height,
    open,
    sources: sources as ConsoleSource[],
    text,
    scope: parseConsoleScope((raw as { scope?: unknown }).scope),
    muted: parseMutedSources((raw as { muted?: unknown }).muted)
  }
}

function parseMutedSources(raw: unknown): ConsoleSource[] {
  return Array.isArray(raw)
    ? raw.filter((s): s is ConsoleSource => CONSOLE_SOURCES.includes(s as ConsoleSource))
    : []
}

/** Validates the guard-config shape at the config-file boundary; defaults to empty on any malformed field. */
function parseGuardConfig(raw: unknown): { packs: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { packs: [] }
  const packs = (raw as { packs?: unknown }).packs
  if (!Array.isArray(packs) || !packs.every((p) => typeof p === 'string')) return { packs: [] }
  return { packs: packs as string[] }
}

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'agentPaths',
  'lastAgent',
  'defaultAgent',
  'agents',
  'theme',
  'console',
  'guard'
])

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
    const defaultAgent = obj.defaultAgent
    if (typeof defaultAgent === 'string' && KNOWN_AGENT_IDS.includes(defaultAgent as AgentId)) {
      config.defaultAgent = defaultAgent as AgentId
    }
    const agents = parseAgents(obj.agents)
    if (agents) config.agents = agents
    if (typeof obj.theme === 'string' && obj.theme.trim().length > 0) config.theme = obj.theme
    if (obj.console !== undefined) {
      config.console = parseConsolePrefs(obj.console) ?? DEFAULT_CONSOLE_PREFS
    }
    if (obj.guard !== undefined) config.guard = parseGuardConfig(obj.guard)
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

/** Narrow shape of the error execFile hands its callback — enough to tell a
 * timed-out probe from a shell that genuinely couldn't find the binary.
 * Aliased directly to node's own ExecFileException so the locally-defined
 * shape never drifts from what execFile actually produces. */
type WhichExecError = ExecFileException | null

/** Injectable in place of node:child_process's execFile so tests can force
 * each failure mode deterministically instead of depending on the host's
 * actual shell/PATH. */
export type WhichExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number },
  cb: (err: WhichExecError, stdout: string) => void
) => void

const defaultWhichExec: WhichExecFn = (file, args, opts, cb) =>
  execFile(file, args, opts, (err, stdout) => cb(err, stdout))

/**
 * Explains why a login-shell PATH probe failed, so the failure isn't a bare
 * undifferentiated "not found" — see the project's Mac PATH-gap issue: a
 * hung/broken shell profile and a genuinely-missing binary need different
 * fixes from the user.
 */
export function describeWhichFailure(err: NonNullable<WhichExecError>, shell: string): string {
  if (err.killed) return `login shell (${shell}) timed out after 5s — check its startup files`
  if (err.code === 'ENOENT') return `login shell '${shell}' does not exist`
  return `not on PATH via ${shell} (${err.message})`
}

/**
 * Resolve a command via the user's login shell, because a GUI app on macOS
 * does not inherit the terminal PATH (nvm, homebrew, ~/.local/bin, ...).
 * On failure, logs *why* the probe came back empty (timeout, missing shell,
 * or a genuine PATH miss) so a broken profile doesn't look identical to an
 * uninstalled binary in the main-process log.
 */
export function whichViaLoginShell(
  bin: string,
  execFn: WhichExecFn = defaultWhichExec
): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env['SHELL'] ?? '/bin/zsh'
    execFn(shell, ['-ilc', `command -v ${bin}`], { timeout: 5000 }, (err, stdout) => {
      const found = stdout.trim().split('\n').pop() ?? ''
      if (!err && found.startsWith('/')) {
        resolve(found)
        return
      }
      if (err)
        console.warn(
          `agent-registry: PATH probe for '${bin}' failed — ${describeWhichFailure(err, shell)}`
        )
      resolve(null)
    })
  })
}

/**
 * Maps a preset's hook-injection mechanism to how much of the
 * {working, needs-you, done} status feed it actually reports — 'full'
 * and 'env-settings-file' adapters distinguish all three states;
 * 'cli-args-full' (Codex's unshipped, unverified-grammar tier) would
 * too, if/when the manual verification checklist clears it; Codex's
 * shipped 'cli-args-notify' tier only ever reports a turn-complete
 * signal, never a wrong-but-confident 'working'/'needs-you'.
 */
function statusFidelityFor(kind: HookAdapterKind): StatusFidelity {
  switch (kind) {
    case 'settings-file':
    case 'env-settings-file':
    case 'cli-args-full':
      return 'full'
    case 'cli-args-notify':
      return 'done-only'
    case 'none':
      return 'none'
  }
}

export class AgentRegistry {
  private config: AgentConfig
  private resolved = new Map<AgentId, string | null>()

  constructor(
    private configFile: string,
    private whichFn: (bin: string) => Promise<string | null> = whichViaLoginShell,
    /** Env override used by tests/e2e: forces the claude preset's command. */
    private claudeBinOverride?: string,
    /** Env override used by tests/e2e: forces the openclaw preset's command. */
    private openclawBinOverride?: string
  ) {
    this.config = loadAgentConfig(configFile)
  }

  /** The command to spawn for an agent (does not check existence). */
  commandFor(agentId: AgentId, customCommand?: string): string {
    if (agentId === 'custom') return customCommand ?? ''
    if (agentId === 'claude' && this.claudeBinOverride) return this.claudeBinOverride
    if (agentId === 'openclaw' && this.openclawBinOverride) return this.openclawBinOverride
    // Shell has no fixed binary name to resolve via PATH — it's always the
    // user's own login shell. Resolve it here (main-side) rather than in the
    // preset table, which src/shared/agents.ts keeps env-free because the
    // renderer imports it too.
    if (agentId === 'shell') {
      return this.config.agentPaths[agentId] ?? process.env['SHELL'] ?? '/bin/zsh'
    }
    return this.config.agentPaths[agentId] ?? presetFor(agentId)?.bin ?? ''
  }

  argsFor(agentId: AgentId, resume: boolean): string[] {
    if (!resume) return presetFor(agentId)?.startArgs ?? []
    return presetFor(agentId)?.resumeArgs ?? []
  }

  hookAdapter(agentId: AgentId): HookAdapterKind {
    return presetFor(agentId)?.hookAdapter ?? 'none'
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

  getDefaultAgent(): AgentId | null {
    return this.config.defaultAgent ?? null
  }

  setDefaultAgent(agentId: AgentId): void {
    this.config.defaultAgent = agentId
    saveAgentConfig(this.configFile, this.config)
  }

  getAgentOverride(agentId: AgentId): AgentOverride {
    return this.config.agents?.[agentId] ?? {}
  }

  /**
   * Persists a per-agent override. Env keys owned by the hook injection
   * (RESERVED_ENV_KEYS) are rejected before anything is written — user env
   * overrides win last in the spawn merge, so letting one through would
   * silently kill that agent's status feed.
   */
  setAgentOverride(
    agentId: AgentId,
    override: AgentOverride
  ): { ok: true } | { ok: false; reserved: string[] } {
    const reserved = Object.keys(override.env ?? {}).filter((k) => RESERVED_ENV_KEYS.includes(k))
    if (reserved.length > 0) return { ok: false, reserved }
    const cleaned = parseAgentOverride(override)
    const agents = { ...this.config.agents }
    if (cleaned) agents[agentId] = cleaned
    else delete agents[agentId]
    this.config.agents = Object.keys(agents).length > 0 ? agents : undefined
    saveAgentConfig(this.configFile, this.config)
    return { ok: true }
  }

  /** Shell-split extra args for spawn composition (empty when unset). */
  extraArgsFor(agentId: AgentId): string[] {
    return splitArgs(this.config.agents?.[agentId]?.extraArgs ?? '')
  }

  /** Env overrides for spawn composition (empty when unset). */
  envFor(agentId: AgentId): Record<string, string> {
    return { ...(this.config.agents?.[agentId]?.env ?? {}) }
  }

  getTheme(): string | null {
    return this.config.theme ?? null
  }

  setTheme(name: string): void {
    this.config.theme = name
    saveAgentConfig(this.configFile, this.config)
  }

  getConsolePrefs(): ConsolePrefs {
    return this.config.console ?? DEFAULT_CONSOLE_PREFS
  }

  setConsolePrefs(prefs: ConsolePrefs): void {
    this.config.console = parseConsolePrefs(prefs) ?? DEFAULT_CONSOLE_PREFS
    saveAgentConfig(this.configFile, this.config)
  }

  getGuardPacks(): string[] {
    return this.config.guard?.packs ?? []
  }

  setGuardPacks(packs: string[]): void {
    this.config.guard = parseGuardConfig({ packs })
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
        hasStatusFeed: hasHookAdapter(preset.hookAdapter),
        statusFidelity: statusFidelityFor(preset.hookAdapter),
        isDefault: this.config.defaultAgent === preset.id,
        extraArgs: this.config.agents?.[preset.id]?.extraArgs ?? '',
        env: this.config.agents?.[preset.id]?.env ?? {}
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
