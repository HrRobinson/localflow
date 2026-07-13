import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, loadAgentConfig, saveAgentConfig } from '../../src/main/agent-registry'
import { RESERVED_ENV_KEYS } from '../../src/main/hook-adapter'

function tmpConfig(): string {
  return join(mkdtempSync(join(tmpdir(), 'localflow-ar-')), 'config.json')
}

describe('agent config persistence', () => {
  it('round-trips agent paths and tolerates missing/corrupt files', () => {
    const file = tmpConfig()
    expect(loadAgentConfig(file)).toEqual({ agentPaths: {} })
    saveAgentConfig(file, { agentPaths: { codex: '/opt/bin/codex' } })
    expect(loadAgentConfig(file)).toEqual({ agentPaths: { codex: '/opt/bin/codex' } })
  })

  it('drops unknown or non-string entries', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: { claude: '/a/claude', evil: 123, gemini: '' } as never
    })
    expect(loadAgentConfig(file)).toEqual({ agentPaths: { claude: '/a/claude' } })
  })

  it('round-trips lastAgent for preset id', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: { codex: '/opt/bin/codex' },
      lastAgent: { agentId: 'claude' }
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: { codex: '/opt/bin/codex' },
      lastAgent: { agentId: 'claude' }
    })
  })

  it('round-trips lastAgent for custom with customCommand', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: {},
      lastAgent: { agentId: 'custom', customCommand: 'aider' }
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: {},
      lastAgent: { agentId: 'custom', customCommand: 'aider' }
    })
  })

  it('drops malformed lastAgent while preserving agentPaths', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: { gemini: '/opt/gemini' },
      lastAgent: {} as never
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: { gemini: '/opt/gemini' }
    })
  })

  it('drops lastAgent with unknown agentId', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: { claude: '/opt/claude' },
      lastAgent: { agentId: 'gpt4' } as never
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: { claude: '/opt/claude' }
    })
  })

  it('drops lastAgent as non-object', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: { codex: '/opt/codex' },
      lastAgent: 'claude' as never
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: { codex: '/opt/codex' }
    })

    saveAgentConfig(file, {
      agentPaths: { codex: '/opt/codex' },
      lastAgent: 42 as never
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: { codex: '/opt/codex' }
    })

    saveAgentConfig(file, {
      agentPaths: { codex: '/opt/codex' },
      lastAgent: null as never
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: { codex: '/opt/codex' }
    })
  })

  it('drops custom lastAgent with missing customCommand', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: {},
      lastAgent: { agentId: 'custom' } as never
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: {}
    })
  })

  it('drops custom lastAgent with empty customCommand', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: {},
      lastAgent: { agentId: 'custom', customCommand: '' }
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: {}
    })

    saveAgentConfig(file, {
      agentPaths: {},
      lastAgent: { agentId: 'custom', customCommand: '   ' }
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: {}
    })
  })

  it('preserves unknown top-level keys across a save round-trip', () => {
    const file = tmpConfig()
    writeFileSync(
      file,
      JSON.stringify({ myCustomKey: { a: 1 }, agentPaths: { codex: '/opt/bin/codex' } })
    )
    const config = loadAgentConfig(file)
    expect(config.agentPaths).toEqual({ codex: '/opt/bin/codex' })
    saveAgentConfig(file, {
      ...config,
      agentPaths: { ...config.agentPaths, gemini: '/opt/gemini' }
    })
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.myCustomKey).toEqual({ a: 1 })
    expect(onDisk.agentPaths).toEqual({ codex: '/opt/bin/codex', gemini: '/opt/gemini' })
  })
})

