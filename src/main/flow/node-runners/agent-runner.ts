import type { FlowNode } from '../../../shared/flows'
import type { AgentId, SessionInfo } from '../../../shared/types'
import { clampEnvironment } from '../../../shared/environment'
import type { RunContext } from '../context'
import { applyTemplate, parseFlowResult } from '../context'
import type { NodeOutcome } from '../types'
import type { DriveResult } from '../pane-driver'

/** The pane-driver surface the agent runner needs (kept narrow for testing). */
interface PaneDriverLike {
  createTerminal(
    environment: number,
    agentId: AgentId,
    groupId: string
  ): Promise<DriveResult<{ handle: string }>>
  prompt(environment: number, handle: string, text: string): Promise<DriveResult<object>>
}

export interface AgentRunnerDeps {
  driver: PaneDriverLike
  manager: Pick<import('../../session-manager').SessionManager, 'peek' | 'get'>
  /** Default environment when the node's config doesn't pin one. */
  environment: number
  /** Suspends until the pane reaches a terminal transition on the SHARED status
   *  feed: `idle` (a Stop hook → node done) or `exited` (pty exit → node fail).
   *  Injected by the engine, which owns the `onPaneStatus` correlation. */
  waitForTerminal(handle: string): Promise<'idle' | 'exited'>
  /** How many peeked lines to scan for the FLOW_RESULT sentinel (default 20). */
  sentinelLines?: number
}

/**
 * Runs an `agent` node: spawns a terminal pane for `node.ref` (an `AgentId`,
 * validated upstream against `OPERATOR_TERMINAL_AGENTS` by the control API) and
 * prompts it with `promptTemplate` rendered against run context. Completion is
 * the pane reaching `idle` (a `Stop` hook); the engine then reduces the pane's
 * output to a typed fact by peeking the `FLOW_RESULT: {…}` sentinel (the hybrid
 * seam, §3.2). An instant-exit fails the node, forwarding the pane's REAL
 * exit-tail message verbatim (§9) — the engine never mints a vaguer error.
 */
export async function runAgent(
  deps: AgentRunnerDeps,
  node: FlowNode,
  context: RunContext
): Promise<NodeOutcome> {
  const agentId = node.ref
  if (!agentId) {
    return {
      status: 'failed',
      message: `Flow node '${node.id}' is misconfigured: an agent node needs a ref naming an agent.`
    }
  }
  const groupId = typeof node.config.groupId === 'string' ? node.config.groupId : ''
  if (!groupId) {
    return {
      status: 'failed',
      message: `Flow node '${node.id}' is misconfigured: an agent node needs a 'groupId' in its config.`
    }
  }
  const environment =
    node.config.environment === undefined
      ? deps.environment
      : clampEnvironment(node.config.environment)

  const created = await deps.driver.createTerminal(environment, agentId as AgentId, groupId)
  if (!created.ok) {
    return {
      status: 'failed',
      message: `Flow node '${node.id}' couldn't drive a pane: ${created.error}`
    }
  }
  const handle = created.handle

  const promptTemplate =
    typeof node.config.promptTemplate === 'string' ? node.config.promptTemplate : ''
  const text = applyTemplate(promptTemplate, context)
  const prompted = await deps.driver.prompt(environment, handle, text)
  if (!prompted.ok) {
    return {
      status: 'failed',
      message: `Flow node '${node.id}' couldn't prompt its pane: ${prompted.error}`
    }
  }

  const terminal = await deps.waitForTerminal(handle)
  if (terminal === 'exited') {
    const info = deps.manager.get(handle) as SessionInfo | null
    // Forward the pane's REAL instant-exit tail verbatim; only fall back to a
    // generic line when the pane carried no message at all.
    const message =
      info?.message ??
      `Flow node '${node.id}' agent pane exited before completing (no output captured).`
    return { status: 'failed', message }
  }

  const lines = deps.manager.peek(handle, deps.sentinelLines ?? 20)
  const fact = parseFlowResult(lines) ?? {}
  return { status: 'done', context: { [node.id]: fact } }
}
