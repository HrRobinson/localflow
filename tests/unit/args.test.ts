import { describe, it, expect } from 'vitest'
import { splitArgs, splitCommandLine } from '../../src/shared/args'

describe('splitArgs', () => {
  it('splits on runs of whitespace', () => {
    expect(splitArgs('--model llama3')).toEqual(['--model', 'llama3'])
    expect(splitArgs('  --a   --b  ')).toEqual(['--a', '--b'])
  })
  it('returns [] for empty/whitespace input', () => {
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('   ')).toEqual([])
  })
  it('keeps double-quoted spans together', () => {
    expect(splitArgs('--prompt "hello world"')).toEqual(['--prompt', 'hello world'])
  })
  it('keeps single-quoted spans together', () => {
    expect(splitArgs("--x 'a b c' --y")).toEqual(['--x', 'a b c', '--y'])
  })
  it('supports empty quoted arguments', () => {
    expect(splitArgs('--flag ""')).toEqual(['--flag', ''])
  })
  it('flushes the trailing partial token on an unbalanced quote', () => {
    // No crash, no dropped input: an unterminated quote keeps consuming to
    // the end of the string and the partial token is flushed as one arg.
    expect(splitArgs('--x "unterminated span')).toEqual(['--x', 'unterminated span'])
    expect(splitArgs('"')).toEqual([''])
  })
  it('pins embedded-quote semantics: backslash is literal, never an escape', () => {
    // By design (see args.ts doc comment) there is no backslash escaping:
    // the backslash stays a literal character and the quote after it still
    // toggles quoting — so "a\"b" parses as a\b, not a"b.
    expect(splitArgs('--x "a\\"b"')).toEqual(['--x', 'a\\b'])
  })
})

describe('splitCommandLine', () => {
  it('splits plain words on whitespace', () => {
    expect(splitCommandLine('code')).toEqual(['code'])
    expect(splitCommandLine('code -n')).toEqual(['code', '-n'])
    expect(splitCommandLine('code   -n')).toEqual(['code', '-n'])
  })

  it('keeps double-quoted spans (spaces included) as one token', () => {
    expect(
      splitCommandLine('"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" -n')
    ).toEqual(['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '-n'])
  })

  it('keeps single-quoted spans as one token', () => {
    expect(splitCommandLine("'/opt/my editor/bin/edit' --wait")).toEqual([
      '/opt/my editor/bin/edit',
      '--wait'
    ])
  })

  it('joins quoted spans adjacent to bare text, shell-style', () => {
    expect(splitCommandLine('pre"fix mid"post')).toEqual(['prefix midpost'])
    expect(splitArgs('pre"fix mid"post')).toEqual(['prefix midpost'])
  })

  it('returns null on an unbalanced quote (where splitArgs flushes)', () => {
    expect(splitCommandLine('code "-n')).toBeNull()
    expect(splitCommandLine("code '-n")).toBeNull()
    expect(splitCommandLine('"')).toBeNull()
  })

  it('returns no tokens for empty input', () => {
    expect(splitCommandLine('')).toEqual([])
    expect(splitCommandLine('   ')).toEqual([])
  })

  it('supports empty quoted arguments, like splitArgs', () => {
    expect(splitCommandLine('--flag ""')).toEqual(['--flag', ''])
  })
})
