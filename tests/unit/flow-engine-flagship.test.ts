import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type PtyLike, type SpawnFn, type SpawnSpec } from '../../src/main/session-manager'
import { PaneRegistry } from '../../src/main/pane-registry'
import { OperatorGrantStore } from '../../src/main/operator-grant'
import { operatorCreatePane } from '../../src/main/pane-ops'
import { handleRequest, type ControlDeps, type OperatorPaneRequest } from '../../src/main/control-api'
import { PaneDriver } from '../../src/main/flow/pane-driver'
import { FlowEngine } from '../../src/main/flow/flow-engine'
import type { ApprovalPort } from '../../src/main/flow/types'
import type { FlowGraph, RunEvent } from '../../src/shared/flows'
import type { IntegrationDescriptor, IntegrationId, IntegrationRegistry } from '../../src/shared/integrations'
import type { AgentId } from '../../src/shared/types'

// --- fakes --------------------------------------------------------------

class FakePty implements PtyLike {
  dataCb: ((d: string) => void) | null = null
  exitCb: ((c?: number, s?: number) => void) | null = null
  written: string[] = []
  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (c?: number, s?: number) => void): void {
    this.exitCb = cb
  }
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  kill(): void {}
}

const specFor = (agentId: AgentId): SpawnSpec => ({
  agentId,
  command: `fake-${agentId}`,
  resumeArgs: [],
  hookAdapter: 'settings-file'
})

const connected = (id: IntegrationId, actions: string[], triggers: string[]): IntegrationDescriptor => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  configFields: [],
  triggers: triggers.map((t) => ({ id: t, label: t })),
  actions: actions.map((a) => ({ id: a, label: a })),
  status: () => 'connected'
})

// Mock IntegrationRegistry: records invokeAction calls, fires canned triggers.
function mockRegistry(): {
  registry: IntegrationRegistry
  calls: { id: IntegrationId; action: string; params: Record<string, unknown> }[]
  fire: (id: IntegrationId, triggerId: string, event: unknown) => void
} {
  const descriptors: Record<string, IntegrationDescriptor> = {
    linear: connected('linear', ['createIssue', 'comment', 'issueUpdate'], ['created']),
    email: connected('email', ['sendDraft'], ['inbound']),
    cloud: connected('cloud', ['applyPlan'], []) // action-only: empty triggers[]
  }
  const calls: { id: IntegrationId; action: string; params: Record<string, unknown> }[] = []
  const handlers: Record<string, (e: unknown) => void> = {}
  const results: Record<string, unknown> = {
    createIssue: { issueId: 'ENG-1' },
    applyPlan: { deployed: true },
    issueUpdate: { state: 'Review' },
    sendDraft: { sent: true },
    comment: { commented: true }
  }
  return {
    calls,
    fire: (id, triggerId, event) => handlers[`${id}:${triggerId}`]?.(event),
    registry: {
      descriptors: () => Object.values(descriptors),
      get: (id) => descriptors[id],
      invokeAction: async (id, action, params) => {
        calls.push({ id, action, params })
        return results[action] ?? { ok: true }
      },
      subscribe: (id, triggerId, handler) => {
        handlers[`${id}:${triggerId}`] = handler
        return () => delete handlers[`${id}:${triggerId}`]
      }
    }
  }
}

