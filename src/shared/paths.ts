import type { SessionInfo } from './types'

/**
 * Cheap syntactic check for a typed path input, before any expansion —
 * absolute (`/...`) or home-relative (`~` or `~/...`). Renderer components
 * use this to enable/disable submit affordances and flag invalid input as
 * the user types. The authoritative check (with a real home directory) is
 * `expandTypedPath`, re-run at the main-process IPC boundary before the
 * value is persisted or used to spawn anything.
 */
export function looksLikeTypedPath(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed.length === 0) return false
  return trimmed.startsWith('/') || trimmed.startsWith('~')
}

/**
 * Expands a leading `~` (exactly, or as `~/...`) to `home`, then requires
 * the result to be an absolute path. Pure — takes `home` as a parameter
 * instead of reaching for `node:os` itself, so it works from both `main`
 * (real `os.homedir()`) and unit tests (a fixture string). `~otheruser/...`
 * is intentionally not expanded (no way to resolve another user's home
 * portably) and so is rejected, same as any other relative path.
 */
export function expandTypedPath(input: string, home: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  let expanded = trimmed
  if (expanded === '~') expanded = home
  else if (expanded.startsWith('~/')) expanded = home + expanded.slice(1)
  return expanded.startsWith('/') ? expanded : null
}

/**
 * Sensible default working directory for a new session: the most recently
 * created terminal session's cwd (sessions are returned oldest-first, same
 * order `SessionManager.list()`/`session:list` already guarantee — Landing's
 * own "Latest sessions" list relies on the same ordering), falling back to
 * `home` when there is none (fresh install, or every session is a browser
 * pane with no filesystem cwd).
 */
export function resolveDefaultCwd(
  sessions: Pick<SessionInfo, 'cwd' | 'kind'>[],
  home: string
): string {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i]
    if (s.kind !== 'browser' && s.cwd) return s.cwd
  }
  return home
}
