import type { ToolAvailability } from '../shared/git'

/**
 * Pure availability gate for an escape-hatch tool: given the resolved absolute
 * path (or null), decide whether the button is enabled and what hint to show
 * when it isn't. Resolution itself (login-shell PATH lookup / env override)
 * lives in main's wiring; this is the testable decision.
 */
export function describeTool(name: string, resolvedPath: string | null): ToolAvailability {
  if (resolvedPath) return { path: resolvedPath, available: true }
  return { path: null, available: false, hint: `${name} not found on PATH` }
}
