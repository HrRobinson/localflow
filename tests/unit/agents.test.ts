import { describe, it, expect } from 'vitest'
import { AGENT_PRESETS, presetFor } from '../../src/shared/agents'

describe('openclaw preset', () => {
  it('is a registered preset with no hook adapter', () => {
    const p = presetFor('openclaw')
    expect(p).toBeDefined()
    expect(p!.bin).toBe('openclaw')
    expect(p!.hookAdapter).toBe('none')
    expect(AGENT_PRESETS.some((x) => x.id === 'openclaw')).toBe(true)
  })
})
