import { readFileSync } from 'node:fs'
import { splitCommandLine } from '../shared/args'

/** The editor spawned by "Open in editor" when config.json says nothing. */
export const DEFAULT_EDITOR_COMMAND = 'code'

/**
 * The `editorCommand` string from config.json (config-as-code; an unknown
 * top-level key preserved by AgentRegistry's `extra` mechanism). A whole command
 * line is allowed ("code -n"); it's split at spawn time. config.json is
 * user-edited, so validate at the boundary and fall back to the default.
 */
export function parseEditorCommand(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_EDITOR_COMMAND
  const value = (raw as { editorCommand?: unknown }).editorCommand
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : DEFAULT_EDITOR_COMMAND
}

/** Reads editorCommand fresh from config.json — hand edits apply without a restart. */
export function loadEditorCommand(configFile: string): string {
  try {
    const data: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
    return parseEditorCommand(data)
  } catch {
    return DEFAULT_EDITOR_COMMAND
  }
}

/** The binary token to resolve plus the argv it gets — never a shell string. */
export interface EditorLaunch {
  bin: string
  args: string[]
}

/**
 * Argv for launching the configured editor on a session's cwd: quote-aware
 * split ("code -n" keeps its flag, quoted paths keep their spaces), cwd
 * appended last. Null — treat the editor as unavailable — on an unbalanced
 * quote or an empty command; guessing at the user's intent here would spawn
 * the wrong thing.
 */
export function editorLaunch(command: string, cwd: string): EditorLaunch | null {
  const parts = splitCommandLine(command)
  const bin = parts?.[0]
  if (!parts || !bin) return null
  return { bin, args: [...parts.slice(1), cwd] }
}
