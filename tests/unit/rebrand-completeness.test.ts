import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LEGACY_PRODUCT_NAME,
  LEGACY_SKILL_KEY,
  MIGRATION_MARKER,
  RENAMED_ENV_VARS
} from '../../src/main/legacy-names'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The only files allowed to still say the old name after the rename:
 * the module whose whole job is remembering it, its test, this gate itself,
 * and the two rebrand documents that describe the change.
 */
const EXEMPT = new Set([
  'src/main/legacy-names.ts',
  'tests/unit/legacy-names.test.ts',
  'tests/unit/rebrand-completeness.test.ts',
  'docs/superpowers/specs/2026-07-21-localflow-to-saiife-rebrand-design.md',
  'docs/superpowers/plans/2026-07-21-localflow-to-saiife-rebrand.md',
  'docs/superpowers/notes/2026-07-21-rebrand-distribution-decision.md',
  'docs/superpowers/notes/2026-07-21-rebrand-safestorage-verification.md'
])

const SEARCH_PATHS = [
  'src',
  'guard/crates',
  'guard/Cargo.toml',
  'guard/Cargo.lock',
  'openclaw',
  'docs',
  'tests',
  '.github',
  'assets',
  'package.json',
  'electron-builder.yml',
  'README.md',
  'CONTRIBUTING.md'
]

/**
 * Renaming the GitHub repo is out of scope, so `github.com/HrRobinson/localflow`
 * must survive the sweep. That is the ONLY line-level exception.
 */
const ALLOWED_LINE = /github\.com\/HrRobinson\/localflow/

/** `<path>:<lineno>:<text>` for every content match, case-insensitively. */
function matchingLines(pattern: string): string[] {
  try {
    const out = execFileSync('grep', ['-rIn', '-i', '-e', pattern, ...SEARCH_PATHS], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    return out.split('\n').filter((line) => line.length > 0)
  } catch (err) {
    // grep exits 1 with empty output when nothing matched; anything else is real.
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

/** Files with at least one match that is neither exempt nor an allowed repo URL. */
function offendingFiles(pattern: string): string[] {
  const files = new Set<string>()
  for (const line of matchingLines(pattern)) {
    const file = line.slice(0, line.indexOf(':'))
    if (EXEMPT.has(file)) continue
    if (ALLOWED_LINE.test(line)) continue
    files.add(file)
  }
  return [...files].sort()
}

describe('rebrand completeness', () => {
  it('no non-exempt file mentions the old product name', () => {
    expect(offendingFiles('localflow')).toEqual([])
  })

  it('no non-exempt file mentions the old guard binary name', () => {
    expect(offendingFiles('lfguard')).toEqual([])
  })

  it('the exempt module still remembers the old names', () => {
    expect(LEGACY_PRODUCT_NAME).toBe('localflow')
    expect(LEGACY_SKILL_KEY).toBe('localflow')
    expect(MIGRATION_MARKER).toBe('.migrated-from-localflow.json')
    expect(RENAMED_ENV_VARS.map((v) => v.legacy)).toEqual([
      'LOCALFLOW_CLAUDE_BIN',
      'LOCALFLOW_OPENCLAW_BIN',
      'LOCALFLOW_LAZYGIT_BIN',
      'LOCALFLOW_EDITOR_BIN'
    ])
    expect(RENAMED_ENV_VARS.map((v) => v.current)).toEqual([
      'SAIIFE_CLAUDE_BIN',
      'SAIIFE_OPENCLAW_BIN',
      'SAIIFE_LAZYGIT_BIN',
      'SAIIFE_EDITOR_BIN'
    ])
  })
})

describe('rebrand identifiers', () => {
  it('electron-builder declares the saiife identity and guard binary', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('appId: dev.hrrobinson.saiife')
    expect(yml).toContain('productName: saiife')
    expect(yml).toContain('from: guard/target/release/saiifeguard')
    expect(yml).toContain('to: saiifeguard')
    expect(yml).not.toContain('productName: Saiife')
    expect(yml).not.toContain('productName: SAIIFE')
  })

  it('package.json is named saiife and keeps the repository URL', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      name: string
      description: string
      repository: { url: string }
    }
    expect(pkg.name).toBe('saiife')
    expect(pkg.description).toBe(
      'Mission control for Claude Code sessions - one window, many agents, glanceable status.'
    )
    expect(pkg.repository.url).toBe('https://github.com/HrRobinson/localflow.git')
  })

  it('the guard crate declares saiifeguard as package, bin and lib', () => {
    const toml = readFileSync(join(repoRoot, 'guard/crates/saiifeguard/Cargo.toml'), 'utf8')
    expect(toml.match(/name = "saiifeguard"/g)).toHaveLength(3)
    const workspace = readFileSync(join(repoRoot, 'guard/Cargo.toml'), 'utf8')
    expect(workspace).toContain('members = ["crates/saiifeguard"]')
    expect(workspace).toContain('repository = "https://github.com/HrRobinson/localflow"')
  })

  it('the preload bridge and its type are renamed', () => {
    const preload = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8')
    expect(preload).toContain("contextBridge.exposeInMainWorld('saiife', api)")
    expect(preload).toContain('SaiifeApi')
    const dts = readFileSync(join(repoRoot, 'src/preload/index.d.ts'), 'utf8')
    expect(dts).toContain('saiife: SaiifeApi')
  })

  it('the guard binary resolver points at saiifeguard', () => {
    const resolver = readFileSync(join(repoRoot, 'src/main/guard-binary.ts'), 'utf8')
    expect(resolver).toContain("join(opts.resourcesPath, 'saiifeguard')")
    expect(resolver).toContain("'guard', 'target', 'release', 'saiifeguard'")
  })
})
