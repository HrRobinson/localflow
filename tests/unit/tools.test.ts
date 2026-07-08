import { describe, it, expect } from 'vitest'
import { describeTool } from '../../src/main/tools'

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
