import { describe, it, expect } from 'vitest'
import { applyTypedPathResult } from '../../src/renderer/src/components/settingsLogic'
import type { AgentInfo } from '../../src/shared/types'

const agents: AgentInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    resolvedPath: '/usr/local/bin/claude',
    hasStatusFeed: true,
    statusFidelity: 'full',
    isDefault: true,
    extraArgs: '',
    env: {}
  }
]

describe('applyTypedPathResult', () => {
  it('surfaces the rejection reason and does not clear the draft — finding: previously silent', () => {
    const result = applyTypedPathResult({
      ok: false,
      reason: "That isn't a valid absolute path — use /… or ~/… (another user's ~ isn't supported)."
    })
    expect(result.error).toBe(
      "That isn't a valid absolute path — use /… or ~/… (another user's ~ isn't supported)."
    )
    expect(result.clearDraft).toBe(false)
    expect(result.agents).toBeNull()
  })

  it('applies the refreshed agent list and clears the draft on success', () => {
    const result = applyTypedPathResult({ ok: true, agents })
    expect(result.agents).toBe(agents)
    expect(result.error).toBeNull()
    expect(result.clearDraft).toBe(true)
  })

  it('treats a null result (malformed call) as a no-op, not a rejection', () => {
    const result = applyTypedPathResult(null)
    expect(result).toEqual({ agents: null, error: null, clearDraft: false })
  })
})
