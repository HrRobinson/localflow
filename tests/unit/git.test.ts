import { describe, it, expect } from 'vitest'
import { parsePorcelain, capDiff, classifyDiffLine, DIFF_MAX_CHARS } from '../../src/shared/git'

describe('parsePorcelain', () => {
  it('classifies staged, unstaged, both, and untracked', () => {
    const out = ['A  staged.txt', ' M tracked.txt', 'MM both.txt', '?? new.txt', ''].join('\n')
    const files = parsePorcelain(out)
    expect(files).toHaveLength(4)
    const by = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(by['staged.txt']).toMatchObject({ staged: true, unstaged: false, untracked: false })
    expect(by['tracked.txt']).toMatchObject({ staged: false, unstaged: true, untracked: false })
    expect(by['both.txt']).toMatchObject({ staged: true, unstaged: true, untracked: false })
    expect(by['new.txt']).toMatchObject({ staged: false, unstaged: false, untracked: true })
  })

  it('ignores blank and too-short lines', () => {
    expect(parsePorcelain('\n\nX')).toEqual([])
  })

  it('parses a rename: current path on the right, origPath on the left', () => {
    const [f] = parsePorcelain('R  old-name.txt -> new-name.txt')
    expect(f.path).toBe('new-name.txt')
    expect(f.origPath).toBe('old-name.txt')
    expect(f.staged).toBe(true)
  })
})

describe('capDiff', () => {
  it('passes short diffs through untruncated', () => {
    expect(capDiff('small')).toEqual({ text: 'small', truncated: false })
  })

  it('truncates over the cap and flags it', () => {
    const big = 'x'.repeat(DIFF_MAX_CHARS + 10)
    const r = capDiff(big)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(DIFF_MAX_CHARS)
  })

  it('honors an explicit cap', () => {
    expect(capDiff('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
  })
})

describe('classifyDiffLine', () => {
  it('tags add/del/hunk and never miscolors file headers', () => {
    expect(classifyDiffLine('+added')).toBe('add')
    expect(classifyDiffLine('-removed')).toBe('del')
    expect(classifyDiffLine('@@ -1,2 +1,2 @@')).toBe('hunk')
    expect(classifyDiffLine('+++ b/file')).toBe('meta')
    expect(classifyDiffLine('--- a/file')).toBe('meta')
    expect(classifyDiffLine('diff --git a/f b/f')).toBe('meta')
    expect(classifyDiffLine(' context')).toBe('context')
  })
})
