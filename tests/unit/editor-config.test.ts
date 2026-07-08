import { describe, it, expect } from 'vitest'
import { parseEditorCommand, DEFAULT_EDITOR_COMMAND } from '../../src/main/editor-config'

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
