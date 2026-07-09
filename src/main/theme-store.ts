import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_THEME, PRESET_THEMES, parseTheme, type Theme } from '../shared/theme'

/** Writes each shipped preset into the themes dir if it is not already there. */
export function ensureThemesSeeded(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const preset of PRESET_THEMES) {
    const file = join(dir, `${preset.name}.json`)
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(preset, null, 2))
  }
}

/** Theme names available on disk (file basenames), sorted. */
export function listThemeNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
  } catch {
    return PRESET_THEMES.map((t) => t.name)
  }
}

/**
 * Resolves the configured theme. A null name (config `theme` absent) is the
 * built-in dark default. A named file that is missing/malformed falls back to
 * the default and carries a human notice — never throws, never crashes.
 */
export function resolveTheme(
  dir: string,
  name: string | null
): { name: string; theme: Theme; error?: string } {
  if (name === null) return { name: DEFAULT_THEME.name, theme: DEFAULT_THEME }
  try {
    const parsed = parseTheme(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')))
    if (parsed) return { name, theme: parsed }
  } catch {
    /* fall through to the default + notice */
  }
  return {
    name: DEFAULT_THEME.name,
    theme: DEFAULT_THEME,
    error: `Theme “${name}” is missing or malformed — using the default.`
  }
}
