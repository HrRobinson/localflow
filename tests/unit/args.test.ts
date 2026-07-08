import { describe, it, expect } from 'vitest'
import { splitArgs } from '../../src/shared/args'

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
})
