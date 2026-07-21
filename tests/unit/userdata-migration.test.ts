import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyUserDataDir, MIGRATION_MARKER } from '../../src/main/legacy-names'
import { describeMigration, migrateLegacyUserData } from '../../src/main/userdata-migration'

const PLATFORM: NodeJS.Platform = 'linux'
const ENV: NodeJS.ProcessEnv = {}

let root: string
let home: string
let newDir: string
let legacyDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'userdata-migration-'))
  home = join(root, 'home')
  newDir = join(root, 'new-userdata')
  mkdirSync(home, { recursive: true })
  legacyDir = legacyUserDataDir({ platform: PLATFORM, env: ENV, home })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const run = (): ReturnType<typeof migrateLegacyUserData> =>
  migrateLegacyUserData({ newDir, platform: PLATFORM, env: ENV, home, overridden: false })

const ENC_BYTES = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x0a])

function seedLegacy(): void {
  mkdirSync(join(legacyDir, 'themes'), { recursive: true })
  mkdirSync(join(legacyDir, 'captures', 'wp1'), { recursive: true })
  mkdirSync(join(legacyDir, 'guard-seen'), { recursive: true })
  writeFileSync(join(legacyDir, 'config.json'), '{"theme":"nord"}')
  writeFileSync(join(legacyDir, 'sessions.json'), '{"sessions":[],"groups":[]}')
  writeFileSync(join(legacyDir, 'keybindings.json'), '{"close-pane":"cmd+w"}')
  writeFileSync(join(legacyDir, 'flows.json'), '[{"id":"f1","name":"nightly"}]')
  writeFileSync(join(legacyDir, 'integration-secrets.enc'), ENC_BYTES)
  writeFileSync(join(legacyDir, 'hosted-token.enc'), ENC_BYTES)
  writeFileSync(join(legacyDir, 'guard-audit.jsonl'), '{"ts":1}\n{"ts":2}\n')
  writeFileSync(join(legacyDir, 'airtable-cursors.json'), '{"tbl1":"rec9"}')
  writeFileSync(join(legacyDir, 'operator-grant-3.json'), '{"token":"t"}')
  writeFileSync(join(legacyDir, 'openclaw.json'), '{}')
  writeFileSync(join(legacyDir, 'themes', 'nord.json'), '{"name":"nord"}')
  writeFileSync(join(legacyDir, 'captures', 'wp1', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e]))
  writeFileSync(join(legacyDir, 'guard-seen', 'pane-1'), 'seen')
}

