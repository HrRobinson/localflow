import { describe, it, expect } from 'vitest'
import {
  parseBinding,
  eventMatches,
  mergeBindings,
  serializeKeyEvent,
  findConflicts,
  DEFAULT_BINDINGS,
  type KeyAction,
  type ParsedBinding,
  type KeyEventLike
} from '../../src/shared/keybindings'

describe('parseBinding', () => {
  it('parses cmd+h', () => {
    const result = parseBinding('cmd+h')
    expect(result).toEqual({
      cmd: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'h'
    })
  })

  it('parses cmd+shift+h', () => {
    const result = parseBinding('cmd+shift+h')
    expect(result).toEqual({
      cmd: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: 'h'
    })
  })

  it('parses cmd+enter (named key)', () => {
    const result = parseBinding('cmd+enter')
    expect(result).toEqual({
      cmd: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'Enter'
    })
  })

  it('parses CMD+SHIFT+L (case insensitive)', () => {
    const result = parseBinding('CMD+SHIFT+L')
    expect(result).toEqual({
      cmd: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: 'l'
    })
  })

  it('parses ctrl+alt+x', () => {
    const result = parseBinding('ctrl+alt+x')
    expect(result).toEqual({
      cmd: false,
      ctrl: true,
      alt: true,
      shift: false,
      key: 'x'
    })
  })

  it('returns null for cmd+ (empty key)', () => {
    expect(parseBinding('cmd+')).toBeNull()
  })

  it('returns null for foo+h (unknown modifier)', () => {
    expect(parseBinding('foo+h')).toBeNull()
  })

  it('returns null for cmd+doesnotexist (unknown named key)', () => {
    expect(parseBinding('cmd+doesnotexist')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseBinding('')).toBeNull()
  })

  it('returns null for string with no + separator', () => {
    expect(parseBinding('h')).toBeNull()
  })
})

describe('eventMatches', () => {
  it('matches cmd+h with {key:h, metaKey:true, others:false}', () => {
    const binding: ParsedBinding = {
      cmd: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'h'
    }
    const event: KeyEventLike = {
      key: 'h',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }
    expect(eventMatches(binding, event)).toBe(true)
  })

  it('does not match when extra shift is pressed', () => {
    const binding: ParsedBinding = {
      cmd: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'h'
    }
    const event: KeyEventLike = {
      key: 'H',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true
    }
    expect(eventMatches(binding, event)).toBe(false)
  })

  it('does not match when ctrl is pressed instead of cmd', () => {
    const binding: ParsedBinding = {
      cmd: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'h'
    }
    const event: KeyEventLike = {
      key: 'h',
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false
    }
    expect(eventMatches(binding, event)).toBe(false)
  })

  it('matches named keys (cmd+enter vs Enter)', () => {
    const binding: ParsedBinding = {
      cmd: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'Enter'
    }
    const event: KeyEventLike = {
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }
    expect(eventMatches(binding, event)).toBe(true)
  })

  it('matches key comparison case-insensitively', () => {
    const binding: ParsedBinding = {
      cmd: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'a'
    }
    const event: KeyEventLike = {
      key: 'A',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }
    expect(eventMatches(binding, event)).toBe(true)
  })
})

describe('mergeBindings', () => {
  it('returns DEFAULT_BINDINGS when user is null', () => {
    const result = mergeBindings(null)
    expect(result).toEqual(DEFAULT_BINDINGS)
  })

  it('returns DEFAULT_BINDINGS when user is a string', () => {
    const result = mergeBindings('not an object')
    expect(result).toEqual(DEFAULT_BINDINGS)
  })

  it('overrides focus-left and keeps others with valid binding', () => {
    const user = { 'focus-left': 'ctrl+b' }
    const result = mergeBindings(user)
    expect(result['focus-left']).toBe('ctrl+b')
    // Check that other keys are from defaults
    expect(result['focus-down']).toBe(DEFAULT_BINDINGS['focus-down'])
    expect(result['focus-up']).toBe(DEFAULT_BINDINGS['focus-up'])
  })

  it('returns pure defaults when user has only invalid bindings', () => {
    const user = { 'focus-left': 'garbage+', evil: 'cmd+x', 42: 1 }
    const result = mergeBindings(user)
    expect(result).toEqual(DEFAULT_BINDINGS)
  })

  it('keeps defaults for unknown action names', () => {
    const user = { 'unknown-action': 'cmd+x' }
    const result = mergeBindings(user)
    expect(result).toEqual(DEFAULT_BINDINGS)
  })

  it('correctly merges valid overrides with defaults', () => {
    const user = {
      'focus-left': 'ctrl+h',
      'focus-down': 'ctrl+j',
      unknown: 'cmd+z'
    }
    const result = mergeBindings(user)
    expect(result['focus-left']).toBe('ctrl+h')
    expect(result['focus-down']).toBe('ctrl+j')
    expect(result['focus-up']).toBe(DEFAULT_BINDINGS['focus-up'])
  })
})

