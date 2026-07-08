import { readFileSync } from 'node:fs'
import { WORKSPACE_MIN, WORKSPACE_MAX } from '../shared/workspace'

/**
 * Optional workspace names, hand-written in config.json as
 * `"workspaces": { "3": "backend" }` (config-as-code; the Settings GUI for
 * this arrives in M4). config.json is user-edited: validate every entry at
 * the boundary and drop anything malformed rather than throwing.
 */
export function parseWorkspaceNames(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const n = Number(key)
    if (!Number.isInteger(n) || n < WORKSPACE_MIN || n > WORKSPACE_MAX) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    out[String(n)] = trimmed
  }
  return out
}

/** Reads names fresh from config.json — hand edits show up without a restart. */
export function loadWorkspaceNames(configFile: string): Record<string, string> {
  try {
    const data: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
    return parseWorkspaceNames((data as { workspaces?: unknown } | null)?.workspaces)
  } catch {
    return {}
  }
}
