import { execFile } from 'node:child_process'
import { devNull } from 'node:os'
import { capDiff, parsePorcelain, type DiffResult, type GitStatus } from '../shared/git'

const GIT_TIMEOUT_MS = 5000
// Roomy enough that a large-but-viewable diff still comes through to be capped
// by capDiff; a truly enormous diff overruns this and is reported as too large.
const DIFF_EXEC_MAXBUFFER = 8 * 1024 * 1024
// core.quotepath=false keeps non-ASCII paths readable (as a leading global
// option, BEFORE the subcommand). Read-only commands only.
const QUOTE_OFF = ['-c', 'core.quotepath=false']

interface GitRun {
  code: number
  stdout: string
}

/** Run a read-only git command in `cwd`. Never throws — a non-repo/missing-git
 *  error resolves with a non-zero code and empty stdout. */
function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      const raw = (err as { code?: unknown } | null)?.code
      const code = typeof raw === 'number' ? raw : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '' })
    })
  })
}

/** Working-tree status; `repo:false` when the cwd is not a git repo (git exits
 *  128) or git is absent. */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!cwd) return { repo: false }
  const res = await runGit(cwd, [...QUOTE_OFF, 'status', '--porcelain=v1', '--untracked-files=all'])
  if (res.code !== 0) return { repo: false }
  return { repo: true, files: parsePorcelain(res.stdout) }
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
        if ((err as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER') {
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
 * worktree diff. An untracked file has no worktree diff, so it falls back to
 * `--no-index` against the null device, rendering as a full-file addition.
 */
export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<DiffResult> {
  if (!cwd || !path) return { text: '', truncated: false }
  const base = [...QUOTE_OFF, 'diff', '--no-color']
  const first = await runDiff(
    cwd,
    staged ? [...base, '--cached', '--', path] : [...base, '--', path]
  )
  if (staged || first.text.trim().length > 0 || first.truncated) return first
  // Untracked: synthesize a full-addition diff. --no-index exits 1 ("differences
  // found"), not an error; runDiff returns its stdout regardless of exit code.
  return runDiff(cwd, [...QUOTE_OFF, 'diff', '--no-color', '--no-index', '--', devNull, path])
}
