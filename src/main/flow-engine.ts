// Flow Engine STUB (§9). The real engine is sub-project #2; until it lands, this
// stub proves the save→run hand-off end-to-end without executing anything:
//   • loads the saved graph via FlowStore (Run always executes PERSISTED truth,
//     never unsaved editor state);
//   • checks basic runnability (graph exists + has ≥1 trigger) — the renderer
//     already blocks Run on any semantic `error` (flow-validate, §5), so this is
//     a final main-side guard, not the whole validator;
//   • logs a one-line run summary and returns a run id (or a legible error).
//
// When #2 lands, this whole module is replaced by the real engine's `run` — the
// `flow:run` IPC signature (id → { ok; runId } | { ok:false; error }) is
// unchanged, so nothing else moves. The stub NEVER spawns a pane: turning an
// agent node into a real pane via the operator `POST /panes` surface is the
// engine's job and its capability boundary (see §4.1).
import type { FlowStore } from './flow-store'

export type RunResult = { ok: true; runId: string } | { ok: false; error: string }

export interface FlowEngine {
  run(id: string): RunResult
}

let runCounterSeed = 0
function nextRunId(): string {
  runCounterSeed += 1
  return `run-${Date.now().toString(36)}-${runCounterSeed.toString(36)}`
}

/**
 * @param store the flow persistence peer (the graph is loaded fresh from disk).
 * @param log where the run summary goes; defaults to console. Injected so tests
 *            can assert the summary without capturing stdout.
 */
export function makeFlowEngineStub(
  store: FlowStore,
  log: (message: string) => void = (m) => console.log(m)
): FlowEngine {
  return {
    run(id: string): RunResult {
      const graph = store.loadFlow(id)
      if (!graph) {
        return {
          ok: false,
          error: `That flow couldn't be found — it may have been deleted. Save it again, then Run. (id: ${id})`
        }
      }
      const triggers = graph.nodes.filter((n) => n.type === 'trigger')
      if (triggers.length === 0) {
        return {
          ok: false,
          error: `"${graph.name}" has no trigger, so there's nothing to start it — add a trigger node and save before running.`
        }
      }
      const runId = nextRunId()
      log(
        `[flow-engine stub] run ${runId} of "${graph.name}" (${graph.id}): ` +
          `${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ` +
          `${triggers.length} trigger(s). No panes spawned — the real engine (#2) owns execution.`
      )
      return { ok: true, runId }
    }
  }
}
