import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_BINDINGS, mergeBindings, type KeyAction } from '../shared/keybindings'

/**
 * Loads keybindings from `file`, creating it with defaults if missing.
 * On a corrupt/unreadable file, logs one warning and returns defaults
 * without touching the user's file.
 */
export function loadOrCreateKeybindings(file: string): Record<KeyAction, string> {
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_BINDINGS, null, 2))
    return { ...DEFAULT_BINDINGS }
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return mergeBindings(parsed)
  } catch (err) {
    console.warn(`localflow: failed to read keybindings file at ${file}, using defaults`, err)
    return { ...DEFAULT_BINDINGS }
  }
}

/** Overwrites the keybindings file with the full merged map (GUI edits). */
export function writeKeybindings(file: string, bindings: Record<KeyAction, string>): void {
  writeFileSync(file, JSON.stringify(bindings, null, 2))
}
