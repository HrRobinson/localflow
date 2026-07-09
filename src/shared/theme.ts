/**
 * A theme is design tokens: the app palette (surfaces, text, the five status
 * colors), an xterm terminal palette (background/foreground/cursor + 16 ansi),
 * and font family/size. Themes live as JSON in userData/themes/<name>.json and
 * are applied live — app tokens as :root CSS variables (Tailwind v4 @theme
 * vars are runtime-overridable) and the terminal palette as an xterm ITheme.
 */
export interface Theme {
  name: string
  app: {
    surface: string
    surfaceRaised: string
    sidebar: string
    text: string
    working: string
    needsYou: string
    idle: string
    running: string
    exited: string
  }
  terminal: {
    background: string
    foreground: string
    cursor: string
    selectionBackground: string
    /** 16 colors: black..white then bright black..bright white. */
    ansi: string[]
  }
  font: {
    family: string
    size: number
  }
}

/** The subset of xterm's ITheme this app sets. */
export interface XtermTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

const MONO = 'ui-monospace, SF Mono, Menlo, monospace'

/** Built-in dark default — the current shipped look (styles.css + xterm). */
export const DEFAULT_THEME: Theme = {
  name: 'dark',
  app: {
    surface: '#111318',
    surfaceRaised: '#1a1b1e',
    sidebar: '#141519',
    text: '#e5e7eb',
    working: '#3b82f6',
    needsYou: '#eab308',
    idle: '#22c55e',
    running: '#8b5cf6',
    exited: '#6b7280'
  },
  terminal: {
    background: '#1a1b1e',
    foreground: '#e5e7eb',
    cursor: '#e5e7eb',
    selectionBackground: '#ffffff40',
    ansi: [
      '#000000',
      '#cd3131',
      '#0dbc79',
      '#e5e510',
      '#2472c8',
      '#bc3fbc',
      '#11a8cd',
      '#e5e5e5',
      '#666666',
      '#f14c4c',
      '#23d18b',
      '#f5f543',
      '#3b8eea',
      '#d670d6',
      '#29b8db',
      '#e5e5e5'
    ]
  },
  font: { family: MONO, size: 12 }
}

const LIGHT_THEME: Theme = {
  name: 'light',
  app: {
    surface: '#f5f5f4',
    surfaceRaised: '#ffffff',
    sidebar: '#ececec',
    text: '#1c1917',
    working: '#2563eb',
    needsYou: '#b45309',
    idle: '#15803d',
    running: '#7c3aed',
    exited: '#9ca3af'
  },
  terminal: {
    background: '#ffffff',
    foreground: '#1c1917',
    cursor: '#1c1917',
    selectionBackground: '#00000022',
    ansi: [
      '#000000',
      '#cd3131',
      '#00bc00',
      '#949800',
      '#0451a5',
      '#bc05bc',
      '#0598bc',
      '#555555',
      '#666666',
      '#cd3131',
      '#14ce14',
      '#b5ba00',
      '#0451a5',
      '#bc05bc',
      '#0598bc',
      '#a5a5a5'
    ]
  },
  font: { family: MONO, size: 12 }
}

// Two popular terminal palettes on the dark app chrome (Solarized Dark, Nord).
const SOLARIZED_DARK_THEME: Theme = {
  name: 'solarized-dark',
  app: { ...DEFAULT_THEME.app },
  terminal: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    selectionBackground: '#073642',
    ansi: [
      '#073642',
      '#dc322f',
      '#859900',
      '#b58900',
      '#268bd2',
      '#d33682',
      '#2aa198',
      '#eee8d5',
      '#002b36',
      '#cb4b16',
      '#586e75',
      '#657b83',
      '#839496',
      '#6c71c4',
      '#93a1a1',
      '#fdf6e3'
    ]
  },
  font: { family: MONO, size: 12 }
}

