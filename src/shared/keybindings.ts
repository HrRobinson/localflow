export type KeyAction =
  | 'focus-left'
  | 'focus-down'
  | 'focus-up'
  | 'focus-right'
  | 'swap-left'
  | 'swap-down'
  | 'swap-up'
  | 'swap-right'
  | 'enlarge-toggle'
  | 'close-pane'
  | 'add-pane'
  | 'group-pane'
  | 'ungroup-pane'
  | 'open-editor'
  | 'new-session'
  | 'go-up'
  | 'toggle-sidebar'
  | 'focus-needs-you'
  | 'environment-1'
  | 'environment-2'
  | 'environment-3'
  | 'environment-4'
  | 'environment-5'
  | 'environment-6'
  | 'environment-7'
  | 'environment-8'
  | 'environment-9'
  | 'move-to-environment-1'
  | 'move-to-environment-2'
  | 'move-to-environment-3'
  | 'move-to-environment-4'
  | 'move-to-environment-5'
  | 'move-to-environment-6'
  | 'move-to-environment-7'
  | 'move-to-environment-8'
  | 'move-to-environment-9'
  | 'console-toggle'

export const DEFAULT_BINDINGS: Record<KeyAction, string> = {
  'focus-left': 'cmd+h',
  'focus-down': 'cmd+j',
  'focus-up': 'cmd+k',
  'focus-right': 'cmd+l',
  'swap-left': 'cmd+shift+h',
  'swap-down': 'cmd+shift+j',
  'swap-up': 'cmd+shift+k',
  'swap-right': 'cmd+shift+l',
  'enlarge-toggle': 'cmd+m',
  'close-pane': 'cmd+w',
  'add-pane': 'cmd+t',
  'group-pane': 'cmd+g',
  'ungroup-pane': 'cmd+shift+g',
  'open-editor': 'cmd+e',
  'new-session': 'cmd+enter',
  'go-up': 'cmd+escape',
  'toggle-sidebar': 'cmd+b',
  'focus-needs-you': 'cmd+u',
  'environment-1': 'cmd+1',
  'environment-2': 'cmd+2',
  'environment-3': 'cmd+3',
  'environment-4': 'cmd+4',
  'environment-5': 'cmd+5',
  'environment-6': 'cmd+6',
  'environment-7': 'cmd+7',
  'environment-8': 'cmd+8',
  'environment-9': 'cmd+9',
  'move-to-environment-1': 'ctrl+1',
  'move-to-environment-2': 'ctrl+2',
  'move-to-environment-3': 'ctrl+3',
  'move-to-environment-4': 'ctrl+4',
  'move-to-environment-5': 'ctrl+5',
  'move-to-environment-6': 'ctrl+6',
  'move-to-environment-7': 'ctrl+7',
  'move-to-environment-8': 'ctrl+8',
  'move-to-environment-9': 'ctrl+9',
  'console-toggle': 'cmd+/'
}

/**
 * Typed `Object.entries` for a bindings record: every key of a
 * `Record<KeyAction, string>` is by construction a known `KeyAction`, but
 * `Object.entries` always widens keys to `string` — this centralizes the one
 * cast that fact requires instead of scattering `as KeyAction` at call sites.
 */
export function bindingEntries(bindings: Record<KeyAction, string>): [KeyAction, string][] {
  return Object.entries(bindings) as [KeyAction, string][]
}

export interface ParsedBinding {
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** KeyboardEvent.code — needed to identify digits under shift (key becomes '!' etc.). */
  code?: string
}

const NAMED_KEY_MAP: Record<string, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  space: ' ',
  'arrow-left': 'ArrowLeft',
  'arrow-right': 'ArrowRight',
  'arrow-up': 'ArrowUp',
  'arrow-down': 'ArrowDown'
}

export function parseBinding(binding: string): ParsedBinding | null {
  if (!binding || typeof binding !== 'string') {
    return null
  }

  const parts = binding.split('+')
  if (parts.length < 2) {
    return null
  }

  const result: ParsedBinding = {
    cmd: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: ''
  }

  const modifiers = new Set<string>()

  // Process all parts except the last one as modifiers
  for (let i = 0; i < parts.length - 1; i++) {
    const modifier = parts[i].toLowerCase()
    if (modifiers.has(modifier)) {
      return null // Duplicate modifier
    }
    modifiers.add(modifier)

    if (modifier === 'cmd') {
      result.cmd = true
    } else if (modifier === 'ctrl') {
      result.ctrl = true
    } else if (modifier === 'alt') {
      result.alt = true
    } else if (modifier === 'shift') {
      result.shift = true
    } else {
      return null // Unknown modifier
    }
  }

  // Last part is the key
  const keyPart = parts[parts.length - 1]
  if (!keyPart) {
    return null // Empty key
  }

  const keyLower = keyPart.toLowerCase()

  // Check if it's a named key
  if (NAMED_KEY_MAP[keyLower]) {
    result.key = NAMED_KEY_MAP[keyLower]
  } else if (keyPart.length === 1) {
    // Single character key, lowercase it
    result.key = keyPart.toLowerCase()
  } else {
    // Unknown named key or invalid key
    return null
  }

  return result
}

