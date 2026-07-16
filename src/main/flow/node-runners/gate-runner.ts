import type { FlowNode } from '../../../shared/flows'
import type { RunContext } from '../context'
import { applyTemplate } from '../context'
import type { ApprovalPort, NodeOutcome } from '../types'

export interface GateRunnerDeps {
  approvals: ApprovalPort
}

/**
 * Runs a `gate` node: requests a human approval via the injected `ApprovalPort`
 * and records the BOOLEAN result under the node id (`{ approved }`). It always
 * resolves `done` — the engine then routes on that boolean (approve edge vs
 * reject edge), and turns a "no" with no reject branch into a clean run
 * `rejected` (design §3.4). The gate NEVER auto-proceeds: it always awaits the
 * port. This is the never-auto-send gate — the send sits on the human side.
 */
export async function runGate(
  deps: GateRunnerDeps,
  node: FlowNode,
  context: RunContext,
  runId: string,
  peek: string[]
): Promise<NodeOutcome> {
  const promptTemplate = typeof node.config.prompt === 'string' ? node.config.prompt : ''
  const prompt = applyTemplate(promptTemplate, context)
  const approved = await deps.approvals.requestApproval({ runId, nodeId: node.id, prompt, peek })
  return { status: 'done', context: { [node.id]: { approved } } }
}
