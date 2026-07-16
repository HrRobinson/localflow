import type { NodeOutcome } from '../types'

/**
 * Runs a `router` node. A router has NO side effect and NO content: it is the
 * explicit branch point in a flow. The actual routing is the engine's PURE
 * evaluation of the router's out-edge conditions against run context
 * (`selectEdges` in context.ts — `resolveField === equals`, no LLM). So the
 * runner simply resolves `done`; the engine reads the conditions and advances
 * along every matching out-edge (design §3.5). Kept as its own runner for the
 * one-runner-per-node-type mapping and to document that routing is boolean.
 */
export function runRouter(): NodeOutcome {
  return { status: 'done' }
}