// The flagship FlowGraph (design §4): email → triage → route → createIssue →
// deploy → plan-apply gate → applyPlan → issueUpdate → draft → never-auto-send
// gate → sendDraft.
function flagshipFlow(groupId: string): FlowGraph {
  const agent = (id: string): FlowGraph['nodes'][number] => ({
    id,
    type: 'agent',
    ref: 'claude',
    config: { groupId, promptTemplate: `${id}: {{t.subject}}` },
    position: { x: 0, y: 0 }
  })
  return {
    id: 'support-triage',
    name: 'Customer email → triage → Linear → deploy → reply',
    nodes: [
      { id: 't', type: 'trigger', integration: 'email', ref: 'inbound', config: {}, position: { x: 0, y: 0 } },
      agent('triage'),
      { id: 'route', type: 'router', config: {}, position: { x: 0, y: 0 } },
      { id: 'createIssue', type: 'action', integration: 'linear', ref: 'createIssue', config: { params: { title: 'Re: {{t.subject}}', body: '{{t.body}}' } }, position: { x: 0, y: 0 } },
      { id: 'comment', type: 'action', integration: 'linear', ref: 'comment', config: { params: { body: 'auto' } }, position: { x: 0, y: 0 } },
      agent('deploy'),
      { id: 'planGate', type: 'gate', config: { prompt: 'Apply the deploy plan?' }, position: { x: 0, y: 0 } },
      { id: 'applyPlan', type: 'action', integration: 'cloud', ref: 'applyPlan', config: { params: {} }, position: { x: 0, y: 0 } },
      { id: 'toReview', type: 'action', integration: 'linear', ref: 'issueUpdate', config: { params: { issueId: '{{createIssue.issueId}}', stateId: 'Review' } }, position: { x: 0, y: 0 } },
      agent('draft'),
      { id: 'sendGate', type: 'gate', config: { prompt: 'Send this reply to {{t.from}}?' }, position: { x: 0, y: 0 } },
      { id: 'sendDraft', type: 'action', integration: 'email', ref: 'sendDraft', config: { params: { threadId: '{{t.threadId}}' } }, position: { x: 0, y: 0 } }
    ],
    edges: [
      { id: 'e1', from: 't', to: 'triage' },
      { id: 'e2', from: 'triage', to: 'route' },
      { id: 'e-bug', from: 'route', to: 'createIssue', condition: { field: 'triage.category', equals: 'bug' } },
      { id: 'e-other', from: 'route', to: 'comment', condition: { field: 'triage.category', equals: 'other' } },
      { id: 'e3', from: 'createIssue', to: 'deploy' },
      { id: 'e4', from: 'deploy', to: 'planGate' },
      { id: 'e-apply', from: 'planGate', to: 'applyPlan', condition: { field: 'planGate.approved', equals: true } },
      { id: 'e5', from: 'applyPlan', to: 'toReview' },
      { id: 'e6', from: 'toReview', to: 'draft' },
      { id: 'e7', from: 'draft', to: 'sendGate' },
      { id: 'e-send', from: 'sendGate', to: 'sendDraft', condition: { field: 'sendGate.approved', equals: true } }
    ]
  }
}

interface Harness {
  engine: FlowEngine
  manager: SessionManager
  reg: ReturnType<typeof mockRegistry>
  events: RunEvent[]
  runDone: Promise<RunEvent & { kind: 'run-status' }>
  fireEmail: () => void
}

