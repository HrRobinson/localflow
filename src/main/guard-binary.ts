import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ResolveGuardOptions {
  packaged: boolean
  repoRoot: string
  resourcesPath: string
  exists?: (p: string) => boolean
}

/**
 * Locate the bundled `lfguard` binary. Dev builds it into the cargo
 * workspace target dir; packaged apps bundle it via electron-builder
 * extraResources to `resourcesPath/lfguard`. Returns null when absent so
 * callers fail open (run the agent unguarded rather than broken).
 */
export function resolveGuardBinary(opts: ResolveGuardOptions): string | null {
  const exists = opts.exists ?? existsSync
  const path = opts.packaged
    ? join(opts.resourcesPath, 'lfguard')
    : join(opts.repoRoot, 'guard', 'target', 'release', 'lfguard')
  return exists(path) ? path : null
}
