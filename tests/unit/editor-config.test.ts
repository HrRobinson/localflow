import { describe, it, expect } from 'vitest'
import {
  parseEditorCommand,
  splitCommandLine,
  DEFAULT_EDITOR_COMMAND
} from '../../src/main/editor-config'

describe('parseEditorCommand', () => {
  it('defaults to code when absent or malformed', () => {
    expect(parseEditorCommand({})).toBe(DEFAULT_EDITOR_COMMAND)
    expect(parseEditorCommand(null)).toBe(DEFAULT_EDITOR_COMMAND)
    expect(parseEditorCommand([1, 2])).toBe(DEFAULT_EDITOR_COMMAND)
    expect(parseEditorCommand({ editorCommand: '' })).toBe(DEFAULT_EDITOR_COMMAND)
    expect(parseEditorCommand({ editorCommand: '   ' })).toBe(DEFAULT_EDITOR_COMMAND)
    expect(parseEditorCommand({ editorCommand: 42 })).toBe(DEFAULT_EDITOR_COMMAND)
  })

  it('takes a non-empty string, trimmed (args preserved)', () => {
    expect(parseEditorCommand({ editorCommand: '  subl  ' })).toBe('subl')
    expect(parseEditorCommand({ editorCommand: 'code -n' })).toBe('code -n')
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
  })

  it('returns null on an unbalanced quote', () => {
    expect(splitCommandLine('code "-n')).toBeNull()
    expect(splitCommandLine("code '-n")).toBeNull()
  })

  it('returns no tokens for empty input', () => {
    expect(splitCommandLine('')).toEqual([])
    expect(splitCommandLine('   ')).toEqual([])
  })
})
