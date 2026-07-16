import type { RunContext } from './context'

/**
 * The terminal result of running one node. Every runner is dependency-injected
 * and returns one of these (the `pane-ops.ts` / `state-machine.ts` purity
 * pattern). `context` is a patch merged into the run context (node-id-keyed
 * typed facts). `message` carries the REAL underlying exception on failure —
 * never a vaguer wrapper (error-message-style).
 *
 * `rejected` is reserved for a human "no" at a gate: a clean stop, NOT a
 * failure.
 */
export interface NodeOutcome {
  status: 'done' | 'failed' | 'rejected'
  context?: RunContext
  message?: string
}

/** A pending gate approval. `peek` is the content the human reviews (the draft
 *  body / the plan / the question) — the same peek `ApproveButton` shows. */
export interface ApprovalRequest {
  runId: string
  nodeId: string
  prompt: string
  peek: string[]
}

/**
 * The gate seam. In production this binds to the existing `needs-you` +
 * `ApproveButton` primitive (design §10.5); in tests it is a mock scripted to
 * resolve `true`/`false`. A gate NEVER auto-proceeds — it always awaits this.
 */
export interface ApprovalPort {
  requestApproval(req: ApprovalRequest): Promise<boolean>
}
