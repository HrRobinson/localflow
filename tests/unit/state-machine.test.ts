import { describe, it, expect } from 'vitest'
import { transition } from '../../src/main/state-machine'

describe('transition', () => {
  it('goes working on UserPromptSubmit', () => {
    expect(transition('idle', 'UserPromptSubmit')).toBe('working')
  })
  it('goes needs-you on Notification', () => {
    expect(transition('working', 'Notification')).toBe('needs-you')
  })
  it('goes idle on Stop', () => {
    expect(transition('working', 'Stop')).toBe('idle')
    expect(transition('needs-you', 'Stop')).toBe('idle')
  })
  it('goes exited on pty-exit from any state', () => {
    expect(transition('working', 'pty-exit')).toBe('exited')
    expect(transition('idle', 'pty-exit')).toBe('exited')
  })
  it('exited is terminal — late hook events are ignored', () => {
    expect(transition('exited', 'Stop')).toBe('exited')
    expect(transition('exited', 'UserPromptSubmit')).toBe('exited')
  })
})
