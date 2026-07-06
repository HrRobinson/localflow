import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
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

  it('claude env override wins and only claude uses hooks', () => {
    const reg = new AgentRegistry(tmpConfig(), async () => null, '/tmp/fake-claude.sh')
    expect(reg.commandFor('claude')).toBe('/tmp/fake-claude.sh')
    expect(reg.useHooks('claude')).toBe(true)
    expect(reg.useHooks('codex')).toBe(false)
    expect(reg.useHooks('custom')).toBe(false)
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

    reg.setPath('codex', '/somewhere/codex')
    expect(loadAgentConfig(file).agentPaths.codex).toBe('/somewhere/codex')
  })
})