describe('AgentRegistry', () => {
  it('resolves commands with config override > preset default', () => {
    const file = tmpConfig()
    saveAgentConfig(file, { agentPaths: { codex: '/custom/codex' } })
    const reg = new AgentRegistry(file, async () => null)
    expect(reg.commandFor('codex')).toBe('/custom/codex')
    expect(reg.commandFor('gemini')).toBe('gemini')
    expect(reg.commandFor('custom', 'aider')).toBe('aider')
  })

  it('claude env override wins and each agent gets its preset hook adapter', () => {
    const reg = new AgentRegistry(tmpConfig(), async () => null, '/tmp/fake-claude.sh')
    expect(reg.commandFor('claude')).toBe('/tmp/fake-claude.sh')
    expect(reg.hookAdapter('claude')).toBe('settings-file')
    expect(reg.hookAdapter('codex')).toBe('cli-args-notify')
    expect(reg.hookAdapter('gemini')).toBe('env-settings-file')
    expect(reg.hookAdapter('custom')).toBe('none')
  })

  it('shell resolves the user SHELL, falling back to /bin/zsh, and carries no hook adapter', () => {
    const reg = new AgentRegistry(tmpConfig(), async () => null)
    const command = reg.commandFor('shell')
    expect(command.length).toBeGreaterThan(0)
    expect(command).toBe(process.env['SHELL'] || '/bin/zsh')
    expect(reg.hookAdapter('shell')).toBe('none')
  })

  it('resume args are agent-specific', () => {
    const reg = new AgentRegistry(tmpConfig(), async () => null)
    expect(reg.argsFor('claude', true)).toEqual(['--continue'])
    expect(reg.argsFor('codex', true)).toEqual(['resume', '--last'])
    expect(reg.argsFor('gemini', true)).toEqual(['--resume', 'latest'])
    expect(reg.argsFor('custom', true)).toEqual([])
    expect(reg.argsFor('claude', false)).toEqual([])
  })

  it('list reports detection via the injected which fn and setPath persists', async () => {
    const file = tmpConfig()
    const reg = new AgentRegistry(file, async (bin) => (bin === 'claude' ? '/found/claude' : null))
    const agents = await reg.list()
    expect(agents.map((a) => a.id)).toEqual(['claude', 'codex', 'gemini', 'openclaw', 'shell'])
    expect(agents.find((a) => a.id === 'claude')?.resolvedPath).toBe('/found/claude')
    expect(agents.find((a) => a.id === 'codex')?.resolvedPath).toBeNull()
    expect(agents.find((a) => a.id === 'claude')?.hasStatusFeed).toBe(true)
    expect(agents.find((a) => a.id === 'codex')?.hasStatusFeed).toBe(true)
    // Claude/Gemini distinguish all three states; Codex's shipped
    // cli-args-notify tier only ever reports a turn-complete signal —
    // the UI must never claim more fidelity than the adapter delivers.
    expect(agents.find((a) => a.id === 'claude')?.statusFidelity).toBe('full')
    expect(agents.find((a) => a.id === 'codex')?.statusFidelity).toBe('done-only')
    expect(agents.find((a) => a.id === 'gemini')?.statusFidelity).toBe('full')
    expect(agents.find((a) => a.id === 'openclaw')?.statusFidelity).toBe('none')
    expect(agents.find((a) => a.id === 'shell')?.statusFidelity).toBe('none')
    // The shell command resolves to an absolute path (SHELL env or the
    // /bin/zsh fallback) at construction time, so it's launchable without
    // going through the injected which fn (which this test forces to null).
    expect(agents.find((a) => a.id === 'shell')?.resolvedPath).not.toBeNull()

    reg.setPath('codex', '/somewhere/codex')
    expect(loadAgentConfig(file).agentPaths.codex).toBe('/somewhere/codex')
  })

  it('getLastAgent returns null on fresh config', () => {
    const file = tmpConfig()
    const reg = new AgentRegistry(file, async () => null)
    expect(reg.getLastAgent()).toBeNull()
  })

  it('recordLastAgent and getLastAgent round-trip preset id', () => {
    const file = tmpConfig()
    const reg = new AgentRegistry(file, async () => null)
    reg.recordLastAgent('codex')
    expect(reg.getLastAgent()).toEqual({ agentId: 'codex' })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: {},
      lastAgent: { agentId: 'codex' }
    })
  })

  it('recordLastAgent and getLastAgent round-trip custom with customCommand', () => {
    const file = tmpConfig()
    const reg = new AgentRegistry(file, async () => null)
    reg.recordLastAgent('custom', 'aider')
    expect(reg.getLastAgent()).toEqual({ agentId: 'custom', customCommand: 'aider' })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: {},
      lastAgent: { agentId: 'custom', customCommand: 'aider' }
    })
  })

  it('preserves a hand-added unknown key across setPath and recordLastAgent', () => {
    const file = tmpConfig()
    writeFileSync(
      file,
      JSON.stringify({ myCustomKey: { a: 1 }, agentPaths: { codex: '/opt/bin/codex' } })
    )
    const reg = new AgentRegistry(file, async () => null)

    reg.setPath('gemini', '/opt/gemini')
    expect(JSON.parse(readFileSync(file, 'utf8')).myCustomKey).toEqual({ a: 1 })

    reg.recordLastAgent('codex')
    expect(JSON.parse(readFileSync(file, 'utf8')).myCustomKey).toEqual({ a: 1 })
  })
})

