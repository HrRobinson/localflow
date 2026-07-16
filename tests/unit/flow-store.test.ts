import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFlows, saveFlows } from '../../src/main/flow/flow-store'
import type { FlowGraph } from '../../src/shared/flows'

function validFlow(id: string): FlowGraph {
  return {
    id,
    name: `Flow ${id}`,
    nodes: [
      {
        id: 't',
        type: 'trigger',
        integration: 'email',
        ref: 'inbound',
        config: {},
        position: { x: 0, y: 0 }
      },
      { id: 'a', type: 'agent', ref: 'claude', config: {}, position: { x: 1, y: 0 } }
    ],
    edges: [{ id: 'e1', from: 't', to: 'a' }]
  }
}

describe('flow-store', () => {
  it('a missing flows.json loads empty with no notices (first run)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-fs-'))
    const res = loadFlows(join(dir, 'flows.json'))
    expect(res.flows).toEqual([])
    expect(res.notices).toEqual([])
  })

  it('round-trips valid flows through an atomic save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-fs-'))
    const file = join(dir, 'flows.json')
    const flows = [validFlow('one'), validFlow('two')]
    expect(saveFlows(file, flows)).toEqual({ ok: true })
    const res = loadFlows(file)
    expect(res.flows.map((f) => f.id)).toEqual(['one', 'two'])
    expect(res.notices).toEqual([])
  })

  it('disables an invalid flow with a loud, specific notice, keeping the valid ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-fs-'))
    const file = join(dir, 'flows.json')
    writeFileSync(
      file,
      JSON.stringify({
        flows: [
          validFlow('good'),
          { id: 'bad', name: 'Bad', nodes: [], edges: [{ id: 'e9', from: 't', to: 'ghost' }] }
        ]
      })
    )
    const res = loadFlows(file)
    expect(res.flows.map((f) => f.id)).toEqual(['good'])
    expect(res.notices).toHaveLength(1)
    expect(res.notices[0]).toMatch(/bad/i)
    expect(res.notices[0]).toMatch(/disabled/i)
  })

  it('a corrupt flows.json loads empty with a notice, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-fs-'))
    const file = join(dir, 'flows.json')
    writeFileSync(file, '{ not json at all')
    const res = loadFlows(file)
    expect(res.flows).toEqual([])
    expect(res.notices[0]).toMatch(/flows\.json/i)
  })

  it('save writes atomically (a .tmp is renamed, not left behind)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-fs-'))
    const file = join(dir, 'flows.json')
    saveFlows(file, [validFlow('one')])
    const written: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect((written as { flows: FlowGraph[] }).flows[0].id).toBe('one')
  })
})
