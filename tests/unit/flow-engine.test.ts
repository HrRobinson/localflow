import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowStore } from '../../src/main/flow-store'
import { makeFlowEngineStub } from '../../src/main/flow-engine'
import type { FlowGraph } from '../../src/shared/flows'

const runnable = (id: string): FlowGraph => ({
  id,
  name: 'runnable',
  nodes: [
    {
      id: 't',
      type: 'trigger',
      integration: 'linear',
      ref: 'issue.created',
      config: {},
      position: { x: 0, y: 0 }
    },
    { id: 'a', type: 'agent', config: {}, position: { x: 0, y: 0 } }
  ],
  edges: [{ id: 'e', from: 't', to: 'a' }]
})

describe('makeFlowEngineStub', () => {
  it('loads the saved graph, validates runnability, logs a summary, returns a run id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-eng-'))
    try {
      const store = new FlowStore(dir)
      store.saveFlow(runnable('f1'))
      const logs: string[] = []
      const engine = makeFlowEngineStub(store, (m) => logs.push(m))
      const res = engine.run('f1')
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.runId).toMatch(/^run-/)
      expect(logs.join('\n')).toMatch(/f1/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns a legible error for an unknown flow id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-eng-'))
    try {
      const engine = makeFlowEngineStub(new FlowStore(dir))
      const res = engine.run('ghost')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/couldn't be found|no longer exists/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to run a graph with no trigger, with an actionable error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-eng-'))
    try {
      const store = new FlowStore(dir)
      store.saveFlow({
        id: 'nt',
        name: 'no trigger',
        nodes: [{ id: 'a', type: 'agent', config: {}, position: { x: 0, y: 0 } }],
        edges: []
      })
      const engine = makeFlowEngineStub(store)
      const res = engine.run('nt')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/trigger/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
