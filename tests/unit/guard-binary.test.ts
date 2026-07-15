import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolveGuardBinary } from '../../src/main/guard-binary'

describe('resolveGuardBinary', () => {
  const repoRoot = '/repo'
  const resourcesPath = '/app/Resources'

  it('dev: resolves to guard/target/release/lfguard when present', () => {
    const p = resolveGuardBinary({ packaged: false, repoRoot, resourcesPath, exists: () => true })
    expect(p).toBe(join(repoRoot, 'guard', 'target', 'release', 'lfguard'))
  })

  it('packaged: resolves to resourcesPath/lfguard when present', () => {
    const p = resolveGuardBinary({ packaged: true, repoRoot, resourcesPath, exists: () => true })
    expect(p).toBe(join(resourcesPath, 'lfguard'))
  })

  it('returns null when the binary is absent (fail-open)', () => {
    const p = resolveGuardBinary({ packaged: true, repoRoot, resourcesPath, exists: () => false })
    expect(p).toBeNull()
  })
})