export function eventMatches(binding: ParsedBinding, e: KeyEventLike): boolean {
  // Check modifiers exactly
  if (
    binding.cmd !== e.metaKey ||
    binding.ctrl !== e.ctrlKey ||
    binding.alt !== e.altKey ||
    binding.shift !== e.shiftKey
  ) {
    return false
  }

  // Digits need physical-key matching: shift+1 reports key '!' (layout-
  // dependent), so a digit binding also accepts the matching e.code.
  if (/^[0-9]$/.test(binding.key) && e.code === `Digit${binding.key}`) {
    return true
  }

  // Check key case-insensitively
  return binding.key.toLowerCase() === e.key.toLowerCase()
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

// Inverse of NAMED_KEY_MAP: KeyboardEvent.key/'code' spelling -> binding token.
const NAMED_KEY_REVERSE: Record<string, string> = {
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  ' ': 'space',
  ArrowLeft: 'arrow-left',
  ArrowRight: 'arrow-right',
  ArrowUp: 'arrow-up',
  ArrowDown: 'arrow-down'
}

/**
 * Turns a captured KeyboardEvent into the binding grammar (`cmd+shift+x`),
 * or null when the press is not a committable binding yet: a bare modifier
 * (still waiting for the real key) or a key with no modifier (bindings
 * require at least one, matching parseBinding). Modifiers are emitted in the
 * canonical order cmd, ctrl, alt, shift. Digits come from e.code so a
 * shift-mangled e.key ('!' for '1') still serializes to the physical digit.
 */
export function serializeKeyEvent(e: KeyEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const mods: string[] = []
  if (e.metaKey) mods.push('cmd')
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (mods.length === 0) return null

  const digit = e.code ? /^Digit([0-9])$/.exec(e.code) : null
  let key: string
  if (digit) {
    key = digit[1]
  } else if (NAMED_KEY_REVERSE[e.key]) {
    key = NAMED_KEY_REVERSE[e.key]
  } else if (e.code && /^Key([A-Z])$/.test(e.code)) {
    key = e.code.slice(3).toLowerCase()
  } else if (e.key.length === 1) {
    key = e.key.toLowerCase()
  } else {
    return null
  }
  return [...mods, key].join('+')
}

/**
 * Other actions whose current binding parses to the same combo as `binding`
 * would for `action`. The editor shows these instead of silently letting two
 * actions collide. Returns [] when the candidate is unparseable (nothing to
 * conflict with yet).
 */
export function findConflicts(
  bindings: Record<KeyAction, string>,
  action: KeyAction,
  binding: string
): KeyAction[] {
  const target = parseBinding(binding)
  if (!target) return []
  return bindingEntries(bindings)
    .filter(([a, b]) => {
      if (a === action) return false
      const p = parseBinding(b)
      return (
        p != null &&
        p.cmd === target.cmd &&
        p.ctrl === target.ctrl &&
        p.alt === target.alt &&
        p.shift === target.shift &&
        p.key.toLowerCase() === target.key.toLowerCase()
      )
    })
    .map(([a]) => a)
}

/**
 * Result of attempting a single rebind. The editor needs to distinguish
 * "that string is not a binding" from "that combo is taken by X", so
 * rejections carry a reason plus the conflicting actions.
 */
export type BindingChangeResult =
  | { ok: true; bindings: Record<KeyAction, string>; changed: boolean }
  | { ok: false; reason: 'invalid' | 'conflict'; conflicts: KeyAction[] }

/**
 * Validates and applies one rebind, pure: unparseable bindings and combos
 * already held by another action are rejected (the spec's "conflicts are
 * shown, not silently allowed" — main's IPC is the gatekeeper for
 * keybindings.json). Re-setting the current value is a successful no-op
 * (`changed: false`, same map back) so callers can skip the write + push.
 * Never mutates the input map; an accepted change returns a fresh copy.
 */
export function applyBindingChange(
  bindings: Record<KeyAction, string>,
  action: KeyAction,
  binding: string
): BindingChangeResult {
  if (parseBinding(binding) === null) return { ok: false, reason: 'invalid', conflicts: [] }
  const conflicts = findConflicts(bindings, action, binding)
  if (conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts }
  if (bindings[action] === binding) return { ok: true, bindings, changed: false }
  return { ok: true, bindings: { ...bindings, [action]: binding }, changed: true }
}

export function mergeBindings(user: unknown): Record<KeyAction, string> {
  // Start with defaults
  const result = { ...DEFAULT_BINDINGS }

  // Only process if user is an object (but not null, array, etc.)
  if (user === null || user === undefined || typeof user !== 'object' || Array.isArray(user)) {
    return result
  }

  // Get all known KeyActions for validation
  const knownActions = new Set<string>(Object.keys(DEFAULT_BINDINGS))

  // Iterate through user object
  for (const [key, value] of Object.entries(user)) {
    // Only process if it's a known action and the value is a string
    if (knownActions.has(key) && typeof value === 'string') {
      // Try to parse the binding
      const parsed = parseBinding(value)
      if (parsed !== null) {
        result[key as KeyAction] = value
      }
    }
  }

  return result
}
