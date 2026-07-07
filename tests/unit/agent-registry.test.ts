import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, loadAgentConfig, saveAgentConfig } from '../../src/main/agent-registry'

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
    expect(agents.map((a) => a.id)).toEqual(['claude', 'codex', 'gemini'])
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
