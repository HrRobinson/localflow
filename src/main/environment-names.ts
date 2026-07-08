import { readFileSync } from 'node:fs'

/**
 * Optional environment names, hand-written in config.json as
 * `"environments": { "3": "backend" }` (config-as-code; the Settings GUI for
 * this arrives in M4). config.json is user-edited: validate every entry at
 * the boundary and drop anything malformed rather than throwing.
 *
 * Only canonical single-digit keys "1"-"9" (the ENVIRONMENT_MIN..ENVIRONMENT_MAX
 * range) are accepted — numeric aliases like "01", "1.0", " 1", "1e0" are
 * dropped, not coerced, so they can never silently collide with the
 * canonical key.
 */
export function parseEnvironmentNames(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[1-9]$/.test(key)) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    out[key] = trimmed
  }
  return out
}

/** Reads names fresh from config.json — hand edits show up without a restart. */
export function loadEnvironmentNames(configFile: string): Record<string, string> {
  try {
    const data: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
    return parseEnvironmentNames((data as { environments?: unknown } | null)?.environments)
  } catch {
    return {}
  }
}
