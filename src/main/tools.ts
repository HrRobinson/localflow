import { isAbsolute } from 'node:path'
import type { ToolAvailability } from '../shared/git'

/** How (whether) a configured binary token may be resolved to a path. */
export type BinGate = 'absolute' | 'login-shell' | 'rejected'

/**
 * Bare names must be strict safe identifiers: `whichViaLoginShell` interpolates
 * its argument into a `command -v ${bin}` line executed by `$SHELL -ilc`, so a
 * config.json-sourced token containing shell metacharacters ($(...), ;, |,
 * backticks, spaces, ...) would be arbitrary code execution the moment
 * capabilities are probed. Only tokens vetted here may reach that resolver.
 */
const SAFE_BIN_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Security gate for a user-configured binary token (editorCommand's first
 * word). Absolute paths — spaces fine — are checked with existsSync and never
 * touch a shell; safe bare names keep the login-shell PATH lookup a GUI app
 * needs (nvm/homebrew paths for `code`, `cursor`, `subl`); everything else
 * (metacharacters, relative paths, `~`) is unresolvable.
 */
export function gateBin(bin: string): BinGate {
  if (isAbsolute(bin)) return 'absolute'
  if (SAFE_BIN_NAME.test(bin)) return 'login-shell'
  return 'rejected'
}

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
