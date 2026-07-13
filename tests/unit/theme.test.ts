import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THEME,
  PRESET_THEMES,
  parseTheme,
  themeToCssVars,
  themeToXterm
} from '../../src/shared/theme'

describe('parseTheme', () => {
  it('accepts a well-formed theme (a shipped preset round-trips)', () => {
    for (const preset of PRESET_THEMES) {
      expect(parseTheme(JSON.parse(JSON.stringify(preset)))).toEqual(preset)
    }
  })
  it('rejects non-objects and arrays', () => {
    expect(parseTheme(null)).toBeNull()
    expect(parseTheme('nope')).toBeNull()
    expect(parseTheme([1, 2])).toBeNull()
  })
  it('rejects a theme missing app palette fields', () => {
    const bad = { ...DEFAULT_THEME, app: { ...DEFAULT_THEME.app, working: 123 } }
    expect(parseTheme(bad)).toBeNull()
  })
  it('rejects a terminal palette without 16 ansi colors', () => {
    const bad = {
      ...DEFAULT_THEME,
      terminal: { ...DEFAULT_THEME.terminal, ansi: DEFAULT_THEME.terminal.ansi.slice(0, 8) }
    }
    expect(parseTheme(bad)).toBeNull()
  })
  it('rejects a non-numeric font size', () => {
    const bad = { ...DEFAULT_THEME, font: { ...DEFAULT_THEME.font, size: '12' } }
    expect(parseTheme(bad)).toBeNull()
  })
  it('defaults app.border to the built-in default when absent (pre-border user themes)', () => {
    const legacy = { ...DEFAULT_THEME, app: { ...DEFAULT_THEME.app } } as Record<string, unknown>
    delete (legacy.app as Record<string, unknown>).border
    const parsed = parseTheme(legacy)
    expect(parsed).not.toBeNull()
    expect(parsed!.app.border).toBe(DEFAULT_THEME.app.border)
  })
  it('keeps an explicit app.border from a hand-written theme', () => {
    const custom = { ...DEFAULT_THEME, app: { ...DEFAULT_THEME.app, border: '#ff00ff' } }
    expect(parseTheme(custom)!.app.border).toBe('#ff00ff')
  })
})

describe('themeToCssVars', () => {
  it('maps app tokens onto both the @theme and legacy var names', () => {
    const vars = themeToCssVars(DEFAULT_THEME)
    expect(vars['--color-surface']).toBe(DEFAULT_THEME.app.surface)
    expect(vars['--bg']).toBe(DEFAULT_THEME.app.surface)
    expect(vars['--color-surface-raised']).toBe(DEFAULT_THEME.app.surfaceRaised)
    expect(vars['--pane-bg']).toBe(DEFAULT_THEME.app.surfaceRaised)
    expect(vars['--color-working']).toBe(DEFAULT_THEME.app.working)
    expect(vars['--working']).toBe(DEFAULT_THEME.app.working)
    expect(vars['--text']).toBe(DEFAULT_THEME.app.text)
    expect(vars['--border']).toBe(DEFAULT_THEME.app.border)
  })
  it('a different theme produces a different surface probe var', () => {
    const light = PRESET_THEMES.find((t) => t.name === 'light')!
    expect(themeToCssVars(light)['--color-surface']).not.toBe(
      themeToCssVars(DEFAULT_THEME)['--color-surface']
    )
  })
  it('emits a different --border for the light preset than the dark default', () => {
    const light = PRESET_THEMES.find((t) => t.name === 'light')!
    expect(themeToCssVars(light)['--border']).toBe(light.app.border)
    expect(themeToCssVars(light)['--border']).not.toBe(themeToCssVars(DEFAULT_THEME)['--border'])
  })
})

describe('themeToXterm', () => {
  it('maps ansi[0..15] onto the xterm ITheme names + background/foreground', () => {
    const { theme, fontSize } = themeToXterm(DEFAULT_THEME)
    expect(theme.background).toBe(DEFAULT_THEME.terminal.background)
    expect(theme.foreground).toBe(DEFAULT_THEME.terminal.foreground)
    expect(theme.black).toBe(DEFAULT_THEME.terminal.ansi[0])
    expect(theme.brightWhite).toBe(DEFAULT_THEME.terminal.ansi[15])
    expect(fontSize).toBe(DEFAULT_THEME.font.size)
  })
})