describe('DEFAULT_BINDINGS', () => {
  it('contains all KeyAction types', () => {
    const allActions: KeyAction[] = [
      'focus-left',
      'focus-down',
      'focus-up',
      'focus-right',
      'swap-left',
      'swap-down',
      'swap-up',
      'swap-right',
      'enlarge-toggle',
      'close-pane',
      'new-session',
      'go-up',
      'toggle-sidebar'
    ]
    allActions.forEach((action) => {
      expect(DEFAULT_BINDINGS).toHaveProperty(action)
      expect(typeof DEFAULT_BINDINGS[action]).toBe('string')
    })
  })

  it('has valid cmd-based bindings for navigation', () => {
    expect(DEFAULT_BINDINGS['focus-left']).toBe('cmd+h')
    expect(DEFAULT_BINDINGS['focus-down']).toBe('cmd+j')
    expect(DEFAULT_BINDINGS['focus-up']).toBe('cmd+k')
    expect(DEFAULT_BINDINGS['focus-right']).toBe('cmd+l')
  })

  it('has valid cmd+shift-based bindings for swaps', () => {
    expect(DEFAULT_BINDINGS['swap-left']).toBe('cmd+shift+h')
    expect(DEFAULT_BINDINGS['swap-down']).toBe('cmd+shift+j')
    expect(DEFAULT_BINDINGS['swap-up']).toBe('cmd+shift+k')
    expect(DEFAULT_BINDINGS['swap-right']).toBe('cmd+shift+l')
  })

  it('has named key bindings', () => {
    expect(DEFAULT_BINDINGS['new-session']).toBe('cmd+enter')
    expect(DEFAULT_BINDINGS['go-up']).toBe('cmd+escape')
    expect(DEFAULT_BINDINGS['toggle-sidebar']).toBe('cmd+b')
  })
})

describe('environment bindings', () => {
  it('defaults environment-N to cmd+N and move-to-environment-N to ctrl+N', () => {
    for (let n = 1; n <= 9; n++) {
      expect(DEFAULT_BINDINGS[`environment-${n}` as KeyAction]).toBe(`cmd+${n}`)
      expect(DEFAULT_BINDINGS[`move-to-environment-${n}` as KeyAction]).toBe(`ctrl+${n}`)
    }
  })

  it('matches a digit binding via e.code when shift turns the key into a symbol', () => {
    const parsed = parseBinding('cmd+shift+1')!
    // US layout: shift+1 reports key '!' — only e.code identifies the digit.
    const event = {
      key: '!',
      code: 'Digit1',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true
    }
    expect(eventMatches(parsed, event)).toBe(true)
  })

  it('still matches a plain digit binding via e.key without a code', () => {
    const parsed = parseBinding('cmd+3')!
    const event = { key: '3', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
    expect(eventMatches(parsed, event)).toBe(true)
  })

  it('does not cross-match different digits', () => {
    const parsed = parseBinding('cmd+shift+1')!
    const event = {
      key: '@',
      code: 'Digit2',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true
    }
    expect(eventMatches(parsed, event)).toBe(false)
  })

  it('letter bindings are unaffected by the code fallback', () => {
    const parsed = parseBinding('cmd+shift+h')!
    const event = {
      key: 'H',
      code: 'KeyH',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true
    }
    expect(eventMatches(parsed, event)).toBe(true)
  })
})

describe('serializeKeyEvent', () => {
  const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over
  })

  it('serializes a modifier + letter in canonical order', () => {
    expect(serializeKeyEvent(ev({ key: 'h', code: 'KeyH', metaKey: true }))).toBe('cmd+h')
    expect(serializeKeyEvent(ev({ key: 'H', code: 'KeyH', metaKey: true, shiftKey: true }))).toBe(
      'cmd+shift+h'
    )
    expect(serializeKeyEvent(ev({ key: 'x', code: 'KeyX', ctrlKey: true, altKey: true }))).toBe(
      'ctrl+alt+x'
    )
  })

  it('serializes digits from e.code even when shift mangles e.key', () => {
    expect(serializeKeyEvent(ev({ key: '3', code: 'Digit3', metaKey: true }))).toBe('cmd+3')
    // US layout: shift+1 reports '!' — the physical code still gives '1'.
    expect(serializeKeyEvent(ev({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }))).toBe(
      'cmd+shift+1'
    )
  })

  it('serializes named keys back to the binding grammar', () => {
    expect(serializeKeyEvent(ev({ key: 'Enter', code: 'Enter', metaKey: true }))).toBe('cmd+enter')
    expect(serializeKeyEvent(ev({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }))).toBe(
      'ctrl+arrow-left'
    )
    expect(serializeKeyEvent(ev({ key: ' ', code: 'Space', altKey: true }))).toBe('alt+space')
  })

  it('returns null for modifier-only and unmodified presses', () => {
    expect(serializeKeyEvent(ev({ key: 'Meta', metaKey: true }))).toBeNull()
    expect(serializeKeyEvent(ev({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(serializeKeyEvent(ev({ key: 'a', code: 'KeyA' }))).toBeNull()
  })

  it('round-trips through parseBinding', () => {
    const s = serializeKeyEvent(ev({ key: 'l', code: 'KeyL', metaKey: true, shiftKey: true }))!
    expect(parseBinding(s)).toEqual({ cmd: true, ctrl: false, alt: false, shift: true, key: 'l' })
  })
})

describe('findConflicts', () => {
  it('reports other actions sharing the same parsed combo', () => {
    const b = { ...DEFAULT_BINDINGS }
    // cmd+h is focus-left by default; assigning it to close-pane conflicts.
    expect(findConflicts(b, 'close-pane', 'cmd+h')).toEqual(['focus-left'])
  })

  it('ignores the action being edited and returns [] when free', () => {
    const b = { ...DEFAULT_BINDINGS }
    expect(findConflicts(b, 'focus-left', 'cmd+h')).toEqual([])
    expect(findConflicts(b, 'close-pane', 'cmd+y')).toEqual([])
  })

  it('treats a digit combo as conflicting regardless of key vs code', () => {
    const b = { ...DEFAULT_BINDINGS }
    // environment-1 defaults to cmd+1; binding new-session to cmd+1 conflicts.
    expect(findConflicts(b, 'new-session', 'cmd+1')).toEqual(['environment-1'])
  })

  it('returns [] for an unparseable candidate', () => {
    expect(findConflicts({ ...DEFAULT_BINDINGS }, 'close-pane', 'nonsense')).toEqual([])
  })
})
