import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { devNull } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep as pathSep } from 'node:path'
import { capDiff, parsePorcelain, type DiffResult, type GitStatus } from '../shared/git'

const GIT_TIMEOUT_MS = 5000
// Roomy enough that a large-but-viewable diff still comes through to be capped
// by capDiff; a truly enormous diff overruns this and is reported as too large.
const DIFF_EXEC_MAXBUFFER = 8 * 1024 * 1024
// Status output is small (one line per changed path), but a repo with a huge
// number of changes could still be large — match the diff budget so an overflow
// resolves as an execFile error (→ friendly repo:false) rather than throwing.
const STATUS_EXEC_MAXBUFFER = 8 * 1024 * 1024
// core.quotepath=false keeps non-ASCII paths readable (as a leading global
// option, BEFORE the subcommand). Read-only commands only.
const QUOTE_OFF = ['-c', 'core.quotepath=false']

// The friendly, never-throw shapes returned when git can't/shouldn't run.
const NO_REPO: GitStatus = { repo: false }
const EMPTY_DIFF: DiffResult = { text: '', truncated: false }

interface GitRun {
  code: number
  stdout: string
}

/** Run a read-only git command in `cwd`. Never throws — a non-repo/missing-git
 *  error resolves with a non-zero code and empty stdout. */
function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: STATUS_EXEC_MAXBUFFER, windowsHide: true },
      (err, stdout) => {
        // NOTE: a maxBuffer overflow surfaces here as an error, so this reports
        // code:1 and the caller degrades to repo:false — an acceptable, safe
        // failure (no partial/garbled status) for the rare giant-status repo.
        const raw = (err as { code?: unknown } | null)?.code
        const code = typeof raw === 'number' ? raw : err ? 1 : 0
        resolve({ code, stdout: stdout ?? '' })
      }
    )
  })
}

/**
 * Confine a candidate path to the repo toplevel, returning the RESOLVED ABSOLUTE
 * path only when it is strictly inside `toplevel`, else null. It runs BEFORE
 * any git spawn so a renderer-supplied path can never reach `git diff
 * --no-index`, which has NO repository boundary and would otherwise read any
 * OS-readable file. Rejects NUL bytes, empty inputs, the toplevel itself, and
 * anything resolving to `..`/outside. Also rejects anything under the repo's
 * `.git` directory: those paths are never emitted by status, so a request for
 * one (e.g. `.git/config`, which can hold embedded remote credentials) is
 * hostile by construction.
 * `toplevel` is absolute (from `git rev-parse --show-toplevel`).
 *
 * Two passes: first a cheap LEXICAL check (string/segment based, no syscalls),
 * then a REALPATH re-check — a directory component inside the repo can be a
 * symlink to anywhere on disk (e.g. an untracked `etcdir -> /etc`), which
 * lexically resolves under `toplevel` and would otherwise pass, but resolves
 * OUTSIDE it once symlinks are followed. The realpath pass closes that hole.
 */
export function confinePath(toplevel: string, candidate: string): string | null {
  if (!toplevel || !candidate) return null
  if (toplevel.includes('\0') || candidate.includes('\0')) return null
  const resolved = resolve(toplevel, candidate)
  const rel = relative(toplevel, resolved)
  const sep = sepFor(rel)
  // Empty → the path IS the toplevel; '..'-prefixed or absolute → outside.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null
  }
  // Reject if ANY path segment is `.git` (case-folded). Case-insensitive
  // filesystems (macOS APFS, Windows) make `.GIT` the same directory, and a
  // nested/submodule `.git` (e.g. `a/.git/config`) is git metadata too. Status
  // never emits such paths, so any request for one is hostile by construction.
  // Exact per-segment match — `.gitignore`/`.github/…`/`.git-credentials`
  // (different segments) still pass.
  if (rel.split(sep).some((s) => s.toLowerCase() === '.git')) return null
  if (!realpathContained(toplevel, resolved)) return null
  return resolved
}

// relative() uses the platform separator; derive it from the value so the
// dotdot check is correct on both POSIX ('/') and Windows ('\').
function sepFor(rel: string): string {
  return rel.includes('\\') ? '\\' : '/'
}

