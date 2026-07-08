import { execFile } from 'node:child_process'
import { devNull } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
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
 * path only when it is strictly inside `toplevel`, else null. Pure and lexical
 * (no symlink resolution) — it runs BEFORE any git spawn so a renderer-supplied
 * path can never reach `git diff --no-index`, which has NO repository boundary
 * and would otherwise read any OS-readable file. Rejects NUL bytes, empty
 * inputs, the toplevel itself, and anything resolving to `..`/outside.
 * `toplevel` is absolute (from `git rev-parse --show-toplevel`).
 */
export function confinePath(toplevel: string, candidate: string): string | null {
  if (!toplevel || !candidate) return null
  if (toplevel.includes('\0') || candidate.includes('\0')) return null
  const resolved = resolve(toplevel, candidate)
  const rel = relative(toplevel, resolved)
  // Empty → the path IS the toplevel; '..'-prefixed or absolute → outside.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sepFor(rel)}`) || isAbsolute(rel)) {
    return null
  }
  return resolved
}

// relative() uses the platform separator; derive it from the value so the
// dotdot check is correct on both POSIX ('/') and Windows ('\').
function sepFor(rel: string): string {
  return rel.includes('\\') ? '\\' : '/'
}

/** The repo toplevel for `cwd`, or null when it is not a git repo / git is
 *  absent. Read-only. */
async function repoToplevel(cwd: string): Promise<string | null> {
  const res = await runGit(cwd, ['-C', cwd, 'rev-parse', '--show-toplevel'])
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