describe('migrateLegacyUserData', () => {
  it('copies the whole legacy tree when the new dir is empty', () => {
    seedLegacy()
    const outcome = run()
    expect(outcome.status).toBe('copied')
    expect(existsSync(join(newDir, 'config.json'))).toBe(true)
    expect(existsSync(join(newDir, 'flows.json'))).toBe(true)
    expect(existsSync(join(newDir, 'hosted-token.enc'))).toBe(true)
    expect(existsSync(join(newDir, 'airtable-cursors.json'))).toBe(true)
    expect(existsSync(join(newDir, 'operator-grant-3.json'))).toBe(true)
    expect(existsSync(join(newDir, 'openclaw.json'))).toBe(true)
  })

  it('leaves the legacy dir completely intact — copy, never move', () => {
    seedLegacy()
    run()
    expect(existsSync(join(legacyDir, 'config.json'))).toBe(true)
    expect(existsSync(join(legacyDir, 'flows.json'))).toBe(true)
    expect(readFileSync(join(legacyDir, 'integration-secrets.enc'))).toEqual(ENC_BYTES)
    expect(existsSync(join(legacyDir, 'themes', 'nord.json'))).toBe(true)
  })

  it('copies nested directories intact, not flattened', () => {
    seedLegacy()
    run()
    expect(existsSync(join(newDir, 'themes', 'nord.json'))).toBe(true)
    expect(existsSync(join(newDir, 'captures', 'wp1', 'shot.png'))).toBe(true)
    expect(existsSync(join(newDir, 'guard-seen', 'pane-1'))).toBe(true)
    expect(existsSync(join(newDir, 'nord.json'))).toBe(false)
    expect(existsSync(join(newDir, 'shot.png'))).toBe(false)
  })

  it('copies .enc and .jsonl payloads byte-for-byte', () => {
    seedLegacy()
    run()
    expect(readFileSync(join(newDir, 'integration-secrets.enc'))).toEqual(ENC_BYTES)
    expect(readFileSync(join(newDir, 'hosted-token.enc'))).toEqual(ENC_BYTES)
    expect(readFileSync(join(newDir, 'guard-audit.jsonl'), 'utf8')).toBe('{"ts":1}\n{"ts":2}\n')
  })

  it('writes a marker so the next launch is cheap', () => {
    seedLegacy()
    run()
    const marker = JSON.parse(readFileSync(join(newDir, MIGRATION_MARKER), 'utf8')) as {
      from: string
      copied: number
    }
    expect(marker.from).toBe(legacyDir)
    expect(marker.copied).toBeGreaterThan(0)
  })

  it('is a no-op when the new dir already has config.json — new config wins', () => {
    seedLegacy()
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'config.json'), '{"theme":"gruvbox"}')
    const outcome = run()
    expect(outcome).toEqual({ status: 'skipped', reason: 'new-data-present' })
    expect(readFileSync(join(newDir, 'config.json'), 'utf8')).toBe('{"theme":"gruvbox"}')
    expect(existsSync(join(newDir, 'flows.json'))).toBe(false)
  })

  it('is a no-op when the marker is already present', () => {
    seedLegacy()
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, MIGRATION_MARKER), '{}')
    expect(run()).toEqual({ status: 'skipped', reason: 'already-migrated' })
    expect(existsSync(join(newDir, 'flows.json'))).toBe(false)
  })

  it('is a clean no-op when neither dir exists', () => {
    expect(run()).toEqual({ status: 'skipped', reason: 'no-legacy-dir' })
    expect(existsSync(newDir)).toBe(false)
  })

  it('is a no-op when the new dir IS the legacy dir (pre-rename builds)', () => {
    seedLegacy()
    const outcome = migrateLegacyUserData({
      newDir: legacyDir,
      platform: PLATFORM,
      env: ENV,
      home,
      overridden: false
    })
    expect(outcome).toEqual({ status: 'skipped', reason: 'same-directory' })
  })

  it('is a no-op when userData was overridden (e2e runs must not touch a real home)', () => {
    seedLegacy()
    const outcome = migrateLegacyUserData({
      newDir,
      platform: PLATFORM,
      env: ENV,
      home,
      overridden: true
    })
    expect(outcome).toEqual({ status: 'skipped', reason: 'user-data-overridden' })
    expect(existsSync(newDir)).toBe(false)
  })

  it('records non-regular entries as failures and still copies the rest', () => {
    seedLegacy()
    symlinkSync(join(root, 'nowhere'), join(legacyDir, 'dangling'))
    const outcome = run()
    expect(outcome.status).toBe('copied')
    if (outcome.status !== 'copied') throw new Error('unreachable')
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]).toContain('dangling')
    expect(existsSync(join(newDir, 'config.json'))).toBe(true)
    expect(existsSync(join(newDir, 'themes', 'nord.json'))).toBe(true)
  })

  it('never overwrites a file that already exists in the new dir', () => {
    seedLegacy()
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'flows.json'), '[{"id":"newer"}]')
    run()
    expect(readFileSync(join(newDir, 'flows.json'), 'utf8')).toBe('[{"id":"newer"}]')
    expect(existsSync(join(newDir, 'config.json'))).toBe(true)
  })

  it('reports failure and never throws when the legacy path is unreadable', () => {
    mkdirSync(join(root, 'home', '.config'), { recursive: true })
    writeFileSync(legacyDir, 'this is a file, not a directory')
    const outcome = run()
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('unreachable')
    expect(outcome.legacyDir).toBe(legacyDir)
    expect(outcome.error.length).toBeGreaterThan(0)
    expect(existsSync(join(newDir, MIGRATION_MARKER))).toBe(false)
  })
})

describe('describeMigration', () => {
  it('names the reason for a skip', () => {
    expect(describeMigration({ status: 'skipped', reason: 'no-legacy-dir' })).toBe(
      'no migration needed (no-legacy-dir)'
    )
  })

  it('reports a clean copy with a count', () => {
    expect(
      describeMigration({ status: 'copied', legacyDir: '/old', copied: 12, failures: [] })
    ).toBe('copied 12 file(s) from /old')
  })

  it('reports skipped entries alongside a partial copy', () => {
    expect(
      describeMigration({
        status: 'copied',
        legacyDir: '/old',
        copied: 12,
        failures: ['/old/x: EACCES']
      })
    ).toBe('copied 12 file(s) from /old; 1 entry skipped: /old/x: EACCES')
  })

  it('reports a failure as a fresh start, not a crash', () => {
    expect(describeMigration({ status: 'failed', legacyDir: '/old', error: 'ENOTDIR' })).toBe(
      'could not read /old — starting with a fresh config (ENOTDIR)'
    )
  })
})