describe('M4 config: defaultAgent, per-agent overrides, theme', () => {
  it('round-trips defaultAgent, agents overrides, and theme', () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: {},
      defaultAgent: 'gemini',
      agents: { claude: { extraArgs: '--model opus', env: { ANTHROPIC_BASE_URL: 'http://x' } } },
      theme: 'nord'
    })
    expect(loadAgentConfig(file)).toEqual({
      agentPaths: {},
      defaultAgent: 'gemini',
      agents: { claude: { extraArgs: '--model opus', env: { ANTHROPIC_BASE_URL: 'http://x' } } },
      theme: 'nord'
    })
  })

  it('keeps a hand-added environments map on extra alongside the new keys', () => {
    const file = tmpConfig()
    writeFileSync(
      file,
      JSON.stringify({ environments: { '3': 'backend' }, defaultAgent: 'claude', agentPaths: {} })
    )
    const config = loadAgentConfig(file)
    expect(config.defaultAgent).toBe('claude')
    expect(config.extra).toEqual({ environments: { '3': 'backend' } })
    saveAgentConfig(file, config)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.environments).toEqual({ '3': 'backend' })
    expect(onDisk.defaultAgent).toBe('claude')
  })

  it('drops a malformed defaultAgent and malformed agents entries', () => {
    const file = tmpConfig()
    writeFileSync(
      file,
      JSON.stringify({
        agentPaths: {},
        defaultAgent: 'gpt5',
        agents: { claude: { extraArgs: 42 }, bogus: { extraArgs: '--x' } }
      })
    )
    const config = loadAgentConfig(file)
    expect(config.defaultAgent).toBeUndefined()
    expect(config.agents).toBeUndefined()
  })

  it('composes extraArgs (split) and env, and flags the default in list()', async () => {
    const file = tmpConfig()
    saveAgentConfig(file, {
      agentPaths: {},
      defaultAgent: 'claude',
      agents: { gemini: { extraArgs: '--foo "a b"', env: { OLLAMA_HOST: 'http://127.0.0.1' } } }
    })
    const reg = new AgentRegistry(file, async () => null)
    expect(reg.getDefaultAgent()).toBe('claude')
    expect(reg.extraArgsFor('gemini')).toEqual(['--foo', 'a b'])
    expect(reg.envFor('gemini')).toEqual({ OLLAMA_HOST: 'http://127.0.0.1' })
    expect(reg.extraArgsFor('claude')).toEqual([])
    expect(reg.envFor('claude')).toEqual({})
    const agents = await reg.list()
    expect(agents.find((a) => a.id === 'claude')?.isDefault).toBe(true)
    expect(agents.find((a) => a.id === 'gemini')?.isDefault).toBe(false)
    expect(agents.find((a) => a.id === 'gemini')?.extraArgs).toBe('--foo "a b"')
    expect(agents.find((a) => a.id === 'gemini')?.env).toEqual({ OLLAMA_HOST: 'http://127.0.0.1' })
  })

  it('setDefaultAgent and setAgentOverride persist and preserve unknown keys', () => {
    const file = tmpConfig()
    writeFileSync(file, JSON.stringify({ environments: { '1': 'web' }, agentPaths: {} }))
    const reg = new AgentRegistry(file, async () => null)
    reg.setDefaultAgent('codex')
    reg.setAgentOverride('codex', { extraArgs: '--sandbox', env: { KEY: 'v' } })
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk.defaultAgent).toBe('codex')
    expect(onDisk.agents.codex).toEqual({ extraArgs: '--sandbox', env: { KEY: 'v' } })
    expect(onDisk.environments).toEqual({ '1': 'web' })
  })

  it('rejects an override with a reserved env key; memory and disk unchanged', () => {
    const file = tmpConfig()
    const reg = new AgentRegistry(file, async () => null)
    expect(reg.setAgentOverride('gemini', { extraArgs: '--keep', env: { SAFE: '1' } })).toEqual({
      ok: true
    })
    const before = readFileSync(file, 'utf8')
    // The single source of reserved names is the hook-adapter export — no
    // string duplication here beyond building the fixture from it.
    const reservedKey = RESERVED_ENV_KEYS[0]
    const result = reg.setAgentOverride('gemini', {
      env: { [reservedKey]: '/tmp/hijack', SAFE: '2' }
    })
    expect(result).toEqual({ ok: false, reserved: [reservedKey] })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(reg.getAgentOverride('gemini')).toEqual({ extraArgs: '--keep', env: { SAFE: '1' } })
  })

  it('non-reserved env keys still save and report ok', () => {
    const file = tmpConfig()
    const reg = new AgentRegistry(file, async () => null)
    const result = reg.setAgentOverride('codex', { env: { OLLAMA_HOST: 'http://127.0.0.1' } })
    expect(result).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(file, 'utf8')).agents.codex).toEqual({
      env: { OLLAMA_HOST: 'http://127.0.0.1' }
    })
  })

  it('setTheme / getTheme round-trip', () => {
    const file = tmpConfig()
    const reg = new AgentRegistry(file, async () => null)
    expect(reg.getTheme()).toBeNull()
    reg.setTheme('light')
    expect(reg.getTheme()).toBe('light')
    expect(JSON.parse(readFileSync(file, 'utf8')).theme).toBe('light')
  })
})
