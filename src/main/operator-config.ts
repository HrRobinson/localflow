import { readFileSync } from 'node:fs'

/**
 * The `operatorRevokeOnExit` flag from config.json (config-as-code, like
 * `editorCommand`). Default OFF: a launch-owned grant normally survives pty
 * exit/close so a closed OpenClaw session restarts with its grant intact —
 * revoke happens only when the last launched session is DELETED. ON revokes
 * as soon as the last live pty of a launch-owned environment exits or is
 * closed. config.json is user-edited, so validate at the boundary: only a
 * literal `true` enables it.
 */
export function parseOperatorRevokeOnExit(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  return (raw as { operatorRevokeOnExit?: unknown }).operatorRevokeOnExit === true
}

/** Reads the flag fresh from config.json — hand edits apply without a restart. */
export function loadOperatorRevokeOnExit(configFile: string): boolean {
  try {
    return parseOperatorRevokeOnExit(JSON.parse(readFileSync(configFile, 'utf8')))
  } catch {
    return false
  }
}
