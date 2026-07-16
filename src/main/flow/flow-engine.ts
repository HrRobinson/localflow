import { randomUUID } from 'node:crypto'
import type { FlowGraph, FlowNode, RunEvent, RunSnapshot, RunStatus } from '../../shared/flows'
import type { SessionStatus } from '../../shared/types'
import { clampEnvironment } from '../../shared/environment'
import type { IntegrationRegistry } from '../../shared/integrations'
import type { FlowsConfig } from './flow-config'
import { selectEdges, type RunContext } from './context'
import {
  applyOutcome,
  initRunState,
  isComplete,
  readyNodes,
  setNodeStatus,
  type RunNodesState
} from './run-state'
import type { PaneDriver } from './pane-driver'
import type { ApprovalPort, NodeOutcome } from './types'
import { runAction } from './node-runners/action-runner'
import { runAgent } from './node-runners/agent-runner'
import { runGate } from './node-runners/gate-runner'
import { runRouter } from './node-runners/router-runner'
import { subscribeTriggers, type SeedEvent } from './trigger-subscriber'

export interface FlowEngineDeps {
  flows: FlowGraph[]
  config: FlowsConfig
  registry: IntegrationRegistry
  approvals: ApprovalPort
  driver: PaneDriver
  manager: Pick<import('../session-manager').SessionManager, 'peek' | 'get'>
  /** Injected clock — every timestamp is deterministic in tests (§5). */
  now?: () => number
}

interface Run {
  graph: FlowGraph
  snapshot: RunSnapshot
  state: RunNodesState
  /** Nodes currently dispatched to a runner (guards double-dispatch). */
  inFlight: Set<string>
  /** The most recent agent pane handle — a gate peeks it for its content. */
  lastPaneHandle?: string
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const terminal = (s: RunStatus): boolean => s === 'done' || s === 'failed' || s === 'rejected'

/**
 * The orchestrator: owns the run lifecycle, the DETERMINISTIC graph walk, the
 * in-memory run registry, and the `onRunStatus`/`onNodeStatus`/`onRunActivity`
 * fan-out (mirroring `SessionManager`'s callback fan-out). Runs are in-memory
 * like operator grants — they do NOT survive a restart (§5, §10.1). NO LLM ever
 * decides routing: the engine reduces each agent's output to a typed fact and
 * routes on boolean edge conditions.
 */
export class FlowEngine {
  private runs = new Map<string, Run>()
  private paneWaiters = new Map<string, (t: 'idle' | 'exited') => void>()
  private eventCbs: ((e: RunEvent) => void)[] = []
  private activeAgentPanes = 0
  private unsubscribe: (() => void) | null = null

  constructor(private deps: FlowEngineDeps) {}

