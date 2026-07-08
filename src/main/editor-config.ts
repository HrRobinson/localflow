import { readFileSync } from 'node:fs'

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

/**
 * Quote-aware command-line splitter: double- and single-quoted spans keep
 * their spaces as one token (macOS editor paths routinely contain spaces —
 * "/Applications/Visual Studio Code.app/..."), adjacent quoted/bare spans
 * join shell-style, and an unbalanced quote returns null (the caller treats
 * the command as unavailable rather than guessing). The tokens are handed to
 * spawn as an argv array — no shell ever sees this string.
 *
 * NOTE: the M4 branch is building a similar splitArgs — post-wave dedup
 * follow-up; keep this signature simple.
 */
export function splitCommandLine(raw: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
    } else {
      current += ch
      inToken = true
    }
  }
  if (quote) return null
  if (inToken) tokens.push(current)
  return tokens
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
