import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  LEGACY_PRODUCT_NAME,
  LEGACY_SKILL_KEY,
  MIGRATION_MARKER,
  legacyUserDataDir,
  userDataDirFor,
  RENAMED_ENV_VARS,
  readRenamedEnv
} from '../../src/main/legacy-names'

describe('legacy name constants', () => {
  it('still spells the pre-rebrand product name', () => {
    expect(LEGACY_PRODUCT_NAME).toBe('localflow')
  })

  it('still spells the pre-rebrand OpenClaw skill key', () => {
    expect(LEGACY_SKILL_KEY).toBe('localflow')
  })

  it('names the migration marker after the directory it came from', () => {
    expect(MIGRATION_MARKER).toBe('.migrated-from-localflow.json')
  })
})

describe('userDataDirFor', () => {
  const home = '/Users/ada'

  it('darwin: Application Support under the home dir', () => {
    expect(userDataDirFor('saiife', { platform: 'darwin', env: {}, home })).toBe(
      join(home, 'Library', 'Application Support', 'saiife')
    )
  })

  it('win32: APPDATA when set', () => {
    expect(
      userDataDirFor('saiife', { platform: 'win32', env: { APPDATA: 'C:/Users/ada/AppData/Roaming' }, home })
    ).toBe(join('C:/Users/ada/AppData/Roaming', 'saiife'))
  })

  it('win32: falls back to AppData/Roaming when APPDATA is unset', () => {
    expect(userDataDirFor('saiife', { platform: 'win32', env: {}, home })).toBe(
      join(home, 'AppData', 'Roaming', 'saiife')
    )
  })

  it('win32: treats an empty APPDATA as unset', () => {
    expect(userDataDirFor('saiife', { platform: 'win32', env: { APPDATA: '' }, home })).toBe(
      join(home, 'AppData', 'Roaming', 'saiife')
    )
  })

  it('linux: XDG_CONFIG_HOME when set', () => {
    expect(
      userDataDirFor('saiife', { platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home })
    ).toBe(join('/xdg', 'saiife'))
  })

  it('linux: falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    expect(userDataDirFor('saiife', { platform: 'linux', env: {}, home })).toBe(
      join(home, '.config', 'saiife')
    )
  })

  it('freebsd and other unixes follow the linux rule', () => {
    expect(userDataDirFor('saiife', { platform: 'freebsd', env: {}, home })).toBe(
      join(home, '.config', 'saiife')
    )
  })
})

describe('legacyUserDataDir', () => {
  const home = '/Users/ada'

  it('resolves the pre-rebrand directory, not a sibling of the new one', () => {
    expect(legacyUserDataDir({ platform: 'darwin', env: {}, home })).toBe(
      join(home, 'Library', 'Application Support', 'localflow')
    )
    expect(legacyUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home })).toBe(
      join('/xdg', 'localflow')
    )
    expect(legacyUserDataDir({ platform: 'win32', env: { APPDATA: 'C:/roaming' }, home })).toBe(
      join('C:/roaming', 'localflow')
    )
  })
})

describe('RENAMED_ENV_VARS', () => {
  it('pairs every renamed variable with its pre-rebrand spelling', () => {
    expect(RENAMED_ENV_VARS.map((v) => [v.current, v.legacy])).toEqual([
      ['SAIIFE_CLAUDE_BIN', 'LOCALFLOW_CLAUDE_BIN'],
      ['SAIIFE_OPENCLAW_BIN', 'LOCALFLOW_OPENCLAW_BIN'],
      ['SAIIFE_LAZYGIT_BIN', 'LOCALFLOW_LAZYGIT_BIN'],
      ['SAIIFE_EDITOR_BIN', 'LOCALFLOW_EDITOR_BIN']
    ])
  })
})

describe('readRenamedEnv', () => {
  it('returns the current variable when it is set', () => {
    const seen: string[] = []
    const value = readRenamedEnv({ SAIIFE_CLAUDE_BIN: '/new/claude' }, 'SAIIFE_CLAUDE_BIN', (m) =>
      seen.push(m)
    )
    expect(value).toBe('/new/claude')
    expect(seen).toEqual([])
  })

  it('falls back to the legacy variable and logs a deprecation notice', () => {
    const seen: string[] = []
    const value = readRenamedEnv(
      { LOCALFLOW_CLAUDE_BIN: '/old/claude' },
      'SAIIFE_CLAUDE_BIN',
      (m) => seen.push(m)
    )
    expect(value).toBe('/old/claude')
    expect(seen).toEqual([
      'LOCALFLOW_CLAUDE_BIN is deprecated and will be removed in a future release — rename it to SAIIFE_CLAUDE_BIN.'
    ])
  })

  it('prefers the current variable and stays silent when both are set', () => {
    const seen: string[] = []
    const value = readRenamedEnv(
      { SAIIFE_OPENCLAW_BIN: '/new/oc', LOCALFLOW_OPENCLAW_BIN: '/old/oc' },
      'SAIIFE_OPENCLAW_BIN',
      (m) => seen.push(m)
    )
    expect(value).toBe('/new/oc')
    expect(seen).toEqual([])
  })

  it('returns undefined and stays silent when neither is set', () => {
    const seen: string[] = []
    expect(readRenamedEnv({}, 'SAIIFE_EDITOR_BIN', (m) => seen.push(m))).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('treats an empty string as unset on both names', () => {
    const seen: string[] = []
    expect(
      readRenamedEnv(
        { SAIIFE_LAZYGIT_BIN: '', LOCALFLOW_LAZYGIT_BIN: '/old/lazygit' },
        'SAIIFE_LAZYGIT_BIN',
        (m) => seen.push(m)
      )
    ).toBe('/old/lazygit')
    expect(
      readRenamedEnv({ SAIIFE_LAZYGIT_BIN: '', LOCALFLOW_LAZYGIT_BIN: '' }, 'SAIIFE_LAZYGIT_BIN', (m) =>
        seen.push(m)
      )
    ).toBeUndefined()
    expect(seen).toHaveLength(1)
  })

  it('returns undefined for a name that has no legacy pairing', () => {
    const seen: string[] = []
    expect(readRenamedEnv({}, 'SAIIFE_NOT_A_REAL_VAR', (m) => seen.push(m))).toBeUndefined()
    expect(seen).toEqual([])
  })
})
