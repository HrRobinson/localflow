import { describe, it, expect } from 'vitest'
import {
  parseBinding,
  eventMatches,
  mergeBindings,
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
      'go-up'
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
  })
})