  /** Subscribes trigger streams for every enabled flow. Opt-in: with the flows
   *  block disabled the engine never starts (localflow's no-config guarantee). */
  start(): void {
    if (!this.deps.config.enabled || this.unsubscribe) return
    this.unsubscribe = subscribeTriggers(this.deps.registry, this.deps.flows, (flow, event) =>
      this.startRun(flow, event)
    )
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Register a run/node/activity event listener (the #3 live-overlay feed). */
  onEvent(cb: (e: RunEvent) => void): void {
    this.eventCbs.push(cb)
  }

  /** The engine JOINS the existing status feed as one more subscriber — it
   *  never registers its own pty listeners. `index.ts` calls this from the
   *  same `manager.onStatus` tap the renderer/console/Linear use. Only a
   *  pane's terminal transitions (`idle`/`exited`) resolve a waiting agent
   *  node; `needs-you` is surfaced on the feed and the node keeps waiting. */
  onPaneStatus(handle: string, status: SessionStatus): void {
    const waiter = this.paneWaiters.get(handle)
    if (!waiter) return
    if (status === 'idle') {
      this.paneWaiters.delete(handle)
      waiter('idle')
    } else if (status === 'exited') {
      this.paneWaiters.delete(handle)
      waiter('exited')
    }
  }

  snapshots(): RunSnapshot[] {
    return [...this.runs.values()].map((r) => ({ ...r.snapshot }))
  }

  getRun(runId: string): RunSnapshot | null {
    const run = this.runs.get(runId)
    return run ? { ...run.snapshot } : null
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Seeds and starts a run: the trigger node is immediately `done`, its payload
   *  written to context under the node id, then the walk pumps forward. Returns
   *  the runId (used by tests/callers to observe the run). */
  startRun(flow: FlowGraph, event: SeedEvent): string {
    const trigger = flow.nodes.find((n) => n.type === 'trigger')
    if (!trigger) return '' // parseFlowGraph guarantees one; defensive only.
    const runId = randomUUID()
    const context: RunContext = { [trigger.id]: event.payload }
    let state = initRunState(flow)
    const snapshot: RunSnapshot = {
      runId,
      flowId: flow.id,
      triggerEventId: event.eventId,
      status: 'running',
      nodes: { ...state.nodes },
      context,
      startedAt: this.now()
    }
    const run: Run = { graph: flow, snapshot, state, inFlight: new Set() }
    this.runs.set(runId, run)
    this.emit({ kind: 'run-status', runId, status: 'running' })
    this.emit({ kind: 'run-activity', runId, nodeId: trigger.id, detail: `Flow '${flow.name}' started` })

    // The trigger resolves promptly: done, routing along its out-edges.
    state = applyOutcome(flow, state, trigger.id, 'done', selectEdges(flow, trigger.id, context))
    run.state = state
    this.syncNodes(run, trigger.id)
    this.pump(runId)
    return runId
  }

  /** Dispatch every ready node not already in flight, honoring the RAM-safe
   *  concurrent-agent-pane cap. No-op once the run is terminal. */
  private pump(runId: string): void {
    const run = this.runs.get(runId)
    if (!run || terminal(run.snapshot.status)) return
    for (const nodeId of readyNodes(run.graph, run.state)) {
      if (run.inFlight.has(nodeId)) continue
      const node = run.graph.nodes.find((n) => n.id === nodeId)
      if (!node) continue
      // Cap only bites agent nodes (the only pane-spawning type). A capped node
      // stays pending and is retried when a pane frees (pump runs again then).
      if (node.type === 'agent' && this.activeAgentPanes >= this.deps.config.maxConcurrentPanes) {
        continue
      }
      this.dispatch(run, node)
    }
    this.refreshRunStatus(run)
  }

  private dispatch(run: Run, node: FlowNode): void {
    run.inFlight.add(node.id)
    const running = node.type === 'gate' ? 'waiting' : 'running'
    run.state = setNodeStatus(run.state, node.id, running)
    this.syncNodes(run, node.id)
    if (node.type === 'agent') this.activeAgentPanes++

    void this.runNode(run, node)
      .then((outcome) => this.handleOutcome(run.snapshot.runId, node, outcome))
      .catch((err: unknown) => {
        // A runner must never throw (they return NodeOutcome), but if one ever
        // does, surface the REAL exception rather than hang the run.
        const detail = err instanceof Error ? err.message : String(err)
        this.handleOutcome(run.snapshot.runId, node, {
          status: 'failed',
          message: `Flow node '${node.id}' crashed: ${detail}`
        })
      })
      .finally(() => {
        if (node.type === 'agent') this.activeAgentPanes--
        run.inFlight.delete(node.id)
        this.pump(run.snapshot.runId)
      })
  }

  private runNode(run: Run, node: FlowNode): Promise<NodeOutcome> {
    switch (node.type) {
      case 'action':
        return runAction({ registry: this.deps.registry }, node, run.snapshot.context)
      case 'agent':
        return runAgent(
          {
            driver: this.deps.driver,
            manager: this.deps.manager,
            environment: this.envFor(node),
            waitForTerminal: (handle) => this.waitForTerminal(run, handle)
          },
          node,
          run.snapshot.context
        )
      case 'gate': {
        const peek = run.lastPaneHandle ? this.deps.manager.peek(run.lastPaneHandle, 20) : []
        return runGate({ approvals: this.deps.approvals }, node, run.snapshot.context, run.snapshot.runId, peek)
      }
      case 'router':
        return Promise.resolve(runRouter(node))
      case 'trigger':
        // Triggers resolve at startRun; a trigger never reaches dispatch.
        return Promise.resolve({ status: 'done' })
    }
  }

  private envFor(node: FlowNode): number {
    return node.config.environment === undefined
      ? this.deps.config.environment
      : clampEnvironment(node.config.environment)
  }

  /** Registers a waiter for a pane's terminal transition; also records it as
   *  the run's most-recent pane so a following gate can peek its content. */
  private waitForTerminal(run: Run, handle: string): Promise<'idle' | 'exited'> {
    run.lastPaneHandle = handle
    return new Promise((resolve) => this.paneWaiters.set(handle, resolve))
  }

  private handleOutcome(runId: string, node: FlowNode, outcome: NodeOutcome): void {
    const run = this.runs.get(runId)
    if (!run || terminal(run.snapshot.status)) return

    // Merge the node's typed fact into run context (node-id-keyed).
    if (outcome.context) {
      for (const [key, value] of Object.entries(outcome.context)) run.snapshot.context[key] = value
    }

    if (outcome.status === 'failed') {
      run.state = applyOutcome(run.graph, run.state, node.id, 'failed', [])
      this.syncNodes(run, node.id)
      this.emit({
        kind: 'run-activity',
        runId,
        nodeId: node.id,
        detail: `Flow '${run.graph.name}' node '${node.id}' failed: ${outcome.message ?? 'unknown error'}`
      })
      this.finishRun(run, 'failed', outcome.message)
      return
    }

    if (outcome.status === 'rejected') {
      run.state = applyOutcome(run.graph, run.state, node.id, 'skipped', [])
      this.syncNodes(run, node.id)
      this.finishRun(run, 'rejected', outcome.message)
      return
    }

    // done: route along matching out-edges (pure boolean edge eval).
    const selected = selectEdges(run.graph, node.id, run.snapshot.context)
    run.state = applyOutcome(run.graph, run.state, node.id, 'done', selected)
    this.syncNodes(run, node.id)

    // A gate whose human said "no" with no matching (reject) edge ends the run
    // cleanly as rejected — a human "no" is NOT a failure (§3.4).
    if (node.type === 'gate' && selected.length === 0) {
      const approved = isObject(run.snapshot.context[node.id]) &&
        (run.snapshot.context[node.id] as Record<string, unknown>).approved === true
      if (!approved) {
        this.emit({
          kind: 'run-activity',
          runId,
          nodeId: node.id,
          detail: `Flow '${run.graph.name}' stopped at gate '${node.id}' — rejected`
        })
        this.finishRun(run, 'rejected', `Rejected at gate '${node.id}'`)
        return
      }
    }

    if (isComplete(run.graph, run.state)) {
      this.finishRun(run, 'done')
      return
    }
    this.pump(runId)
  }

  private finishRun(run: Run, status: RunStatus, message?: string): void {
    run.snapshot.status = status
    run.snapshot.endedAt = this.now()
    if (message) run.snapshot.message = message
    this.emit({ kind: 'run-status', runId: run.snapshot.runId, status, message })
  }

  /** Recomputes the run-level status from node states while the run is live:
   *  `needs-you` if any gate is waiting, else `running`. Terminal statuses are
   *  set by finishRun. */
  private refreshRunStatus(run: Run): void {
    if (terminal(run.snapshot.status)) return
    const anyWaiting = Object.values(run.state.nodes).some((s) => s === 'waiting')
    const next: RunStatus = anyWaiting ? 'needs-you' : 'running'
    if (next !== run.snapshot.status) {
      run.snapshot.status = next
      this.emit({ kind: 'run-status', runId: run.snapshot.runId, status: next })
    }
  }

  /** Mirror the reducer's node map onto the snapshot and emit a node-status. */
  private syncNodes(run: Run, changedNodeId: string): void {
    run.snapshot.nodes = { ...run.state.nodes }
    this.emit({
      kind: 'node-status',
      runId: run.snapshot.runId,
      nodeId: changedNodeId,
      status: run.state.nodes[changedNodeId]
    })
  }

  private emit(event: RunEvent): void {
    for (const cb of this.eventCbs) cb(event)
  }
}
