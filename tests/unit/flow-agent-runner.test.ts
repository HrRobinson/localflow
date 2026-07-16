import { describe, it, expect, vi } from 'vitest'
import { runAgent, type AgentRunnerDeps } from '../../src/main/flow/node-runners/agent-runner'
import type { FlowNode } from '../../src/shared/flows'

function agentNode(over: Partial<FlowNode> = {}): FlowNode {
  return {
    id: 'triage',
    type: 'agent',
    ref: 'claude',
    config: { groupId: 'g1', promptTemplate: 'Triage: {{trigger.subject}}. Print FLOW_RESULT.' },
    position: { x: 0, y: 0 },
    ...over
  }
}

function deps(over: Partial<AgentRunnerDeps> = {}): {
  deps: AgentRunnerDeps
  created: { agentId: string; groupId: string }[]
  prompted: { handle: string; text: string }[]
} {
  const created: { agentId: string; groupId: string }[] = []
  const prompted: { handle: string; text: string }[] = []
  const base: AgentRunnerDeps = {
    driver: {
      createTerminal: async (_env, agentId, groupId) => {
        created.push({ agentId, groupId })
        return { ok: true, handle: 'h1' }
      },
      prompt: async (_env, handle, text) => {
        prompted.push({ handle, text })
        return { ok: true }
      }
    },
    manager: {
      peek: () => ['FLOW_RESULT: {"category":"bug"}'],
      get: () => null
    },
    environment: 1,
    waitForTerminal: async () => 'idle',
    ...over
  }
  return { deps: base, created, prompted }
}

describe('runAgent', () => {
  it('creates + prompts a pane, waits for idle, and extracts the sentinel fact', async () => {
    const h = deps()
    const out = await runAgent(h.deps, agentNode(), { trigger: { subject: 'Login broken' } })
    expect(h.created).toEqual([{ agentId: 'claude', groupId: 'g1' }])
    expect(h.prompted[0].text).toBe('Triage: Login broken. Print FLOW_RESULT.')
    expect(out.status).toBe('done')
    expect(out.context).toEqual({ triage: { category: 'bug' } })
  })

  it('completing with no sentinel yields an empty typed fact (done, {})', async () => {
    const h = deps({ manager: { peek: () => ['just some chatter'], get: () => null } })
    const out = await runAgent(h.deps, agentNode(), {})
    expect(out.status).toBe('done')
    expect(out.context).toEqual({ triage: {} })
  })

  it("an instant-exit fails the node, forwarding the pane's REAL exit tail verbatim", async () => {
    const tail = 'Exited right away (exit code 1) — last output: “No conversation found”'
    const h = deps({
      waitForTerminal: async () => 'exited',
      manager: { peek: () => [], get: () => ({ message: tail }) as never }
    })
    const out = await runAgent(h.deps, agentNode(), {})
    expect(out.status).toBe('failed')
    expect(out.message).toBe(tail)
  })

  it("a rejected pane creation fails the node with the router's error and never prompts", async () => {
    const prompt = vi.fn()
    const h = deps({
      driver: {
        createTerminal: async () => ({ ok: false, error: '403 no grant' }),
        prompt
      }
    })
    const out = await runAgent(h.deps, agentNode(), {})
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/403 no grant/)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('a guard-blocked prompt fails the node, carrying the guard deny message', async () => {
    const h = deps({
      driver: {
        createTerminal: async () => ({ ok: true, handle: 'h1' }),
        prompt: async () => ({ ok: false, error: '403 ⛔ lfguard blocked rm -rf' })
      }
    })
    const out = await runAgent(h.deps, agentNode(), {})
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/lfguard blocked/)
  })

  it('a node missing its agent ref is misconfigured (no drive attempted)', async () => {
    const create = vi.fn()
    const h = deps({ driver: { createTerminal: create, prompt: vi.fn() } })
    const out = await runAgent(h.deps, agentNode({ ref: undefined }), {})
    expect(out.status).toBe('failed')
    expect(out.message).toMatch(/misconfigured|ref/i)
    expect(create).not.toHaveBeenCalled()
  })
})
