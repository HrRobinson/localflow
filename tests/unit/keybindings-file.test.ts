import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateKeybindings } from '../../src/main/keybindings-file'
import { DEFAULT_BINDINGS } from '../../src/shared/keybindings'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'localflow-kb-')), 'keybindings.json')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadOrCreateKeybindings', () => {
  it('creates the file with defaults when missing', () => {
    const file = tmpFile()
    expect(existsSync(file)).toBe(false)

    const result = loadOrCreateKeybindings(file)

    expect(result).toEqual(DEFAULT_BINDINGS)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_BINDINGS)
  })

  it('merges an existing file and leaves it untouched', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ 'focus-left': 'ctrl+b' }))

    const result = loadOrCreateKeybindings(file)

    expect(result).toEqual({ ...DEFAULT_BINDINGS, 'focus-left': 'ctrl+b' })
    expect(readFileSync(file, 'utf8')).toEqual(JSON.stringify({ 'focus-left': 'ctrl+b' }))
  })

  it('returns defaults and warns once on a corrupt file, without overwriting it', () => {
    const file = tmpFile()
    writeFileSync(file, 'garbage')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = loadOrCreateKeybindings(file)

    expect(result).toEqual(DEFAULT_BINDINGS)
    expect(readFileSync(file, 'utf8')).toBe('garbage')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
