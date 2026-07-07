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
  | 'new-session'
  | 'go-up'

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
  'new-session': 'cmd+enter',
  'go-up': 'cmd+escape'
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

  // Check key case-insensitively
  return binding.key.toLowerCase() === e.key.toLowerCase()
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
