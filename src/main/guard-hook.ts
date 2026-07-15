export interface ResolvedGuard {
  bin: string
  auditLog: string
  packs: string[]
}

const SAFE_PANE_RE = /^[A-Za-z0-9-]+$/
const SAFE_PACK_RE = /^[A-Za-z0-9._-]+$/

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The shell command a pre-tool hook runs: invoke lfguard in exit-2 deny
 * mode with the active packs and per-pane audit tag. bin/auditLog are
 * single-quoted because macOS userData paths contain spaces.
 */
export function guardHookCommand(guard: ResolvedGuard, paneId: string): string {
  if (!SAFE_PANE_RE.test(paneId)) throw new Error('invalid paneId')
  const packFlags = guard.packs.filter((p) => SAFE_PACK_RE.test(p)).map((p) => `--pack ${p}`)
  return [
    shSingleQuote(guard.bin),
    'check',
    '--hook-exit',
    ...packFlags,
    '--audit-log',
    shSingleQuote(guard.auditLog),
    '--audit-tag',
    paneId
  ].join(' ')
}
