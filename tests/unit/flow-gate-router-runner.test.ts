import { describe, it, expect, vi } from 'vitest'
import { runGate } from '../../src/main/flow/node-runners/gate-runner'
import { runRouter } from '../../src/main/flow/node-runners/router-runner'
import type { FlowNode } from '../../src/shared/flows'
import type { ApprovalPort } from '../../src/main/flow/types'

function gateNode(over: Partial<FlowNode> = {}): FlowNode {
  return {
    id: 'g1',
    type: 'gate',
    config: { prompt: 'Send reply to {{trigger.from}}?' },
    position: { x: 0, y: 0 },
    ...over
  }
}

describe('runGate', () => {
  it('requests approval with a templated prompt + peek, records the boolean', async () => {
    const requestApproval = vi.fn(async () => true)
    const port: ApprovalPort = { requestApproval }
    const out = await runGate(
      { approvals: port },
      gateNode(),
      { trigger: { from: 'a@b.com' } },
      'run-1',
      ['the draft body']
    )
    expect(requestApproval).toHaveBeenCalledWith({
      runId: 'run-1',
      nodeId: 'g1',
      prompt: 'Send reply to a@b.com?',
      peek: ['the draft body']
    })
    expect(out.status).toBe('done')
    expect(out.context).toEqual({ g1: { approved: true } })
  })

  it('records a human "no" as approved:false (still a done outcome — the engine routes/rejects)', async () => {
    const port: ApprovalPort = { requestApproval: async () => false }
    const out = await runGate({ approvals: port }, gateNode(), {}, 'run-1', [])
    expect(out.status).toBe('done')
    expect(out.context).toEqual({ g1: { approved: false } })
  })

  it('never auto-proceeds — it always awaits the port', async () => {
    let resolved = false
    const port: ApprovalPort = {
      requestApproval: () =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => {
            resolved = true
            resolve(true)
          }, 0)
        )
    }
    const out = await runGate({ approvals: port }, gateNode(), {}, 'r', [])
    expect(resolved).toBe(true)
    expect(out.status).toBe('done')
  })
})

describe('runRouter', () => {
  it("resolves done with no side effects — routing is the engine's pure edge eval", () => {
    expect(runRouter()).toEqual({ status: 'done' })
  })
})
