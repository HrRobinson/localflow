import { describe, it, expect } from 'vitest'
import { TerminalScreen } from '../../src/main/terminal-screen'

describe('TerminalScreen', () => {
  it('renders a redraw with SGR + cursor moves as a clean final frame', () => {
    const screen = new TerminalScreen(80, 24)
    // Clear screen, home cursor, paint a colored prompt (SGR 246), then a bold line.
    screen.write('\x1b[2J\x1b[H\x1b[38;5;246mDo you want to proceed?\x1b[0m\r\n')
    screen.write('\x1b[1m> 1. Yes\x1b[0m')
    const lines = screen.snapshot()
    const joined = lines.join('\n')
    expect(joined).toContain('Do you want to proceed?')
    expect(joined).toContain('> 1. Yes')
    // No escape fragments survive the emulator (the '246m'/ESC garbage the
    // byte-tail path leaked is gone).
    expect(joined).not.toContain('246m')
    expect(joined).not.toContain('\x1b')
  })

  it('trims trailing blank lines but keeps the painted rows', () => {
    const screen = new TerminalScreen(80, 24)
    screen.write('only one line')
    const lines = screen.snapshot()
    expect(lines).toEqual(['only one line'])
  })

  it('returns the last N non-empty lines when maxLines is given', () => {
    const screen = new TerminalScreen(80, 24)
    screen.write('a\r\nb\r\nc\r\nd\r\n')
    expect(screen.snapshot(2)).toEqual(['c', 'd'])
  })

  it('resize re-flows wrapping (a 25-char line wraps at width 20)', () => {
    const screen = new TerminalScreen(80, 24)
    screen.resize(20, 10)
    screen.write('0123456789012345678901234')
    expect(screen.snapshot().length).toBeGreaterThanOrEqual(2)
  })

  it('is throw-safe: use after dispose returns [] and never throws', () => {
    const screen = new TerminalScreen(80, 24)
    screen.write('hello')
    screen.dispose()
    expect(() => screen.write('x')).not.toThrow()
    expect(() => screen.resize(10, 10)).not.toThrow()
    expect(screen.snapshot()).toEqual([])
  })
})
