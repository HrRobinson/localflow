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
  })
  it('a different theme produces a different surface probe var', () => {
    const light = PRESET_THEMES.find((t) => t.name === 'light')!
    expect(themeToCssVars(light)['--color-surface']).not.toBe(
      themeToCssVars(DEFAULT_THEME)['--color-surface']
    )
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
