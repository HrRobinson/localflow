import { describe, it, expect } from 'vitest'
import {
  editorLaunch,
  parseEditorCommand,
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

describe('editorLaunch', () => {
  it('appends the cwd as the last argv entry', () => {
    expect(editorLaunch('code', '/tmp/proj')).toEqual({ bin: 'code', args: ['/tmp/proj'] })
  })

  it('keeps configured args ahead of the cwd', () => {
    expect(editorLaunch('code -n --wait', '/tmp/proj')).toEqual({
      bin: 'code',
      args: ['-n', '--wait', '/tmp/proj']
    })
  })

  it('keeps quoted spans (paths with spaces) as one token', () => {
    expect(editorLaunch('"/Applications/Visual Studio Code.app/code" -n', '/tmp/proj')).toEqual({
      bin: '/Applications/Visual Studio Code.app/code',
      args: ['-n', '/tmp/proj']
    })
  })

  it('treats an unbalanced quote as unavailable', () => {
    expect(editorLaunch('code "-n', '/tmp/proj')).toBeNull()
  })

  it('treats an empty command as unavailable', () => {
    expect(editorLaunch('', '/tmp/proj')).toBeNull()
    expect(editorLaunch('   ', '/tmp/proj')).toBeNull()
  })
})
