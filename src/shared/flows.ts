import type { IntegrationId } from './integrations'

// The FlowGraph model — OWNED by the Flow Engine (sub-project #2). Sub-project
// #3's canvas PRODUCES these documents; the engine CONSUMES them. The four
// core types are pinned VERBATIM (brainstorm-approved) so the canvas and the
// engine agree byte-for-byte.

export type FlowNodeType = 'trigger' | 'agent' | 'action' | 'gate' | 'router'
export interface FlowNode {
  id: string
  type: FlowNodeType
  integration?: IntegrationId
  ref?: string
  config: Record<string, unknown>
  position: { x: number; y: number }
}
export interface FlowEdge {
  id: string
  from: string
  to: string
  condition?: { field: string; equals: unknown }
}
export interface FlowGraph {
  id: string
  name: string
  nodes: FlowNode[]
  edges: FlowEdge[]
}

// ---------------------------------------------------------------------------
// Run-state types — PRODUCED for sub-project #3 (the canvas renders them as a
// live overlay). In-memory only; runs do not survive a restart (they mirror
// the operator grants' non-durable posture — see the design spec §5, §10.1).
// ---------------------------------------------------------------------------

/** Per-node execution state within a single run. `skipped` = a branch the
 *  router/gate did not take (deterministically), never silently un-run. */
export type NodeRunStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped'

/** Whole-run status. `needs-you` = a gate is awaiting a human; `rejected` = a
 *  human said no at a gate (a clean stop, NOT a failure). */
export type RunStatus = 'running' | 'needs-you' | 'done' | 'failed' | 'rejected'

export interface RunSnapshot {
  runId: string
  flowId: string
  triggerEventId: string
  status: RunStatus
  nodes: Record<string, NodeRunStatus>
  /** Node-id-keyed outputs; boolean/typed facts only (the hybrid seam reduces
   *  agent content to a typed value here before any routing reads it). */
  context: Record<string, unknown>
  startedAt: number
  endedAt?: number
  /** Terminal failure/reject reason — carries the real underlying exception. */
  message?: string
}

/** The fan-out the engine emits so #3 can render run state live. Mirrors the
 *  callback-registration shape `SessionManager` uses (`onStatus`/`onActivity`). */
export type RunEvent =
  | { kind: 'run-status'; runId: string; status: RunStatus; message?: string }
  | { kind: 'node-status'; runId: string; nodeId: string; status: NodeRunStatus }
  | { kind: 'run-activity'; runId: string; nodeId?: string; detail: string }
