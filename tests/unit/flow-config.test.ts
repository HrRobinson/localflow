import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFlowsConfig, loadFlowsConfig } from '../../src/main/flow/flow-config'

describe('parseFlowsConfig — validate at the boundary, off by default', () => {
  it('absent flows block → disabled (opt-in default)', () => {
    expect(parseFlowsConfig({})).toEqual({ enabled: false, environment: 1, maxConcurrentPanes: 2 })
    expect(parseFlowsConfig(null)).toEqual({ enabled: false, environment: 1, maxConcurrentPanes: 2 })
  })

  it('honors a well-typed flows block', () => {
    expect(parseFlowsConfig({ flows: { enabled: true, environment: 3, maxConcurrentPanes: 4 } })).toEqual({
      enabled: true,
      environment: 3,
      maxConcurrentPanes: 4
    })
  })

  it('only a literal true enables; garbage disables', () => {
    expect(parseFlowsConfig({ flows: { enabled: 'yes' } }).enabled).toBe(false)
    expect(parseFlowsConfig({ flows: 42 }).enabled).toBe(false)
  })

  it('rejects an out-of-range environment to 1 and floors concurrency at 1', () => {
    expect(parseFlowsConfig({ flows: { enabled: true, environment: 99 } }).environment).toBe(1)
    expect(parseFlowsConfig({ flows: { enabled: true, environment: 5 } }).environment).toBe(5)
    expect(parseFlowsConfig({ flows: { enabled: true, maxConcurrentPanes: 0 } }).maxConcurrentPanes).toBe(1)
  })

  it('loadFlowsConfig reads config.json fresh; a missing/broken file disables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-fc-'))
    const file = join(dir, 'config.json')
    expect(loadFlowsConfig(file).enabled).toBe(false)
    writeFileSync(file, JSON.stringify({ flows: { enabled: true, environment: 2 } }))
    expect(loadFlowsConfig(file)).toEqual({ enabled: true, environment: 2, maxConcurrentPanes: 2 })
    writeFileSync(file, '{ not json')
    expect(loadFlowsConfig(file).enabled).toBe(false)
  })
})