/**
 * Re-check containment AFTER resolving symlinks, so a symlinked directory
 * component inside the repo (e.g. `etcdir -> /etc`) that lexically passes the
 * checks above cannot smuggle an out-of-tree read through git's `--no-index`
 * fallback (which has no repository boundary of its own).
 *
 * `toplevel` comes from `git rev-parse --show-toplevel`, which already prints
 * a symlink-resolved path — but it's realpath'd here too, cheaply, rather
 * than trusting that invariant across callers.
 *
 * `resolvedCandidate` usually exists (the --no-index caller diffs an existing
 * untracked file), but stays robust when it doesn't: walks up to the nearest
 * EXISTING ancestor directory and realpaths that instead — a symlinked
 * directory is what matters for the escape, and that's always an existing
 * ancestor even when the leaf name is fabricated.
 *
 * Any realpath failure (ENOENT on the whole chain, a broken symlink, a
 * permission error) is treated as reject — a safe default, not a pass.
 */
function realpathContained(toplevel: string, resolvedCandidate: string): boolean {
  try {
    const realTop = realpathSync.native(toplevel)
    let probe = resolvedCandidate
    while (!existsSync(probe)) {
      const parent = dirname(probe)
      if (parent === probe) return false // hit the filesystem root; nothing exists
      probe = parent
    }
    const realProbe = realpathSync.native(probe)
    return realProbe === realTop || realProbe.startsWith(`${realTop}${pathSep}`)
  } catch {
    return false
  }
}

/** The repo toplevel for `cwd`, or null when it is not a git repo / git is
 *  absent. Read-only. */
async function repoToplevel(cwd: string): Promise<string | null> {
  // runGit already runs with execFile's cwd set to `cwd`, so no `-C` needed.
  const res = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (res.code !== 0) return null
  const top = res.stdout.trim()
  return top.length > 0 ? top : null
}

/** Working-tree status; `repo:false` when the cwd is not a git repo (git exits
 *  128), git is absent, or any unexpected execFile rejection occurs. */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!cwd) return NO_REPO
  try {
    const res = await runGit(cwd, [
      ...QUOTE_OFF,
      'status',
      '--porcelain=v1',
      '--untracked-files=all'
    ])
    if (res.code !== 0) return NO_REPO
    return { repo: true, files: parsePorcelain(res.stdout) }
  } catch {
    // Belt-and-suspenders: an invalid argv (e.g. NUL byte) rejects execFile
    // synchronously inside the Promise executor; funnel it to the friendly
    // shape so the IPC handler never sees a rejection.
    return NO_REPO
  }
}

/** Run a diff command, capping output; a maxBuffer overrun becomes an empty
 *  truncated result (the renderer shows "diff too large"). */
function runDiff(cwd: string, args: string[]): Promise<DiffResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_EXEC_MAXBUFFER, windowsHide: true },
      (err, stdout) => {
        // A maxBuffer overrun raises ERR_CHILD_PROCESS_STDIO_MAXBUFFER — report
        // it as truncated so the renderer shows "diff too large".
        if ((err as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ text: '', truncated: true })
          return
        }
        resolve(capDiff(stdout ?? ''))
      }
    )
  })
}

/**
 * Diff for one path at one layer. `staged` → `git diff --cached`; otherwise the
 * worktree diff. The path is confined to the repo toplevel FIRST (see
 * confinePath) and the RESOLVED ABSOLUTE path is what git sees — this both
 * blocks reading files outside the repo and removes relative-path ambiguity
 * when the session cwd is a repo subdirectory (porcelain paths are
 * toplevel-relative). An untracked file has no worktree diff, so it falls back
 * to `--no-index` against the null device, rendering as a full-file addition.
 */
export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<DiffResult> {
  if (!cwd || !path) return EMPTY_DIFF
  try {
    const toplevel = await repoToplevel(cwd)
    if (toplevel === null) return EMPTY_DIFF
    const safe = confinePath(toplevel, path)
    if (safe === null) return EMPTY_DIFF
    const base = [...QUOTE_OFF, 'diff', '--no-color']
    const first = await runDiff(
      cwd,
      staged ? [...base, '--cached', '--', safe] : [...base, '--', safe]
    )
    if (staged || first.text.trim().length > 0 || first.truncated) return first
    // Untracked: synthesize a full-addition diff. --no-index exits 1
    // ("differences found"), not an error; runDiff returns stdout regardless of
    // exit code. `safe` is confirmed inside the repo, so --no-index cannot be
    // steered to an out-of-tree file.
    return await runDiff(cwd, [
      ...QUOTE_OFF,
      'diff',
      '--no-color',
      '--no-index',
      '--',
      devNull,
      safe
    ])
  } catch {
    // Funnel any unexpected execFile rejection to the friendly shape so the IPC
    // handler never sees a rejection cross the bridge.
    return EMPTY_DIFF
  }
}
