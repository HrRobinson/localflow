// Persistence peer of persistence.ts, per-flow. One JSON file per flow under
// `<flowsDir>/<flowId>.json`, with the SAME discipline copied verbatim (it's a
// non-negotiable house pattern):
//   • atomic write (writeFileSync(tmp) → renameSync) — a crash mid-write never
//     truncates a flow;
//   • corrupt-on-load → backed up aside (`.corrupt-<iso>`) and reported, never a
//     silent empty; not overwritten unless the backup rename SUCCEEDED;
//   • a read error (EACCES/EBUSY) leaves the file untouched;
//   • a save failure returns a legible `ok:false` error (surfaced to the
//     renderer as a notice by index.ts).
//
// The FlowGraph shape is re-validated at the save boundary (untrusted renderer
// input) via `isFlowGraph` — a malformed node type, a non-object config, or an
// edge referencing an unknown node is rejected rather than persisted.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  mkdirSync,
  statSync,
  existsSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { isFlowGraph, summarize, type FlowGraph, type FlowSummary } from '../shared/flows'

export type SaveFlowResult = { ok: true; summary: FlowSummary } | { ok: false; error: string }

/** The load-with-signals shape (mirrors persistence.ts's LoadedState). */
export interface LoadedFlow {
  graph: FlowGraph | null
  error?: string
  safeToPersist: boolean
}

const backupCorruptFile = (file: string): string | null => {
  const backupPath = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    renameSync(file, backupPath)
    return basename(backupPath)
  } catch {
    return null
  }
}

export class FlowStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  /** All saved flows as lightweight summaries. Unreadable/corrupt files are
   *  skipped (they surface their own notice on an explicit load), never crash
   *  the list. */
  listFlows(): FlowSummary[] {
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return [] // dir not created yet (no flow ever saved) — a normal empty list
    }
    const summaries: FlowSummary[] = []
    for (const name of entries) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
      const file = join(this.dir, name)
      try {
        const graph: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (!isFlowGraph(graph)) continue
        summaries.push(summarize(graph, statSync(file).mtimeMs))
      } catch {
        continue // corrupt/unreadable — excluded from the list, not fatal
      }
    }
    return summaries
  }

  /** Full graph by id; null if unknown/unreadable/corrupt (the simple shape the
   *  `flow:get` IPC returns). Use `loadFlowSafe` when the corrupt-file signals
   *  matter (backup + notice). */
  loadFlow(id: string): FlowGraph | null {
    return this.loadFlowSafe(id).graph
  }

  /** Load with the persistence.ts signal discipline: distinguishes a genuine
   *  missing file, a transient read error (left untouched), and real corruption
   *  (backed up aside). */
  loadFlowSafe(id: string): LoadedFlow {
    const file = this.fileFor(id)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { graph: null, safeToPersist: true } // no such flow — normal
      }
      const detail = err instanceof Error ? err.message : String(err)
      return {
        graph: null,
        error: `This flow couldn't be read — the file was left untouched and will NOT be overwritten, so nothing is lost. Fix the permission/lock and retry. (${detail})`,
        safeToPersist: false
      }
    }
    try {
      const graph: unknown = JSON.parse(raw)
      if (!isFlowGraph(graph)) throw new Error('not a valid flow graph')
      return { graph, safeToPersist: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const backupName = backupCorruptFile(file)
      if (backupName) {
        return {
          graph: null,
          error: `This flow couldn't be read and was reset — the file was backed up to ${backupName}. (${detail})`,
          safeToPersist: true
        }
      }
      return {
        graph: null,
        error: `This flow couldn't be read and could not be backed up, so it was left untouched and will NOT be overwritten — fix the problem and retry. (${detail})`,
        safeToPersist: false
      }
    }
  }

  /** Persists a flow atomically. Rejects a malformed graph at the boundary. */
  saveFlow(graph: unknown): SaveFlowResult {
    if (!isFlowGraph(graph)) {
      return {
        ok: false,
        error:
          "This flow couldn't be saved — it was malformed (an unknown node type, a non-object config, or an arrow pointing at a missing node). Nothing was written."
      }
    }
    try {
      this.ensureDir()
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      return {
        ok: false,
        error: `Couldn't save this flow — the flows folder ${this.dir} couldn't be created. (${e.code ?? ''}: ${e.message})`
      }
    }
    const file = this.fileFor(graph.id)
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(graph, null, 2))
      renameSync(tmp, file)
      return { ok: true, summary: summarize(graph, statSync(file).mtimeMs) }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      const detail = e.code ? `${e.code}: ${e.message}` : e.message
      return {
        ok: false,
        error: `Couldn't save this flow — disk write to ${file} failed, so your recent edits won't survive a restart. (${detail})`
      }
    }
  }

  /** Removes a saved flow (best-effort; a missing file is not an error). */
  deleteFlow(id: string): void {
    const file = this.fileFor(id)
    if (existsSync(file)) rmSync(file, { force: true })
  }
}