function harness(approvals: ApprovalPort): Harness {
  const ptys: FakePty[] = []
  const spawnFn: SpawnFn = () => {
    const p = new FakePty()
    ptys.push(p)
    return p
  }
  const manager = new SessionManager({
    settingsDir: mkdtempSync(join(tmpdir(), 'lf-fe-')),
    port: 9999,
    token: 'tok',
    spawnFn,
    now: () => 1000
  })
  const grants = new OperatorGrantStore()
  const group = manager.createGroup('proj', 1)
  const seed = manager.create('/proj', specFor('claude'), 1)
  manager.assignToGroup(seed.id, group.id)

  const controlDeps: ControlDeps = {
    registry: new PaneRegistry(manager),
    grants,
    manager,
    panes: {
      create: (environment: number, req: OperatorPaneRequest) =>
        operatorCreatePane(manager, specFor, environment, req)
    }
  }
  const driver = new PaneDriver({ controlDeps, grants })
  const reg = mockRegistry()

  // Engine joins the ONE status feed as an additional subscriber (§2.3).
  manager.onStatus((id, status) => engine.onPaneStatus(id, status))

  const engine = new FlowEngine({
    flows: [flagshipFlow(group.id)],
    config: { enabled: true, environment: 1, maxConcurrentPanes: 2 },
    registry: reg.registry,
    approvals,
    driver,
    manager,
    now: () => 1000
  })

  // Pilot: drive each engine-spawned agent pane deterministically to idle. The
  // drive runs on a macrotask (setTimeout 0) — always AFTER the runner's
  // microtask chain has registered its terminal waiter, so there is no race and
  // no wall-clock wait. The first agent pane (triage) prints the routing
  // sentinel; the others just complete.
  let engineAgentCount = 0
  const seen = new Set<string>([seed.id])
  manager.onSessionsChanged(() => {
    manager.list().forEach((s) => {
      if (s.kind !== 'terminal' || seen.has(s.id)) return
      seen.add(s.id)
      const idx = ptys.length - 1 // this pane's pty is the most recent spawn
      const pty = ptys[idx]
      const sentinel = engineAgentCount === 0 ? '{"category":"bug"}' : null
      engineAgentCount++
      const id = s.id
      setTimeout(() => {
        manager.applyHookEvent({ paneId: id, event: 'UserPromptSubmit' }) // → working
        if (sentinel) pty.dataCb?.(`FLOW_RESULT: ${sentinel}\r\n`)
        manager.applyHookEvent({ paneId: id, event: 'Stop' }) // → idle (node done)
      }, 0)
    })
  })

  const events: RunEvent[] = []
  let resolveDone!: (e: RunEvent & { kind: 'run-status' }) => void
  const runDone = new Promise<RunEvent & { kind: 'run-status' }>((r) => (resolveDone = r))
  engine.onEvent((e) => {
    events.push(e)
    if (e.kind === 'run-status' && (e.status === 'done' || e.status === 'failed' || e.status === 'rejected')) {
      resolveDone(e)
    }
  })
  engine.start()

  return {
    engine,
    manager,
    reg,
    events,
    runDone,
    fireEmail: () =>
      reg.fire('email', 'inbound', {
        eventId: 'evt-1',
        payload: { from: 'user@ex.com', subject: 'Login broken', body: 'cannot log in', threadId: 'thread-9' }
      })
  }
}

describe('FlowEngine — flagship loop (headless, deterministic, all mocks)', () => {
  it('walks email → triage → Linear → deploy → gate → Review → draft → never-auto-send gate → send', async () => {
    const approvals: ApprovalPort = { requestApproval: async () => true }
    const h = harness(approvals)
    h.fireEmail()
    const done = await h.runDone

    expect(done.status).toBe('done')

    // Actions invoked deterministically, in flagship order, with templated params.
    const actions = h.reg.calls.map((c) => `${c.id}.${c.action}`)
    expect(actions).toEqual([
      'linear.createIssue',
      'cloud.applyPlan',
      'linear.issueUpdate',
      'email.sendDraft'
    ])

    // Router branched on the boolean fact (bug), so linear.comment never ran.
    expect(actions).not.toContain('linear.comment')

    // Params templated from run context (the trigger payload + upstream results).
    const createIssue = h.reg.calls.find((c) => c.action === 'createIssue')
    expect(createIssue?.params).toEqual({ title: 'Re: Login broken', body: 'cannot log in' })
    const issueUpdate = h.reg.calls.find((c) => c.action === 'issueUpdate')
    expect(issueUpdate?.params).toEqual({ issueId: 'ENG-1', stateId: 'Review' })
    const send = h.reg.calls.find((c) => c.action === 'sendDraft')
    expect(send?.params).toEqual({ threadId: 'thread-9' })

    // Final run snapshot is a clean terminal `done` with an injected-clock stamp.
    const snap = h.engine.snapshots()[0]
    expect(snap.status).toBe('done')
    expect(snap.startedAt).toBe(1000)
    expect(snap.endedAt).toBe(1000)
    expect(snap.nodes.comment).toBe('skipped')
  })

  it('NEVER auto-sends: a rejected send gate ends the run rejected with no email.sendDraft call', async () => {
    // Approve the plan gate, REJECT the never-auto-send gate.
    const approvals: ApprovalPort = {
      requestApproval: async (req) => req.nodeId !== 'sendGate'
    }
    const h = harness(approvals)
    h.fireEmail()
    const done = await h.runDone

    expect(done.status).toBe('rejected')
    const actions = h.reg.calls.map((c) => `${c.id}.${c.action}`)
    expect(actions).toContain('cloud.applyPlan') // plan gate approved
    expect(actions).not.toContain('email.sendDraft') // send gate rejected — the hard invariant
  })
})