const NORD_THEME: Theme = {
  name: 'nord',
  app: { ...DEFAULT_THEME.app },
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    ansi: [
      '#3b4252',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#88c0d0',
      '#e5e9f0',
      '#4c566a',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#8fbcbb',
      '#eceff4'
    ]
  },
  font: { family: MONO, size: 12 }
}

export const PRESET_THEMES: Theme[] = [DEFAULT_THEME, LIGHT_THEME, SOLARIZED_DARK_THEME, NORD_THEME]

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Validates a hand-written or shipped theme structurally (colors are any
 * non-empty string — CSS accepts names and hex alike). Returns null on any
 * shape violation; callers fall back to the default with a visible notice.
 */
export function parseTheme(raw: unknown): Theme | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const t = raw as Record<string, unknown>
  if (!isStr(t.name)) return null
  const app = t.app as Record<string, unknown> | undefined
  if (typeof app !== 'object' || app === null) return null
  const appKeys = [
    'surface',
    'surfaceRaised',
    'sidebar',
    'text',
    'working',
    'needsYou',
    'idle',
    'running',
    'exited'
  ] as const
  for (const k of appKeys) if (!isStr(app[k])) return null
  const term = t.terminal as Record<string, unknown> | undefined
  if (typeof term !== 'object' || term === null) return null
  for (const k of ['background', 'foreground', 'cursor', 'selectionBackground'] as const) {
    if (!isStr(term[k])) return null
  }
  const ansi = term.ansi
  if (!Array.isArray(ansi) || ansi.length !== 16 || !ansi.every(isStr)) return null
  const font = t.font as Record<string, unknown> | undefined
  if (typeof font !== 'object' || font === null) return null
  if (!isStr(font.family) || typeof font.size !== 'number' || !Number.isFinite(font.size)) {
    return null
  }
  return {
    name: t.name as string,
    app: {
      surface: app.surface as string,
      surfaceRaised: app.surfaceRaised as string,
      sidebar: app.sidebar as string,
      text: app.text as string,
      working: app.working as string,
      needsYou: app.needsYou as string,
      idle: app.idle as string,
      running: app.running as string,
      exited: app.exited as string
    },
    terminal: {
      background: term.background as string,
      foreground: term.foreground as string,
      cursor: term.cursor as string,
      selectionBackground: term.selectionBackground as string,
      ansi: ansi as string[]
    },
    font: { family: font.family as string, size: font.size as number }
  }
}

/** App tokens → the CSS custom properties the renderer sets on :root. */
export function themeToCssVars(theme: Theme): Record<string, string> {
  const a = theme.app
  return {
    '--color-working': a.working,
    '--working': a.working,
    '--color-needs-you': a.needsYou,
    '--needs-you': a.needsYou,
    '--color-idle': a.idle,
    '--idle': a.idle,
    '--color-running': a.running,
    '--running': a.running,
    '--color-exited': a.exited,
    '--exited': a.exited,
    '--color-surface': a.surface,
    '--bg': a.surface,
    '--color-surface-raised': a.surfaceRaised,
    '--pane-bg': a.surfaceRaised,
    '--color-sidebar': a.sidebar,
    '--text': a.text
  }
}

/** Terminal tokens → an xterm ITheme plus font options. */
export function themeToXterm(theme: Theme): {
  theme: XtermTheme
  fontFamily: string
  fontSize: number
} {
  const t = theme.terminal
  const c = t.ansi
  return {
    theme: {
      background: t.background,
      foreground: t.foreground,
      cursor: t.cursor,
      selectionBackground: t.selectionBackground,
      black: c[0],
      red: c[1],
      green: c[2],
      yellow: c[3],
      blue: c[4],
      magenta: c[5],
      cyan: c[6],
      white: c[7],
      brightBlack: c[8],
      brightRed: c[9],
      brightGreen: c[10],
      brightYellow: c[11],
      brightBlue: c[12],
      brightMagenta: c[13],
      brightCyan: c[14],
      brightWhite: c[15]
    },
    fontFamily: theme.font.family,
    fontSize: theme.font.size
  }
}
