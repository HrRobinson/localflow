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

  it('defaults a fresh session to `chat`, so the picker opens a working TUI', () => {
    const p = presetFor('openclaw')
    expect(p!.startArgs).toEqual(['chat'])
  })
})

describe('startArgs is opt-in per preset', () => {
  it('every preset other than openclaw has no startArgs', () => {
    for (const preset of AGENT_PRESETS) {
      if (preset.id === 'openclaw') continue
      expect(preset.startArgs).toBeUndefined()
    }
  })
})

describe('shell preset', () => {
  it('is a registered preset with no hook adapter or resume args', () => {
    const p = presetFor('shell')
    expect(p).toBeDefined()
    expect(p!.label).toBe('Shell')
    expect(p!.hookAdapter).toBe('none')
    expect(p!.resumeArgs).toEqual([])
    expect(AGENT_PRESETS.some((x) => x.id === 'shell')).toBe(true)
  })
})
