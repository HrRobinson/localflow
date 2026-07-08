import { describe, it, expect } from 'vitest'
import { extractPeekLines } from '../../src/main/peek'

describe('extractPeekLines', () => {
  it('returns the last N non-empty lines', () => {
    expect(extractPeekLines('one\ntwo\nthree\nfour\n', 2)).toEqual(['three', 'four'])
  })

  it('strips ANSI escapes and control bytes', () => {
    const raw = '[31mDo you want[0m to proceed?\n[1m> Yes / No[0m\n'
    expect(extractPeekLines(raw, 5)).toEqual(['Do you want to proceed?', '> Yes / No'])
  })

  it('drops blank and whitespace-only lines', () => {
    expect(extractPeekLines('a\n\n   \nb\n', 5)).toEqual(['a', 'b'])
  })

  it('handles CRLF line endings (\\r is stripped as a control byte)', () => {
    expect(extractPeekLines('first\r\nsecond\r\n', 5)).toEqual(['first', 'second'])
  })

  it('trims trailing whitespace per line', () => {
    expect(extractPeekLines('padded   \n', 5)).toEqual(['padded'])
  })

  it('returns [] for empty or escape-only input', () => {
    expect(extractPeekLines('', 5)).toEqual([])
    expect(extractPeekLines('[2J[H', 5)).toEqual([])
  })

  it('returns everything when fewer lines than maxLines', () => {
    expect(extractPeekLines('only\n', 5)).toEqual(['only'])
  })
})
