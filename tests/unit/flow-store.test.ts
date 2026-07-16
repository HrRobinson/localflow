import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:os'
import { FlowStore } from '../../src/main/flow-store'
import type { FlowGraph } from '../../src/shared/flows'

const graph = (id: string, name = 'flow'): FlowGraph => ({
  id,
  name,
  nodes: [
    {
      id: 't',
      type: 'trigger',
      integration: 'linear',
      ref: 'issue.created',
      config: {},
      position: { x: 1, y: 2 }
    },
    { id: 'a', type: 'agent', config: { agentId: 'claude' }, position: { x: 3, y: 4 } }
  ],
  edges: [{ id: 'e', from: 't', to: 'a' }]
})

describe('FlowStore', () => {
  let dir: string
  let store: FlowStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lf-flows-'))
    store = new FlowStore(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips a saved flow (nodes, edges, config, position)', () => {
    const res = store.saveFlow(graph('f1', 'Checkout'))
    expect(res.ok).toBe(true)
    const loaded = store.loadFlow('f1')
    expect(loaded).toEqual(graph('f1', 'Checkout'))
  })

  it('creates the flows dir on first save and writes one file per flow', () => {
    store.saveFlow(graph('f1'))
    store.saveFlow(graph('f2'))
    expect(existsSync(join(dir, 'f1.json'))).toBe(true)
    expect(existsSync(join(dir, 'f2.json'))).toBe(true)
  })

  it('lists saved flows as summaries with a node count', () => {
    store.saveFlow(graph('f1', 'One'))
    store.saveFlow(graph('f2', 'Two'))
    const summaries = store.listFlows()
    expect(summaries.map((s) => s.id).sort()).toEqual(['f1', 'f2'])
    expect(summaries.find((s) => s.id === 'f1')!.nodeCount).toBe(2)
    expect(summaries.find((s) => s.id === 'f1')!.name).toBe('One')
    expect(typeof summaries[0].updatedAt).toBe('number')
  })

  it('returns null loading an unknown flow', () => {
    expect(store.loadFlow('ghost')).toBeNull()
  })

  it('does not leave a .tmp file behind after an atomic save', () => {
    store.saveFlow(graph('f1'))
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('deletes a saved flow', () => {
    store.saveFlow(graph('f1'))
    store.deleteFlow('f1')
    expect(store.loadFlow('f1')).toBeNull()
    expect(store.listFlows()).toEqual([])
  })

  it('rejects a malformed graph at the save boundary rather than writing it', () => {
    const bad = {
      id: 'bad',
      name: 'x',
      nodes: [{ id: 'n', type: 'nope', config: {}, position: { x: 0, y: 0 } }],
      edges: []
    }
    const res = store.saveFlow(bad as unknown as FlowGraph)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/couldn't be saved|invalid|malformed/i)
    expect(existsSync(join(dir, 'bad.json'))).toBe(false)
  })

  it('rejects a graph whose edge references a missing node', () => {
    const bad = { id: 'b2', name: 'x', nodes: [], edges: [{ id: 'e', from: 'a', to: 'b' }] }
    const res = store.saveFlow(bad as unknown as FlowGraph)
    expect(res.ok).toBe(false)
    expect(existsSync(join(dir, 'b2.json'))).toBe(false)
  })

  it('backs up a corrupt flow file and reports a legible notice on load', () => {
    store.saveFlow(graph('f1'))
    writeFileSync(join(dir, 'f1.json'), '{{{garbage')
    const res = store.loadFlowSafe('f1')
    expect(res.graph).toBeNull()
    expect(res.error).toMatch(/couldn't be read/i)
    expect(res.error).toMatch(/backed up/i)
    expect(existsSync(join(dir, 'f1.json'))).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('f1.json.corrupt-'))).toBe(true)
  })

  it('leaves an unreadable file untouched (transient read error), not corrupt-flagged', () => {
    if (platform() === 'win32') return
    store.saveFlow(graph('f1'))
    const file = join(dir, 'f1.json')
    chmodSync(file, 0o000)
    try {
      const res = store.loadFlowSafe('f1')
      expect(res.graph).toBeNull()
      expect(res.error).toMatch(/couldn't be read/i)
      expect(existsSync(file)).toBe(true)
      expect(readdirSync(dir).some((f) => f.startsWith('f1.json.corrupt-'))).toBe(false)
    } finally {
      chmodSync(file, 0o600)
    }
  })

  it('reports a legible error (not a throw) when a save write fails', () => {
    if (platform() === 'win32') return
    chmodSync(dir, 0o500)
    try {
      const res = store.saveFlow(graph('f1'))
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toMatch(/couldn't save/i)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})
