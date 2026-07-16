import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { FlowGraph } from '../../shared/flows'
import { parseFlowGraphResult } from './flow-model'

/**
 * Persistence for `flows.json` — the flow definitions, stored config-as-code in
 * userData. Every flow is validated through `parseFlowGraph` at the READ
 * boundary (the `persistence.ts` / `loadSavedState` discipline): an invalid
 * flow is DISABLED with a loud, specific notice naming the offending field, and
 * the valid flows still load. A corrupt file loads empty with a notice. Reads
 * and writes never throw.
 */

export type SaveFlowsResult = { ok: true } | { ok: false; error: string }

export interface LoadedFlows {
  flows: FlowGraph[]
  /** Human-readable, actionable notices — one per disabled flow / read error. */
  notices: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function loadFlows(file: string): LoadedFlows {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    // A missing file is a normal first run — no flows, no notice. Any other
    // read error is surfaced but non-fatal.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { flows: [], notices: [] }
    const detail = err instanceof Error ? err.message : String(err)
    return { flows: [], notices: [`Couldn't read flows.json — ${detail}. Fix the file and relaunch.`] }
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      flows: [],
      notices: [`flows.json couldn't be parsed and no flows were loaded — ${detail}. Fix flows.json.`]
    }
  }

  const list = isObject(data) && Array.isArray(data.flows) ? data.flows : []
  const flows: FlowGraph[] = []
  const notices: string[] = []
  for (const rawFlow of list) {
    const res = parseFlowGraphResult(rawFlow)
    if (res.ok) flows.push(res.flow)
    else notices.push(`Flow disabled — ${res.error}. Fix flows.json.`)
  }
  return { flows, notices }
}

export function saveFlows(file: string, flows: FlowGraph[]): SaveFlowsResult {
  // Atomic: a crash mid-write must never leave a truncated flows.json (the
  // `writeFileSync(tmp)`+`renameSync` pattern from persistence.ts).
  const tmp = file + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify({ flows }, null, 2))
    renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const detail = e.code ? `${e.code}: ${e.message}` : e.message
    return {
      ok: false,
      error: `Couldn't save your flows — disk write to ${file} failed, so recent flow changes won't survive a restart. (${detail})`
    }
  }
}
